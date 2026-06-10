import { IS_DEV } from 'common/process';

/**
 * Video freeze detection + self-heal for the SlideMode `<video>`.
 *
 * ## Why this exists
 *
 * Electron/Chromium's HTML5 `<video>` can freeze mid-playback on Windows: the
 * frame stops advancing while the element still reports itself as playing. The
 * only reliable recovery is to re-initialise the media pipeline — which the app
 * currently achieves only by navigating away from the video and back, remounting
 * the element. This is a well-documented Chromium/Electron class of bug,
 * aggravated by seeking (which forces a decoder flush) and by the `loop`
 * attribute. See:
 *   - electron/electron#12465 (freezes mid-playback, timeline skips, seek to resume)
 *   - electron/electron#13033 (looping video → decoder degradation/freeze)
 *   - Dash-Industry-Forum/dash.js#1784 (freezes after seeking; recovers on
 *     pause/play or another seek — the exact recovery this watchdog automates)
 *
 * ## What it does
 *
 * A lightweight watchdog samples `currentTime` while the element is expected to
 * be playing. If the position stops advancing for `stuckThresholdMs`, it nudges
 * the element back to life in-place, escalating across attempts:
 *   1. pause → play (no seek)
 *   2. small forward seek + play (crosses a bad frame / keyframe gap)
 *   3. hard reset: `load()` then restore `currentTime` and play — the
 *      programmatic equivalent of the remount that "switch away and back" does
 * After `maxAttempts` it gives up to avoid an infinite reload loop.
 *
 * A media `error` event triggers an immediate hard reset. In every case the
 * element's media state (readyState, networkState, error, buffered ranges) is
 * logged so the underlying cause can be diagnosed from the DevTools console in a
 * portable build — these are exceptional, low-volume events, so they log at
 * `warn` even outside dev. The noisy per-seek `waiting`/`stalled` events only
 * log in dev.
 */

export interface FreezeRecoveryOptions {
  /** How long `currentTime` may stall (ms) during expected playback before acting. */
  stuckThresholdMs?: number;
  /** Watchdog sampling interval (ms). */
  checkIntervalMs?: number;
  /** Max recovery attempts per freeze episode before giving up (avoids reload loops). */
  maxAttempts?: number;
}

const PREFIX = '[VideoFreezeRecovery]';

/** Render the buffered TimeRanges as a compact "start-end, start-end" string. */
function describeBuffered(video: HTMLVideoElement): string {
  try {
    const b = video.buffered;
    const ranges: string[] = [];
    for (let i = 0; i < b.length; i++) {
      ranges.push(`${b.start(i).toFixed(2)}-${b.end(i).toFixed(2)}`);
    }
    return ranges.join(', ') || '(none)';
  } catch {
    return '(unavailable)';
  }
}

/** Capture the element's media state for diagnostics at the moment of an event. */
function snapshot(video: HTMLVideoElement, reason: string, attempt: number) {
  return {
    reason,
    attempt,
    src: video.currentSrc,
    currentTime: Number(video.currentTime.toFixed(3)),
    duration: Number.isFinite(video.duration) ? Number(video.duration.toFixed(3)) : video.duration,
    paused: video.paused,
    ended: video.ended,
    seeking: video.seeking,
    readyState: video.readyState, // 0 HAVE_NOTHING .. 4 HAVE_ENOUGH_DATA
    networkState: video.networkState, // 0 EMPTY .. 3 NO_SOURCE
    error: video.error ? { code: video.error.code, message: video.error.message } : null,
    buffered: describeBuffered(video),
  };
}

/** Call play() and swallow the expected AbortError when interrupted by a load/seek. */
function safePlay(video: HTMLVideoElement): void {
  video.play().catch((err: unknown) => {
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      // eslint-disable-next-line no-console
      console.warn(`${PREFIX} play() rejected during recovery`, err);
    }
  });
}

/**
 * Attach the freeze watchdog to a `<video>` element.
 *
 * @returns a cleanup function — call it on detach/unmount to stop the watchdog
 * and remove all listeners.
 */
