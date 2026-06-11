import React, { useCallback, useEffect, useRef, useState } from 'react';
import { observer } from 'mobx-react-lite';

import { isFileExtensionVideo } from 'common/fs';
import { IconSet } from 'widgets';
import { RendererMessenger } from '../../ipc/renderer';
import { useStore } from '../contexts/StoreContext';
import { ClientFile } from '../entities/File';
import { AppToaster } from './Toaster';

interface ImageToolsProps {
  file: ClientFile;
}

const ImageTools = observer(({ file }: ImageToolsProps) => {
  const { uiStore, fileStore } = useStore();

  // Local state for the in-progress encode ----------------------------------------
  const [isEncoding, setIsEncoding] = useState(false);
  const [encodePercent, setEncodePercent] = useState<number | null>(null);
  // jobId is delivered via the first REENCODE_PROGRESS event; needed for Cancel.
  const jobIdRef = useRef<string | null>(null);

  // Clean up the progress subscription when the component unmounts while an
  // encode is running (edge case: user closes the inspector mid-encode).
  const unsubscribeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  const handleReencode = useCallback(async () => {
    if (uiStore.isMediaProcessing || isEncoding) {
      return;
    }

    // Subscribe to progress events BEFORE invoking startReencode so we never
    // miss the synthetic percent:0 / jobId event (per TASK-076 contract).
    const unsubscribe = RendererMessenger.onReencodeProgress((msg) => {
      // Stash the jobId from the first event for the Cancel button.
      if (jobIdRef.current === null && msg.jobId) {
        jobIdRef.current = msg.jobId;
      }
      if (msg.percent !== undefined) {
        // Round to a whole percent — also avoids a re-render per fractional progress tick.
        setEncodePercent(Math.round(msg.percent));
      }
    });
    unsubscribeRef.current = unsubscribe;

    setIsEncoding(true);
    setEncodePercent(null);
    jobIdRef.current = null;

    uiStore.beginMediaProcessing(file.absolutePath);

    try {
      const { outputPath } = await RendererMessenger.startReencode(file.absolutePath);

      // Tear down the progress subscription — encode is complete.
      unsubscribe();
      unsubscribeRef.current = null;

      // Wait for the watcher to ingest the new file (bounded 10 s).
      let newFile: ClientFile;
      try {
        newFile = await fileStore.waitForIngestedFile(outputPath, 10000);
      } catch {
        // The output landed outside a watched folder or ingestion timed out.
        AppToaster.show({
          message: `Encoded to ${outputPath} but it is outside a watched folder; tags not attached.`,
          timeout: 8000,
        });
        return;
      }

      // Copy DB tags and write EXIF/XMP metadata onto the new file (single write).
      await fileStore.copyTagsToFile(file, newFile);

      // Select the new file and ensure SlideMode shows it.
      uiStore.selectFile(newFile, true);
      uiStore.enableSlideMode();

      // Open the delete-original prompt (TASK-079 renders the actual Alert).
      uiStore.openReEncodeDeleteOriginal(file);
    } catch (err: unknown) {
      // Tear down subscription on failure too.
      unsubscribe();
      unsubscribeRef.current = null;

      const message = err instanceof Error ? err.message : String(err);
      if (message === 'REENCODE_CANCELLED') {
        // User-initiated cancel — no error toast.
        AppToaster.show({ message: 'Re-encode cancelled.', timeout: 3000 });
      } else {
        AppToaster.show({
          message: `Re-encode failed: ${message}`,
          clickAction: { label: 'Dev Tools', onClick: RendererMessenger.toggleDevTools },
          timeout: 8000,
        });
      }
    } finally {
      // Always release the UI lock and reset local state — even on cancel/error.
      uiStore.endMediaProcessing();
      setIsEncoding(false);
      setEncodePercent(null);
      jobIdRef.current = null;
    }
  }, [file, fileStore, isEncoding, uiStore]);

  const handleCancel = useCallback(() => {
    if (jobIdRef.current) {
      RendererMessenger.cancelReencode(jobIdRef.current);
    }
  }, []);

  const isVideo = isFileExtensionVideo(file.extension);

  return (
    <div className="inspector-section">
      <div className="tools">
        {isVideo ? (
          <>
            {isEncoding ? (
              <div className="reencode-progress">
                <div className="loading-spinner" />
                <span className="reencode-progress__text">
                  {encodePercent !== null ? `Re-encoding… ${encodePercent}%` : 'Re-encoding…'}
                </span>
                <button
                  className="reencode-progress__cancel"
                  onClick={handleCancel}
                  title="Cancel re-encode"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                disabled={uiStore.isMediaProcessing}
                onClick={handleReencode}
                title="Re-encode this video to H.264 MP4"
              >
                {IconSet.PLAY}Re-encode (x264)
              </button>
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
