/**
 * Shared encoder-arg constants and the ffprobe-driven audio-args decision helper.
 *
 * This module is the single source of truth for two shared contracts:
 *
 *   1. NVENC_H264_VIDEO_ARGS — the project-standard H.264/NVENC video-codec block, referenced
 *      by every video-encoding job (reencode-x264, subtract-clip, rotate-cw, rotate-ccw) so
 *      they cannot drift from one another. Extracted to fix INV-032 Directive 1.
 *
 *   2. MP4_LEGAL_AUDIO_CODECS / audioArgsForProbe / decideAudioArgs — the deterministic
 *      up-front copy-vs-AAC audio decision used by the three copy-audio jobs (rotate-cw,
 *      rotate-ccw, reencode-x264). The decision is driven by a single ffprobe of the source's
 *      first audio stream so that non-MP4-legal audio (Vorbis, Opus, FLAC, PCM, …) is
 *      transparently re-encoded to AAC 192k rather than silently failing the mux. Extracted to
 *      fix INV-032 Directive 2.
 *
 * subtract-clip and normalize-audio already re-encode audio and are intentionally NOT wired here.
 */

import { FfmpegRunner, AudioProbeResult } from './FfmpegRunner';

// ---------------------------------------------------------------------------
// 1. Shared NVENC video-codec args
// ---------------------------------------------------------------------------

/**
 * Project-standard NVIDIA NVENC H.264 video-encoder block.
 *
 * -c:v h264_nvenc   NVENC H.264 encoder (requires an NVIDIA GPU + NVENC-enabled ffmpeg).
 * -preset p7        Slowest/best quality NVENC preset (p1 = fastest, p7 = slowest).
 * -tune hq          High-quality tuning mode.
 * -cq 21            Constant-quality target (lower = better; 21 is visually transparent).
 *
 * There is NO software fallback — if NVENC is unavailable the ffmpeg invocation exits non-zero
 * and the job surfaces a loud error via MediaJobErrorAlert.
 *
 * Referenced by: reencode-x264 (src/main.ts), subtract-clip (src/media/subtractClip.ts),
 * rotate-cw and rotate-ccw (src/main.ts). Any future encoder change belongs here alone.
 */
export const NVENC_H264_VIDEO_ARGS: readonly string[] = [
  '-c:v',
  'h264_nvenc',
  '-preset',
  'p7',
  '-tune',
  'hq',
  '-cq',
  '21',
];

// ---------------------------------------------------------------------------
// 2. Copy-vs-AAC audio-decision helper (INV-032 Directive 2)
// ---------------------------------------------------------------------------

/**
 * Audio codecs that can be muxed directly into an MP4 container without re-encoding.
 * Any codec NOT in this set is transparently re-encoded to AAC 192k.
 *
 * Conservative allowlist: add entries only when you are certain the codec is MP4-legal.
 * An unknown-but-actually-muxable codec is re-encoded to AAC unnecessarily (transparent,
 * very slightly lossy) — that is the safe default and preferred over a silent mux failure.
 */
export const MP4_LEGAL_AUDIO_CODECS: ReadonlySet<string> = new Set([
  'aac', // AAC-LC, AAC-HE, …  (native MP4 audio)
  'mp3', // MPEG-1/2 Audio Layer III (ISO 14496-3)
  'ac3', // Dolby Digital
  'eac3', // Dolby Digital Plus
  'alac', // Apple Lossless (ISO 14496-14)
]);

/**
 * Pure audio-args decision: given a three-state probe result, return the ffmpeg audio flags
 * to append to a copy-audio job's base args.
 *
 * - MP4-legal codec  → ['-c:a', 'copy']           (lossless pass-through, instant)
 * - Present but non-MP4-legal codec → ['-c:a', 'aac', '-b:a', '192k']  (transparent re-encode)
 * - No audio stream  → ['-an']                     (drop audio mapping; must NOT error)
 * - Probe failure    → throws (loud abort; the caller rejects the media-job promise so the
 *                      renderer shows MediaJobErrorAlert — consistent with fail-loud)
 *
 * Pure (no side-effects, no spawning) so it can be unit-tested without ffprobe.
 *
 * @param result  The AudioProbeResult from FfmpegRunner.probeFirstAudioCodec.
 * @param input   The source path, used only to build the thrown error message.
 */
export function audioArgsForProbe(result: AudioProbeResult, input = '<unknown>'): string[] {
  switch (result.kind) {
    case 'codec':
      if (MP4_LEGAL_AUDIO_CODECS.has(result.codecName)) {
        return ['-c:a', 'copy'];
      }
      return ['-c:a', 'aac', '-b:a', '192k'];

    case 'no-audio':
      return ['-an'];

    case 'error':
      throw new Error(`audio probe failed for "${input}": ${result.error.message}`);
  }
}

/**
 * Async convenience: probe `input`'s first audio stream via `runner`, then map through
 * `audioArgsForProbe`. Throws on probe failure (loud abort).
 *
 * Used in `onStartMediaJob` (src/main.ts) for rotate-cw, rotate-ccw, and reencode-x264.
 */
export async function decideAudioArgs(runner: FfmpegRunner, input: string): Promise<string[]> {
  const result = await runner.probeFirstAudioCodec(input);
  return audioArgsForProbe(result, input);
}
