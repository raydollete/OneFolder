---
id: INV-038
title: 'Media queue: stalled jobs block the queue forever and Cancel does not forcibly kill / free the slot'
reported_bug: 'A stuck media job (no progress) blocks the whole queue, and Cancel does not actually stop a stalled ffmpeg process nor let the queue continue.'
date: 2026-06-23
status: active
superseded_by:
tasks_spawned: [TASK-154, TASK-155, TASK-156]
root_cause_category: architectural-shortcoming
affects:
  - MediaQueueStore (renderer FIFO queue, runItem/cancel/processNext)
  - FfmpegRunner (main-process ffmpeg child, no inactivity timeout)
  - MediaJobService (main-process job registry, cancel/_encode)
  - main.ts media-job IPC handlers (START/CANCEL_MEDIA_JOB)
  - FileStore.finalizeEncodedOutput (unbounded finalize phase + watcher-suppression leak)
---

## Bug Report

### Observed Behavior

The media-queue drawer (`src/frontend/containers/MediaQueue/index.tsx`) drains one ffmpeg job at a
time. Two related failures were reported:

1. **A stalled job blocks the entire queue.** If a running ffmpeg job stops making progress (stuck at
   the same `percent` for a long time — e.g. a network-mount stall, a codec deadlock, or a process
   that never emits another `out_time_ms` tick), nothing ever errors it out. The `runItem` async body
   is `await`-ing `RendererMessenger.startMediaJob(...)` which never resolves or rejects, so the row
   stays `status: 'running'` forever, the single FIFO slot (`runningItem`) is never released, and
   every queued job behind it sits `pending` indefinitely.

2. **Cancel does not stop a stalled process and does not free the queue.** Clicking Cancel on a
   running row calls `MediaQueueStore.cancel(id)`, which for a running item only fires
   `RendererMessenger.cancelMediaJob(item.jobId)` and then *waits passively* for the in-flight
   `runItem` promise to reject with `MEDIA_JOB_CANCELLED`. The row is only spliced, and
   `processNext()` only re-runs, if/when that rejection arrives. There is no local optimistic removal,
   no queue-advance, and no backstop — so if the kill is best-effort and the child never closes (or if
   the job has already moved past the `encoding` phase), the row is never removed and the queue never
   advances.

### Expected Behavior

Per the reporter's explicit requirements:

1. **Stall = no encode progress for over 60 seconds → the item must error out.** It moves to
   the `failed` state (with a clear "stalled / timed out" error message), the underlying ffmpeg child
   is killed, and the queue immediately drains the next `pending` job. A stalled job must never be able
   to block the queue.
   - **USER DECISION (2026-06-23): the liveness signal is `outTimeSec`, not literal `percent`.** The user
     was shown the false-positive risk (on a long encode a single 1% step can exceed 60s) and chose to
     reset the 60s watchdog on ffmpeg's `outTimeSec` (encoded-output timestamp) advancing — it ticks far
     more often than `percent`, so the watchdog fires only when the process is genuinely frozen. The
     user-visible error still reports the frozen `percent` ("stuck at N%"); only the *reset trigger* is
     `outTimeSec`. This supersedes the original "same percent for 60s" wording in the Risks section below.

2. **Cancel must kill the process immediately AND free the queue to continue draining.** Pressing
   Cancel terminates the spawned ffmpeg child without delay and, regardless of whether/when the
   main-process confirmation arrives, removes the row and advances to the next `pending` job
   immediately. Cancel must work in every running phase, including after ffmpeg has finished but while
   the job is still finalizing (tag → commit/move → ingest).

### Reproduction Context

