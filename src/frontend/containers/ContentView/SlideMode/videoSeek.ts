/**
 * Pure wheel-seek step computation for slide-mode video playback.
 *
 * Extracted from the former inline logic in `ZoomPan.handleMouseWheel` so the
 * viewer-scoped wheel listener (SlideMode) and unit tests share one source of
 * truth. The consumer applies the returned step to `video.currentTime`
 * (clamping to [0, duration]) and pauses first when `pauseFirst` is set.
 */

// Video wheel-seek step sizes (per scroll tick). Direction sign is multiplied in.
export const VIDEO_SEEK_BARE_SECONDS = 2;
export const VIDEO_SEEK_CTRL_SECONDS = 10;
// Heuristic single-frame step: exact at 30fps, ~2 frames at 60fps, may not advance at <30fps.
// HTML5 <video> exposes no per-frame step API, so we approximate.
export const VIDEO_SEEK_SHIFT_FRAME_SECONDS = 1 / 30;

export interface WheelSeekModifiers {
  altKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
}

export interface VideoSeekStep {
  /** Seconds to add to `currentTime` (already signed by scroll direction). */
  stepSeconds: number;
  /** Frame-stepping only makes sense on a paused video, so pause before seeking. */
  pauseFirst: boolean;
}

/**
 * Compute the wheel-seek step for a video timeline.
 *
 * Returns `null` when the wheel should NOT seek — either Alt is held (the wheel
 * drives zoom instead) or the wheel produced no vertical delta.
 *
 * Modifier precedence: Shift > Ctrl > bare. Alt = "not a seek".
 */
export function computeVideoSeekStep(
  modifiers: WheelSeekModifiers,
  deltaY: number,
): VideoSeekStep | null {
  if (modifiers.altKey) {
    return null;
  }
  const direction = deltaY < 0 ? -1 : deltaY > 0 ? 1 : 0;
  if (direction === 0) {
    return null;
  }
  if (modifiers.shiftKey) {
    return { stepSeconds: VIDEO_SEEK_SHIFT_FRAME_SECONDS * direction, pauseFirst: true };
  }
  if (modifiers.ctrlKey) {
    return { stepSeconds: VIDEO_SEEK_CTRL_SECONDS * direction, pauseFirst: false };
  }
  return { stepSeconds: VIDEO_SEEK_BARE_SECONDS * direction, pauseFirst: false };
}
