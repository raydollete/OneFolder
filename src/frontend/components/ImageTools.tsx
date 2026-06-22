import React, { useCallback, useState } from 'react';
import { observer } from 'mobx-react-lite';

import { isFileExtensionVideo } from 'common/fs';
import { formatSecondsToHms, parseHmsToSeconds } from 'common/fmt';
import { IconSet } from 'widgets';
import { useStore } from '../contexts/StoreContext';
import { ClientFile } from '../entities/File';

interface ImageToolsProps {
  file: ClientFile;
}

const ImageTools = observer(({ file }: ImageToolsProps) => {
  const { mediaQueueStore } = useStore();

  // HH:MM:SS fields for the Mark Start / Mark End / Create Clip controls.
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

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

  // Subtract Clip removes the marked [start, end] section, so it needs BOTH marks, a forward
  // range, and at least 1s of lead before the start so the cross-fade fits in clip A
  // (offset = start − 1 must be ≥ 0). Clip-B-too-short (end within 1s of the true end) can't be
  // checked here without the source duration; ffmpeg fails loudly and surfaces a Failed row.
  const subtractValid =
    bothValid && (startSec as number) < (endSec as number) && (startSec as number) >= 1;

  // Show a hint when both fields are filled but the range is backwards/equal.
  const showRangeHint =
    startTime !== '' &&
    endTime !== '' &&
    startSec !== null &&
    endSec !== null &&
    startSec >= endSec;

  return (
    <div className="inspector-section">
      <div className="tools">
        {isVideo ? (
          <>
            <button
              onClick={() => mediaQueueStore.enqueue(file, 'rotate-cw')}
              title="Rotate this video 90° clockwise (ffmpeg transpose=1)"
            >
              {IconSet.RELOAD}Rotate CW
            </button>
            <button
              onClick={() => mediaQueueStore.enqueue(file, 'rotate-ccw')}
              title="Rotate this video 90° counterclockwise (ffmpeg transpose=2)"
            >
              {IconSet.RELOAD}Rotate CCW
            </button>
            <button
              onClick={() => mediaQueueStore.enqueue(file, 'reencode-x264')}
              title="Re-encode this video to H.264 MP4"
            >
              {IconSet.PLAY}Re-encode (x264)
            </button>
            <button
              onClick={() => mediaQueueStore.enqueue(file, 'normalize-audio')}
              title="Compress dynamic range, then normalize loudness (ffmpeg acompressor + loudnorm)"
            >
              {IconSet.MEDIA}Compress &amp; Normalize Audio
            </button>
            <div className="tools__mark-row">
              <button
                className="tools__mark-btn"
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
              />
            </div>
            <div className="tools__mark-row">
              <button
                className="tools__mark-btn"
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
              />
            </div>
            {showRangeHint && <p className="tools__clip-hint">End must be after start.</p>}
            <button
              disabled={!clipValid}
              onClick={() => {
                const clip: { start?: string; end?: string } = {};
                if (startTime !== '') {
                  clip.start = startTime;
                }
                if (endTime !== '') {
                  clip.end = endTime;
                }
                mediaQueueStore.enqueue(file, 'create-clip', clip);
              }}
              title="Trim a lossless stream-copy clip between the marked times"
            >
              {IconSet.MEDIA}Create Clip
            </button>
            <button
              disabled={!subtractValid}
              onClick={() => {
                const clip: { start?: string; end?: string } = {};
                if (startTime !== '') {
                  clip.start = startTime;
                }
                if (endTime !== '') {
                  clip.end = endTime;
                }
                mediaQueueStore.enqueue(file, 'subtract-clip', clip);
              }}
              title="Remove the marked section and cross-fade the remaining video together"
            >
              {IconSet.MEDIA}Subtract Clip
            </button>
          </>
        ) : (
          <p className="tools__no-tools-caption">No tools available for this file type.</p>
        )}
      </div>
    </div>
  );
});

export default ImageTools;
