---
id: TASK-093
title: 'Widen the media-job runner to accept pre-`-i` ffmpeg args, add the `create-clip` job type with validated start/end times threaded through IPC, and add HH:MM:SS time helpers'
investigation: INV-022
status: done
priority: medium
blocked_by: []
date_created: 2026-06-12
date_completed: 2026-06-13
files:
  - 'src/ReEncodeManager.ts (add optional preInputArgs slot before -i)'
  - 'src/ipc/messages.ts (add create-clip to MediaJobType; extend StartMediaJobMessage with clip params)'
  - 'src/ipc/renderer.ts (forward optional clip params from startMediaJob)'
  - 'src/main.ts (MEDIA_JOB_SPECS create-clip entry; validate + build preInputArgs in onStartMediaJob)'
  - 'common/fmt.ts (parseHmsToSeconds / formatSecondsToHms helpers)'
  - 'tests/re-encode-manager.test.ts (preInputArgs ordering case)'
---

## What

Extend the existing main-process media-job plumbing so it can run a stream-copy
clip trim. Three coupled changes plus a shared helper:

1. Give `ReEncodeManager` an optional `preInputArgs: string[]` (default `[]`) that
   is inserted BEFORE `-i` in the ffmpeg argv (required so `-ss [start] -to [end]`
   come before the input for correct stream-copy seeking).
2. Add a `create-clip` `MediaJobType`, thread the clip's `HH:MM:SS` start/end
   through the `START_MEDIA_JOB` payload, and in `src/main.ts` validate them and
   turn them into `preInputArgs = ['-ss', start, '-to', end]` with a static spec of
   `{ args: ['-c', 'copy'], outputExt: 'mp4' }`.
3. Add `parseHmsToSeconds` / `formatSecondsToHms` to `common/fmt.ts` for validation
   here and reuse by the renderer (TASK-094).

This is pure backend/plumbing; no UI. The two existing jobs (reencode-x264,
normalize-audio) must be completely unaffected (they pass no `preInputArgs` and no
clip params).

## Why

The media-job runner hard-codes the argv as `[-hide_banner, -i, inputPath,
...jobArgs, -progress, …]`, which has no slot for args before `-i`; and job specs
are static, with no way to carry per-click user times. A lossless trim needs both.

See [INV-022](../investigations/INV-022_MEDIUM_FRONTEND_mark-in-out-create-clip-video-tool.md)
(root cause items 1-2; blast radius items 1-4).

## Implementation Steps

- [x] 1. `common/fmt.ts`: add `export function parseHmsToSeconds(s: string): number
      | null` — accepts `HH:MM:SS` (HH ≥ 0, 2+ digits ok; MM and SS each 0–59);
      returns total seconds, or `null` when malformed/empty. Add `export function
      formatSecondsToHms(sec: number): string` — zero-pads to `HH:MM:SS`, clamps
      negatives/NaN to `00:00:00`, floors fractional seconds. Keep these pure (no
      imports) so both main and renderer can use them.
- [x] 2. `src/ReEncodeManager.ts`: change `start(inputPath, jobArgs, outputExt,
      callbacks)` to `start(inputPath, jobArgs, outputExt, callbacks, preInputArgs:
      string[] = [])`, and thread `preInputArgs` into `_runJob(...)`. In `_runJob`,
      build the argv as `['-hide_banner', ...preInputArgs, '-i', inputPath,
      ...jobArgs, '-progress', 'pipe:1', '-nostats', '-y', outputPath]`. Update the
      `_runJob` signature/JSDoc accordingly. Do NOT change progress parsing,
      cancel, killAll, or _probeDuration (it still probes the SOURCE — clip percent
      against source duration is accepted per INV-022 Risks).
- [x] 3. `src/ipc/messages.ts`: add `'create-clip'` to the `MediaJobType` union.
      Extend `StartMediaJobMessage` to `{ inputPath: string; jobType: MediaJobType;
      clip?: { start: string; end: string } }` (optional; only populated for
      create-clip). Add a short doc comment that `clip` is required iff
      `jobType === 'create-clip'`.
- [x] 4. `src/ipc/renderer.ts`: update `startMediaJob` to forward the optional clip
      params. Minimal-diff form: `static startMediaJob = (jobType: MediaJobType,
      inputPath: string, clip?: { start: string; end: string }):
      Promise<MediaJobResult> => ipcRenderer.invoke(START_MEDIA_JOB, { inputPath,
      jobType, clip } as StartMediaJobMessage);`. Existing 2-arg callers
      (reencode-x264, normalize-audio) keep working (clip is undefined).
- [x] 5. `src/main.ts`: add to `MEDIA_JOB_SPECS` an entry `'create-clip': { args:
      ['-c', 'copy'], outputExt: 'mp4' }`.
- [x] 6. `src/main.ts` `onStartMediaJob` handler: destructure `clip` from the
      message. When `jobType === 'create-clip'`: reject the promise with a clear
      Error if `clip` is missing, if `parseHmsToSeconds(clip.start)` or
      `parseHmsToSeconds(clip.end)` is `null`, or if start ≥ end. Otherwise compute
      `preInputArgs = ['-ss', clip.start, '-to', clip.end]` and pass it as the new
      5th arg to `reEncodeManager.start(inputPath, spec.args, spec.outputExt, {…},
      preInputArgs)`. For all other job types pass no `preInputArgs` (or `[]`),
      preserving current behavior. Import the fmt helpers in main.
- [x] 7. `tests/re-encode-manager.test.ts`: add a case that starts a job with
      `preInputArgs = ['-ss', '00:00:01', '-to', '00:00:02']` and asserts the
      spawned argv places `-ss`/`-to` BEFORE `-i` and `-c copy` after, and that a
      call with no `preInputArgs` produces the unchanged legacy argv. Follow the
      suite's existing ffmpeg-path-override / spawn-mock pattern.

## Done When

- [x] `ReEncodeManager.start(...)` accepts an optional `preInputArgs` that lands
      before `-i`; calling it without that arg yields the byte-for-byte same argv as
      before (verified by the existing + new test cases; `yarn test` passes).
- [x] `MediaJobType` includes `'create-clip'`; `StartMediaJobMessage` carries the
      optional `clip` params; `RendererMessenger.startMediaJob` forwards them while
      the existing 2-arg call sites still compile and behave identically.
- [x] `src/main.ts` runs `create-clip` as `ffmpeg -hide_banner -ss <start> -to
      <end> -i <src> -c copy -progress pipe:1 -nostats -y <dst>` and rejects with a
      clear error on missing/malformed times or start ≥ end.
- [x] `parseHmsToSeconds` / `formatSecondsToHms` exist in `common/fmt.ts`, are pure,
      and round-trip valid `HH:MM:SS` values; `parseHmsToSeconds` returns `null` for
      malformed input.
- [ ] `yarn build` and `yarn test` pass; no existing IPC channel signature or job
      behavior changed for reencode-x264 / normalize-audio. (`yarn test` passes: 100/100;
      `yarn build` deferred per parent-run instructions — will be batched at the end.)
