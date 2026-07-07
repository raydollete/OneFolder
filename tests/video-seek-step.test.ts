import {
  computeVideoSeekStep,
  VIDEO_SEEK_BARE_SECONDS,
  VIDEO_SEEK_CTRL_SECONDS,
  VIDEO_SEEK_SHIFT_FRAME_SECONDS,
} from '../src/frontend/containers/ContentView/SlideMode/videoSeek';

const NO_MODS = { altKey: false, ctrlKey: false, shiftKey: false };

describe('computeVideoSeekStep', () => {
  describe('bare wheel', () => {
    it('seeks +2s scrolling down', () => {
      expect(computeVideoSeekStep(NO_MODS, 100)).toEqual({
        stepSeconds: VIDEO_SEEK_BARE_SECONDS,
        pauseFirst: false,
      });
    });

    it('seeks -2s scrolling up', () => {
      expect(computeVideoSeekStep(NO_MODS, -100)).toEqual({
        stepSeconds: -VIDEO_SEEK_BARE_SECONDS,
        pauseFirst: false,
      });
    });
  });

  describe('Ctrl+wheel', () => {
    it('seeks ±10s and does not pause', () => {
      const mods = { ...NO_MODS, ctrlKey: true };
      expect(computeVideoSeekStep(mods, 100)).toEqual({
        stepSeconds: VIDEO_SEEK_CTRL_SECONDS,
        pauseFirst: false,
      });
      expect(computeVideoSeekStep(mods, -100)).toEqual({
        stepSeconds: -VIDEO_SEEK_CTRL_SECONDS,
        pauseFirst: false,
      });
    });
  });

  describe('Shift+wheel', () => {
    it('steps ±1 frame and pauses first', () => {
      const mods = { ...NO_MODS, shiftKey: true };
      expect(computeVideoSeekStep(mods, 100)).toEqual({
        stepSeconds: VIDEO_SEEK_SHIFT_FRAME_SECONDS,
        pauseFirst: true,
      });
      expect(computeVideoSeekStep(mods, -100)).toEqual({
        stepSeconds: -VIDEO_SEEK_SHIFT_FRAME_SECONDS,
        pauseFirst: true,
      });
    });
  });

  describe('modifier precedence (Shift > Ctrl > bare)', () => {
    it('prefers Shift over Ctrl when both are held', () => {
      const mods = { altKey: false, ctrlKey: true, shiftKey: true };
      expect(computeVideoSeekStep(mods, 100)).toEqual({
        stepSeconds: VIDEO_SEEK_SHIFT_FRAME_SECONDS,
        pauseFirst: true,
      });
    });
  });

  describe('Alt = not a seek', () => {
    it('returns null when Alt is held, regardless of other modifiers', () => {
      expect(computeVideoSeekStep({ ...NO_MODS, altKey: true }, 100)).toBeNull();
      expect(
        computeVideoSeekStep({ altKey: true, ctrlKey: true, shiftKey: false }, 100),
      ).toBeNull();
      expect(
        computeVideoSeekStep({ altKey: true, ctrlKey: false, shiftKey: true }, -100),
      ).toBeNull();
    });
  });

  describe('no vertical delta', () => {
    it('returns null when deltaY is zero', () => {
      expect(computeVideoSeekStep(NO_MODS, 0)).toBeNull();
      expect(computeVideoSeekStep({ ...NO_MODS, ctrlKey: true }, 0)).toBeNull();
      expect(computeVideoSeekStep({ ...NO_MODS, shiftKey: true }, 0)).toBeNull();
    });
  });
});
