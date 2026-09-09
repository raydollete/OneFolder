import {
  MediaReleaseCoordinator,
  decodeVideoSrcToPath,
} from '../src/frontend/image/MediaReleaseCoordinator';
import { encodeFilePath } from '../common/fs';

// ---------------------------------------------------------------------------
// decodeVideoSrcToPath round-trip tests
// ---------------------------------------------------------------------------

describe('decodeVideoSrcToPath', () => {
  it('round-trips a simple Windows path through encodeFilePath', () => {
    const original = 'C:/Videos/my-video.mp4';
    const encoded = encodeFilePath(original);
    expect(decodeVideoSrcToPath(encoded)).toBe(original);
  });

  it('round-trips a path with spaces', () => {
    const original = 'C:/My Videos/test video.mp4';
    const encoded = encodeFilePath(original);
    expect(decodeVideoSrcToPath(encoded)).toBe(original);
  });

  it('round-trips a path with query params (e.g. ?v=1)', () => {
    const original = 'C:/Videos/test.mp4';
    const encoded = encodeFilePath(original + '?v=1');
    // The decoded result should strip the query param and return the path
    expect(decodeVideoSrcToPath(encoded)).toBe(original);
  });

  it('returns undefined for non-file:// URLs', () => {
    expect(decodeVideoSrcToPath('https://example.com/video.mp4')).toBeUndefined();
    expect(decodeVideoSrcToPath('blob:http://localhost/abc')).toBeUndefined();
    expect(decodeVideoSrcToPath('data:video/mp4;base64,abc')).toBeUndefined();
  });

  it('handles a path with a # character', () => {
    const original = 'C:/test#folder/video.mp4';
    const encoded = encodeFilePath(original);
    expect(decodeVideoSrcToPath(encoded)).toBe(original);
  });

  // -------------------------------------------------------------------------
  // Windows WHATWG URL round-trip (Root Cause #2 regression guard)
  //
  // Chromium (and Node's WHATWG URL parser) normalizes the two-slash form
  // `file://C:/...` that encodeFilePath produces into the three-slash form
  // `file:///C:/...`.  After stripping `file://` the leftover `/C:/...`
  // caused path.normalize on Windows to insert a leading backslash.
  // This test verifies the fix strips the spurious `/` so the decoded path
  // can be matched against the registry key.
  //
  // Forward-slash Windows paths are used so that path.normalize behaves
  // consistently across Windows and POSIX runners.
  // -------------------------------------------------------------------------

  it('decodes a browser-resolved Windows file:/// URL (triple-slash form) to the correct path', () => {
    // Simulate what Chromium / WHATWG URL parser returns for el.src
    const browserResolved = 'file:///C:/Users/foo/bar.mp4';
    const decoded = decodeVideoSrcToPath(browserResolved);
    expect(decoded).toBe('C:/Users/foo/bar.mp4');
  });

  it('does not strip leading / for POSIX absolute paths (macOS/Linux safety)', () => {
    // POSIX file URL — the leading / must be preserved
    const posixUrl = 'file:///Users/foo/bar.mp4';
    const decoded = decodeVideoSrcToPath(posixUrl);
    // After stripping `file://`, pathPart is `/Users/foo/bar.mp4`.
    // The drive-letter regex does NOT match, so the `/` is kept.
    expect(decoded).toBe('/Users/foo/bar.mp4');
  });
});

// ---------------------------------------------------------------------------
// MediaReleaseCoordinator — register / unregister symmetry
// ---------------------------------------------------------------------------

/** Minimal HTMLVideoElement mock for unit testing. */
function makeMockVideo() {
  return {
    pause: jest.fn(),
    removeAttribute: jest.fn(),
    load: jest.fn(),
    src: '',
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  } as unknown as HTMLVideoElement;
}

