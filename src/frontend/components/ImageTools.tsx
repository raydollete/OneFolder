import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';

import { isFileExtensionVideo } from 'common/fs';
import { formatSecondsToHms, parseHmsToSeconds } from 'common/fmt';
import { IconSet } from 'widgets';
import { MediaJobType } from '../../ipc/messages';
import { RendererMessenger } from '../../ipc/renderer';
import { useStore } from '../contexts/StoreContext';
import { ClientFile } from '../entities/File';
import { AppToaster } from './Toaster';

interface ImageToolsProps {
  file: ClientFile;
}

const ImageTools = observer(({ file }: ImageToolsProps) => {
  const { uiStore, fileStore } = useStore();

  // Local state for the in-progress media job ----------------------------------------
  // activeJob tracks which tool is currently running; null means idle.
  // Only one job runs at a time (gated by uiStore.isMediaProcessing).
  const [activeJob, setActiveJob] = useState<MediaJobType | null>(null);
  const [jobPercent, setJobPercent] = useState<number | null>(null);
  // isFinalizing covers the ffmpeg-exit -> output-open gap (awaitWriteFinish + DB
  // poll + refetch + waitForIngestedFile). activeJob stays set during this phase so
  // the tool label is available for the "Finalizing…" text, but jobPercent is null
  // so the spinner is indeterminate. The Cancel button is hidden during this phase
  // (ffmpeg is already done; there is nothing to cancel).
  const [isFinalizing, setIsFinalizing] = useState(false);
  // jobId is delivered via the first MEDIA_JOB_PROGRESS event; needed for Cancel.
  const jobIdRef = useRef<string | null>(null);

  // HH:MM:SS fields for the Mark Start / Mark End / Create Clip controls.
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  // Clean up the progress subscription when the component unmounts while a
  // job is running (edge case: user closes the inspector mid-job).
  const unsubscribeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  // Read the live playback position of the currently mounted slide <video>.
  // The gallery grid stays mounted behind the slide overlay (LayoutSwitcher.tsx),
  // and gallery thumbnail videos (<video data-file-id=…> in GalleryItem.tsx) precede
  // the slide video in document order. document.querySelector('video') would therefore
  // return a gallery thumbnail (reset to currentTime=0 on slide-mode entry) — always
  // capturing 00:00:00. Scope the query to #zoomable-image (the SlideMode container,
  // see SlideMode/index.tsx:241) to reach only the slide <video>, mirroring the proven
  // pattern in ZoomPan.tsx:165. The :not([data-file-id]) guard is defense in depth
  // (the slide video carries no data-file-id; every gallery thumbnail does).
  const captureCurrentTime = useCallback((): string => {
    const v = document.querySelector(
      '#zoomable-image video:not([data-file-id])',
    ) as HTMLVideoElement | null;
    const sec = v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
    return formatSecondsToHms(sec);
  }, []);

  const runMediaJob = useCallback(
    async (jobType: MediaJobType, clip?: { start?: string; end?: string }) => {
      if (uiStore.isMediaProcessing || activeJob !== null) {
        return;
      }

      // Subscribe to progress events BEFORE invoking startMediaJob so we never
      // miss the synthetic percent:0 / jobId event (per IPC contract).
      const unsubscribe = RendererMessenger.onMediaJobProgress((msg) => {
        // Stash the jobId from the first event for the Cancel button.
        if (jobIdRef.current === null && msg.jobId) {
          jobIdRef.current = msg.jobId;
        }
        if (msg.percent !== undefined) {
          // Round to a whole percent — avoids a re-render per fractional progress tick.
          setJobPercent(Math.round(msg.percent));
        }
      });
      unsubscribeRef.current = unsubscribe;

      setActiveJob(jobType);
      setJobPercent(null);
      jobIdRef.current = null;

      // Pin the viewer to the SOURCE for the entire job. While pinned, SlideMode and the Inspector
      // display this exact file by identity, immune to any fileList/firstItem churn the folder
      // watcher causes when the output appears — the user cannot be dropped back to the grid.
      uiStore.beginMediaProcessing(file);

      try {
        const { outputPath } = await RendererMessenger.startMediaJob(
          jobType,
          file.absolutePath,
          clip,
        );

        // Tear down the progress subscription — ffmpeg is done.
        unsubscribe();
        unsubscribeRef.current = null;

        // Enter the finalization phase: ffmpeg has exited but the output is not yet open. The
        // source stays pinned on screen with an indeterminate "Finalizing…" label (the inspector
        // remains mounted because it, too, is pinned). The media-processing lock remains held
        // throughout (released only in finally). activeJob intentionally stays set so the tool
        // label is available for the label string below.
        setIsFinalizing(true);

        // Corrected post-encode order (INV-019): copy tags at the DB level FIRST so the destination
        // carries the source's tags before it is shown, then resolve the output ClientFile.
        // finalizeEncodedOutput returns the verified-openable output (tags already copied), or null
        // if it could not be confirmed in the library.
        const outputFile = await fileStore.finalizeEncodedOutput(file, outputPath);

        // Finalization complete — clear the finalizing phase before finally runs.
        setIsFinalizing(false);

        if (outputFile !== null) {
          // Seamless in-place swap: move the pin from the source to the output. The viewer (still
          // mounted, still in SlideMode) switches from the source video to the new one with no trip
          // back to the grid and no intermediate blank frame.
          uiStore.setMediaProcessingFile(outputFile);

          // For Create Clip, reset the time fields so they are ready for the next clip.
          // Do NOT reset on failure or cancel — the user may want to retry with the same values.
          if (jobType === 'create-clip') {
            setStartTime('');
            setEndTime('');
          }

          // Open the delete-original prompt (rendered by DeleteOriginalAfterJob). This runs AFTER
          // the output is verified and shown — only when we actually have a confirmed output.
          uiStore.openDeleteOriginalPrompt(file);
        }
        // If outputFile === null, finalizeEncodedOutput already surfaced an honest toast and the
        // source stays pinned on screen; we do NOT prompt to delete an unverifiable original.
      } catch (err: unknown) {
        // Tear down subscription on failure too.
        unsubscribe();
        unsubscribeRef.current = null;

        const message = err instanceof Error ? err.message : String(err);
        const toastLabel =
          jobType === 'normalize-audio'
            ? 'Normalize audio'
            : jobType === 'create-clip'
            ? 'Create clip'
            : 'Re-encode';
        if (message === 'MEDIA_JOB_CANCELLED') {
          // User-initiated cancel — show a neutral toast, no error. The source stays on screen.
          AppToaster.show({ message: `${toastLabel} cancelled.`, timeout: 3000 });
        } else {
          // Hard ffmpeg failure — surface the error in a blocking MODAL (MediaJobErrorAlert), not a
          // transient toast, and keep the SOURCE video on screen (the pin is still the source; the
          // finally below reconciles firstItem back to it). The output, if any, was already removed
          // by ReEncodeManager on non-zero exit.
          uiStore.showMediaJobError(toastLabel, message);
        }
      } finally {
        // Always release the UI lock and reset local state — even on cancel/error.
        // setIsFinalizing(false) is also called immediately after finalizeEncodedOutput
        // on the success path; this defensive call covers cancel and error paths where
        // finalization may have been entered but not successfully exited.
        uiStore.endMediaProcessing();
        setActiveJob(null);
        setJobPercent(null);
        setIsFinalizing(false);
        jobIdRef.current = null;
      }
    },
    [activeJob, file, fileStore, uiStore],
  );

  const handleCancel = useCallback(() => {
    if (jobIdRef.current) {
      RendererMessenger.cancelMediaJob(jobIdRef.current);
    }
  }, []);

  const isVideo = isFileExtensionVideo(file.extension);

  // Derive validity for the Create Clip button.
  // At least one valid HH:MM:SS marker is required; start < end is enforced only when
  // both are present. End-only requires end > 0 (a 00:00:00 end-only would be a zero-
  // length clip). An empty string is treated as "not provided" (distinct from malformed).
  const startSec = startTime === '' ? null : parseHmsToSeconds(startTime);
  const endSec = endTime === '' ? null : parseHmsToSeconds(endTime);
  const startValid = startTime !== '' && startSec !== null;
  const endValid = endTime !== '' && endSec !== null && endSec > 0;
  const bothValid = startValid && endValid;
  const clipValid =
    (bothValid && (startSec as number) < (endSec as number)) ||
    (startValid && endTime === '') ||
    (endValid && startTime === '');

  // Show a hint when both fields are filled but the range is backwards/equal.
  const showRangeHint =
    startTime !== '' &&
    endTime !== '' &&
    startSec !== null &&
    endSec !== null &&
    startSec >= endSec;

  // Derive a human-readable label for the in-progress spinner.
  // During the finalization phase (isFinalizing) all tools show "Finalizing…"
  // (indeterminate — no percent). During the ffmpeg phase the label is tool-specific
  // and percent-qualified once ffmpeg starts reporting progress.
  const progressLabel = isFinalizing
    ? 'Finalizing…'
    : activeJob === 'normalize-audio'
    ? jobPercent !== null
      ? `Normalizing audio… ${jobPercent}%`
      : 'Normalizing audio…'
    : activeJob === 'create-clip'
    ? jobPercent !== null
      ? `Creating clip… ${jobPercent}%`
      : 'Creating clip…'
    : jobPercent !== null
    ? `Re-encoding… ${jobPercent}%`
    : 'Re-encoding…';

  const cancelTitle =
    activeJob === 'normalize-audio'
      ? 'Cancel audio normalization'
      : activeJob === 'create-clip'
      ? 'Cancel clip'
      : 'Cancel re-encode';

  return (
    <div className="inspector-section">
      <div className="tools">
        {isVideo ? (
          <>
            {activeJob !== null ? (
              <div className="reencode-progress">
                <div className="loading-spinner" />
                <span className="reencode-progress__text">{progressLabel}</span>
                {!isFinalizing && (
                  <button
                    className="reencode-progress__cancel"
                    onClick={handleCancel}
                    title={cancelTitle}
                  >
                    Cancel
                  </button>
                )}
              </div>
            ) : (
              <>
                <button
                  disabled={uiStore.isMediaProcessing}
                  onClick={() => runMediaJob('reencode-x264')}
                  title="Re-encode this video to H.264 MP4"
                >
                  {IconSet.PLAY}Re-encode (x264)
                </button>
                <button
                  disabled={uiStore.isMediaProcessing}
                  onClick={() => runMediaJob('normalize-audio')}
                  title="Normalize audio levels using ffmpeg dynaudnorm"
                >
                  {IconSet.MEDIA}Normalize Audio
                </button>
                <div className="tools__mark-row">
                  <button
                    className="tools__mark-btn"
                    disabled={uiStore.isMediaProcessing}
                    onClick={() => setStartTime(captureCurrentTime())}
                    title="Set start time from current video playback position"
                  >
                    Mark Start
                  </button>
                  <input
                    className="tools__time-field"
                    aria-label="Clip start time (HH:MM:SS)"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    placeholder="00:00:00"
                    disabled={uiStore.isMediaProcessing}
                  />
                </div>
                <div className="tools__mark-row">
                  <button
                    className="tools__mark-btn"
                    disabled={uiStore.isMediaProcessing}
                    onClick={() => setEndTime(captureCurrentTime())}
                    title="Set end time from current video playback position"
                  >
                    Mark End
                  </button>
                  <input
                    className="tools__time-field"
                    aria-label="Clip end time (HH:MM:SS)"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    placeholder="00:00:00"
                    disabled={uiStore.isMediaProcessing}
                  />
                </div>
                {showRangeHint && <p className="tools__clip-hint">End must be after start.</p>}
                <button
                  disabled={!clipValid || uiStore.isMediaProcessing}
                  onClick={() => {
                    const clip: { start?: string; end?: string } = {};
                    if (startTime !== '') {
                      clip.start = startTime;
                    }
                    if (endTime !== '') {
                      clip.end = endTime;
                    }
                    runMediaJob('create-clip', clip);
                  }}
                  title="Trim a lossless stream-copy clip between the marked times"
                >
                  {IconSet.MEDIA}Create Clip
                </button>
              </>
            )}
          </>
        ) : (
          <p className="tools__no-tools-caption">No tools available for this file type.</p>
        )}
      </div>
    </div>
  );
});

export default ImageTools;
