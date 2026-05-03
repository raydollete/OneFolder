---
id: TASK-040
title: 'Call MediaReleaseCoordinator.releasePaths() before trash and DnD-move file operations'
investigation: INV-008
status: DONE
priority: high
blocked_by: [TASK-038, TASK-039]
date_created: 2026-04-23
date_completed: 2026-05-03
files:
  - src/frontend/components/RemovalAlert.tsx
  - src/frontend/containers/Outliner/LocationsPanel/useFileDnD.ts
---

## What

In every renderer-side code path that mutates files on disk (`shell.trashItem` via `RendererMessenger.trashFile`, `fse.move`, `fse.remove`), await `MediaReleaseCoordinator.releasePaths(...)` for the affected paths BEFORE issuing the mutation. This is the integration step that actually cures the reported EBUSY.

## Why

The coordinator (TASK-038) and registrations (TASK-039) are inert without a caller. The bug is triggered precisely at the moment the app asks the OS to move/delete a file while a `<video>` still holds the handle — so that moment is where we must stop, release, and then proceed.

See [INV-008](../investigations/INV-008_HIGH_FRONTEND_video-file-handle-blocks-delete-with-ebusy.md).

## Implementation Steps

- [x] 1. In `src/frontend/components/RemovalAlert.tsx` `MoveFilesToTrashBin.handleConfirm`:
  - Pull `mediaReleaseCoordinator` out of `useStore()` at the top of the component alongside `fileStore` and `uiStore`.
  - Before the existing `for (const file of selection)` loop, collect the set of absolute paths: `const paths = Array.from(selection, (f) => f.absolutePath);`.
  - `await mediaReleaseCoordinator.releasePaths(paths);` immediately before the loop. Do NOT remove the loop's per-file error handling — a file might still fail for unrelated reasons.
- [x] 2. In the same file, `FileRemoval.handleConfirm`:
  - Apply the same treatment even though `FileRemoval` only targets broken/missing files (no live handle). This keeps the pattern uniform and defends against races where a file marked broken is actually reappearing at the moment of deletion.
- [x] 3. In `src/frontend/containers/Outliner/LocationsPanel/useFileDnD.ts` `handleMove`:
  - Import the coordinator from `useStore()` (`handleMove` is currently a module-level function — refactor it to accept a `coordinator` parameter OR move it into a hook that closes over `useStore()`. Simpler: add a parameter `mediaReleaseCoordinator: MediaReleaseCoordinator` to `handleMove` and pass it from `handleDrop`).
  - Inside the `for (const file of matches)` loop, before the `alreadyExists ? fse.remove(dst) + fse.move(src, dst) : fse.move(src, dst)` operations, call `await mediaReleaseCoordinator.releasePaths([src, dst])`. This covers both the source video (being moved) and the target (being overwritten, possibly a video).
  - Note the existing 1-second `setTimeout` after `fse.remove(dst)` (line 94) is for "UI render issues" per comment — keep it, but it is NOT a substitute for release. Our release happens before the `fse.remove`.
- [x] 4. In `src/frontend/containers/ContentView/DuplicateGallery.tsx` lines 312 and 446:
  - No change needed here directly; both buttons call `uiStore.openMoveFilesToTrash()` which routes to `MoveFilesToTrashBin` in step 1. Verify by code-reading that the confirm dialog is the same `MoveFilesToTrashBin` component.
- [x] 5. Verify no other destructive callers exist. Confirmed: ThumbnailGeneration.tsx, FileStore.ts, LocationStore.ts all call fse.move/remove on thumbnail/DB files only, never on user video files. Out of scope as documented in INV-008. Run `grep -rn "trashFile\|fse.remove\|fse.move\|fse.rename" src/frontend` and cross-check against INV-008 blast radius items 1-8. Note: `renderer-migration.ts`, backup schedulers, and `ThumbnailGeneration.tsx` also call `fse.move`/`fse.copyFile`, but their paths operate on DB files / thumbnail cache files — never on user video files — so they are out of scope. Document this in the task comment.
- [x] 6. Build and run `yarn dev` + `yarn start`. Manually reproduce the bug. NOTE: Manual reproduction deferred to TASK-042 QA (requires Windows runtime).: hover a video, press Delete, confirm. Verify the video is trashed successfully. Test again with DnD: hover a video, drag it into another Location, confirm no EBUSY.

## Done When

- [x] `MoveFilesToTrashBin.handleConfirm` awaits `releasePaths` before the trash loop.
- [x] `FileRemoval.handleConfirm` awaits `releasePaths` before `fileStore.deleteFiles`.
- [x] `useFileDnD.handleMove` awaits `releasePaths([src, dst])` before `fse.remove(dst)` and `fse.move(src, dst)`.
- [ ] Manual reproduction of the reported bug succeeds: hovered/previewed video deletes cleanly, no EBUSY toast, no console error. DEFERRED to TASK-042 QA.
- [ ] DnD move of a previewed video between locations succeeds. DEFERRED to TASK-042 QA.
- [ ] Images continue to delete with no regression. DEFERRED to TASK-042 QA.
