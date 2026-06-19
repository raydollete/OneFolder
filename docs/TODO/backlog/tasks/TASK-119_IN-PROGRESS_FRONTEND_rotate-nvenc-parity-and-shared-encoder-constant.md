---
id: TASK-119
title: 'Rotate CW/CCW use NVENC; extract a single shared NVENC video-args constant'
investigation: INV-032
status: in-progress
priority: medium
blocked_by: []
date_created: 2026-06-19
date_completed:
files:
  - 'src/main.ts'
  - 'src/media/subtractClip.ts'
  - 'src/media/audioArgs.ts (new — or wherever the shared constant lands)'
---

## What

Make the `rotate-cw` / `rotate-ccw` media-job specs encode video with the
project-standard NVENC settings (`-c:v h264_nvenc -preset p7 -tune hq -cq 21`),
identical to `reencode-x264` and `subtract-clip`, while keeping `-vf transpose=1`
(CW) / `-vf transpose=2` (CCW). To prevent the drift that caused this bug, extract
the NVENC argument block into a **single shared constant** and reference it from
all four NVENC consumers (reencode, subtract-clip, rotate-cw, rotate-ccw). Remove
the static `-c:a copy` from the rotate specs — the audio args become runtime-built
in TASK-120, so after this task the rotate specs contain **video args only**.

## Why

The rotate specs cloned a stale "matches Re-encode (x264)" encoder choice and pasted
`-c:v libx264`, even though `reencode-x264` had already migrated to NVENC. The NVENC
block is now triplicated, so it can drift again. This fork has NO software fallback —
NVENC-unavailable must fail loudly, exactly like `reencode-x264`.

See [INV-032](../investigations/INV-032_MEDIUM_FRONTEND_rotate-nvenc-parity-and-probe-audio-copy-vs-aac.md)
(Directive 1; Blast Radius items 1, 3, 4).

## Implementation Steps

- [x] 1. **Add a shared NVENC constant.** Create/choose a module (recommended: a new
      `src/media/audioArgs.ts` will be created in TASK-120; you may instead add the
      video constant there, or in a small `src/media/encodeArgs.ts`). Export:
      `export const NVENC_H264_VIDEO_ARGS = ['-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-cq', '21'] as const;`
      (or a `readonly string[]`). Keep it in `src/media/` so both `src/main.ts` and
      `src/media/subtractClip.ts` can import it without a cycle.
- [x] 2. **Reference it from `reencode-x264`** (`src/main.ts:36–43`): replace the inline
      `'-c:v', 'h264_nvenc', '-preset', 'p7', '-tune', 'hq', '-cq', '21'` portion with
      `...NVENC_H264_VIDEO_ARGS`. Leave the audio portion alone for now (TASK-120 moves
      it to runtime). Behavior must be byte-for-byte identical.
- [x] 3. **Reference it from `subtract-clip`** (`src/media/subtractClip.ts:60–67`):
      replace the inline NVENC block in the returned array with `...NVENC_H264_VIDEO_ARGS`.
      Leave the trailing `'-c:a', 'aac'` (subtract-clip re-encodes audio and is out of
      scope for the audio change). The resulting array must be byte-for-byte identical to
      today (verify against `tests/subtract-clip.test.ts` which asserts the exact array).
- [x] 4. **Rewrite the rotate specs** (`src/main.ts:73–83`) to video-only NVENC:
      - `rotate-cw`:  `{ args: ['-vf', 'transpose=1', ...NVENC_H264_VIDEO_ARGS], outputExt: 'mp4' }`
      - `rotate-ccw`: `{ args: ['-vf', 'transpose=2', ...NVENC_H264_VIDEO_ARGS], outputExt: 'mp4' }`
      Remove the static `'-c:a', 'copy'` — audio args are appended at runtime in TASK-120.
      Update the spec comments to say NVENC (and that audio is decided per-invocation,
      forward-referencing TASK-120).
- [x] 5. **Confirm no software fallback** is introduced anywhere for rotate; the spec is
      NVENC-only and inherits the loud-failure behavior of `reencode-x264`.
- [ ] 6. **Build:** `yarn build` must compile (the `Record<MediaJobType, …>` typing still
      holds; rotate entries still have `args` + `outputExt`). — Deferred to batch build at end.

## Done When

- [ ] `NVENC_H264_VIDEO_ARGS` is defined once and imported by reencode, subtract-clip,
      and both rotate specs; no inline NVENC string remains at those four sites.
- [ ] `rotate-cw` args = `['-vf','transpose=1','-c:v','h264_nvenc','-preset','p7','-tune','hq','-cq','21']`
      and `rotate-ccw` args = the same with `transpose=2`; neither contains a static
      `-c:a` arg.
- [ ] `reencode-x264` and `subtract-clip` produce the exact same argv as before this task
      (verified by the existing `tests/subtract-clip.test.ts` still passing unchanged).
- [ ] No libx264 reference remains in any executable media-job spec.
- [ ] `yarn build` passes.
