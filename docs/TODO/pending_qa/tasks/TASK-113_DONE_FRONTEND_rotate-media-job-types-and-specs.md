---
id: TASK-113
title: 'Add rotate-cw / rotate-ccw MediaJobType + MEDIA_JOB_SPECS entries'
investigation: INV-030
status: DONE
priority: medium
blocked_by: []
date_created: 2026-06-19
date_completed: 2026-06-19
files:
  - 'src/ipc/messages.ts'
  - 'src/main.ts'
---

## What

Add two new job types, `'rotate-cw'` and `'rotate-ccw'`, to the `MediaJobType`
union and to the `MEDIA_JOB_SPECS` map. Rotate CW uses ffmpeg `-vf transpose=1`
(90° clockwise) and Rotate CCW uses `-vf transpose=2` (90° counterclockwise);
both re-encode video with `libx264`, stream-copy audio, and output `.mp4`. Verify
the existing `onStartMediaJob` handler runs them via its default path with no new
branch.

## Why

The media-job stack is already generalized (Re-encode, Normalize Audio, Create
Clip, Subtract Clip). A rotate tool that emits a sibling file needs only a static
spec entry — no per-invocation args, no `clip` payload, no handler validation.

See [INV-030](../investigations/INV-030_MEDIUM_FRONTEND_rotate-cw-ccw-video-tools.md).

## Implementation Steps

- [x] 1. In `src/ipc/messages.ts`, widen the `MediaJobType` union (currently
      `'reencode-x264' | 'normalize-audio' | 'create-clip' | 'subtract-clip'`) to
      also include `'rotate-cw'` and `'rotate-ccw'`. This is the single source of
      truth; the `Record<MediaJobType, …>` typing of `MEDIA_JOB_SPECS` will then
      force the spec entries to exist (compile guard).
- [x] 2. In `src/main.ts`, add two entries to `MEDIA_JOB_SPECS`:
      ```typescript
      'rotate-cw': {
        // 90° clockwise. transpose is a video filter so the video stream MUST be
        // re-encoded (a rotated frame is a new frame); audio is stream-copied.
        args: ['-vf', 'transpose=1', '-c:v', 'libx264', '-c:a', 'copy'],
        outputExt: 'mp4',
      },
      'rotate-ccw': {
        // 90° counterclockwise (transpose=2).
        args: ['-vf', 'transpose=2', '-c:v', 'libx264', '-c:a', 'copy'],
        outputExt: 'mp4',
      },
      ```
      Place them adjacent to the other specs; ordering in the map is irrelevant.
- [x] 3. Inspect the `onStartMediaJob` handler in `src/main.ts` (around line 770).
      Confirm that for a job type it does not special-case it leaves
      `jobArgs = spec.args` and `preInputArgs` empty, and does NOT require a
      `clip` payload. The current `if (jobType === 'create-clip') … else if
      (jobType === 'subtract-clip') …` chain has no trailing `else` that rejects
      unknown types, so `rotate-cw`/`rotate-ccw` fall through correctly. Do NOT
      add a branch for the rotate types — verify only.
- [x] 4. Run `yarn build`. It must compile with no `MediaJobType`-exhaustiveness
      errors (the two spec entries satisfy the `Record` type).

## Done When

- [x] `MediaJobType` includes `'rotate-cw'` and `'rotate-ccw'`.
- [x] `MEDIA_JOB_SPECS` has matching entries with the `transpose=1` / `transpose=2`
      `-c:v libx264 -c:a copy` args and `outputExt: 'mp4'`.
- [x] `onStartMediaJob` is confirmed to run both new types through its default
      (no-clip, no-preInputArgs) path with no new branch.
- [x] `yarn build` passes.