describe('MediaReleaseCoordinator', () => {
  let coordinator: MediaReleaseCoordinator;

  beforeEach(() => {
    coordinator = new MediaReleaseCoordinator();
  });

  // -------------------------------------------------------------------------
  // register / unregister
  // -------------------------------------------------------------------------

  it('registers an element and returns a working unregister callback', async () => {
    const el = makeMockVideo();
    const unregister = coordinator.register('C:/Videos/clip.mp4', el);

    // After register: releasePaths should call pause/removeAttribute/load
    await coordinator.releasePaths(['C:/Videos/clip.mp4'], { timeoutMs: 0 });
    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(el.removeAttribute).toHaveBeenCalledWith('src');
    expect(el.load).toHaveBeenCalledTimes(1);

    // After unregister: releasePaths should NOT call pause/removeAttribute/load again
    unregister();
    const el2 = makeMockVideo();
    coordinator.register('C:/Videos/other.mp4', el2);

    await coordinator.releasePaths(['C:/Videos/clip.mp4'], { timeoutMs: 0 });
    // el was called once above, count should still be 1
    expect(el.pause).toHaveBeenCalledTimes(1);
  });

  it('handles multiple elements registered under the same path', async () => {
    const el1 = makeMockVideo();
    const el2 = makeMockVideo();
    coordinator.register('C:/Videos/clip.mp4', el1);
    coordinator.register('C:/Videos/clip.mp4', el2);

    await coordinator.releasePaths(['C:/Videos/clip.mp4'], { timeoutMs: 0 });
    expect(el1.pause).toHaveBeenCalledTimes(1);
    expect(el2.pause).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // releasePaths — order of operations
  // -------------------------------------------------------------------------

  it('calls pause, removeAttribute("src"), load in that order', async () => {
    const callOrder: string[] = [];
    const el = {
      pause: jest.fn(() => callOrder.push('pause')),
      removeAttribute: jest.fn(() => callOrder.push('removeAttribute')),
      load: jest.fn(() => callOrder.push('load')),
      src: '',
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    } as unknown as HTMLVideoElement;

    coordinator.register('C:/Videos/clip.mp4', el);
    await coordinator.releasePaths(['C:/Videos/clip.mp4'], { timeoutMs: 0 });

    expect(callOrder).toEqual(['pause', 'removeAttribute', 'load']);
  });

  // -------------------------------------------------------------------------
  // releasePaths — no-match case
  // -------------------------------------------------------------------------

  it('resolves promptly when no elements match the target paths', async () => {
    // No elements registered at all
    await expect(
      coordinator.releasePaths(['C:/Videos/nonexistent.mp4'], { timeoutMs: 0 }),
    ).resolves.toBeUndefined();
  });

  it('resolves promptly when called with an empty iterable', async () => {
    await expect(coordinator.releasePaths([], { timeoutMs: 0 })).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Path normalization — shared path-identity seam (Task 2.2)
  //
  // The coordinator routes register/release keys through
  // platform.path.normalizePathIdentity, which folds separators on every
  // desktop and folds case ONLY on Windows. The Jest runner is Linux, so the
  // default policy here is case-SENSITIVE.
  // -------------------------------------------------------------------------

  it('matches separator variants at identical case (cross-platform)', async () => {
    const el = makeMockVideo();
    coordinator.register('C:\\Videos\\clip.mp4', el);

    // Same case, different separators → must match on every platform.
    await coordinator.releasePaths(['C:/Videos/clip.mp4'], { timeoutMs: 0 });
    expect(el.pause).toHaveBeenCalledTimes(1);
  });

  it('keeps case-distinct paths DISTINCT on non-Windows (Linux case-sensitivity)', async () => {
    const el = makeMockVideo();
    coordinator.register('/videos/Clip.mp4', el);

    // Different case on a case-sensitive filesystem → must NOT match.
    await coordinator.releasePaths(['/videos/clip.mp4'], { timeoutMs: 0 });
    expect(el.pause).not.toHaveBeenCalled();

    // Same case → matches, proving the element is registered correctly.
    await coordinator.releasePaths(['/videos/Clip.mp4'], { timeoutMs: 0 });
    expect(el.pause).toHaveBeenCalledTimes(1);
  });

  it('matches case variants under the Windows policy (IS_WIN = true)', async () => {
    jest.resetModules();
    jest.doMock('common/process', () => ({
      ...jest.requireActual('common/process'),
      IS_WIN: true,
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MediaReleaseCoordinator: WinCoordinator } = require('../src/frontend/image/MediaReleaseCoordinator');
    const winCoordinator = new WinCoordinator();
    const el = makeMockVideo();
    winCoordinator.register('C:\\Videos\\Clip.mp4', el);

    // Different case + forward slashes → matches under the Windows policy.
    await winCoordinator.releasePaths(['C:/videos/clip.mp4'], { timeoutMs: 0 });
    expect(el.pause).toHaveBeenCalledTimes(1);

    jest.dontMock('common/process');
    jest.resetModules();
  });

  // -------------------------------------------------------------------------
  // WHATWG URL round-trip integration (Root Cause #2 regression guard)
  //
  // Simulates the full path: register a Windows path → Chromium resolves
  // el.src to the triple-slash form → DOM-fallback decodes and matches.
  // Uses Node's built-in URL (same WHATWG algorithm as Chromium) so the
  // test passes on both Windows and POSIX CI runners without jsdom.
  // Forward-slash Windows paths ensure path.normalize is consistent
  // across platforms.
  // -------------------------------------------------------------------------

  it('DOM-fallback matches a Windows path after WHATWG URL resolution (triple-slash form)', async () => {
    const el = makeMockVideo();
    const registeredPath = 'C:/Users/foo/bar.mp4';
    coordinator.register(registeredPath, el);

    // Simulate what <video>.src returns after the WHATWG URL parser
    // normalizes the two-slash form encodeFilePath produces:
    //   encodeFilePath('C:/Users/foo/bar.mp4') → 'file://C:/Users/foo/bar.mp4'
    //   new URL('file://C:/Users/foo/bar.mp4').href → 'file:///C:/Users/foo/bar.mp4'
    // This is the value releasePaths sees when it reads el.src from the DOM.
    const browserResolvedSrc = new URL(encodeFilePath(registeredPath)).href;
    expect(browserResolvedSrc).toBe('file:///C:/Users/foo/bar.mp4');

    // Decode and verify it round-trips back to the registered path's key
    const decoded = decodeVideoSrcToPath(browserResolvedSrc);
    if (decoded === undefined) {
      throw new Error('decodeVideoSrcToPath returned undefined for a valid file:// URL');
    }
    expect(decoded).toBe('C:/Users/foo/bar.mp4');

    // Verify releasePaths finds the registered element via the decoded path
    await coordinator.releasePaths([decoded], { timeoutMs: 0 });
    expect(el.pause).toHaveBeenCalledTimes(1);
    expect(el.removeAttribute).toHaveBeenCalledWith('src');
    expect(el.load).toHaveBeenCalledTimes(1);
  });
});
