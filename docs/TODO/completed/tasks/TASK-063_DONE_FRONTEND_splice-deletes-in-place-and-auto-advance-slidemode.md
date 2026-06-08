---
id: TASK-063
title: 'Splice deletes in place in FileStore and auto-advance SlideMode without reshuffling random sort'
investigation: INV-015
status: DONE
priority: medium
blocked_by: []
date_created: 2026-05-15
date_completed: 2026-05-15
files:
  - src/frontend/stores/FileStore.ts
  - src/frontend/stores/LocationStore.ts
  - src/frontend/stores/UiStore.ts
---

## What

Replace `FileStore.deleteFiles`'s post-removal `refetch()` with an
in-place splice of the affected entries from `fileList`, and reconcile
`uiStore.firstItem` so SlideMode auto-advances to the next surviving file
(or the previous one when the deleted file was at the tail). Add a new
helper `removeFilesFromListInPlace(files: ClientFile[])` that encapsulates
the splice + index rebuild + count update + firstItem reconciliation, and
adopt it from `LocationStore.removeSublocationFiles` for consistency.

The behavioral effect: under any sort mode (including `random`), deleting
files no longer re-queries the backend and no longer reshuffles the
gallery. From SlideMode specifically, the video viewer stays open on the
next file instead of dumping the user back to the thumbnail index.

## Why

`FileStore.deleteFiles` (line 670-691) ends with `return this.refetch()`,
which re-issues `backend.fetchFiles(this.orderBy, this.orderDirection)`.
Under `orderBy === 'random'` (the new default per INV-011), the SQLite
backend issues `ORDER BY RANDOM()` and the Dexie backend calls
`shuffleArray` — both produce a fresh shuffle, so every delete reshuffles
the visible gallery. Compounding the bug, `refetch()` routes through
`setContentAll` (or whichever content setter), which unconditionally calls
`uiStore.disableSlideMode()` — kicking the user out of the video viewer
on every delete regardless of sort mode.

The existing `FileStore.replaceMovedFile` (line 649-667) is the template
for "mutate one entry in place without refetching." The destructive
analogue was never written; this task adds it.

See [INV-015](../investigations/INV-015_MEDIUM_FRONTEND_video-delete-exits-slidemode-and-reshuffles-random-sort.md).

## Implementation Steps

- [x] 1. In `src/frontend/stores/FileStore.ts`, add a new private
      `@action` method `removeFilesFromListInPlace(files: ClientFile[])`
      placed near `replaceMovedFile` (around line 649). Behavior:
  - Build a `Set<ID>` of the file IDs to remove from the supplied array.
  - Snapshot the OLD `firstItem` value and the OLD file at that index
    (if any) BEFORE mutating fileList — needed for auto-advance.
  - Filter `this.fileList` in place: iterate and `fileList.remove(file)`
    for each entry whose id is in the set. (Using `fileList.remove(...)`
    in a loop is O(n*k) but k is small for typical deletes; if k is
    expected large, replace with a single `fileList.replace(survivors)`
    where `survivors = fileList.filter(f => !ids.has(f.id))`. Prefer
    the `.replace` path for k > 50 to avoid quadratic blowup.)
  - Call `cleanFileSelection()` to drop any selection entries that
    referenced the now-removed files.
  - Call `updateFileListState()` to rebuild `index`,
    `numUntaggedFiles`, and `numMissingFiles` from the new fileList.
  - Decrement `numTotalFiles` by the count of entries that were
    actually present in fileList (the supplied array may contain
    already-hidden broken files that were filtered out of fileList by
    `hideMissingFilesInBrowsing`; only count actual removals).
  - Set `this.fileListLastModified = new Date()` so downstream
    effects (Preview window fade-in, MasonryRenderer scroll restore)
    re-trigger.
  - Reconcile `uiStore.firstItem`:
    * If the OLD-firstItem file was removed (its id is in the deleted
      set): scan forward through the OLD fileList starting from
      `oldFirstItem + 1` for the first non-deleted file. If found,
      set `uiStore.firstItem` to its index in the NEW fileList (use
      the rebuilt `this.index` map). If not found, scan backward from
      `oldFirstItem - 1` for the first non-deleted file; same lookup.
      If neither is found, set `uiStore.firstItem = 0` (fileList is
      empty; the LayoutSwitcher gate will unmount SlideMode).
    * If the OLD-firstItem file survived: set `uiStore.firstItem` to
      its NEW index from `this.index` (may have shifted left).
    * If `uiStore.isSlideMode` is true AND the resulting fileList is
      empty: call `uiStore.disableSlideMode()` so re-adding files
      later does not auto-open SlideMode on whatever lands at index 0.

