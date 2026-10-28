/**
 * Tests for the pure playability derivation (change: support-mov-playback).
 *
 * `derivePlayability` is a zero-import pure function over STORED codec names:
 *  - playable   — first video stream H.264, audio absent or Chromium-decodable
 *  - unplayable — any other non-empty codec string
 *  - unprobed   — null/undefined codec: never presented as unplayable
 *                 (fail-loud invariant INV-032 mirror); decided FIRST, even
 *                 when the container is unplayable
 *  - container  — `formatName` containing 'mpegts' → unplayable regardless of
 *                 codec strings (change: support-mkv-ts-playback)
 *
 * Codec comparison is case-insensitive: ffprobe output casing is not stable
 * across builds.
 */

import { derivePlayability } from '../src/frontend/image/playability';

// ---------------------------------------------------------------------------
// 1. Table-driven verdicts
// ---------------------------------------------------------------------------

describe('derivePlayability', () => {
  type Case = [name: string, videoCodec: string | null | undefined, audioCodec: string | null | undefined, expected: 'playable' | 'unplayable' | 'unprobed', formatName?: string | null];

  const cases: Case[] = [
    // Playable: H.264 video with no audio, or a Chromium-decodable audio codec.
    ['h264 + aac', 'h264', 'aac', 'playable'],
    ['h264 + null (no audio stream)', 'h264', null, 'playable'],
    ['h264 + undefined (no audio stream)', 'h264', undefined, 'playable'],
    ['h264 + mp3', 'h264', 'mp3', 'playable'],
    ['h264 + opus', 'h264', 'opus', 'playable'],
    ['h264 + vorbis', 'h264', 'vorbis', 'playable'],

    // Unplayable: every other codec string, on either stream.
    ['hevc + aac', 'hevc', 'aac', 'unplayable'],
    ['prores + aac', 'prores', 'aac', 'unplayable'],
    ['h264 + pcm_s16le', 'h264', 'pcm_s16le', 'unplayable'],
    ['h264 + ac-3', 'h264', 'ac-3', 'unplayable'],
    ['h264 + flac (unknown to the allowlist)', 'h264', 'flac', 'unplayable'],

    // Unprobed: probe pending / probe errored — NEVER a verdict for the user.
    ['null + null (probe-error/absent)', null, null, 'unprobed'],
    ['undefined + undefined (probe-error/absent)', undefined, undefined, 'unprobed'],
    ['null + aac (probe-error/absent)', null, 'aac', 'unprobed'],

    // Unprobed wins over the container rule: an unprobed .ts is never badged.
    ['null codec + mpegts container (unprobed .ts)', null, null, 'unprobed', 'mpegts'],
    ['undefined codec + mpegts container (unprobed .ts)', undefined, 'aac', 'unprobed', 'mpegts'],
    ['blank codec + mpegts container', '  ', 'aac', 'unprobed', 'mpegts'],

    // MPEG-TS container: unplayable regardless of codec strings.
    ['mpegts + h264 + aac', 'h264', 'aac', 'unplayable', 'mpegts'],
    ['mpegts + h264 + no audio', 'h264', null, 'unplayable', 'mpegts'],
    ['mpegts + hevc + aac', 'hevc', 'aac', 'unplayable', 'mpegts'],

    // Matroska/WebM container: codec table decides (H.264 plays natively).
    ['matroska,webm + h264 + aac', 'h264', 'aac', 'playable', 'matroska,webm'],
    ['matroska,webm + h264 + no audio', 'h264', undefined, 'playable', 'matroska,webm'],
    ['matroska,webm + hevc + aac', 'hevc', 'aac', 'unplayable', 'matroska,webm'],

    // Explicit null/undefined formatName: container imposes no constraint.
    ['null formatName + h264 + aac', 'h264', 'aac', 'playable', null],
    ['undefined formatName + h264 + aac', 'h264', 'aac', 'playable', undefined],
    ['null formatName + hevc + aac', 'hevc', 'aac', 'unplayable', null],
    ['mov,mp4,m4a container + h264 + aac', 'h264', 'aac', 'playable', 'mov,mp4,m4a,3gp,3g2,mj2'],
    // Operator defect 2026-10-27: VP9 clips played but were badged
    // 'VP9 — not playable here'. Chromium decodes VP8/VP9/AV1 natively —
    // these are WebM's own codecs; badge-free.
    ['matroska,webm + vp9 + opus', 'vp9', 'opus', 'playable', 'matroska,webm'],
    ['matroska,webm + vp8 + vorbis', 'vp8', 'vorbis', 'playable', 'matroska,webm'],
    ['webm + vp9 + no audio', 'vp9', null, 'playable', 'webm'],
    ['mov,mp4 + av1 + opus', 'av1', 'opus', 'playable', 'mov,mp4,m4a,3gp,3g2,mj2'],
    ['vp9 + pcm_s16le', 'vp9', 'pcm_s16le', 'unplayable', 'matroska,webm'],
    ['mpegts + vp9 + opus (container rule still wins)', 'vp9', 'opus', 'unplayable', 'mpegts'],
    ['vp6 (unknown codec)', 'vp6', 'vorbis', 'unplayable', 'matroska,webm'],
  ];

  // Rest-parameter callback: declaring a 5th positional param would make
  // Jest append its `done` callback to the 4-element rows as `formatName`.
  it.each(cases)('%s', (...args) => {
    const [_name, videoCodec, audioCodec, expected, formatName] = args;
    expect(derivePlayability(videoCodec, audioCodec, formatName)).toBe(expected);
  });

  // -------------------------------------------------------------------------
  // 2. Case robustness
  // -------------------------------------------------------------------------

  it.each([
    ['H264 + null', 'H264', null, 'playable'],
    ['H264 + AAC', 'H264', 'AAC', 'playable'],
    ['HEVC + aac', 'HEVC', 'aac', 'unplayable'],
  ] as Case[])('%s', (_name, videoCodec, audioCodec, expected) => {
    expect(derivePlayability(videoCodec, audioCodec)).toBe(expected);
  });

  // -------------------------------------------------------------------------
  // 3. Absent codec never renders as unplayable (INV-032 mirror)
  // -------------------------------------------------------------------------

  it.each([[undefined, undefined], [null, null], [undefined, 'aac'], [null, 'pcm_s16le']] as const)(
    'videoCodec=%s audioCodec=%s is never unplayable',
    (videoCodec, audioCodec) => {
      expect(derivePlayability(videoCodec, audioCodec)).not.toBe('unplayable');
    },
  );

  // -------------------------------------------------------------------------
  // 4. Container-rule robustness (change: support-mkv-ts-playback)
  // -------------------------------------------------------------------------

  it('container match is case-insensitive (ffprobe casing is not stable)', () => {
    expect(derivePlayability('h264', 'aac', 'MPEGTS')).toBe('unplayable');
    expect(derivePlayability('h264', 'aac', ' MpegTS ')).toBe('unplayable');
  });

  it('blank formatName falls through to the codec table', () => {
    expect(derivePlayability('h264', 'aac', '')).toBe('playable');
    expect(derivePlayability('hevc', 'aac', '')).toBe('unplayable');
  });

  it('never reads an extension or filename: same codecs, verdicts identical across containers', () => {
    // The only lever is the formatName string; h264+aac stays playable in
    // every non-mpegts container, including ones named like video files.
    expect(derivePlayability('h264', 'aac', 'matroska')).toBe('playable');
    expect(derivePlayability('h264', 'aac', 'webm')).toBe('playable');
    expect(derivePlayability('h264', 'aac', 'mpegts,foo')).toBe('unplayable');
    expect(derivePlayability('h264', 'aac', 'foo-mpegts-bar')).toBe('unplayable');
  });
});
