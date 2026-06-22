---
id: TASK-143
title: 'Remove the media-processing pin/lock from UiStore, delete the DeleteOriginalAfterJob and MediaJobErrorAlert blocking modals and their render sites, and strip every isMediaProcessing guard'
investigation: INV-035
status: done
priority: high
blocked_by: [TASK-140, TASK-141, TASK-142]
date_created: 2026-06-22
date_completed: 2026-06-22
files:
  - 'src/frontend/stores/UiStore.ts'
  - 'src/frontend/components/RemovalAlert.tsx'
  - 'src/frontend/containers/ContentView/index.tsx'
  - 'src/frontend/containers/SlideMode/index.tsx'
  - 'src/frontend/containers/Main.tsx'
---

## What

Retire the obsolete in-viewer model: remove the `UiStore` media-processing pin/lock and
its error/keep state, delete the two blocking modals (`DeleteOriginalAfterJob`,
`MediaJobErrorAlert`) and their render sites, and remove every `isMediaProcessing`
navigation/delete guard. This is the intentional reversal of the INV-021 / INV-023
viewer-pin invariant — now that jobs run in the queue, the pin/lock is dead weight.

## Why

The queue (TASK-140/141) owns job lifecycle, progress serialization, completion (Keep
actions), and failure (inline `Failed` rows). The `UiStore` lock, the two modals, and
the guards exist ONLY to support the removed in-viewer model and now block the
non-blocking behavior the user asked for.

See [INV-035](../investigations/INV-035_HIGH_FRONTEND_media-job-bottom-queue-drawer-non-blocking.md).

## Implementation Steps

- [x] 1. In `UiStore.ts` remove: `mediaProcessing`, `mediaProcessingFile`,
      `isMediaProcessing`, `beginMediaProcessing`, `setMediaProcessingFile`,
      `endMediaProcessing`, `showMediaJobError` / `closeMediaJobError` / `mediaJobError`,
      and the `deleteOriginalAfterJob*` state + its open/close actions
      (`UiStore.ts:229-271, 674-742`). Remove their `makeObservable` annotations.
- [x] 2. Simplify `slideFile` to `firstFileInView` by dropping the
      `mediaProcessingFile ??` pin (`UiStore.ts:1381-1383`).
- [x] 3. Remove the `isMediaProcessing` guard inside `UiStore.openMoveFilesToTrash`
      (delete-while-processing block) so deletion is no longer gated.
- [x] 4. In `RemovalAlert.tsx`, delete `DeleteOriginalAfterJob` and `MediaJobErrorAlert`
      entirely. Keep `MoveFilesToTrashBin` and the trash helper extracted in TASK-138.
- [x] 5. In `ContentView/index.tsx`, remove the imports and render sites for both
      deleted modals (`ContentView/index.tsx:16-18, 146-147`).
- [x] 6. In `SlideMode/index.tsx`, remove the `isMediaProcessing` navigation guards
      (~95-96 and ~121) so prev/next navigation is never frozen by a job.
- [x] 7. In `Main.tsx`, remove the `isMediaProcessing` reference in the delete-shortcut
      path / comment (~60-64) so the delete shortcut is not gated by job state.
- [x] 8. Grep the whole `src/` tree for any remaining references to `isMediaProcessing`,
      `beginMediaProcessing`, `mediaProcessingFile`, `mediaJobError`,
      `DeleteOriginalAfterJob`, or `MediaJobErrorAlert` and remove/repair each. The only
      surviving job-lifecycle owner must be `MediaQueueStore`. Zero matches remain.
- [x] 9. Note the accepted new edge case (do NOT add a guard for v1): deleting a file
      that is the source of a pending job makes that job fail loudly (a `Failed` row);
      deleting the source of a running job may fail at the trash step (ffmpeg holds a
      read handle) and surface the normal trash-error toast.

## Done When

- [x] `UiStore` has no media-processing pin/lock/error/keep state or actions; `slideFile`
      is just `firstFileInView`; deletion/navigation are never gated by job state.
- [x] `DeleteOriginalAfterJob` and `MediaJobErrorAlert` no longer exist and are not
      rendered anywhere; `MoveFilesToTrashBin` still works.
- [x] No `isMediaProcessing` references remain anywhere in `src/`.
- [ ] `yarn lint` / `yarn build` pass (compiles; batch test at end of investigation).