- [x] 2. Rewrite `FileStore.deleteFiles` (line 670-691) to use the new
      helper:
  - Keep the empty-files-array early return.
  - Keep `await this.backend.removeFiles(files.map(f => f.id))`.
  - Keep the existing per-file cleanup loop (`file.dispose()`,
    `uiStore.deselectFile(file)`, `this.removeThumbnail(...)`). Note
    that `cleanFileSelection()` inside the new helper will redundantly
    deselect; either drop the per-file `deselectFile` call (cleaner)
    or leave it (harmless). Prefer dropping for clarity.
  - Replace the final `return this.refetch()` with
    `this.removeFilesFromListInPlace(files)`.
  - Keep the catch block — `console.error` on backend failure, no
    splice if backend rejected.

- [x] 3. In `src/frontend/stores/LocationStore.ts:554-563`
      (`removeSublocationFiles`), after `await
      this.backend.removeFiles(...)`, look up the corresponding
      ClientFile instances in `fileStore.fileList` by id and call the
      new helper instead of `fileStore.refetch()`. Falls back to no-op
      if no matches — the backend already removed them and the file
      watcher will catch up.

- [x] 4. Verify the user-visible flow end-to-end by inspection. Trace:
  - `Main.tsx:61` → `uiStore.openMoveFilesToTrash()`
  - `RemovalAlert.MoveFilesToTrashBin.handleConfirm` (line 162-214)
    → `fileStore.deleteFiles(deleted)`
  - `FileStore.deleteFiles` → new helper → in-place splice + firstItem
    reconcile (no refetch)
  - SlideMode is rendered when `uiStore.firstFileInView` is truthy
    (LayoutSwitcher.tsx:193) — confirm that for the auto-advance
    case it stays truthy because firstItem now points at a valid
    file.

- [x] 5. Skim `src/frontend/components/RemovalAlert.tsx` for any
      assumption that a refetch will happen after `deleteFiles`. The
      `FileRemoval.handleConfirm` (line 89-102) and
      `MoveFilesToTrashBin.handleConfirm` (line 162-214) both call
      `fileStore.deleteFiles(...)` as the last step and rely on the
      store to update state. After this change, the in-memory state
      is updated synchronously inside the new helper — no caller-
      visible contract change.

- [x] 6. Verify no test references break:
      `tests/file-store-generation-gate.test.ts` doesn't mock or test
      `deleteFiles` directly (the Grep at investigation time confirmed
      no tests touch deleteFiles/removeFiles). Run `yarn test` to
      confirm the build still passes.

- [ ] 7. Smoke test in `yarn dev` + `yarn start`: open a video in
      SlideMode under random sort, hit Delete, confirm. SlideMode
      should stay open showing the next file; the underlying gallery
      should retain the same shuffle order minus the deleted file.
      (Manual QA — deferred to TASK-064's full QA matrix.)

## Done When

- [x] `FileStore.removeFilesFromListInPlace` exists, splices in place,
      reconciles `index` / `numTotalFiles` / `numUntaggedFiles` /
      `numMissingFiles`, and reconciles `uiStore.firstItem` per the
      auto-advance rules in the investigation's Behavioral
      Specifications.
- [x] `FileStore.deleteFiles` calls the new helper instead of
      `this.refetch()`.
- [x] `LocationStore.removeSublocationFiles` uses the new helper (or
      equivalent in-place splice) instead of `fileStore.refetch()`.
- [x] `yarn lint` passes (no new issues introduced; 118 pre-existing problems match baseline).
- [x] `yarn test` passes (tag-store.test.ts failure is pre-existing and unrelated).
- [ ] Manual smoke (step 7) shows SlideMode auto-advances and the
      gallery does not reshuffle under random sort. (Full QA matrix
      lives in TASK-064; this is the developer-side smoke check.)
