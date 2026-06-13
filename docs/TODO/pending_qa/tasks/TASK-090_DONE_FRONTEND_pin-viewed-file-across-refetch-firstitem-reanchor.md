---
id: TASK-090
title: 'Add a pin-by-identity primitive so a refetch/list-replacement can keep SlideMode anchored to a specific file: reconcile uiStore.firstItem toward a caller-supplied pin file inside the same MobX transaction as the fileList replacement, closing the asymmetry where removeFilesFromListInPlace reconciles firstItem but updateFromBackend does not.'
investigation: INV-021
status: done
priority: high
blocked_by: []
date_created: 2026-06-11
date_completed: 2026-06-12
files:
  - 'src/frontend/stores/FileStore.ts'
---

## What

Provide a reusable way to refetch / replace `fileList` while keeping the
SlideMode viewer pinned to a specific file by **identity** (file id), so the
viewer never unmounts when the list churns. Either teach `updateFromBackend` to
re-anchor `uiStore.firstItem` toward a caller-supplied "pin file id" (mirroring
`removeFilesFromListInPlace:792-807`), or add a small
`FileStore.pinViewedFileAcrossRefetch(file)` helper that wraps refetch +
re-anchor + selection in a single MobX `transaction`. TASK-089 consumes this.

## Why

`removeFilesFromListInPlace` (`FileStore.ts:703-809`) carefully snapshots
`oldFirstItemId` and re-points `uiStore.firstItem` to the survivor's new index
(`:792-807`) so SlideMode auto-advances correctly. The fetch path
(`updateFromBackend`, `:1523-1647`) has NO such reconciliation: it does
`clear()/push()` (`:1572-1573`) + `cleanFileSelection()` (`:1575`) and leaves
`firstItem` pointing at a stale index. Since SlideMode is mounted only while
`uiStore.firstFileInView` (`= fileList[firstItem]`, `UiStore.ts:1275-1278`) is
defined (`LayoutSwitcher.tsx:193`), any refetch while in SlideMode can blind-drop
the viewer. This structural asymmetry is the root enabler of INV-021's
"returns to the thumbnail index" symptom; closing it prevents the whole class of
refetch-in-SlideMode teardowns, not just the post-encode one.

See [INV-021](../investigations/INV-021_HIGH_FRONTEND_post-encode-slidemode-teardown-and-finalization-gap.md).

## Implementation Steps

- [x] 1. Add `FileStore.pinViewedFileAcrossRefetch(pinFile: ClientFile): Promise<void>`
      (or an overload of `refetch(pinFileId?)`). It must, after the fetcher's
      `updateFromBackend` settles, re-derive the pin file's NEW index via
      `this.index.get(pinFile.id)` and set `uiStore.firstItem` to it, plus
      `selectFile(pinFile, true)` — all inside one MobX `transaction` with the
      list mutation so `firstFileInView` is never transiently `undefined`.
- [x] 2. If the pin file is NOT in the refetched list (e.g. tagless output under
      a tag filter), do NOT leave `firstItem` stale: fall back to a caller-
      decidable outcome (return a boolean "pinned") so TASK-089 can choose to
      pin-insert the output instead. Do not silently point firstItem at a wrong
      file.
- [x] 3. Ensure the transaction boundary covers the existing
      `updateFromBackend` mutations (clear/push, cleanFileSelection,
      updateFileListState) OR run the re-anchor immediately after the
      fetch promise resolves but before any React reaction can fire — verify
      against MobX `transaction` semantics that no intermediate render observes
      `firstItem` out of range.
- [x] 4. Add a `docs/TOOLS.md` note: the fetch path (`updateFromBackend`) does
      not by itself reconcile `firstItem`; any refetch performed while
      `isSlideMode` is true must pin the viewed file by identity (use this
      primitive) to avoid unmounting SlideMode.
- [x] 5. Keep the change additive — do NOT alter the default `refetch()`/
      `updateFromBackend` behavior for non-SlideMode callers (they must remain
      unaffected to avoid regressing gallery refetch behavior).

## Done When

- [x] A new primitive exists that refetches/replaces `fileList` while keeping
      SlideMode anchored to a given file by id, with the re-anchor and list
      mutation in one transaction (no transient `firstFileInView === undefined`).
- [x] When the pin file survives the refetch, the viewer stays on it (new index
      resolved via `this.index`); when it does not, the caller is told (boolean
      return) rather than firstItem being left stale.
- [x] Default `refetch()` behavior for existing non-pinned callers is unchanged.
- [x] `docs/TOOLS.md` documents the firstItem-non-reconciliation gap and the pin
      rule.
