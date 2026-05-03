import { MediaReleaseCoordinator, decodeVideoSrcToPath } from '../src/frontend/image/MediaReleaseCoordinator';
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
  // Path normalization — case-insensitive matching on Windows paths
  // -------------------------------------------------------------------------

  it('matches paths case-insensitively', async () => {
    const el = makeMockVideo();
    coordinator.register('C:\\Videos\\Clip.mp4', el);

    // Different case + forward slashes
    await coordinator.releasePaths(['C:/videos/clip.mp4'], { timeoutMs: 0 });
    expect(el.pause).toHaveBeenCalledTimes(1);
  });
});
