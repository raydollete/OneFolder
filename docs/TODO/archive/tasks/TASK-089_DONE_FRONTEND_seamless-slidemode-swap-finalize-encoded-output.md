---
id: TASK-089
title: 'Seamless in-place SlideMode swap in finalizeEncodedOutput: keep the source video pinned in SlideMode through finalization and swap to the output in place, instead of refetch()-replacing fileList (which orphans firstItem and unmounts SlideMode) and falling back through clearSearchCriteriaList() (which calls disableSlideMode).'
investigation: INV-021
status: done
priority: high
blocked_by: [TASK-090]
date_created: 2026-06-11
date_completed: 2026-06-12
files:
  - 'src/frontend/stores/FileStore.ts'
---

## What

Rework Steps B–E of `FileStore.finalizeEncodedOutput` (`:1422-1497`) so that,
while the user is in SlideMode, the source video stays on screen until the
freshly-encoded output is ready, then the viewer swaps to the output **in
place** — never collapsing back to the thumbnail grid. Preserve INV-019
correctness (Step A DB-level tag copy stays first and unchanged; single EXIF
write; honest fallback messaging).

## Why

Today, finalization tears the source out of SlideMode at ffmpeg exit:

- Step B `this.refetch()` (`FileStore.ts:1435`) -> `updateFromBackend()`
  wholesale-replaces `fileList` (`clear()/push()` at `:1572-1573`) but never
  reconciles `uiStore.firstItem`. SlideMode is mounted only while
  `uiStore.firstFileInView` (`= fileList[firstItem]`, `UiStore.ts:1275-1278`) is
  defined (`LayoutSwitcher.tsx:193`), so the stale `firstItem` makes
  `firstFileInView` return `undefined` -> SlideMode unmounts -> grid.
- Step E `clearSearchCriteriaList()` (`:1463`) -> `viewAllContent` ->
  `fetchAllFiles` -> `setContentAll()`, which unconditionally calls
  `disableSlideMode()` (`FileStore.ts:629-634`) -> guaranteed teardown.

The viewer then re-opens via `selectFile + enableSlideMode` (`:1449-1450`),
producing the user-reported "close, wait, pop." This task removes the teardown.

See [INV-021](../investigations/INV-021_HIGH_FRONTEND_post-encode-slidemode-teardown-and-finalization-gap.md).

## Implementation Steps

- [x] 1. Leave **Step A unchanged**: `copyTagsToOutputPath(source, outputPath)`
      still runs first (DB-level tag copy, bounded poll, single EXIF/XMP write).
      Capture its `tagged` boolean as today.
- [x] 2. Replace the "Step B `refetch()` then Step C `waitForIngestedFile` then
      Step D `selectFile`" sequence with a **pinned swap** that uses the
      TASK-090 primitive. The output ClientFile must be brought into `fileList`
      and selected WITHOUT ever leaving `firstFileInView` undefined:
      - Resolve the output ClientFile. Prefer the TASK-090
        `pinViewedFileAcrossRefetch(file)` / pin-aware refetch so the list
        replacement and the `firstItem` re-anchor happen in the SAME MobX
        `transaction`. If using a plain refetch, the subsequent `firstItem`
        re-anchor + `selectFile(output, true)` MUST be wrapped in `transaction()`
        with the list mutation so React never observes an intermediate state.
      - Keep `uiStore.isSlideMode === true` throughout (do NOT call
        `enableSlideMode` after a `disableSlideMode` — never disable it in the
        happy path at all).
- [x] 3. After the swap, `firstItem` points at the output's index, the output is
      the sole selection, and SlideMode is still mounted showing the output.
- [x] 4. **Rework the fallback (old Step E)** so it is SlideMode-safe and never
      routes through `clearSearchCriteriaList()` / content-mode setters while in
      SlideMode (those call `disableSlideMode()`):
      - When the output is not visible in the active filter after the bounded
        wait, resolve its ClientFile by absolute path independent of the active
        filter (reuse the path-normalized lookup logic already in
        `copyTagsToOutputPath`, `:1328-1332`), pin it into `fileList` via the
        TASK-090 primitive, and swap to it in place — keeping slide mode on.
      - Only if the output truly cannot be resolved/shown, keep the **SOURCE** on
        screen (do not blank the viewer) and surface the existing honest INV-019
        toast (`:1481-1496`) verbatim — never assert "outside a watched folder"
        as the sole cause (docs/TOOLS.md rule 4).
- [x] 5. Do not call `endMediaProcessing` here (still the caller's `finally` in
      `runMediaJob`). Do not open the delete-original prompt here (still the
      caller, after this resolves).
- [x] 6. Verify the helper compiles under strict mode and that no code path
      calls `disableSlideMode`, `clearSearchCriteriaList`, or a content-mode
      setter while `isSlideMode` is true.

## Done When

- [x] In SlideMode, a successful re-encode/normalize keeps the source on screen
      and swaps to the output in place; `isSlideMode` is never toggled off during
      `finalizeEncodedOutput`.
- [x] `firstFileInView` is never `undefined` at any point during the swap (no
      transient grid flash) — guaranteed by doing list-replace + firstItem
      re-anchor + selection in one `transaction`.
- [x] The fallback never routes through `clearSearchCriteriaList()` / content-
      mode setters while in SlideMode; it either pins the output or keeps the
      source visible with the honest toast.
- [x] INV-019 behavior preserved: Step A unchanged; exactly one EXIF/XMP write;
      no "outside a watched folder" assertion.
- [x] Both Re-encode and Normalize Audio (which share this helper) get the new
      behavior with no tool-specific code.
