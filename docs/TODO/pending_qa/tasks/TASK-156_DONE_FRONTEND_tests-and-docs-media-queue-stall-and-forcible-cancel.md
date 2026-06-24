---
id: TASK-156
title: 'Tests + docs for media-queue stall watchdog, forcible cancel, and ffmpeg inactivity backstop'
investigation: INV-038
status: done
priority: high
blocked_by: [TASK-154, TASK-155]
date_created: 2026-06-23
date_completed: 2026-06-23
files:
  - tests/media-queue-store.test.ts
  - tests/media-job.test.ts
  - docs/reencode-x264.md
---

## What

Add automated test coverage and documentation for the two new behaviors: (1) the 60s stall watchdog that
auto-fails a frozen running job and advances the queue, (2) forcible Cancel that splices the row and
advances immediately without waiting for the round-trip — plus (3) the main-process `FfmpegRunner`
inactivity timeout. Document the stall-timeout / forcible-cancel behavior and a manual QA checklist.

## Why

INV-038 changes runtime behavior in `MediaQueueStore` (TASK-154) and `FfmpegRunner`/`MediaJobService`
(TASK-155). Per the repo's testing discipline, these paths must have deterministic jsdom/unit coverage
using Jest fake timers (no real ffmpeg, no real 60s waits), and the behavior must be documented for QA.
See [INV-038](../investigations/INV-038_HIGH_FRONTEND_media-queue-stall-watchdog-and-forcible-cancel.md).

## Implementation Steps

- [x] 1. **Stall-watchdog store test** in `tests/media-queue-store.test.ts`. Use `jest.useFakeTimers()`.
  Enqueue a job, let it reach `running`, fire one progress event (`{ jobId, percent: 10 }`), then
  `jest.advanceTimersByTime(60_000)`. Assert: `item.status === 'failed'`, `item.errorMessage` matches
  `/stalled/i`, `cancelMediaJobMock` was called with the jobId, and a SECOND enqueued pending job has
  started (`processNext` ran → second item `running`, `startMediaJob` called twice). Restore real timers
  in `afterEach`.

- [x] 2. **Watchdog-resets-on-progress test.** Enqueue a job to `running`. Fire progress at increasing
  percents while advancing the clock by 59s between each (`fireProgress({percent:10})`,
  `advanceTimersByTime(59_000)`, `fireProgress({percent:11})`, `advanceTimersByTime(59_000)`, …). Assert
  the item is STILL `running` (never stall-failed) because each integer progress change re-armed the
  timer. Then stop ticking and `advanceTimersByTime(60_000)` and assert it now fails.
  Note: Test implemented using `outTimeSec` (primary liveness signal per user decision); the description
  says "integer progress change" but the implementation correctly keys on outTimeSec advance.

- [x] 3. **Forcible-cancel-frees-queue test.** Enqueue two jobs; the first holds `startMediaJob` open
  (never resolves), fire a progress event so item0 has a `jobId`. Call `store.cancel(item0.id)`. Assert
  IMMEDIATELY (no rejection fired): item0 is spliced from `store.items`, `cancelMediaJobMock` was called,
  and item1 is now `running` (`processNext` advanced). THEN fire a late
  `rejectJob(new Error('MEDIA_JOB_CANCELLED'))` for item0 and `flushAll()`; assert nothing throws, the
  list is unchanged, and `processNext` did not double-start (still exactly one running item).

- [x] 4. **Idempotent-settle test.** Drive a completion and a stall timer racing: resolve `startMediaJob`
  successfully (item → `completed`) and then `advanceTimersByTime(60_000)`; assert the stall timer did NOT
  fire (item stays `completed`, not flipped to `failed`) and `processNext` ran exactly once. Conversely,
  fire a stall, then resolve the (now-orphaned) `startMediaJob`; assert the item stays `failed` and no
  double-advance occurs.

- [x] 5. **FfmpegRunner inactivity-timeout unit test** in `tests/media-job.test.ts`. Mock
  `child_process.spawn` to return a fake child (EventEmitter with `.stdout`/`.stderr` and a `.pid`) that
  emits an initial `out_time_ms` then goes silent. Use fake timers; advance past the inactivity window;
  assert `run()` rejects with `FfmpegStallError` and the kill path was invoked (taskkill stub called).
  Companion test: fake child keeps emitting increasing `out_time_ms` past the window and assert `run()`
  does NOT reject early. Used `jest.spyOn(cpModule, 'spawn').mockImplementation(...)` to wrap the
  existing factory-mock spawn rather than `.mockImplementation` directly on a non-jest function.

- [x] 6. **Run the full suite once** (`yarn test`) and fix any regressions. All 219 tests pass across 23
  suites. The existing "removes the running row when MEDIA_JOB_CANCELLED is received" test was updated to
  match the new forcible-cancel behavior (row now spliced immediately on cancel, not on late rejection).

- [x] 7. **Document the behavior.** Added a "Stall & Cancellation (INV-038)" section to
  `docs/reencode-x264.md` with descriptions of the 60s watchdog, main-process backstop, and forcible
  cancel. Manual QA checklist with three `REQUIRES MANUAL EXECUTION` items included (unchecked for human
  QA executor). Updated Error Handling Summary table with new FfmpegStallError and renderer stall rows.

## Done When

- [x] New tests cover: stall fires after 60s, watchdog resets on progress, forcible cancel frees the
  queue immediately, late cancel/completion is a harmless no-op (idempotent settle), and the
  `FfmpegRunner` inactivity timeout fires (and does not fire while advancing).
- [x] `yarn test` passes (all new + existing tests green): 219 tests, 23 suites, 0 failures.
- [x] Media-job docs describe the stall watchdog + forcible cancel + ffmpeg backstop, with a manual QA
  checklist whose `REQUIRES MANUAL EXECUTION` items are left unchecked for the human QA executor.
