---
id: TASK-155
title: 'Main-process backstop: FfmpegRunner inactivity timeout + finalize watcher-suppression hardening'
investigation: INV-038
status: done
priority: high
blocked_by: []
date_created: 2026-06-23
date_completed: 2026-06-23
files:
  - src/media/FfmpegRunner.ts
  - src/media/MediaJobService.ts
  - src/frontend/stores/FileStore.ts
---

## What

Add defense-in-depth on the MAIN process so a wedged ffmpeg child can never hang the pipeline even if the
renderer watchdog (TASK-154) is bypassed:

1. Give `FfmpegRunner.run()` an **inactivity timeout** that resets on each `out_time_ms` advance and, on
   expiry, kills the child and rejects with a distinct stalled error (mirroring the existing 10s timeouts
   on `probeDuration` / `probeFirstAudioCodec`).
2. Surface that as an `onError` through `MediaJobService._encode`.
3. Harden `FileStore.finalizeEncodedOutput` so a wedged finalize step cannot leak the watcher suppression
   (Blast Radius #3).

## Why

`FfmpegRunner.run()` is the only spawn in its file with no timeout; its promise settles only on the
child's `close`/`error` event, so a child that is alive but emitting no progress never settles, hanging
`MediaJobService._encode` → the main `START_MEDIA_JOB` handler → the renderer await. The renderer watchdog
in TASK-154 handles the common case, but the main side must independently refuse to hang (and must kill
orphaned children at quit). The finalize phase has its own unbounded awaits that can leak watcher
suppression forever. See [INV-038](../investigations/INV-038_HIGH_FRONTEND_media-queue-stall-watchdog-and-forcible-cancel.md) (Blast Radius #1, #3, #6).

## Implementation Steps

- [x] 1. **Add a stalled-error type to `src/media/FfmpegRunner.ts`** alongside `FfmpegAbortError`:
  ```ts
  /** Thrown by run() when the child produced no progress for the inactivity window (distinct from a real failure). */
  export class FfmpegStallError extends Error {
    constructor(public readonly idleMs: number) {
      super(`FFMPEG_STALLED: no progress for ${idleMs}ms`);
      this.name = 'FfmpegStallError';
    }
  }
  ```

- [x] 2. **Add an inactivity-timeout option** to `FfmpegRunOptions`:
  `/** Kill the child and reject with FfmpegStallError if no out_time advance is seen for this many ms. Default 60000. */ inactivityTimeoutMs?: number;`
  Add a module constant `const DEFAULT_INACTIVITY_TIMEOUT_MS = 60_000;`.

- [x] 3. **Implement the inactivity watchdog inside `run()`** (`src/media/FfmpegRunner.ts`). After the
  child spawns and the progress parser is set up:
  - Maintain `let lastActivityOutTimeSec = -1;` and an `armWatchdog()` that clears any existing timer and
    sets `setTimeout(onStall, opts.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS)`.
  - In the stdout parser, whenever `lastOutTimeSec` increases beyond `lastActivityOutTimeSec`, update it
    and call `armWatchdog()` (real forward progress resets the clock). Arm it once immediately after spawn
    so a child that never emits a single tick is still caught.
  - `onStall = () => { stalled = true; this.kill(child); }` where `stalled` is a closure flag. The
    existing `child.on('close')` handler then needs a new branch: if `stalled`, `reject(new
    FfmpegStallError(inactivityMs))` (check this BEFORE the `signal?.aborted` and `code === 0` branches so
    a stall is not misreported as an abort or success).
  - Clear the watchdog timer in `cleanup()` (extend the existing `cleanup`) and on `close`/`error` so it
    never fires after the child exits.
  - Do NOT reset the watchdog on `progress=continue` lines that carry no new `out_time_ms` — reset only on
    a genuine `out_time_ms` increase, so a child spamming keep-alive lines without encoding is still
    detected.

- [x] 4. **Surface the stall as an error in `MediaJobService._encode`** (`src/media/MediaJobService.ts`).
  The `catch (err)` block already branches on `FfmpegAbortError` → `onCancelled()`. Add: an
  `FfmpegStallError` (or any non-abort error) flows to `callbacks.onError(...)`. No special-casing is
  strictly required since the default branch already routes to `onError`, but add an explicit comment
  noting `FfmpegStallError` is the inactivity backstop so the temp file is cleaned up (the existing
  `fse.remove(job.tempPath)` in the catch already handles cleanup). Confirm the message text reaches the
  renderer (it becomes the `failed` row's `errorMessage` via the `START_MEDIA_JOB` reject path).

- [x] 5. **Pass an inactivity timeout from the encode call.** In `MediaJobService._encode`'s
  `this.runner.run({ ... })` call, optionally pass `inactivityTimeoutMs` (leave default 60s). Keep it a
  single source of truth — if a constant is wanted, export it from FfmpegRunner and reference it; do not
  hardcode 60000 in two places.

- [x] 6. **Harden `FileStore.finalizeEncodedOutput`** (`src/frontend/stores/FileStore.ts`, ~line 1539) so
  a wedged finalize step cannot leak watcher suppression:
  - The `unsuppressIngest(finalPath)` is already in a `finally` — verify it covers ALL throw points
    including a throw from `tagTempFile` BEFORE `suppressIngest` is called (it must NOT — `suppressIngest`
    is called after `tagTempFile`, so a tag failure happens before suppression and needs no release;
    confirm by reading the current order and leave a clarifying comment).
  - Wrap `commitMediaJob(jobId)` (and optionally `ingestFile`) so that if the underlying main-side move
    hangs, the suppression is still releasable. The minimal robust change: ensure `unsuppressIngest` is
    unconditionally reached on every exit path (it is, via `finally`) and add a comment documenting that a
    hung `commitMediaJob` is now contained by TASK-154's renderer settle (the queue advances for other
    items) and by TASK-155's main-side ffmpeg backstop (the encode can't hang). A deeper per-step timeout
    on exiftool/move is explicitly deferred to a future hardening pass (noted in INV-038 latent defects)
    — do NOT add an exiftool timeout here.

- [x] 7. **Confirm `killAll()` on `before-quit` still works** (`src/media/MediaJobService.ts:174` /
  `src/main.ts:514`). No code change expected; verify by reading that `killAll` → `cancel` → `abort()`
  still triggers `FfmpegRunner`'s `onAbort` → `kill()`. Add a one-line comment in `killAll` noting that
  the inactivity watchdog is also cleared on child close so no timer leaks at quit.

## Done When

- [x] `FfmpegRunner.run()` rejects with `FfmpegStallError` after `inactivityTimeoutMs` (default 60000) of
  no `out_time_ms` advance, and the child is killed.
- [x] A child emitting steady `out_time_ms` advances is never stall-killed (watchdog re-arms on each
  advance).
- [x] The stall surfaces to the renderer as a `failed` row with a recognizable message via the existing
  `onError` → `START_MEDIA_JOB` reject path.
- [x] `finalizeEncodedOutput` releases `unsuppressIngest` on every exit path (verified), with a comment
  documenting containment by the renderer settle + ffmpeg backstop.
- [x] No watchdog timer leaks after a child exits (cleared in `cleanup`/`close`/`error`).
- [x] `yarn lint` passes on changed files (no new errors in modified files; pre-existing errors in other files are pre-existing).
