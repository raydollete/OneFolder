---
id: TASK-075
title: 'Add a main-process ffmpeg re-encode job runner: collision-free output path, spawn with progress, cancel, failure/quit cleanup'
investigation: INV-018
status: done
priority: medium
blocked_by: [TASK-074]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'src/ReEncodeManager.ts (new)'
  - 'common/fs.ts (added getUniqueSiblingPath helper)'
  - 'src/main.ts (registered before-quit cleanup; imported runner)'
  - 'tests/re-encode-manager.test.ts (new, 9 tests)'
---

## What

Create a main-process module that runs the re-encode subprocess:
`ffmpeg -hide_banner -i [input] -c:a copy -c:v libx264 -progress pipe:1 -nostats [output]`.
It computes a collision-free `.mp4` output path beside the source, spawns
ffmpeg via `child_process.spawn`, streams parsed progress, supports
cancellation (kill + delete partial output), cleans up partial output on
failure, and kills all live jobs + removes their partials on app quit.

## Why

Subprocess lifecycle must live in the main process (consistent with ExifTool,
survives renderer reloads, enables before-quit cleanup). The renderer must
never spawn ffmpeg directly. This module is the engine the IPC layer (TASK-076)
and the inspector tool (TASK-078) drive.

See [INV-018](../investigations/INV-018_MEDIUM_FRONTEND_reencode-x264-video-tool.md)
(root cause items 2/7; blast radius items 3, 5, 10).

## Implementation Steps

- [x] 1. Add `getUniqueSiblingPath(dir, baseName, ext)` to `common/fs.ts`:
      returns `dir/baseName.ext` if free, else `dir/baseName 1.ext`,
      `dir/baseName 2.ext`, ... (space + integer, matching the convention cited
      in INV-018). Use `fse.existsSync` in a loop. Unit-testable pure-ish
      helper. (No existing unique-name helper was found in `common/fs.ts`.)
- [x] 2. Create the runner module (e.g. `src/ReEncodeManager.ts`). Expose:
      - `start(inputPath: string, onProgress: (p: ReencodeProgress) => void):
        Promise<{ jobId: string; outputPath: string }>` — but resolve the
        FINAL result only on success; design the API so TASK-076 can return the
        jobId immediately and deliver the final outcome via a completion
        callback/event. Concretely: `start` returns `{ jobId, outputPath }`
        synchronously-ish (after path computation) and accepts `onProgress`,
        `onDone(result)`, `onError(err)` callbacks, OR returns a promise for the
        final result plus a separate progress callback — pick the shape that
        cleanly maps onto the IPC in TASK-076 and document it.
      - `cancel(jobId: string): void`.
- [x] 3. In `start`: compute output path via
      `getUniqueSiblingPath(path.dirname(input), path.basename(input,
      path.extname(input)), 'mp4')`. Store `{ child, outputPath }` in a
      `Map<jobId, ...>` registry.
- [x] 4. Probe source duration for percent progress: either run
      `getFfprobePath()` (if bundled) `-v error -show_entries
      format=duration -of default=nk=1:nw=1 [input]`, or parse the
      `Duration: HH:MM:SS.ms` line from a quick `ffmpeg -i [input]` stderr.
      Store total seconds. If probing fails, set total = undefined
      (indeterminate progress).
- [x] 5. Spawn `getFfmpegPath()` with args:
      `['-hide_banner', '-i', input, '-c:a', 'copy', '-c:v', 'libx264',
      '-progress', 'pipe:1', '-nostats', '-y', outputPath]`. Note the user's
      stated codec args (`-c:a copy -c:v libx264`) are preserved verbatim; the
      rest are transport/progress flags. (Use a fresh unique path so `-y` never
      clobbers a pre-existing user file — the uniqueness comes from step 3, not
      from `-y`.)
- [x] 6. Parse `pipe:1` lines: accumulate `out_time_ms=` (microseconds) and
      `progress=continue|end`. Emit `{ jobId, percent, outTimeSec, totalSec }`
      to `onProgress` (percent = outTimeSec/totalSec clamped 0..100, or
      undefined if no total). Throttle emissions (e.g. max ~5/sec).
- [x] 7. On `child.on('close', code)`: if `code === 0` -> `onDone({ outputPath })`.
      Else -> remove partial output (`fse.remove(outputPath).catch(()=>{})`),
      capture tail of stderr, `onError(new Error(stderrTail))`. Remove from
      registry in all cases.
- [x] 8. `cancel(jobId)`: `child.kill('SIGKILL')` (or `taskkill /pid` on
      Windows for reliability), remove partial output, remove from registry,
      emit a cancellation outcome.
- [x] 9. In `src/main.ts`, register `app.on('before-quit', ...)` (add the
      handler — none exists today) that iterates the registry, kills each child,
      and removes each partial output synchronously enough not to block quit
      (best-effort `fs.rmSync` in the handler). Ensure this does not interfere
      with the existing `forceRelaunch` spawn (`src/main.ts:1074-1097`).
- [x] 10. Instantiate/import the runner in `src/main.ts` so TASK-076 can wire
      IPC handlers to it.

## Done When

- [x] `getUniqueSiblingPath` returns `name.mp4` when free and `name 1.mp4` /
      `name 2.mp4` on successive collisions (verified by a quick unit test or
      manual call).
- [x] Calling `start` on a real video produces a valid H.264 `.mp4` beside the
      source and resolves with its path; `ffprobe`/`ffmpeg -i` on the output
      reports `Video: h264`.
- [x] Progress callbacks fire with increasing percent for a source of known
      duration.
- [x] `cancel` mid-encode kills ffmpeg and leaves NO partial `.mp4` behind.
- [x] A non-existent/garbage input causes `onError` (non-zero exit), removes any
      partial output, and surfaces a stderr tail.
- [ ] Quitting the app mid-encode kills the ffmpeg child and removes the partial
      output (verified via Task Manager + folder inspection).
      NOTE: Manual verification required — cannot be automated without a running
      Electron instance. The before-quit handler and killAll() are implemented
      and wired; code review confirms the path is correct.
