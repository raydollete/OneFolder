import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';

import { isFileExtensionVideo } from 'common/fs';
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

  const runMediaJob = useCallback(
    async (jobType: MediaJobType) => {
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

      uiStore.beginMediaProcessing(file.absolutePath);

      try {
        const { outputPath } = await RendererMessenger.startMediaJob(jobType, file.absolutePath);

        // Tear down the progress subscription — ffmpeg is done.
        unsubscribe();
        unsubscribeRef.current = null;

        // Enter the finalization phase: ffmpeg has exited but the output is not yet
        // open. The inspector spinner stays visible (TASK-089 keeps the source in
        // SlideMode so this component remains mounted) with an indeterminate
        // "Finalizing…" label. The media-processing lock remains held throughout
        // (released only in finally). activeJob intentionally stays set so the
        // tool label is available for the label string below.
        setIsFinalizing(true);

        // Corrected post-encode order (INV-019): copy tags at the DB level FIRST
        // so the output can match a tag-filtered view, then wait for it to appear,
        // then select it. The graceful fallback and any toasts are handled inside
        // finalizeEncodedOutput — do not duplicate that logic here.
        await fileStore.finalizeEncodedOutput(file, outputPath);

        // Finalization complete — clear the finalizing phase before finally runs.
        setIsFinalizing(false);

        // Open the delete-original prompt (TASK-086 renders the actual Alert).
        // This runs AFTER finalize so the output is already selected/visible.
        uiStore.openDeleteOriginalPrompt(file);
      } catch (err: unknown) {
        // Tear down subscription on failure too.
        unsubscribe();
        unsubscribeRef.current = null;

        const message = err instanceof Error ? err.message : String(err);
        if (message === 'MEDIA_JOB_CANCELLED') {
          // User-initiated cancel — show a neutral toast, no error.
          const label = jobType === 'normalize-audio' ? 'Normalize audio' : 'Re-encode';
          AppToaster.show({ message: `${label} cancelled.`, timeout: 3000 });
        } else {
          const label = jobType === 'normalize-audio' ? 'Normalize audio' : 'Re-encode';
          AppToaster.show({
            message: `${label} failed: ${message}`,
            clickAction: { label: 'Dev Tools', onClick: RendererMessenger.toggleDevTools },
            timeout: 8000,
          });
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

  // Derive a human-readable label for the in-progress spinner.
  // During the finalization phase (isFinalizing) both tools show "Finalizing…"
  // (indeterminate — no percent). During the ffmpeg phase the label is tool-specific
  // and percent-qualified once ffmpeg starts reporting progress.
  const progressLabel = isFinalizing
    ? 'Finalizing…'
    : activeJob === 'normalize-audio'
    ? jobPercent !== null
      ? `Normalizing audio… ${jobPercent}%`
      : 'Normalizing audio…'
    : jobPercent !== null
    ? `Re-encoding… ${jobPercent}%`
    : 'Re-encoding…';

  const cancelTitle =
    activeJob === 'normalize-audio' ? 'Cancel audio normalization' : 'Cancel re-encode';

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
