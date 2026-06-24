---
id: TASK-154
title: 'MediaQueueStore: idempotent settle guard, 60s stall watchdog, and immediate forcible cancel'
investigation: INV-038
status: done
priority: high
blocked_by: []
date_created: 2026-06-23
date_completed: 2026-06-23
files:
  - src/frontend/stores/MediaQueueStore.ts
---

## What

Make a running media-queue job impossible to wedge the queue with:

1. A single **idempotent settle point** (`settleItem`) that all terminal outcomes route through — it
   tears down the progress subscription AND the stall watchdog, applies the terminal mutation, and calls
   `processNext()` exactly once.
2. A per-running-item **stall watchdog**: if the job's progress stays at the same value for over 60
   seconds it auto-fails the row (after killing the child) and advances the queue.
3. A **forcible Cancel** for running items that fires `cancelMediaJob` and immediately settles (splices)
   the row and advances the queue, without waiting for the `MEDIA_JOB_CANCELLED` round-trip — and that
   works even when the job is past ffmpeg and inside finalize.

## Why

The single FIFO slot (`runningItem`) is only freed when the in-flight `runItem` async IIFE settles, and
every hop is an unbounded `await`. A stalled ffmpeg child never settles, so the queue dies; Cancel is
fire-and-forget with no local state change or backstop, so a cancel whose confirmation never arrives (most
reliably during the finalize phase) never frees the slot. See [INV-038](../investigations/INV-038_HIGH_FRONTEND_media-queue-stall-watchdog-and-forcible-cancel.md) (root cause + Blast Radius #2, #4, #5, #7).

## Implementation Steps

- [x] 1. **Add a module-level constant** `const STALL_TIMEOUT_MS = 60_000;` near the top of
  `src/frontend/stores/MediaQueueStore.ts` (below imports). This is the "same percent for over 60s"
  threshold from the user's requirement.

- [x] 2. **Track non-observable per-item runtime handles.** In `runItem`, keep the existing
  `unsubscribe` closure but also create a stall watchdog. Because these are imperative timers/closures
  (not UI state) keep them in `runItem`'s lexical scope (do NOT make them observable). Specifically:
  - `let settled = false;` — the idempotency latch for this run.
  - `let stallTimer: ReturnType<typeof setTimeout> | null = null;`
  - `let lastProgressValue: number | null = null;` — the last seen progress used to detect "no change".

- [x] 3. **Introduce a single `settle(apply: () => void)` helper inside `runItem`** (closure over the
  item, `unsubscribe`, `stallTimer`, and `settled`). It must:
  - Return immediately if `settled` is already `true` (idempotent — late `MEDIA_JOB_CANCELLED`, a natural
    completion racing the watchdog, or a double cancel are all harmless no-ops).
  - Set `settled = true`.
  - Call `unsubscribe()` (tear down the `MEDIA_JOB_PROGRESS` listener — fixes the leak in Blast Radius #7).
  - Clear the stall timer (`if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }`).
  - Run `apply()` inside `runInAction` to perform the terminal mutation (splice / set
    `completed` / set `failed`).
  - Call `this.processNext()` exactly once.

- [x] 4. **Add the stall watchdog (re)arm logic.** Define a local `armStallTimer()` that clears any
  existing `stallTimer` and sets a new `setTimeout(..., STALL_TIMEOUT_MS)` whose callback, when it fires:
  - Captures `item.jobId` and, if non-null, calls `RendererMessenger.cancelMediaJob(item.jobId)` to kill
    the wedged child.
  - Calls `settle(() => { item.status = 'failed'; item.errorMessage = \`Stalled: no progress for 60s\` +
    (item.percent !== null ? \` (stuck at ${item.percent}%).\` : '.'); })`.
  Arm it once immediately when the item enters `running` (the synthetic `percent:0` first event is the
  start of the clock — arming on `running` entry covers the case where the synthetic event has not yet
  been processed).

- [x] 5. **Reset the watchdog on real forward progress, using `outTimeSec` as the primary liveness
  signal.** USER DECISION (2026-06-23): the watchdog resets on ffmpeg's **`outTimeSec`** (encoded output
  timestamp) advancing, NOT on the integer `percent`. `outTimeSec` ticks far more often than `percent`, so
  on a long encode where a single 1% step legitimately exceeds 60s the timer still re-arms and never
  false-fails; the watchdog fires only when the process is *genuinely frozen* (no encoded-time progress at
  all for 60s). In the existing `onMediaJobProgress` handler inside `runItem`, after updating `item.percent`:
  - Track `let lastOutTimeSec = -1;` (forward-progress latch) instead of / alongside `lastProgressValue`.
  - If `msg.outTimeSec !== undefined && msg.outTimeSec > lastOutTimeSec`, update `lastOutTimeSec` and call
    `armStallTimer()`. (Use `>` so a stuck or non-monotonic timestamp does not keep re-arming.)
  - If a progress message lacks `outTimeSec` (older/edge messages), fall back to re-arming on a forward
    integer `percent` change so healthy jobs without an `outTimeSec` field are never false-failed.
  - The stall message should still report the frozen `percent` for the user (`Stalled: no progress for 60s
    (stuck at N%)`), since percent is what the user sees — but the *reset trigger* is `outTimeSec`.
  - Confirm the IPC progress message actually carries `outTimeSec` end-to-end (FfmpegRunner →
    START_MEDIA_JOB → MEDIA_JOB_PROGRESS → `onMediaJobProgress`); if the field name differs, use the
    main-process field that conveys ffmpeg `out_time_ms`/`out_time` and document the mapping.

- [x] 6. **Route the three existing terminal paths through `settle`:**
  - Success: replace the inline `runInAction(() => { item.output = output; item.status = 'completed'; })`
    with `settle(() => { item.output = output; item.status = 'completed'; })`. Remove the now-duplicated
    standalone `unsubscribe()` on the success path (settle owns it).
  - Cancel rejection (`message === 'MEDIA_JOB_CANCELLED'`): `settle(() => { const idx =
    this.items.indexOf(item); if (idx !== -1) this.items.splice(idx, 1); })`.
  - Hard failure (else): `settle(() => { item.status = 'failed'; item.errorMessage = message; })`.
  - Remove the standalone `unsubscribe()` calls in the `catch` and the `finally`-block
    `this.processNext()` (settle now owns both unsubscribe and processNext). The `finally` may be dropped
    entirely, OR kept as a defensive `settle(() => {})` no-op to guarantee the slot is freed even on an
    unexpected throw before any terminal branch ran. Prefer the defensive `settle(() => {})` in `finally`
    so an unforeseen exception still advances the queue.

- [x] 7. **Make `cancel()` forcible and immediate for running items.** In the `else if (item.status ===
  'running' ...)` branch of `cancel(itemId)`:
  - Still call `RendererMessenger.cancelMediaJob(item.jobId)` when `item.jobId !== null` (kill the child).
  - Additionally, **immediately splice the row and advance the queue** rather than waiting for the
    rejection. Because `cancel()` is on the store (not inside `runItem`'s closure), it cannot call the
    local `settle`. To keep one idempotent path, set a cancellation flag on the item that the in-flight
    run observes, OR — simpler and self-contained — perform the optimistic splice here and rely on the
    run's `settle` idempotency latch so the later `MEDIA_JOB_CANCELLED` is a no-op. Implement it as:
    splice the row from `this.items` now, then `this.processNext()`. Document that the in-flight
    `runItem`'s `settle` will still fire when the rejection (or completion) arrives but, because the item
    is no longer in `this.items`, its `apply()` splice is a harmless no-op and `processNext()` is
    idempotent (it only starts a job if none is running).
  - IMPORTANT: this makes Cancel work even in the finalize phase (Blast Radius #2): even if
    `cancelMediaJob` is a main-side no-op there, the row is removed and the queue advances locally; the
    orphaned `finalizeEncodedOutput` completes or fails harmlessly against the no-longer-listed item.
  - Handle the `item.jobId === null` running case (cancel pressed before the first progress event): still
    splice + advance locally; send the kill best-effort once jobId is known is NOT required because the
    main side will time out via the FfmpegRunner backstop (TASK-155).

- [x] 8. **Avoid double-advance / double-settle interaction between step 6 and step 7.** Verify by
  reasoning (and the tests in TASK-156) that: cancel-then-rejection settles once; rejection-then-nothing
  settles once; stall-then-late-completion settles once; completion-then-stall-timer (timer already
  cleared by settle) does not fire. The `settled` latch + clearing `stallTimer` inside `settle` guarantee
  this.

## Done When

- [x] `STALL_TIMEOUT_MS = 60_000` exists as a single named constant.
- [x] A running item whose `percent` does not change for 60s transitions to `status: 'failed'` with a
  "Stalled: no progress for 60s" message, `cancelMediaJob` is called for its `jobId`, and `processNext()`
  runs (the next pending job starts).
- [x] A healthy job whose `outTimeSec` keeps advancing is never stall-failed — including a long encode
  where a single integer `percent` step takes longer than 60s (the timer re-arms on `outTimeSec`, not
  `percent`).
- [x] Cancel on a running item removes the row and starts the next pending job immediately, without
  waiting for `MEDIA_JOB_CANCELLED`; a late `MEDIA_JOB_CANCELLED` (or natural completion) for that item is
  a harmless no-op (no double splice, no double `processNext`, no error).
- [x] No `MEDIA_JOB_PROGRESS` listener leaks: every terminal path (success, fail, cancel, stall) calls
  `unsubscribe()` exactly once via `settle`.
- [x] `yarn lint` passes on the changed file (no new errors in modified file; pre-existing errors in other files are pre-existing).
