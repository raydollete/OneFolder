---
id: TASK-123
title: 'Re-select the auto-advanced-to file after a SlideMode delete so the next delete is armed'
investigation: INV-033
status: done
priority: high
blocked_by: []
date_created: 2026-06-19
date_completed: 2026-06-19
files:
  - 'src/frontend/stores/FileStore.ts'
---

## What

In `FileStore.removeFilesFromListInPlace`, after the auto-advance logic
reconciles `uiStore.firstItem` to the file the SlideMode viewer should now show,
also make that file the sole entry in `uiStore.fileSelection` — but only when
`uiStore.isSlideMode` is true. This keeps the viewed file and the selected file
in sync so the next Delete (which is selection-driven) targets the on-screen
file instead of an empty selection.

## Why

The delete command (`MoveFilesToTrashBin` / `openMoveFilesToTrash` / the Delete
hotkey) acts on `uiStore.fileSelection`. After a SlideMode delete,
`removeFilesFromListInPlace` advances `firstItem` to the next file but
`cleanFileSelection()` has already dropped the deleted file and nothing
re-selects the advanced-to file, so the selection is empty and the next delete
is a silent no-op until the user navigates away and back. Manual nav
(`incrImgIndex`/`decrImgIndex`) and `DeleteOriginalAfterJob.handleKeepOriginal`
already call `selectFile(..., true)`; the auto-advance path is the one place that
forgot to.

See [INV-033](../investigations/INV-033_HIGH_FRONTEND_slidemode-delete-leaves-empty-selection-second-delete-noops.md).

## Implementation Steps

- [x] 1. In `src/frontend/stores/FileStore.ts`, locate `removeFilesFromListInPlace`
      (currently ~lines 716-822). Identify the three `firstItem`-reconciliation
      branches after `cleanFileSelection()`:
        (a) empty-list branch (`fileList.length === 0`) — leave UNCHANGED
            (SlideMode is disabled; nothing to select).
        (b) "viewed file was deleted" branch — computes `targetFile` (forward
            then backward scan) and sets `uiStore.firstItem = newIndex`.
        (c) "viewed file survived" branch — sets `uiStore.firstItem` to the
            viewed file's new index.
- [x] 2. In branches (b) and (c), when `uiStore.isSlideMode === true` and a
      target file is resolved, make it the sole selection. Used preferred approach:
      kept existing `uiStore.firstItem = newIndex` assignment and added
      `uiStore.fileSelection.replace([targetFile])` immediately after it.
- [x] 3. Gate every new selection write on `uiStore.isSlideMode` so grid-only
      (non-SlideMode) deletes keep their current behavior (selection ends empty;
      the grid is not armed for an implicit single-file delete).
- [x] 4. Keep all new writes inside the existing `@action` so the splice,
      `firstItem`, and `fileSelection` commit in one MobX transaction (no
      intermediate frame where the viewed file and the selection disagree).
- [x] 5. Add a short code comment referencing INV-033 explaining the invariant:
      "while in SlideMode the viewed file must also be the selected file, because
      the delete command is selection-driven."
- [x] 6. Build/typecheck: `yarn lint` passes with no new errors. Full test suite (157 tests, 20 suites) passes.

## Done When

- [x] After `removeFilesFromListInPlace([viewedFile])` with `isSlideMode === true`,
      `uiStore.fileSelection` contains exactly the advanced-to file and
      `uiStore.firstItem` points at it.
- [x] The empty-list branch still disables SlideMode and leaves the selection
      empty.
- [x] Non-SlideMode deletes are unchanged (selection ends empty).
- [x] `firstItem` has a single writer per branch (no redundant double-write).
- [x] Project builds/typechecks cleanly.
