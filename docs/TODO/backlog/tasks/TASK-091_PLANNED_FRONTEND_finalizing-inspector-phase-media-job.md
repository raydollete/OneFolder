---
id: TASK-091
title: 'Add a "Finalizing…" phase to the media-job state machine in ImageTools.tsx / runMediaJob so the inspector shows feedback across the ffmpeg-exit -> output-open gap (awaitWriteFinish + DB poll + refetch + waitForIngestedFile), instead of the spinner vanishing with the source the moment ffmpeg resolves.'
investigation: INV-021
status: planned
priority: high
blocked_by: [TASK-089]
date_created: 2026-06-11
date_completed:
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

- [ ] 1. Add a finalization phase to the local state machine in `runMediaJob`
      (`ImageTools.tsx:39-108`): e.g. a `const [isFinalizing, setIsFinalizing] =
      useState(false)`, or extend `activeJob` with a phase discriminator. Set it
      `true` immediately after `startMediaJob` resolves and the progress
      subscription is torn down (`:69-70`), and clear it after
      `finalizeEncodedOutput` returns (in the same scope, and defensively in the
      `finally` at `:99-104`).
- [ ] 2. Render the existing `reencode-progress` spinner (`:136-147`) during the
      finalizing phase with an indeterminate (no-percent) label. Parameterize the
      label like the existing `progressLabel` (`:119-126`) so Normalize Audio
      shows "Finalizing…" too (e.g. reuse the `activeJob === 'normalize-audio'`
      branch only for the verb if desired; "Finalizing…" alone is acceptable for
      both).
- [ ] 3. Keep the **Cancel** button hidden/disabled during finalization (ffmpeg
      is already done; there is nothing to cancel — cancelling mid-ingest is out
      of scope). The spinner shows but no Cancel.
- [ ] 4. Ensure the media-processing lock (`isMediaProcessing`) remains held
      until `endMediaProcessing()` in the `finally` (`:101`), spanning
      finalization — no change to lock timing, only to the visible indicator.
- [ ] 5. Confirm the indicator is mounted: because TASK-089 keeps the source in
      SlideMode (so the inspector stays mounted), the finalizing spinner renders
      in the inspector Tools section. If a new SCSS modifier is needed for the
      indeterminate state, add it; otherwise reuse `reencode-progress`.
- [ ] 6. Verify both tool buttons remain disabled (`uiStore.isMediaProcessing`)
      and the idle Tools view returns only after finalization completes.

## Done When

- [ ] From `startMediaJob` resolving until `finalizeEncodedOutput` resolves, the
      inspector shows a "Finalizing…" indicator (indeterminate, no Cancel).
- [ ] The indicator label is correct for both Re-encode and Normalize Audio.
- [ ] The media-processing lock is held for the whole encode + finalize window
      and released exactly once in `finally` on every path (success/fail/cancel).
- [ ] After finalization, the inspector returns to its idle Tools view for the
      now-open output.