export function attachVideoFreezeRecovery(
  video: HTMLVideoElement,
  options: FreezeRecoveryOptions = {},
): () => void {
  const stuckThresholdMs = options.stuckThresholdMs ?? 1500;
  const checkIntervalMs = options.checkIntervalMs ?? 500;
  const maxAttempts = options.maxAttempts ?? 3;

  let lastTime = video.currentTime;
  let lastAdvanceTs = performance.now();
  let recovering = false;
  let attempts = 0;

  const resetTracking = (): void => {
    lastTime = video.currentTime;
    lastAdvanceTs = performance.now();
  };

  const recover = (reason: string): void => {
    if (recovering) {
      return;
    }
    if (attempts >= maxAttempts) {
      // Give up to avoid an infinite reload loop; surface state for diagnosis.
      // eslint-disable-next-line no-console
      console.warn(
        `${PREFIX} giving up after ${attempts} attempts`,
        snapshot(video, reason, attempts),
      );
      return;
    }
    recovering = true;
    attempts += 1;
    const target = video.currentTime;
    // eslint-disable-next-line no-console
    console.warn(`${PREFIX} freeze detected — recovering`, snapshot(video, reason, attempts));

    try {
      if (attempts === 1) {
        // Gentlest: pause/play, no position change.
        video.pause();
        safePlay(video);
      } else if (attempts < maxAttempts) {
        // Small forward seek to cross a bad frame / keyframe gap, then resume.
        const dur = Number.isFinite(video.duration) ? video.duration : target + 1;
        video.currentTime = Math.min(dur - 0.1, target + 0.1);
        safePlay(video);
      } else {
        // Hard reset: rebuild the media pipeline (what a remount does), restore
        // position once metadata is back, then resume.
        const onLoaded = (): void => {
          video.removeEventListener('loadedmetadata', onLoaded);
          try {
            video.currentTime = target;
          } catch {
            /* element may have been detached mid-reset */
          }
          safePlay(video);
        };
        video.addEventListener('loadedmetadata', onLoaded);
        video.load();
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`${PREFIX} recovery nudge threw`, err);
    } finally {
      // Consume our own induced position change so it isn't read as real playback
      // progress, and give the element time to react before the next attempt.
      resetTracking();
      window.setTimeout(() => {
        recovering = false;
      }, stuckThresholdMs);
    }
  };

  const tick = (): void => {
    // Not expected to be advancing — keep the baseline fresh so we don't false-trigger.
    if (video.paused || video.ended || video.seeking || video.readyState < 2) {
      resetTracking();
      return;
    }
    const t = video.currentTime;
    if (t > lastTime + 0.01) {
      // Forward progress: healthy. Clear any in-progress freeze episode.
      lastTime = t;
      lastAdvanceTs = performance.now();
      attempts = 0;
      return;
    }
    if (t + 0.01 < lastTime) {
      // Position jumped backwards: loop wrap or a user seek — activity, not a
      // freeze. Re-baseline but do NOT clear attempts (this isn't proof of health).
      lastTime = t;
      lastAdvanceTs = performance.now();
      return;
    }
    // Position unchanged while playback is expected → potential freeze.
    if (performance.now() - lastAdvanceTs >= stuckThresholdMs) {
      recover('watchdog: currentTime stalled during playback');
    }
  };

  const intervalId = window.setInterval(tick, checkIntervalMs);

  // A media error is a definite failure — force the next recover() to hard-reset.
  const onError = (): void => {
    attempts = Math.max(attempts, maxAttempts - 1);
    recover('error event');
  };
  // A new source started loading — reset episode state for the new video.
  const onLoadStart = (): void => {
    attempts = 0;
    recovering = false;
    resetTracking();
  };
  // Fine-grained diagnostics (dev only — noisy during normal seeks/buffering).
  const onWaiting = IS_DEV
    ? (): void => console.debug(`${PREFIX} waiting`, snapshot(video, 'waiting', attempts))
    : undefined;
  const onStalled = IS_DEV
    ? (): void => console.debug(`${PREFIX} stalled`, snapshot(video, 'stalled', attempts))
    : undefined;

  video.addEventListener('error', onError);
  video.addEventListener('loadstart', onLoadStart);
  if (onWaiting) {
    video.addEventListener('waiting', onWaiting);
  }
  if (onStalled) {
    video.addEventListener('stalled', onStalled);
  }

  return () => {
    window.clearInterval(intervalId);
    video.removeEventListener('error', onError);
    video.removeEventListener('loadstart', onLoadStart);
    if (onWaiting) {
      video.removeEventListener('waiting', onWaiting);
    }
    if (onStalled) {
      video.removeEventListener('stalled', onStalled);
    }
  };
}