Deterministic for the *architecture* (the timeout/backstop simply does not exist); the *trigger* for a
real stall is conditional (a wedged ffmpeg child — easiest to force with a media file on a slow/removable
volume, a corrupt stream, or by suspending the ffmpeg PID). The cancel-never-frees-the-queue path is
reproducible any time the `MEDIA_JOB_CANCELLED` rejection fails to arrive — most reliably by cancelling
during the finalize phase (see Blast Radius #2), where `cancelMediaJob` is a no-op.

---

## Root Cause Analysis

**Category:** architectural-shortcoming

### Diagnosis

The media pipeline was built on an optimistic single-path assumption: **"a job that started will always
reach a terminal event (done / error / cancelled), so no link in the chain needs a timeout or a single
idempotent settle point."** Progress (`percent`) is treated as *advisory display data*, never as a
*liveness signal*.

There is exactly one serialization slot in `MediaQueueStore` — `runningItem` — and the **only** thing
that frees it is the in-flight `runItem` async IIFE settling (its `finally` calls `processNext()`).
Every hop in the chain is an unbounded `await`:

- `MediaQueueStore.runItem` → `await RendererMessenger.startMediaJob(...)` (`MediaQueueStore.ts:301`)
- main `START_MEDIA_JOB` handler → `mediaJobService.start(...)` whose promise resolves/rejects only via
  `onDone`/`onError`/`onCancelled` (`main.ts:878-918`)
- `MediaJobService._encode` → `await runner.run(...)` (`MediaJobService.ts:202`)
- `FfmpegRunner.run` → settles only on the child's `close`/`error` event (`FfmpegRunner.ts:148-158`) —
  **no inactivity timeout** (notably, `probeDuration` and `probeFirstAudioCodec` in the SAME file *do*
  have 10s timeouts — the omission on `run()` is an oversight, not a decision).

Because nothing imposes a timeout or watchdog, any single wedge pins the FIFO slot forever.

Cancel is a corollary of the same flaw: `MediaQueueStore.cancel()` for a running item is fire-and-forget
(`RendererMessenger.cancelMediaJob`) and assumes the abort will produce a `close`/`onCancelled` that
rejects `runItem`. It performs **no local state change** and has **no backstop**. And the cancel path on
the main side (`MediaJobService.cancel`) only actually aborts a live child when the job is in the
`encoding` phase; once the job is past that (`encoded`/`placing`, or already deleted by `place()`), the
cancel is a silent no-op while the renderer is still `await`-ing `finalizeEncodedOutput` — so cancelling
during finalize neither stops anything nor frees the slot.

The structural hole that makes a fix non-trivial is the absence of a single, idempotent "settle this item
exactly once (and advance the queue)" guard. `unsubscribe()` and `processNext()` are scattered across the
success and catch paths of `runItem`; any watchdog/cancel that splices a row without going through that
exact path would leak the `MEDIA_JOB_PROGRESS` listener and/or fail to advance the queue.

### Diagnostic Questions Considered

- **Wrong mental model?** Yes — `percent` was modeled as display data, never as a heartbeat. "Started ⇒
  will terminate" was assumed but never enforced.
- **Architectural shortcoming?** Yes (primary) — no liveness/timeout enforcement on a running job, and
  no single idempotent settle/advance point. The one FIFO slot can only be freed by the happy/cancel
  path completing.
- **Incorrect order of operations?** Partially — cancel during the finalize phase races the
  `place()`-driven job deletion, so the same jobId is "unknown" by the time cancel reaches main.
- **Missing edge case?** Yes — "child alive but emitting no progress" and "cancel after ffmpeg finished
  but before finalize completes" were never implemented.
- **Wrong abstraction?** Partially — `FfmpegRunner.run` has no inactivity timeout while the probe methods
  do; the timeout concept exists in the file but was not applied to the long-running path.
- **Silent failure?** Yes — `MediaJobService.cancel` early-returns `job === undefined` as a no-op, and
  `killAll`/best-effort `taskkill` swallow failures; a cancel that does nothing looks like a cancel that
  worked.

---

## Blast Radius

1. **`FfmpegRunner.run()` — no inactivity/stall timeout (the seed defect).**
   `src/media/FfmpegRunner.ts:77-160`. The encode promise settles only on `child.on('close')` /
   `child.on('error')`. A child that is alive but emitting no `out_time_ms` never closes, so `run()`
   never settles. `probeDuration` (line ~188) and `probeFirstAudioCodec` (line ~255) already have 10s
   timeouts — this is the lone unbounded spawn.

2. **Cancel during the `encoded` / `placing` / finalize window is a silent no-op that strands the row.**
   After ffmpeg finishes, `onDone` has already resolved the `startMediaJob` promise; the renderer is now
   `await`-ing `FileStore.finalizeEncodedOutput`. Clicking Cancel here calls
   `MediaJobService.cancel(jobId)`, which either (a) hits the `job === undefined` early-return
   (`MediaJobService.ts:157`) if `place()` already deleted the job, or (b) takes the non-encoding branch
   and deletes the temp file out from under `tagTempFile`/`commit`, firing `onCancelled()` on an
   *already-settled* promise (lands nowhere). In every variant `runItem` never observes the cancel, the
   row stays `running`, and `processNext()` never advances. There is no concept of "cancel the finalize
   phase" anywhere.

3. **A job that completes ffmpeg but wedges INSIDE `finalizeEncodedOutput` is also unbounded.**
   `src/frontend/stores/FileStore.ts:1539-1583`. Three awaited steps, none time-bounded: `tagTempFile`
   → `exifTool.writeTags` (a long-lived `node-exiftool` child with no per-call timeout); `commitMediaJob`
   → `place()` → `fse.move` (cross-volume copy onto a stalled volume can hang); `ingestFile` + `refetch`.
   Any wedge here pins the FIFO slot exactly like a stalled encode, and additionally **leaves the watcher
   suppressed forever** because `unsuppressIngest` is in the `finally` that never runs (a compounding
   latent defect — future adds to that folder are silently dropped).

4. **The synthetic `percent:0` first event masks a never-ticking job.**
   `main.ts:909-916` emits one synthetic `{percent:0}` purely to deliver the jobId. A job that emits
   ONLY that event and then never ticks looks identical to a healthy just-started 0% job, because the
   store never timestamps `percent` changes. A stall watchdog keyed on "time since `percent` last
   changed" is exactly what's missing — and it must treat the synthetic 0% as the start of the clock.

5. **`retry()` cannot rescue a wedged queue.**
   `MediaQueueStore.ts:379-391` → `enqueue` → `processNext`, but `processNext` early-returns whenever
   `runningItem` exists (line 252). A wedged `running` predecessor leaves a retried job `pending`
   forever. Retry depends on the same single slot being freed.

6. **`killAll()` on `before-quit` cannot guarantee children die.**
   `main.ts:514-516` → `MediaJobService.killAll()` fires the same best-effort detached `taskkill` for
   `encoding` jobs (not awaited at quit), so a wedged ffmpeg can outlive the app as an orphan; for a job
   in the finalize window there is no live child but nothing forces the renderer's hung await to resolve.

7. **Progress-subscription (`unsubscribe`) leak / double-settle risk for any naive fix.**
   `MediaQueueStore.ts:280-348`. `unsubscribe()` runs in exactly two spots (success line 308, catch line
   324) and `processNext()` once (finally, line 346). A watchdog or forcible-cancel that splices the row
   or advances the queue WITHOUT routing through one idempotent settle point would leak the
   `MEDIA_JOB_PROGRESS` listener, keep a stale closure mutating a spliced `QueueItem`, and/or double-fire
   `processNext`. The fix must introduce a single "settle this item exactly once" guard.

### Latent defects elsewhere (same flaw class — child-process / IPC awaits with no timeout backstop)

- **`common/ExifIO.ts` (`writeTags`/reads)** — shared persistent exiftool process, no per-operation
  timeout; a wedged exiftool stalls every metadata caller, not just media jobs. Out of scope for this
  investigation but noted for a future hardening pass.
- **`RendererMessenger.startMediaJob` / `commitMediaJob`** (`src/ipc/renderer.ts:254,267`) are bare
  `ipcRenderer.invoke` with no timeout wrapper — the un-timed invoke is the vehicle by which an
  un-settling main handler hangs the renderer.

---

## UX / Requirements Specification

### Purpose

Make the media queue self-healing and the Cancel button authoritative: a stuck job can never block the
queue, and Cancel always stops the work and immediately frees the slot.

### User-Stated Design Decisions

1. **Stall definition is "same `percent` for over 60 seconds."** — Not "no event for 60s" and not a
   wall-clock cap on total job time. The watchdog clock resets whenever the rounded `percent` *changes*
   (including the initial synthetic 0% → first real tick). Rationale: a long encode that is steadily
   advancing must never be killed; only a job whose progress has frozen is a stall.
2. **A stalled job errors out (does NOT just get cancelled/spliced).** — It moves to the `failed` state
   with a descriptive error message so the row stays visible as history and the user can Retry or
   Dismiss it. Rationale: a stall is an abnormal termination the user should see, distinct from a
   user-initiated cancel (which removes the row).
3. **Cancel kills immediately AND frees the queue immediately.** — Cancel must not wait for a
   round-trip confirmation before removing the row and advancing. The local row removal + queue advance
   happen optimistically the moment Cancel is pressed; the main-process kill is fired in parallel.
4. **Both behaviors must release the single FIFO slot and drain the next pending job.** — Whether a job
   ends by stall-timeout or by cancel, `processNext()` must run exactly once afterward.

### Behavioral Specifications

- The 60s stall threshold lives as a single named constant (e.g. `STALL_TIMEOUT_MS = 60_000`) so it is
  testable and tunable.
- The watchdog is per-running-item. It starts when the item enters `running` (the synthetic 0% counts as
  the initial percent), resets on every `percent` change, and is torn down whenever the item leaves
  `running` for any reason (completed / failed / cancelled / stalled).
- On stall fire: send `cancelMediaJob(jobId)` to kill the child, mark the item `failed` with message
  like `"Stalled: no progress for 60s (stuck at NN%)."`, tear down the progress subscription and
  watchdog, and call `processNext()` — all via a single idempotent settle path so it cannot double-fire
  with a late natural completion or a user cancel.
- Cancel on a running item: immediately fire `cancelMediaJob(jobId)` (if `jobId` known), then route
  through the same idempotent settle path that splices the row and calls `processNext()` — without
  waiting for `MEDIA_JOB_CANCELLED`. A late-arriving `MEDIA_JOB_CANCELLED` (or natural completion) for an
  already-settled item must be a harmless no-op.
- Cancel must also work when the item is past ffmpeg and inside finalize: the settle guard marks the item
  done and advances the queue even though the main-side `cancelMediaJob` may be a no-op (the orphaned
  finalize work is allowed to complete or fail harmlessly against the already-settled row).
- Main-process backstop (defense in depth): `FfmpegRunner.run()` gains an inactivity timeout that kills
  the child and rejects with a distinct stalled error if no `out_time_ms` advance is seen for a
  configurable window, so the main side cannot hang even if the renderer watchdog is somehow bypassed.

### Explicit Rejections

- Do NOT impose a fixed wall-clock cap on total encode time — a legitimately long, steadily-progressing
  encode must be allowed to finish.
- Do NOT treat a stall as a silent cancel/splice — it must surface as a visible `failed` row.
- Do NOT make Cancel wait for the main-process confirmation before freeing the queue.

---

## Holistic Solution

### Approach

Introduce **liveness enforcement and a single idempotent settle point** on the running job, on both sides
of the IPC boundary:

1. **Renderer settle guard + stall watchdog (`MediaQueueStore`).** Add a private `settleItem(item, fn)`
   helper that runs exactly once per item: it tears down the progress subscription and the stall
   watchdog, applies the terminal mutation (`completed` / `failed` / splice), and calls `processNext()`.
   Route the existing success, error, and cancel paths through it. Add a per-item stall watchdog that
   (re)arms a 60s timer on every `percent` change (including the initial synthetic 0%) and, on fire,
   settles the item as `failed` with a "stalled" message after sending `cancelMediaJob`. Make `cancel()`
   on a running item fire `cancelMediaJob` and then settle (splice) immediately — not wait for the
   rejection. This satisfies requirements 1-4 directly and fixes Blast Radius #2, #4, #5, #7.

2. **Main-process inactivity backstop (`FfmpegRunner` + `MediaJobService`).** Add an inactivity timeout
   to `FfmpegRunner.run()` (mirroring the existing probe timeouts) that resets on each `out_time_ms`
   advance and, on expiry, kills the child and rejects with a distinct `FfmpegStallError`. Surface it
   through `MediaJobService._encode` as an `onError`. This guarantees the main side cannot hang even if
   the renderer watchdog is bypassed (Blast Radius #1, #6).

3. **Bound the finalize phase + protect the suppression release (`FileStore.finalizeEncodedOutput`).**
   Ensure the watcher-suppression release is robust and (optionally) time-bound the finalize awaits so a
   wedged tag/commit/ingest cannot pin the slot forever and cannot leak suppression. At minimum, the
   renderer settle guard (step 1) means a finalize wedge no longer blocks *new* cancels/stalls from
   advancing the queue for *other* items; the targeted hardening here closes Blast Radius #3.

### Expected Outcomes

- A job frozen at the same percent for 60s auto-fails, its ffmpeg child is killed, and the next job
  starts — the queue is self-healing.
- Cancel kills the child and frees the slot instantly, in every running phase, with late confirmations
  becoming harmless no-ops.
- No leaked `MEDIA_JOB_PROGRESS` listeners and no double `processNext()`.
- The main process cannot hang on a wedged ffmpeg even absent the renderer watchdog.

### Risks and Tradeoffs

- **False-positive stalls.** A genuinely slow-but-advancing encode whose rounded `percent` doesn't tick
  for 60s (e.g. a very long file where 1% takes >60s) could be killed. Mitigation: reset on `percent`
  change at integer granularity is coarse; if needed, key the watchdog on raw `outTimeSec` advance
  (which ticks far more often) rather than rounded `percent`. The investigation specifies the user's
  literal "same percent for 60s" definition; the task notes this tradeoff and recommends resetting on any
  forward `outTimeSec`/`percent` movement so steadily-progressing long encodes are safe.
- **Orphaned finalize work after a finalize-phase cancel.** The orphaned `finalizeEncodedOutput` may
  still place/ingest a file after the row is settled. Acceptable: it dedups harmlessly (the watcher add
  is idempotent) or fails loud against an already-resolved row; it cannot corrupt the queue.
- **Two watchdogs (renderer + main) firing for the same stall.** Idempotent settle on the renderer and
  the distinct error path on main make this a harmless race (whichever fires first wins; the other is a
  no-op).

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: `docs/media-queue` / media-job docs to be touched by TASK-156 (stall-timeout and
      forcible-cancel behavior, plus a QA checklist).
