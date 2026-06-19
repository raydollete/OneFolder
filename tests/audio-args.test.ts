/**
 * Unit tests for the shared audio-args decision helper (src/media/audioArgs.ts).
 *
 * These tests cover the pure `audioArgsForProbe` mapper and the `MP4_LEGAL_AUDIO_CODECS` set.
 * No ffprobe spawning — `audioArgsForProbe` is pure, so every branch is exercised without the
 * real binary. (Tests for the async `decideAudioArgs` / `probeFirstAudioCodec` argv are in
 * tests/media-job.test.ts which has the spawn mock infrastructure.)
 */

import {
  audioArgsForProbe,
  MP4_LEGAL_AUDIO_CODECS,
  NVENC_H264_VIDEO_ARGS,
} from '../src/media/audioArgs';
import type { AudioProbeResult } from '../src/media/FfmpegRunner';

// ---------------------------------------------------------------------------
// MP4_LEGAL_AUDIO_CODECS — allowlist membership
// ---------------------------------------------------------------------------

describe('MP4_LEGAL_AUDIO_CODECS', () => {
  it('contains the required minimum set: aac, mp3, ac3, eac3, alac', () => {
    expect(MP4_LEGAL_AUDIO_CODECS.has('aac')).toBe(true);
    expect(MP4_LEGAL_AUDIO_CODECS.has('mp3')).toBe(true);
    expect(MP4_LEGAL_AUDIO_CODECS.has('ac3')).toBe(true);
    expect(MP4_LEGAL_AUDIO_CODECS.has('eac3')).toBe(true);
    expect(MP4_LEGAL_AUDIO_CODECS.has('alac')).toBe(true);
  });

  it('does not contain non-MP4-legal codecs: vorbis, opus, flac, pcm_s16le', () => {
    expect(MP4_LEGAL_AUDIO_CODECS.has('vorbis')).toBe(false);
    expect(MP4_LEGAL_AUDIO_CODECS.has('opus')).toBe(false);
    expect(MP4_LEGAL_AUDIO_CODECS.has('flac')).toBe(false);
    expect(MP4_LEGAL_AUDIO_CODECS.has('pcm_s16le')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NVENC_H264_VIDEO_ARGS — constant shape
// ---------------------------------------------------------------------------

describe('NVENC_H264_VIDEO_ARGS', () => {
  it('contains the expected NVENC H.264 flags in order', () => {
    expect(NVENC_H264_VIDEO_ARGS).toEqual([
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p7',
      '-tune',
      'hq',
      '-cq',
      '21',
    ]);
  });

  it('does not contain any libx264 reference', () => {
    expect(NVENC_H264_VIDEO_ARGS).not.toContain('libx264');
  });
});

// ---------------------------------------------------------------------------
// audioArgsForProbe — pure mapper for all four branches
// ---------------------------------------------------------------------------

describe('audioArgsForProbe', () => {
  // --- MP4-legal codecs → -c:a copy ---

  it('returns [-c:a, copy] for aac (MP4-legal)', () => {
    const result: AudioProbeResult = { kind: 'codec', codecName: 'aac' };
    expect(audioArgsForProbe(result)).toEqual(['-c:a', 'copy']);
  });

  it('returns [-c:a, copy] for mp3 (MP4-legal)', () => {
    const result: AudioProbeResult = { kind: 'codec', codecName: 'mp3' };
    expect(audioArgsForProbe(result)).toEqual(['-c:a', 'copy']);
  });

  it('returns [-c:a, copy] for ac3 (MP4-legal)', () => {
    const result: AudioProbeResult = { kind: 'codec', codecName: 'ac3' };
    expect(audioArgsForProbe(result)).toEqual(['-c:a', 'copy']);
  });

  it('returns [-c:a, copy] for eac3 (MP4-legal)', () => {
    const result: AudioProbeResult = { kind: 'codec', codecName: 'eac3' };
    expect(audioArgsForProbe(result)).toEqual(['-c:a', 'copy']);
  });

  it('returns [-c:a, copy] for alac (MP4-legal)', () => {
    const result: AudioProbeResult = { kind: 'codec', codecName: 'alac' };
    expect(audioArgsForProbe(result)).toEqual(['-c:a', 'copy']);
  });

  // --- Non-MP4-legal codecs → -c:a aac -b:a 192k ---

  it('returns [-c:a, aac, -b:a, 192k] for vorbis (non-MP4-legal)', () => {
    const result: AudioProbeResult = { kind: 'codec', codecName: 'vorbis' };
    expect(audioArgsForProbe(result)).toEqual(['-c:a', 'aac', '-b:a', '192k']);
  });

  it('returns [-c:a, aac, -b:a, 192k] for opus (non-MP4-legal)', () => {
    const result: AudioProbeResult = { kind: 'codec', codecName: 'opus' };
    expect(audioArgsForProbe(result)).toEqual(['-c:a', 'aac', '-b:a', '192k']);
  });

  it('returns [-c:a, aac, -b:a, 192k] for flac (non-MP4-legal)', () => {
    const result: AudioProbeResult = { kind: 'codec', codecName: 'flac' };
    expect(audioArgsForProbe(result)).toEqual(['-c:a', 'aac', '-b:a', '192k']);
  });

  it('returns [-c:a, aac, -b:a, 192k] for pcm_s16le (non-MP4-legal)', () => {
    const result: AudioProbeResult = { kind: 'codec', codecName: 'pcm_s16le' };
    expect(audioArgsForProbe(result)).toEqual(['-c:a', 'aac', '-b:a', '192k']);
  });

  // --- No audio stream → -an ---

  it('returns [-an] for no-audio (source has no audio stream)', () => {
    const result: AudioProbeResult = { kind: 'no-audio' };
    expect(audioArgsForProbe(result)).toEqual(['-an']);
  });

  // --- Probe failure → throws (loud abort) ---

  it('throws for an error result (probe failure on should-have-audio file)', () => {
    const probeError = new Error('ffprobe exited with code 1');
    const result: AudioProbeResult = { kind: 'error', error: probeError };
    expect(() => audioArgsForProbe(result, '/path/to/source.mkv')).toThrow(
      /audio probe failed for "\/path\/to\/source\.mkv"/,
    );
  });

  it('thrown error message includes the underlying probe error message', () => {
    const probeError = new Error('ffprobe timed out after 10s');
    const result: AudioProbeResult = { kind: 'error', error: probeError };
    expect(() => audioArgsForProbe(result, '/some/file.mp4')).toThrow(
      /ffprobe timed out after 10s/,
    );
  });

  it('throws even without a provided input path (uses "<unknown>" placeholder)', () => {
    const result: AudioProbeResult = { kind: 'error', error: new Error('spawn failure') };
    expect(() => audioArgsForProbe(result)).toThrow(/audio probe failed for "<unknown>"/);
  });
});
