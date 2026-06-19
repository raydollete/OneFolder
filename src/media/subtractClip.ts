/**
 * subtract-clip arg builder.
 *
 * "Subtract Clip" removes the marked middle section `[startSec, endSec]` from a video and
 * cross-fades the two surviving pieces back together in a SINGLE ffmpeg pass:
 *
 *   - clip A = `[0, startSec]`
 *   - clip B = `[endSec, end-of-stream]`
 *   - A and B are joined with a `xfade` (video) + `acrossfade` (audio) of `crossfadeSec`.
 *
 * Unlike `create-clip` (a lossless stream copy driven by `-ss`/`-to` pre-input args), the
 * trimming here is done by the filtergraph, so the args are ordinary post-`-i` args. This keeps
 * subtract-clip a normal single-invocation media job — `MediaJobService`/`FfmpegRunner` and the
 * whole renderer-side finalize flow are reused unchanged.
 *
 * Correctness notes:
 *   - `xfade.offset` is the point in clip A's timeline where the blend begins, so it MUST equal
 *     `clipA_duration − crossfadeSec` = `startSec − crossfadeSec` (NOT a hardcoded constant).
 *     This requires `startSec ≥ crossfadeSec`; the caller validates that before building args.
 *   - `setpts=PTS-STARTPTS` / `asetpts=N/SR/TB` reset each trimmed segment to start at t=0, which
 *     `xfade`/`acrossfade` require. Both segments come from the same source, so they share
 *     dimensions/pixfmt/fps and satisfy `xfade`'s same-format constraint automatically.
 *   - The whole graph is ONE argv element — `spawn()` runs without a shell, so no quoting is
 *     needed (mirrors the `normalize-audio` filtergraph in `src/main.ts`).
 */

/** Default cross-fade length, in seconds. Matches the value baked into the UI's validity check. */
export const SUBTRACT_CLIP_CROSSFADE_SEC = 1;

/**
 * Build the post-`-i` ffmpeg args for a subtract-clip job.
 *
 * @param startSec  Mark Start, in seconds (must be ≥ crossfadeSec).
 * @param endSec    Mark End, in seconds (must be > startSec).
 * @param crossfadeSec  Cross-fade duration, in seconds (default 1).
 */
export function buildSubtractClipArgs(
  startSec: number,
  endSec: number,
  crossfadeSec: number = SUBTRACT_CLIP_CROSSFADE_SEC,
): string[] {
  // Where the blend starts in clip A's timeline (clip A is `startSec` long).
  const offset = startSec - crossfadeSec;

  const filter =
    `[0:v]trim=0:${startSec},setpts=PTS-STARTPTS[va];` +
    `[0:v]trim=start=${endSec},setpts=PTS-STARTPTS[vb];` +
    `[va][vb]xfade=transition=fade:duration=${crossfadeSec}:offset=${offset}[v];` +
    `[0:a]atrim=0:${startSec},asetpts=N/SR/TB[aa];` +
    `[0:a]atrim=start=${endSec},asetpts=N/SR/TB[ab];` +
    `[aa][ab]acrossfade=d=${crossfadeSec}[a]`;

  return [
    '-filter_complex',
    filter,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'h264_nvenc',
    '-preset',
    'p7',
    '-tune',
    'hq',
    '-cq',
    '21',
    '-c:a',
    'aac',
  ];
}
