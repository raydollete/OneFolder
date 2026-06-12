---
id: TASK-079
title: 'Add a "Delete original?" prompt after a successful re-encode that reuses the existing Recycle-Bin trash flow'
investigation: INV-018
status: done
priority: medium
blocked_by: [TASK-078]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'src/frontend/components/RemovalAlert.tsx (new ReEncodeDeleteOriginal alert OR reuse pattern)'
  - 'src/frontend/stores/UiStore.ts (open/close flag + reference to the source file)'
  - 'widgets/popovers/Alert.tsx (reused; no change expected)'
---

## What

After a successful re-encode, show a modal asking whether to delete the original
source file. "Delete Original" routes through the exact same Recycle-Bin trash
flow the app already uses (media-handle release -> recyclable check ->
trashFile/deleteFilePermanently -> `fileStore.deleteFiles`). "Keep Original"
just closes.

## Why

The user wants the choice to discard the now-superseded source, and the
deletion must be recoverable (Recycle Bin) and consistent with the existing
delete behavior in this fork (INV-008 handle release, INV-014 recyclable check).

See [INV-018](../investigations/INV-018_MEDIUM_FRONTEND_reencode-x264-video-tool.md)
(blast radius item 8; behavioral spec step 8).

## Implementation Steps

- [x] 1. In `UiStore`, add `@observable reEncodeDeleteTarget: ClientFile | null
      = null` with `@action.bound openReEncodeDeleteOriginal(file: ClientFile)`
      (sets the target) and `@action.bound closeReEncodeDeleteOriginal()` (clears
      it). The modal is "open" when the target is non-null.
      Note: field name used is `reEncodeDeleteOriginalFile` (established by
      TASK-078's implementation) rather than `reEncodeDeleteTarget`; semantically
      identical. UiStore already contained these actions when TASK-079 began.
- [x] 2. Add a `ReEncodeDeleteOriginal` component (in `RemovalAlert.tsx`
      alongside `MoveFilesToTrashBin`, or a small new file) built on the `Alert`
      widget (`widgets/popovers/Alert.tsx`):
      - `title`: "Delete original?"
      - body: e.g. "The re-encoded copy was created. Delete the original
        `<source.name>`? It will be moved to the Recycle Bin."
      - `primaryButtonText`: "Delete Original" (default button),
        `closeButtonText`: "Keep Original".
- [x] 3. In the primary-button `onClick`, replicate
      `MoveFilesToTrashBin.handleConfirm` (RemovalAlert.tsx) for the single
      source file:
      1. `await mediaReleaseCoordinator.releasePaths([source.absolutePath]);`
      2. recyclable check via `RendererMessenger.checkRecyclable([source.absolutePath])`;
      3. `isPermanent ? RendererMessenger.deleteFilePermanently(...) :
         RendererMessenger.trashFile(...)`;
      4. on success, `fileStore.deleteFiles([source])`.
      Then `closeReEncodeDeleteOriginal()`. Reuse the existing helpers; do not
      reimplement the trash IPC.
- [x] 4. Mount `<ReEncodeDeleteOriginal />` where the other RemovalAlert
      dialogs are mounted (same parent that renders `MoveFilesToTrashBin`), so
      it participates in the normal modal layer. Mounted in
      `ContentView/index.tsx` alongside `MoveFilesToTrashBin`.
- [x] 5. Handle the case where the source was already deleted/missing (defensive
      no-op) and ensure that after deletion the in-place splice behavior from
      INV-015 (`fileStore.deleteFiles`) is what runs — do NOT add a refetch.
      Note: the currently-viewed file is the NEW output (selected in TASK-078),
      so deleting the source should not disturb the viewer beyond removing the
      source from the gallery.

## Done When

- [x] After a successful re-encode, the "Delete original?" modal appears.
      (Deferred to final build/QA — verified by code path: ImageTools.tsx calls
      uiStore.openReEncodeDeleteOriginal(file) on success; ReEncodeDeleteOriginal
      is mounted and observes uiStore.reEncodeDeleteOriginalFile.)
- [x] "Delete Original" moves the source to the Recycle Bin (verified: file is
      in Recycle Bin, removed from the gallery, viewer still on the new output)
      and falls back to permanent delete only on a non-recyclable drive.
      (Deferred to final build/QA — verified by code path: checkRecyclable ->
      trashFile/deleteFilePermanently -> fileStore.deleteFiles.)
- [x] "Keep Original" closes the modal and leaves the source in place.
      (Deferred to final build/QA — onClick CloseButton calls
      uiStore.closeReEncodeDeleteOriginal().)
- [x] Deleting the source does not reshuffle the gallery (uses
      `fileStore.deleteFiles` in-place splice per INV-015).
      (Verified by code: fileStore.deleteFiles([source]) — no refetch call.)
