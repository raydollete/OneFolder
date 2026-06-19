---
id: TASK-120
title: 'Add ffprobe audio-codec probe + shared copy-vs-AAC audio-args helper; wire rotate + reencode-x264'
investigation: INV-032
status: done
priority: medium
blocked_by: [TASK-119]
date_created: 2026-06-19
date_completed: 2026-06-19
files:
  - 'src/media/FfmpegRunner.ts'
  - 'src/media/audioArgs.ts (new)'
  - 'src/main.ts'
---

## What

Add a deterministic, up-front audio-codec decision shared by the three copy-audio
jobs (`rotate-cw`, `rotate-ccw`, `reencode-x264`). Probe the source's first audio
stream `codec_name` via ffprobe and choose:

- MP4-legal codec (aac, mp3, ac3, eac3, alac, …) → `['-c:a', 'copy']` (lossless, instant).
- present but non-MP4-legal codec → `['-c:a', 'aac', '-b:a', '192k']` (transparent).
- no audio stream → `['-an']` (must NOT error).
- probe error / unparseable output on a file that should have audio → **throw** (loud
  failure, no silent fallback).

The decision lives in ONE shared helper and is appended to each job's video-only base
args at runtime in `onStartMediaJob` — so rotate moves from a fully static spec to
per-invocation arg building, exactly like `create-clip` / `subtract-clip`.

## Why

`-c:a copy` into a forced `.mp4` silently breaks when the source audio codec is not
MP4-muxable (Vorbis, Opus from old muxers, FLAC, PCM, …). The three copy-audio jobs
share this identical latent bug, so the fix must be one shared helper, not per-spec
duplication. ffprobe is already bundled (`getFfprobePath()` → `resources/ffmpeg/
ffprobe.exe`) and already spawned by `FfmpegRunner.probeDuration`, so only a new
`codec_name` probe method is needed — NOT `ffmpeg -i` text parsing. The probe must
distinguish "no audio" from "probe failed" so it does not re-introduce a silent
failure (the fork's philosophy is fail-loud).

See [INV-032](../investigations/INV-032_MEDIUM_FRONTEND_rotate-nvenc-parity-and-probe-audio-copy-vs-aac.md)
(Directive 2; Blast Radius items 1, 2, 3, 5, 6, 7).

## Implementation Steps

- [x] 1. **Add `FfmpegRunner.probeFirstAudioCodec(input)`** (`src/media/FfmpegRunner.ts`,
      next to `probeDuration`). Spawn `this.ffprobePath` with:
      `['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'default=nokey=1:noprint_wrappers=1', input]`
      (the exact argv shape already used in `tests/media-job.test.ts:222–223` for the
      video stream, with `a:0` for audio). Use the same 10 s timeout/kill pattern as
      `probeDuration`. Return a THREE-state result, e.g.:
      `Promise<{ kind: 'codec'; codecName: string } | { kind: 'no-audio' } | { kind: 'error'; error: Error }>`.
      - exit 0 + non-empty stdout → `{ kind: 'codec', codecName: <trimmed> }`.
      - exit 0 + EMPTY stdout (no a:0 stream selected) → `{ kind: 'no-audio' }`.
      - non-zero exit, spawn failure, or timeout → `{ kind: 'error', error }`.
      Do NOT collapse `error` into `no-audio` (that would re-introduce a silent
      failure). Keep `probeDuration` untouched.
- [x] 2. **Create the shared helper `src/media/audioArgs.ts`.** Export:
      - `MP4_LEGAL_AUDIO_CODECS: ReadonlySet<string>` containing at least
        `aac, mp3, ac3, eac3, alac` (extend conservatively; document that unknown
        codecs fall through to AAC re-encode — a safe default).
      - A pure mapper, e.g.
        `audioArgsForProbe(result): string[]` that, given the three-state probe result,
        returns `['-c:a','copy']` for an MP4-legal codec, `['-c:a','aac','-b:a','192k']`
        for a present-but-non-legal codec, `['-an']` for `no-audio`, and **throws** a
        descriptive `Error` for `error` (e.g. `audio probe failed for "<input>": <msg>`).
      - An async convenience, e.g.
        `async function decideAudioArgs(runner: FfmpegRunner, input: string): Promise<string[]>`
        that calls `runner.probeFirstAudioCodec(input)` then `audioArgsForProbe`.
      Keeping `audioArgsForProbe` pure makes it unit-testable without spawning ffprobe.
      (If TASK-119 placed `NVENC_H264_VIDEO_ARGS` here, keep both exports in this file.)
- [x] 3. **Wire the handler** in `onStartMediaJob` (`src/main.ts:785–907`). For
      `jobType ∈ {'rotate-cw', 'rotate-ccw', 'reencode-x264'}`, before constructing the
      job, `await decideAudioArgs(...)` for `inputPath` and set
      `jobArgs = [...spec.args, ...audioArgs]` (spec.args is video-only after TASK-119;
      for reencode-x264, also remove its static `-c:a copy` from the spec in this task so
      it flows through the helper instead). The handler already returns a `Promise`, so
      await fits its shape; surface a thrown probe error by rejecting the promise (the
      renderer then shows the existing `MediaJobErrorAlert`). Leave the `create-clip`,
      `subtract-clip`, and `normalize-audio` branches UNCHANGED — they must not be probed.
- [x] 4. **Confirm `MediaJobService` stays codec-agnostic** — it already accepts
      `jobArgs: string[]` verbatim and passes them to `FfmpegRunner.run`
      (`src/media/MediaJobService.ts:92–116, 202–215`). No change needed there; the
      probe/decision belongs in the handler (mirrors how create-clip/subtract-clip build
      args in the handler).
- [x] 5. **Confirm out-of-scope jobs are untouched:** `reencode-x264` spec no longer
      carries a static `-c:a` arg (moved to the helper); `subtract-clip`
      (`src/media/subtractClip.ts` `-c:a aac`) and `normalize-audio` (`src/main.ts`
      `-af …,loudnorm`) are not probed and not modified.
- [x] 6. **Build:** `yarn build` compiles. — Passed (34s, 1 pre-existing warning).

## Done When

- [x] `FfmpegRunner.probeFirstAudioCodec` exists and returns the three-state result
      (codec / no-audio / error) without collapsing error into no-audio.
- [x] `src/media/audioArgs.ts` exports the MP4-legal set, the pure `audioArgsForProbe`
      mapper (copy / aac / `-an` / throw), and an async `decideAudioArgs`.
- [x] `onStartMediaJob` builds runtime audio args via the shared helper for exactly the
      three copy-audio job types; rotate-cw/ccw and reencode-x264 all route through it.
- [x] No `-c:a copy` (or any static `-c:a`) remains in the rotate or reencode specs;
      subtract-clip / normalize-audio / create-clip args are unchanged.
- [x] A source with no audio stream rotates/reencodes to a valid output with no audio and
      no error; a should-have-audio source whose probe fails rejects with a loud error.
- [x] `yarn build` passes.
