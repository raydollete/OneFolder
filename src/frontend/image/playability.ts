/**
 * Pure playability derivation (change: support-mov-playback).
 *
 * The verdict is derived from STORED codec facts only — the codec names
 * ffprobe recorded on the file row. The file-extension predicate
 * (`common/fs.ts` `isFileExtensionVideo`) is a discovery trigger that decides
 * which files get probed; it is NEVER a playability test.
 *
 * A null/absent codec means the file has not been probed (probe pending, or
 * the probe errored) and MUST NEVER render as unplayable — an unknown verdict
 * is disclosed as unknown, never as a verdict (fail-loud invariant, INV-032
 * mirror).
 *
 * Deliberately dependency-free: this module is consumed by both the desktop
 * renderer and the read-only web/sidecar bundle, and must stay free of
 * platform seams so both render identical badges.
 */

export type Playability = 'playable' | 'unplayable' | 'unprobed';

/**
 * First-video-stream codecs Chromium decodes natively. H.264 was the only
 * entry until the operator observed VP9 clips playing while badged
 * 'VP9 — not playable here' (2026-10-27): VP8/VP9/AV1 are WebM's native
 * codecs — badge-free. HEVC/ProRes stay unplayable (no in-app decoder).
 */
const PLAYABLE_VIDEO_CODECS: Readonly<Record<string, true>> = {
  h264: true,
  vp8: true,
  vp9: true,
  av1: true,
};

/** First-audio-stream codecs Chromium can decode natively. */
const PLAYABLE_AUDIO_CODECS: Readonly<Record<string, true>> = {
  aac: true,
  mp3: true,
  opus: true,
  vorbis: true,
};

/**
 * Substrings that identify a container Chromium cannot play natively, no
 * matter how healthy its codec strings look. MPEG-TS (`.ts`, `.m2ts`,
 * broadcast streams) reports ffprobe `format.format_name` `mpegts`; Matroska
 * (`matroska,webm`) is NOT listed — Chromium plays H.264 inside it natively
 * (change: support-mkv-ts-playback).
 */
const UNPLAYABLE_CONTAINER_MARKERS: readonly string[] = ['mpegts'];

/**
 * True when the stored container fact is one Chromium cannot demux at all, so
 * the verdict (and its reason token) is CONTAINER-driven: name the container,
 * never a codec. Single source for the surfaces (badge tooltip, banner) AND
 * the derivation below — both read this same marker list, so the reason
 * tokens can never drift from the verdict rule.
 */
export function usesContainerReason(formatName?: string | null): boolean {
  const container = normalize(formatName);
  return (
    container !== null &&
    UNPLAYABLE_CONTAINER_MARKERS.some((marker) => container.includes(marker))
  );
}

/**
 * Derive the playability verdict for a recognized video file from its stored
 * first-video codec, first-audio codec, and container format name.
 *
 * Evaluation order is fixed:
 *  1. No probed video stream (null/undefined/blank videoCodec) → `unprobed`
 *     FIRST — never badged, even when `formatName` says `mpegts`. An unknown
 *     verdict is disclosed as unknown, never as a verdict.
 *  2. Container marker match (`formatName` containing `mpegts`) → `unplayable`
 *     regardless of codec strings.
 *  3. Otherwise the codec table: playable iff the first video stream is
 *     H.264, VP8, VP9 or AV1 AND the first audio stream is absent or
 *     Chromium-decodable (AAC, MP3, Opus, Vorbis). HEVC, ProRes, PCM, AC-3,
 *     FLAC and any other codec is unplayable.
 *
 * Consults ONLY the stored codec/container strings, never an extension or
 * filename.
 */
export function derivePlayability(
  videoCodec?: string | null,
  audioCodec?: string | null,
  formatName?: string | null,
): Playability {
  const video = normalize(videoCodec);
  if (video === null) return 'unprobed';

  if (usesContainerReason(formatName)) return 'unplayable';

  if (PLAYABLE_VIDEO_CODECS[video] !== true) return 'unplayable';

  const audio = normalize(audioCodec);
  if (audio === null) return 'playable';
  return PLAYABLE_AUDIO_CODECS[audio] === true ? 'playable' : 'unplayable';
}

/** Lower-case a codec name, folding null/undefined/blank to `null` (absent). */
function normalize(codec: string | null | undefined): string | null {
  if (codec === null || codec === undefined) return null;
  const trimmed = codec.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}
