---
id: TASK-122
title: 'Docs + manual QA: rotate NVENC parity and probe-driven copy-vs-AAC audio'
investigation: INV-032
status: pending_qa
priority: medium
blocked_by: [TASK-119, TASK-120]
date_created: 2026-06-19
date_completed:
files:
  - 'docs/rotate-video.md'
  - 'docs/reencode-x264.md'
  - 'docs/TOOLS.md'
  - 'docs/index.md'
---

## What

Update the tool documentation to reflect (1) rotate now uses NVENC (not libx264) and
(2) the three copy-audio jobs (rotate-cw, rotate-ccw, reencode-x264) now make a
deterministic up-front ffprobe-driven copy-vs-AAC audio decision. Record a manual QA
matrix that verifies both behaviors in the running app, including the previously-failing
non-MP4-legal-audio case and the no-audio case.

## Why

The docs currently describe rotate as `-c:v libx264 -c:a copy` and reencode as
`-c:a copy`, which are both stale/incorrect after TASK-119/TASK-120. The non-MP4-legal
audio behavior is a real runtime change that only the running app can fully verify
(NVENC requires the GPU; container muxing requires real ffmpeg).

See [INV-032](../investigations/INV-032_MEDIUM_FRONTEND_rotate-nvenc-parity-and-probe-audio-copy-vs-aac.md)
(Directive 1 + 2; Blast Radius items 9, 10).

## Implementation Steps

### Docs

- [x] 1. **`docs/rotate-video.md`** — in "ffmpeg Commands", change `-c:v libx264` to the
      NVENC block `-c:v h264_nvenc -preset p7 -tune hq -cq 21` for both CW and CCW, and
      replace the static `-c:a copy` with a description of the runtime audio decision.
      Update the argument table, the "Video is re-encoded" limitation (NVENC, requires
      NVIDIA GPU, no software fallback — fails loudly), and **replace** the
      "`-c:a copy` into forced `.mp4` can fail" limitation with the new behavior:
      MP4-legal → copy; otherwise → AAC 192k; no audio → omitted; probe failure on a
      should-have-audio source → loud error. Update the QA-matrix audio-incompatible
      row accordingly.
- [x] 2. **`docs/reencode-x264.md`** — change the ffmpeg command from `-c:a copy` to the
      runtime audio decision; add a short "Audio handling" subsection mirroring rotate
      (copy / AAC 192k / `-an` / loud probe-failure). The video command is already NVENC
      in the spec but the doc still shows `-c:v libx264` at line 57/65 — correct it to
      NVENC to match `src/main.ts:41`.
- [x] 3. **`docs/TOOLS.md`** — update **Worked Example 5** (lines ~348–379, currently says
      `-c:v libx264 -c:a copy`) to NVENC + runtime audio decision. Add/extend the
      encoder/audio rule: video tools use the shared `NVENC_H264_VIDEO_ARGS`; copy-audio
      tools route audio through the shared `decideAudioArgs` probe; note `subtract-clip`
      and `normalize-audio` already re-encode audio and are not probed. Note the
      `create-clip` (`-c copy`) sibling defect as a known, broader, out-of-scope issue
      for a future investigation.
- [x] 4. **`docs/index.md`** — update line ~49 (rotate summary) from
      `-c:v libx264 -c:a copy` to NVENC + the audio note.
- [x] 5. **Confirm out-of-scope safety claims in docs:** explicitly state that
      `subtract-clip` forces `-c:a aac` (acrossfade) and `normalize-audio` re-encodes via
      `-af …,loudnorm`, so both are already MP4-safe and intentionally not probed.

### QA (REQUIRES MANUAL EXECUTION — run `yarn dev` + `yarn start`)

- [ ] 6. REQUIRES MANUAL EXECUTION — Rotate CW on an `.mp4` (H.264 + AAC). Verify the
      output's video codec is `h264` from NVENC (ffprobe the output; encoder = NVENC),
      the rotation direction is clockwise, and the audio is `-c:a copy` (codec unchanged,
      instant). Capture ffprobe output / screenshot.
- [ ] 7. REQUIRES MANUAL EXECUTION — Rotate CCW on a fresh source; verify counterclockwise
      and the same NVENC/audio-copy behavior.
- [ ] 8. REQUIRES MANUAL EXECUTION — Non-MP4-legal audio: rotate a `.webm`/`.ogg` with
      Vorbis (or a FLAC/PCM source). Verify the job now SUCCEEDS (previously failed), the
      output is a playable `.mp4`, and the output audio codec is `aac` (~192k). Capture
      ffprobe output.
- [ ] 9. REQUIRES MANUAL EXECUTION — No-audio source: rotate a video with no audio stream.
      Verify the job succeeds with no error and the output has no audio stream.
- [ ] 10. REQUIRES MANUAL EXECUTION — Re-encode (x264) on a non-MP4-legal-audio source:
      verify the same copy→AAC behavior (shared helper) and NVENC video.
- [ ] 11. REQUIRES MANUAL EXECUTION — Probe-failure / loud-fail path: on a machine without
      NVENC, verify rotate fails loudly via `MediaJobErrorAlert` (no silent libx264
      fallback). If reproducible, also verify a should-have-audio source whose probe fails
      surfaces a loud error rather than silently proceeding. Capture the error modal.
- [ ] 12. REQUIRES MANUAL EXECUTION — Regression: confirm tag-copy, delete-original prompt
      (Keep Modified / Keep Original / Keep Both), in-place viewer swap, cancel, and
      quit-mid-job all still behave as in INV-030.

## Done When

- [x] `docs/rotate-video.md`, `docs/reencode-x264.md`, `docs/TOOLS.md`, and `docs/index.md`
      describe NVENC for rotate and the probe-driven copy/AAC/`-an`/loud-fail audio
      behavior for all three copy-audio jobs, and confirm subtract-clip/normalize-audio
      are already safe and create-clip is a noted sibling.
- [x] No doc still claims rotate uses `libx264` or that any of the three jobs
      unconditionally `-c:a copy`.
- [ ] The manual QA steps above are executed in the running app with evidence (ffprobe
      output / screenshots) attached or linked here. (Per QA-DISCIPLINE.md, automated
      agents may not tick the REQUIRES MANUAL EXECUTION boxes; this investigation may not
      be promoted to pending_qa until at least one QA step has produced concrete evidence.)
