/**
 * @jest-environment jsdom
 *
 * DOM-fallback sweep tests for MediaReleaseCoordinator (INV-014 Root Cause #2).
 *
 * These tests run in the jsdom environment so that `document.createElement`,
 * `document.body`, and `document.querySelectorAll` are available.  jsdom uses
 * the same WHATWG URL algorithm as Chromium, so setting `video.src` to a
 * two-slash file URL (`file://C:/...`) produces the three-slash resolved form
 * (`file:///C:/...`) when read back — exactly the behavior that caused the
 * Windows path-mismatch bug.
 *
 * The coordinator's DOM-fallback sweep calls `document.querySelectorAll('video[src]')`
 * and decodes each element's `.src` IDL attribute.  The fix in
 * `decodeVideoSrcToPath` (strip leading `/` before a drive letter) must allow
 * the fallback to match and release attached video elements whose src was
 * set via an `encodeFilePath`-produced URL.
 */

import { MediaReleaseCoordinator } from '../src/frontend/image/MediaReleaseCoordinator';
import { encodeFilePath } from '../common/fs';

// jsdom does not implement HTMLVideoElement.pause/load — they throw "Not implemented".
// We silence those errors via a global beforeAll and spy on the methods directly
// on each element after creation.

describe('MediaReleaseCoordinator DOM-fallback sweep (jsdom)', () => {
  afterEach(() => {
    // Clean up any <video> elements left in the document body between tests
    document.querySelectorAll('video').forEach((v) => v.remove());
  });

  it('DOM-fallback sweep finds and releases an unregistered attached Windows video element', async () => {
    const coordinator = new MediaReleaseCoordinator();

    // Use a forward-slash Windows path so path.normalize is consistent on all runners
    const original = 'C:/Users/foo/bar.mp4';

    // Create a real jsdom <video> and set its src via encodeFilePath.
    // jsdom's URL parser resolves 'file://C:/Users/foo/bar.mp4' →
    // 'file:///C:/Users/foo/bar.mp4' (triple-slash), exactly as Chromium does.
    const videoEl = document.createElement('video');
    videoEl.setAttribute('src', encodeFilePath(original));
    document.body.appendChild(videoEl);

    // Confirm jsdom resolved the src to the triple-slash form
    expect(videoEl.src).toBe('file:///C:/Users/foo/bar.mp4');

    // Spy on the HTMLVideoElement methods jsdom stubs out
    const pauseSpy = jest.spyOn(videoEl, 'pause').mockImplementation(() => undefined);
    const removeAttrSpy = jest.spyOn(videoEl, 'removeAttribute');
    const loadSpy = jest.spyOn(videoEl, 'load').mockImplementation(() => undefined);

    // The element is NOT registered with the coordinator — only the DOM-fallback
    // sweep should find and release it.
    await coordinator.releasePaths([original], { timeoutMs: 0 });

    expect(pauseSpy).toHaveBeenCalled();
    expect(removeAttrSpy).toHaveBeenCalledWith('src');
    expect(loadSpy).toHaveBeenCalled();

    document.body.removeChild(videoEl);
  });

  it('DOM-fallback sweep does not release a video with a different path', async () => {
    const coordinator = new MediaReleaseCoordinator();

    const original = 'C:/Users/foo/bar.mp4';
    const other = 'C:/Users/baz/qux.mp4';

    const videoEl = document.createElement('video');
    videoEl.setAttribute('src', encodeFilePath(other));
    document.body.appendChild(videoEl);

    const pauseSpy = jest.spyOn(videoEl, 'pause').mockImplementation(() => undefined);

    await coordinator.releasePaths([original], { timeoutMs: 0 });

    // The video's path does not match original, so it must NOT be released
    expect(pauseSpy).not.toHaveBeenCalled();

    document.body.removeChild(videoEl);
  });
});
