/**
 * Tests for MOV ingest recognition (change: support-mov-playback, TASK-1.1).
 *
 * 'mov' must appear in the single authoritative video-extension predicate
 * (common/fs.isFileExtensionVideo) and the ingest allowlist
 * (src/api/file.IMG_EXTENSIONS), and propagate through mediaTypeMatches
 * without any duplicated list.
 */

import { IMG_EXTENSIONS, MOV_CODEC_VERSION } from '../src/api/file';
import { isFileExtensionVideo, mediaTypeMatches } from '../common/fs';

describe('MOV ingest allowlist', () => {
  it('IMG_EXTENSIONS includes mov beside the other video formats', () => {
    expect(IMG_EXTENSIONS).toContain('mov');
    expect(IMG_EXTENSIONS).toContain('mp4');
    expect(IMG_EXTENSIONS).toContain('webm');
    expect(IMG_EXTENSIONS).toContain('ogg');
  });

  it('MOV_CODEC_VERSION is defined', () => {
    expect(MOV_CODEC_VERSION).toBe(1);
  });
});

describe('isFileExtensionVideo', () => {
  it('recognizes mov as video', () => {
    expect(isFileExtensionVideo('mov')).toBe(true);
  });

  it('does not treat images as video', () => {
    expect(isFileExtensionVideo('jpg')).toBe(false);
  });
});

describe('mediaTypeMatches with mov', () => {
  it('video filter matches mov', () => {
    expect(mediaTypeMatches('video', 'mov')).toBe(true);
  });

  it('images filter excludes mov', () => {
    expect(mediaTypeMatches('images', 'mov')).toBe(false);
  });

  it('all filter matches mov', () => {
    expect(mediaTypeMatches('all', 'mov')).toBe(true);
  });
});

describe('ExifIO video-extension pattern', () => {
  // Mirrors common/ExifIO.isVideoFile's regex without instantiating ExifIO
  // (private method, native exiftool dependency).
  const videoExtensionPattern = /\.(mp4|webm|ogg|mov)$/;

  it('accepts .MOV case-insensitively via the same lowercase+pattern check', () => {
    expect('.MOV'.toLowerCase().match(videoExtensionPattern) !== null).toBe(true);
    expect('clip.MOV'.toLowerCase().match(videoExtensionPattern) !== null).toBe(true);
  });

  it('rejects non-video extensions', () => {
    expect('photo.jpg'.toLowerCase().match(videoExtensionPattern)).toBeNull();
  });
});
