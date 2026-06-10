/**
 * Unit tests for the SlideMode video freeze watchdog (solution #2).
 *
 * Verifies that `attachVideoFreezeRecovery`:
 *   - does NOT act while the video advances normally,
 *   - detects a stalled (frozen-but-playing) element and escalates pause/play →
 *     seek → load() across attempts,
 *   - treats a backward jump (loop wrap / user seek) as activity, not a freeze,
 *   - hard-resets on a media `error` event,
 *   - stops completely after its cleanup function runs.
 *
 * The watchdog reads wall-clock via `performance.now()` and schedules work via
 * `window.setInterval` / `window.setTimeout`. The test env is Node, so we point
 * `window` at the (fake-timer-patched) global and drive `performance.now()` with
 * a controlled counter that we advance in lock-step with the fake timers.
 */

import { attachVideoFreezeRecovery } from '../src/frontend/image/videoFreezeRecovery';

const THRESHOLD = 1500;
const INTERVAL = 500;

let perfNow = 0;

/** A minimal mock of the HTMLVideoElement surface the watchdog touches. */
function makeMockVideo() {
  const listeners: Record<string, Array<() => void>> = {};
  const v: any = {
    currentTime: 0,
    duration: 100,
    paused: false,
    ended: false,
    seeking: false,
    readyState: 4, // HAVE_ENOUGH_DATA
    networkState: 1,
    error: null,
    currentSrc: 'file:///video.mp4',
    buffered: { length: 1, start: () => 0, end: () => 50 },
    play: jest.fn(() => Promise.resolve()),
    pause: jest.fn(), // no-op: the test controls `paused` so a frozen video stays "playing"
    load: jest.fn(),
    addEventListener: (type: string, handler: () => void) => {
      (listeners[type] ||= []).push(handler);
    },
    removeEventListener: (type: string, handler: () => void) => {
      listeners[type] = (listeners[type] || []).filter((h) => h !== handler);
    },
    emit: (type: string) => (listeners[type] || []).slice().forEach((h) => h()),
  };
  return v;
}

/** Advance both the fake timer clock and performance.now() by `ms`, in tick-sized steps. */
function advance(ms: number): void {
  const steps = Math.round(ms / INTERVAL);
  for (let i = 0; i < steps; i++) {
    perfNow += INTERVAL;
    jest.advanceTimersByTime(INTERVAL);
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  perfNow = 0;
  // window.setInterval/clearInterval/setTimeout must resolve to the fake-timer
  // globals jest installed above.
  (global as any).window = global;
  jest.spyOn(performance, 'now').mockImplementation(() => perfNow);
  // Silence the watchdog's diagnostic warnings during the test run.
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete (global as any).window;
});

describe('attachVideoFreezeRecovery', () => {
  it('does not act while the video advances normally', () => {
    const video = makeMockVideo();
    const cleanup = attachVideoFreezeRecovery(video);

    // Simulate healthy playback: currentTime advances every tick.
    for (let i = 0; i < 20; i++) {
      perfNow += INTERVAL;
      video.currentTime += INTERVAL / 1000;
      jest.advanceTimersByTime(INTERVAL);
    }

    expect(video.pause).not.toHaveBeenCalled();
    expect(video.load).not.toHaveBeenCalled();
    cleanup();
  });

  it('detects a stall and nudges with pause/play (attempt 1)', () => {
    const video = makeMockVideo();
    const cleanup = attachVideoFreezeRecovery(video);

    // Frozen-but-playing: currentTime never changes for > threshold.
    advance(THRESHOLD + INTERVAL);

    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.load).not.toHaveBeenCalled();
    cleanup();
  });

  it('escalates to a hard reset (load + restore) under a sustained freeze', () => {
    const video = makeMockVideo();
    const cleanup = attachVideoFreezeRecovery(video);

    // Stay frozen long enough for all three escalation attempts to fire. Each
    // attempt is gated behind the `recovering` flag for ~threshold ms.
    advance(THRESHOLD * 5);

    // Attempt 1 = pause/play, attempt 2 = forward seek, attempt 3 = load().
    expect(video.pause).toHaveBeenCalled();
    expect(video.load).toHaveBeenCalledTimes(1);

    // Completing the reset restores the saved position and resumes.
    const restoreTarget = video.currentTime;
    video.emit('loadedmetadata');
    expect(video.currentTime).toBe(restoreTarget);
    expect(video.play).toHaveBeenCalled();
    cleanup();
  });

  it('treats a backward jump (loop wrap / seek) as activity, not a freeze', () => {
    const video = makeMockVideo();
    const cleanup = attachVideoFreezeRecovery(video);

    video.currentTime = 99;
    advance(INTERVAL); // baseline near the end

    // Loop wraps back to the start every tick — position keeps changing.
    for (let i = 0; i < 10; i++) {
      perfNow += INTERVAL;
      video.currentTime = video.currentTime > 1 ? 0 : 99; // toggle wrap
      jest.advanceTimersByTime(INTERVAL);
    }

    expect(video.pause).not.toHaveBeenCalled();
    expect(video.load).not.toHaveBeenCalled();
    cleanup();
  });

  it('hard-resets immediately on a media error event', () => {
    const video = makeMockVideo();
    const cleanup = attachVideoFreezeRecovery(video);

    video.error = { code: 3, message: 'DECODE' };
    video.emit('error');

    expect(video.load).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('stops acting after cleanup', () => {
    const video = makeMockVideo();
    const cleanup = attachVideoFreezeRecovery(video);
    cleanup();

    advance(THRESHOLD * 4); // frozen the whole time

    expect(video.pause).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
    expect(video.load).not.toHaveBeenCalled();
  });
});
