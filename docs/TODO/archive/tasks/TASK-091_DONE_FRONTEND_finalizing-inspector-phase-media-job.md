---
id: TASK-091
title: 'Add a "Finalizing…" phase to the media-job state machine in ImageTools.tsx / runMediaJob so the inspector shows feedback across the ffmpeg-exit -> output-open gap (awaitWriteFinish + DB poll + refetch + waitForIngestedFile), instead of the spinner vanishing with the source the moment ffmpeg resolves.'
investigation: INV-021
status: done
priority: high
blocked_by: [TASK-089]
date_created: 2026-06-11
date_completed: 2026-06-12
files:
  - 'src/frontend/components/ImageTools.tsx'
  - 'resources/style (SCSS, only if a new modifier is needed)'
---

## What

Extend the inspector media-job UI so a **"Finalizing…"** indicator is shown for
the entire window between ffmpeg exit (`startMediaJob` resolves) and the output
opening (`finalizeEncodedOutput` resolves). Re-use the existing
`reencode-progress` spinner markup with a parameterized label so both Re-encode
and Normalize Audio read "Finalizing…". The media-processing lock stays held
throughout (it already is).

## Why

The only on-screen feedback during a media job is the inspector spinner
(`ImageTools.tsx:136-147`), driven by `activeJob`/`jobPercent` which reflect
ffmpeg progress ONLY. After `startMediaJob` resolves (`:66`), the progress
subscription is torn down (`:69-70`) and `finalizeEncodedOutput` is `await`ed
(`:76`) — a structural gap of ~2 s `awaitWriteFinish` (`folderWatcher.worker.ts:49`)
+ up to ~3 s DB poll (`copyTagsToOutputPath`, `FileStore.ts:1338-1361`) +
refetch + `waitForIngestedFile`. During that gap there is no feedback. (Today the
spinner also vanishes because SlideMode unmounts; TASK-089 keeps SlideMode mounted,
so this task's indicator will actually be visible.) The user reported this as
"several seconds with no indication that anything is happening."

See [INV-021](../investigations/INV-021_HIGH_FRONTEND_post-encode-slidemode-teardown-and-finalization-gap.md).

## Implementation Steps

- [x] 1. Add a finalization phase to the local state machine in `runMediaJob`
      (`ImageTools.tsx:39-108`): e.g. a `const [isFinalizing, setIsFinalizing] =
      useState(false)`, or extend `activeJob` with a phase discriminator. Set it
      `true` immediately after `startMediaJob` resolves and the progress
      subscription is torn down (`:69-70`), and clear it after
      `finalizeEncodedOutput` returns (in the same scope, and defensively in the
      `finally` at `:99-104`).
      Added `const [isFinalizing, setIsFinalizing] = useState(false)`. Set via
      `setIsFinalizing(true)` after the `unsubscribe()` call (line ~84), cleared
      via `setIsFinalizing(false)` immediately after `finalizeEncodedOutput`
      resolves (line ~93), and defensively cleared in `finally` (line ~124).
      `activeJob` remains set throughout finalization so the tool label is
      available for the label derivation.
- [x] 2. Render the existing `reencode-progress` spinner (`:136-147`) during the
      finalizing phase with an indeterminate (no-percent) label. Parameterize the
      label like the existing `progressLabel` (`:119-126`) so Normalize Audio
      shows "Finalizing…" too (e.g. reuse the `activeJob === 'normalize-audio'`
      branch only for the verb if desired; "Finalizing…" alone is acceptable for
      both).
      `progressLabel` now has an `isFinalizing` branch as the first condition that
      returns `'Finalizing…'` for both tools. The ffmpeg-phase branches are
      unchanged (tool-specific, percent-qualified when available).
- [x] 3. Keep the **Cancel** button hidden/disabled during finalization (ffmpeg
      is already done; there is nothing to cancel — cancelling mid-ingest is out
      of scope). The spinner shows but no Cancel.
      Cancel button wrapped in `{!isFinalizing && (...)}` — hidden during the
      finalization phase, visible during the ffmpeg encoding phase as before.
- [x] 4. Ensure the media-processing lock (`isMediaProcessing`) remains held
      until `endMediaProcessing()` in the `finally` (`:101`), spanning
      finalization — no change to lock timing, only to the visible indicator.
      Lock timing is unchanged: `beginMediaProcessing` before try, `endMediaProcessing`
      in finally. `setIsFinalizing` calls do not touch the lock at all.
- [x] 5. Confirm the indicator is mounted: because TASK-089 keeps the source in
      SlideMode (so the inspector stays mounted), the finalizing spinner renders
      in the inspector Tools section. If a new SCSS modifier is needed for the
      indeterminate state, add it; otherwise reuse `reencode-progress`.
      No new SCSS modifier needed. The existing `.reencode-progress` / `.loading-spinner`
      / `.__text` markup is reused as-is. The "Finalizing…" label has no percent
      suffix (indeterminate state is just the absence of `jobPercent`).
- [x] 6. Verify both tool buttons remain disabled (`uiStore.isMediaProcessing`)
      and the idle Tools view returns only after finalization completes.
      The idle branch (`activeJob === null`) is only rendered when `activeJob` is
      null. `activeJob` is cleared in `finally` which runs after
      `finalizeEncodedOutput` returns (or throws). During finalization `activeJob`
      is still set, so the spinner branch shows. Both tool buttons render only in
      the idle branch and are also gated by `uiStore.isMediaProcessing` (still
      held throughout). Lock releases in finally after `setActiveJob(null)`, so
      the idle view returns with the lock already released.

## Done When

- [x] From `startMediaJob` resolving until `finalizeEncodedOutput` resolves, the
      inspector shows a "Finalizing…" indicator (indeterminate, no Cancel).
- [x] The indicator label is correct for both Re-encode and Normalize Audio.
- [x] The media-processing lock is held for the whole encode + finalize window
      and released exactly once in `finally` on every path (success/fail/cancel).
- [x] After finalization, the inspector returns to its idle Tools view for the
      now-open output.
