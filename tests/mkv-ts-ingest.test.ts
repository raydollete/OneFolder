/**
 * Tests for MKV/TS ingest recognition (change: support-mkv-ts-playback, TASK-1.1).
 *
 * 'mkv' and 'ts' must appear in the single authoritative video-extension
 * predicate (common/fs.isFileExtensionVideo) and the ingest allowlist
 * (src/api/file.IMG_EXTENSIONS), and propagate through mediaTypeMatches
 * without any duplicated list.
 *
 * The ImageLoader import below is deliberate: ts-jest type-checks the module,
 * so the exhaustive `Record<IMG_EXTENSIONS_TYPE, FormatHandlerType>` in
 * src/frontend/image/ImageLoader.ts must carry 'mkv' and 'ts' keys to compile.
 */


// These loaders/workers use `import.meta.url` (webpack-only); stub them so
// importing ImageLoader for its exhaustive-Record type-check does not drag in
// the WASM/worker modules. The mocks are hoisted above the imports by ts-jest.
jest.mock('src/frontend/image/ExrLoader', () => ({ __esModule: true, default: class {} }));
jest.mock('src/frontend/image/PSDLoader', () => ({ __esModule: true, default: class {} }));
jest.mock('src/frontend/image/HEICLoader', () => ({ __esModule: true, default: class {} }));
jest.mock('src/frontend/image/ThumbnailGeneration', () => ({
  __esModule: true,
  generateThumbnailUsingWorker: jest.fn(),
}));
import { IMG_EXTENSIONS } from '../src/api/file';
import { isFileExtensionVideo, mediaTypeMatches } from '../common/fs';
import 'src/frontend/image/ImageLoader';

describe('MKV/TS ingest allowlist', () => {
  it('IMG_EXTENSIONS includes mkv and ts beside the other video formats', () => {
    expect(IMG_EXTENSIONS).toContain('mkv');
    expect(IMG_EXTENSIONS).toContain('ts');
    expect(IMG_EXTENSIONS).toContain('mov');
    expect(IMG_EXTENSIONS).toContain('mp4');
    expect(IMG_EXTENSIONS).toContain('webm');
    expect(IMG_EXTENSIONS).toContain('ogg');
  });
});

describe('isFileExtensionVideo', () => {
  it('recognizes mkv as video', () => {
    expect(isFileExtensionVideo('mkv')).toBe(true);
  });

  it('recognizes ts as video', () => {
    expect(isFileExtensionVideo('ts')).toBe(true);
  });

  it('does not treat images as video', () => {
    expect(isFileExtensionVideo('jpg')).toBe(false);
  });
});

describe('mediaTypeMatches with mkv/ts', () => {
  it('video filter matches ts', () => {
    expect(mediaTypeMatches('video', 'ts')).toBe(true);
  });

  it('video filter matches mkv', () => {
    expect(mediaTypeMatches('video', 'mkv')).toBe(true);
  });

  it('images filter excludes mkv', () => {
    expect(mediaTypeMatches('images', 'mkv')).toBe(false);
  });

  it('images filter excludes ts', () => {
    expect(mediaTypeMatches('images', 'ts')).toBe(false);
  });

  it('all filter matches mkv and ts', () => {
    expect(mediaTypeMatches('all', 'mkv')).toBe(true);
    expect(mediaTypeMatches('all', 'ts')).toBe(true);
  });
});

describe('ExifIO video-extension pattern', () => {
  // Mirrors common/ExifIO.isVideoFile's regex without instantiating ExifIO
  // (private method, native exiftool dependency).
  const videoExtensionPattern = /\.(mp4|webm|ogg|mov|mkv|ts)$/;

  it('accepts .MKV/.TS case-insensitively via the same lowercase+pattern check', () => {
    expect('.MKV'.toLowerCase().match(videoExtensionPattern) !== null).toBe(true);
    expect('clip.MKV'.toLowerCase().match(videoExtensionPattern) !== null).toBe(true);
    expect('clip.TS'.toLowerCase().match(videoExtensionPattern) !== null).toBe(true);
  });

  it('rejects non-video extensions', () => {
    expect('photo.jpg'.toLowerCase().match(videoExtensionPattern)).toBeNull();
  });
});
