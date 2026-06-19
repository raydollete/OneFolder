---
id: TASK-121
title: 'Tests: rotate NVENC args assertion + audio copy-vs-AAC decision helper (+ functional non-MP4-legal-audio)'
investigation: INV-032
status: planned
priority: medium
blocked_by: [TASK-119, TASK-120]
date_created: 2026-06-19
date_completed:
files:
  - 'tests/media-job.test.ts'
  - 'tests/audio-args.test.ts (new — or co-located)'
---

## What

Close the test blind spot that let both flaws ship: the suite only ever feeds
H.264/AAC `.mp4` sources, so neither the libx264 divergence nor the audio-copy
incompatibility was caught at build time. Add (1) an args-assertion test that locks
in the rotate specs' NVENC + transpose args (mirroring `tests/subtract-clip.test.ts`),
(2) unit tests for the shared `audioArgsForProbe` decision helper covering all four
branches (copy / aac / `-an` / loud-error), and (3) — guarded on the bundled ffmpeg
being present — a functional test that a non-MP4-legal-audio source is rotated/
reencoded to a working AAC output, and a no-audio source produces a valid output.

## Why

`tests/subtract-clip.test.ts` already asserts subtract-clip's exact NVENC+aac argv,
which is why subtract-clip didn't drift; there is no analogous guard for rotate, and
no test exercises a Vorbis/Opus/FLAC source through a copy-audio job. Without these
tests, an encoder change could again leave rotate behind and the audio decision could
regress silently.

See [INV-032](../investigations/INV-032_MEDIUM_FRONTEND_rotate-nvenc-parity-and-probe-audio-copy-vs-aac.md)
(Blast Radius item 8).

## Implementation Steps

- [ ] 1. **Pure decision-helper unit tests** (`tests/audio-args.test.ts`, no spawn
      needed because `audioArgsForProbe` is pure). Assert:
      - `{ kind: 'codec', codecName: 'aac' }` → `['-c:a','copy']`; same for `mp3`,
        `ac3`, `eac3`, `alac`.
      - `{ kind: 'codec', codecName: 'vorbis' }` (and `opus`, `flac`, `pcm_s16le`) →
        `['-c:a','aac','-b:a','192k']`.
      - `{ kind: 'no-audio' }` → `['-an']`.
      - `{ kind: 'error', error }` → **throws** (use `expect(() => …).toThrow()`), and
        the message names the input / includes the underlying error.
      - `MP4_LEGAL_AUDIO_CODECS` contains at least aac, mp3, ac3, eac3, alac.
- [ ] 2. **Rotate spec args-assertion test** (add to `tests/media-job.test.ts`, mirroring
      `tests/subtract-clip.test.ts`). Because the rotate audio args are now runtime-built
      in the handler, assert the two layers separately:
      - The rotate spec base args (import or reconstruct the expected video-only array):
        `['-vf','transpose=1','-c:v','h264_nvenc','-preset','p7','-tune','hq','-cq','21']`
        for CW and `transpose=2` for CCW. (If `MEDIA_JOB_SPECS` is not exported, assert
        via `NVENC_H264_VIDEO_ARGS` + the transpose prefix, or export the specs for test
        visibility.)
      - Confirm neither rotate base array contains `libx264` or a static `-c:a`.
- [ ] 3. **`probeFirstAudioCodec` argv test** (extend the existing `FfmpegRunner argv
      ordering` describe in `tests/media-job.test.ts`, reusing the `/fake/ffprobe` spawn
      mock). Drive the mock to assert the probe spawns ffprobe with
      `-select_streams a:0 -show_entries stream=codec_name`. (The mock currently emits
      `close 0` with empty stdout — extend it to push a `codec_name` line on stdout so
      the `{ kind: 'codec' }` path is covered, or add a dedicated mock case.)
- [ ] 4. **Functional non-MP4-legal-audio test** (in the
      `MediaJobService functional encode + place` describe, guarded by
      `FFMPEG_AVAILABLE`). Generate a source with non-MP4-legal audio (e.g.
      `ffmpeg -f lavfi -i testsrc -f lavfi -i sine -c:v libx264 -c:a libvorbis out.webm`,
      or FLAC into a mkv) using the bundled ffmpeg, run a rotate/reencode job through the
      handler-equivalent path (probe → decide → encode), then ffprobe the OUTPUT's
      `a:0 codec_name` and assert it is `aac`. Also generate a video-only (`-an`) source
      and assert the job succeeds and the output has no audio stream.
- [ ] 5. **Run:** `yarn test` — all new and existing tests pass. (`tests/subtract-clip.test.ts`
      must still pass unchanged, confirming TASK-119's refactor was byte-for-byte.)

## Done When

- [ ] `audioArgsForProbe` unit tests cover copy / aac / `-an` / throw and pass.
- [ ] A rotate args-assertion test locks in NVENC + transpose (CW and CCW) and rejects
      libx264 / static `-c:a`.
- [ ] `probeFirstAudioCodec` is exercised with the `a:0 codec_name` argv via the spawn mock.
- [ ] When the bundled ffmpeg is present, a non-MP4-legal-audio source yields an `aac`
      output and a no-audio source yields a valid no-audio output; both via the functional
      test. (Skipped cleanly when ffmpeg is absent, matching the existing pattern.)
- [ ] `yarn test` passes with no regressions to existing media-job / subtract-clip tests.
