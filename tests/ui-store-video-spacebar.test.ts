/**
 * Tests for `video-spacebar-toggle-playback`.
 *
 * `UiStore.processGlobalShortCuts` gains an early branch: when Space is pressed
 * while a video is shown in slide mode (and its <video> element is registered via
 * setActiveVideoElement), it toggles that element's playback from its real
 * `paused` state and preempts the `viewSlide` binding (which also uses Space and
 * would otherwise exit slide mode). Non-video slide items must still exit on Space,
 * and a focused text-entry surface must never have its Space hijacked.
 *
 * These are pure-logic tests: the KeyboardEvent, target, and <video> element are
 * plain-object fakes, so no DOM/jsdom is required. The platform seam is mocked so
 * importing UiStore does not pull the Electron/native import graph.
 */

import { configure } from 'mobx';

configure({ enforceActions: 'never' });

// Neutralise the platform seam (and thus the fs-extra/ExifIO/electron graph) so
// UiStore can be imported and constructed in a plain Node test environment.
jest.mock('src/frontend/platform', () => ({ __esModule: true, default: {} }));

import UiStore from '../src/frontend/stores/UiStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUiStore(extension: string): UiStore {
  const file = { id: 'f1', extension } as any;
  const fileList = [file];
  // In slide mode, slideFile now resolves by identity via fileStore.get(slideFileId)
  // (viewer-file-anchoring). Provide the same O(1) id→file surface the real
  // FileStore exposes so the anchor resolves to fileList[0].
  const index = new Map<string, number>([['f1', 0]]);
  const mockRootStore = {
    fileStore: {
      fileList,
      get: (id: string) => (index.get(id) !== undefined ? fileList[index.get(id)!] : undefined),
      getIndex: (id: string) => index.get(id),
    },
  } as any;
  const store = new UiStore(mockRootStore);
  store.firstItem = 0;
  store.slideFileId = 'f1'; // anchor the viewer on fileList[0] (as enableSlideMode would)
  return store;
}

function makeVideoEl(paused: boolean): {
  paused: boolean;
  play: jest.Mock;
  pause: jest.Mock;
} {
  return {
    paused,
    play: jest.fn().mockResolvedValue(undefined),
    pause: jest.fn(),
  };
}

/** A fake Space keydown whose `target` is (by default) not a text field. */
function spaceEvent(target: { matches: (sel: string) => boolean }): KeyboardEvent {
  return {
    which: 32, // keyCode 32 -> 'space' in hotkeyParser
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target,
    preventDefault: jest.fn(),
  } as unknown as KeyboardEvent;
}

const nonInputTarget = { matches: () => false };
const inputTarget = { matches: (sel: string) => /input/.test(sel) };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UiStore Spacebar video playback toggle', () => {
  // toggleSlideMode is a non-writable bound MobX action, so it cannot be spied.
  // Instead we assert on its only side effect: whether `isSlideMode` flipped.

  it('plays a paused video and does not exit slide mode', () => {
    const store = makeUiStore('mp4');
    store.isSlideMode = true;
    const el = makeVideoEl(true); // paused
    store.setActiveVideoElement(el as any);

    const e = spaceEvent(nonInputTarget);
    store.processGlobalShortCuts(e);

    expect(el.play).toHaveBeenCalledTimes(1);
    expect(el.pause).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(store.isSlideMode).toBe(true); // did NOT exit slide mode
  });

  it('pauses a playing video and does not exit slide mode', () => {
    const store = makeUiStore('webm');
    store.isSlideMode = true;
    const el = makeVideoEl(false); // playing
    store.setActiveVideoElement(el as any);

    const e = spaceEvent(nonInputTarget);
    store.processGlobalShortCuts(e);

    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(el.play).not.toHaveBeenCalled();
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(store.isSlideMode).toBe(true); // did NOT exit slide mode
  });

  it('does not toggle playback when a text input is focused (space types normally)', () => {
    const store = makeUiStore('mp4');
    store.isSlideMode = true;
    const el = makeVideoEl(true);
    store.setActiveVideoElement(el as any);

    const e = spaceEvent(inputTarget);
    store.processGlobalShortCuts(e);

    expect(el.play).not.toHaveBeenCalled();
    expect(el.pause).not.toHaveBeenCalled();
    // Early input guard returns before any shortcut handling => no preventDefault.
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('non-video slide item still toggles slide mode on Space (no regression)', () => {
    const store = makeUiStore('jpg');
    store.isSlideMode = true;
    store.setActiveVideoElement(null); // image path clears any registered video

    const e = spaceEvent(nonInputTarget);
    store.processGlobalShortCuts(e);

    // viewSlide (Space) ran -> slide mode toggled off.
    expect(store.isSlideMode).toBe(false);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('does nothing special when not in slide mode (video branch is gated)', () => {
    const store = makeUiStore('mp4');
    store.isSlideMode = false;
    const el = makeVideoEl(true);
    store.setActiveVideoElement(el as any);

    const e = spaceEvent(nonInputTarget);
    store.processGlobalShortCuts(e);

    expect(el.play).not.toHaveBeenCalled();
    expect(el.pause).not.toHaveBeenCalled();
    // viewSlide is bound to Space, so outside slide mode Space ENTERS slide mode.
    expect(store.isSlideMode).toBe(true);
  });
});
