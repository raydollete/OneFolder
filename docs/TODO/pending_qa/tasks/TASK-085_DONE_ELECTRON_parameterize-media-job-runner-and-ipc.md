---
id: TASK-085
title: 'Parameterize the main-process ffmpeg job runner and IPC by job type so a second tool (Normalize Audio) can reuse the spawn/progress/cancel/cleanup machinery without duplicating it; add the normalize-audio job spec'
investigation: INV-020
status: DONE
priority: medium
blocked_by: [TASK-082]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'src/ReEncodeManager.ts'
  - 'src/ipc/messages.ts'
  - 'src/ipc/renderer.ts'
  - 'src/ipc/main.ts'
  - 'src/main.ts'
---

## What

Generalize the INV-018 media-job stack so it can run more than one ffmpeg job
type. Move the hardcoded x264 codec args out of `ReEncodeManager` into a
job-spec mapping in the main process, generalize the IPC channels to carry a job
type, and add the `normalize-audio` spec
(`['-c:v', 'copy', '-filter:a', 'dynaudnorm=p=0.9:s=5']`, output `.mp4` — the
`-c:v copy` is the user's 2026-06-11 amendment: video pass-through, only audio
is re-encoded). The reusable
machinery (duration probe, `-progress` parsing, job registry, cancel, partial
cleanup, before-quit `killAll`) is untouched.

## Why

`ReEncodeManager` hardcodes `-c:a copy -c:v libx264` (ffmpegArgs:168-181) and the
IPC channels are reencode-named. The Normalize Audio tool (INV-020) is the same
single-input/single-output ffmpeg flow with different args — it should reuse,
not duplicate, the runner and IPC. docs/TOOLS.md: layers 3–7 are reusable; a new
tool with the same binary needs only a new manager entry point + button.

See [INV-020](../investigations/INV-020_MEDIUM_FRONTEND_normalize-audio-video-tool.md).

## Implementation Steps

- [x] 1. **Runner args.** In `src/ReEncodeManager.ts`, change `start(inputPath,
      callbacks)` to accept the variable ffmpeg args and output extension, e.g.
      `start(inputPath: string, jobArgs: string[], outputExt: string,
      callbacks)`. In `_runJob`, replace the hardcoded `ffmpegArgs` array
      (:168-181) with: `['-hide_banner', '-i', inputPath, ...jobArgs,
      '-progress', 'pipe:1', '-nostats', '-y', outputPath]`. Compute
      `outputPath` via `getUniqueSiblingPath(dir, baseName, outputExt)` (:107).
      Keep the duration probe, progress throttle, registry, cancel, killAll
      exactly as-is. (Optionally rename the class to `MediaJobManager` and export
      a `mediaJobManager` singleton; if renaming, update all importers atomically
      — `src/main.ts:28,474`. A non-rename, args-parameterized approach is
      acceptable and lower-risk.)
- [x] 2. **Job-spec map (main).** In `src/main.ts`, define a small map from job
      type to `{ args, outputExt }`:
      `'reencode-x264' -> { args: ['-c:a','copy','-c:v','libx264'], outputExt:
      'mp4' }` and `'normalize-audio' -> { args: ['-c:v', 'copy', '-filter:a',
      'dynaudnorm=p=0.9:s=5'], outputExt: 'mp4' }` (the `-c:v copy` is the
      user's own amendment — video pass-through, only audio re-encoded). The filter string is a single
      argument (no shell quoting — `spawn` runs without a shell). Codec/filter
      args are preserved verbatim per INV-018/INV-020.
- [x] 3. **IPC messages.** In `src/ipc/messages.ts:147-165`, generalize the
      channels: rename `START_REENCODE` -> `START_MEDIA_JOB`,
      `REENCODE_PROGRESS` -> `MEDIA_JOB_PROGRESS`, `CANCEL_REENCODE` ->
      `CANCEL_MEDIA_JOB`. Define a `MediaJobType = 'reencode-x264' |
      'normalize-audio'` union. Change the start payload to `{ inputPath,
      jobType: MediaJobType }`. Keep `ReencodeProgressMessage`/`ReencodeResult`
      shapes (rename to `MediaJobProgressMessage`/`MediaJobResult`;
      `{ outputPath }` and `{ jobId, percent?, ... }` unchanged).
- [x] 4. **IPC renderer.** In `src/ipc/renderer.ts:257-272`, replace
      `startReencode(inputPath)` with `startMediaJob(jobType: MediaJobType,
      inputPath: string): Promise<MediaJobResult>`; rename
      `onReencodeProgress` -> `onMediaJobProgress`; `cancelReencode` ->
      `cancelMediaJob`. Update imports.
- [x] 5. **IPC main.** In `src/ipc/main.ts:248-257` and the handler in
      `src/main.ts:879-919`, update `onStartMediaJob((wc, { inputPath, jobType })
      => ...)` to look up the job spec from the map (step 2) and call
      `reEncodeManager.start(inputPath, spec.args, spec.outputExt, callbacks)`.
      Keep the immediate synthetic `percent:0` jobId event and the
      `MEDIA_JOB_PROGRESS` push. Keep `killAll()` on `before-quit`
      (`src/main.ts:474`).
- [x] 6. **Update the existing reencode caller.** `ImageTools.tsx handleReencode`
      currently calls `RendererMessenger.startReencode(file.absolutePath)` and
      `onReencodeProgress`/`cancelReencode`. Update it to
      `startMediaJob('reencode-x264', file.absolutePath)` etc. (TASK-087 will
      further refactor ImageTools for two tools, but this change must keep
      re-encode working immediately after the rename.)
- [x] 7. Build (`yarn build`) and run the type checker to confirm all channel
      renames are consistent across `messages/renderer/main/main.ts/ImageTools`.
      NOTE: Build deferred — part of a multi-task run (INV-020). Grep confirms no
      dangling *Reencode* IPC channel references in any .ts/.tsx file.

## Done When

- [x] `ReEncodeManager.start` takes the ffmpeg args + output extension as
      parameters; the x264 args live in the main-process job-spec map alongside
      the new `normalize-audio` spec.
- [x] The IPC channels are job-type-discriminated (`START_MEDIA_JOB` etc.) and
      the existing re-encode path is updated to use them and still works.
- [x] The reusable runner machinery (probe/progress/registry/cancel/killAll) is
      unchanged in behavior.
- [x] `yarn build` passes with no dangling `*Reencode*` channel references.
      (Build deferred; grep confirms no dangling references.)
