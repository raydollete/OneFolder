---
id: TASK-018
title: 'Delete on-disk library data (SQLite DB, backups, thumbnails) when removing a library'
investigation: INV-001
status: done
priority: medium
blocked_by: []
date_created: 2026-04-21
date_completed: 2026-04-21
files:
  - 'src/frontend/containers/LibrarySelector.tsx'
  - 'src/ipc/messages.ts'
  - 'src/ipc/main.ts'
  - 'src/ipc/renderer.ts'
  - 'src/main.ts'
  - 'common/library-registry.ts'
---

## What

Add an opt-in "Also delete files from disk" option to the library-delete flow in `LibrarySelector`. When checked, a new main-process IPC handler removes the library's per-library subdirectory (`{basePath}/libraries/{libraryId}/` — which contains `onefolder.db`, its `-wal`/`-shm` sidecars, and the `backups/` subdirectory) along with the library's thumbnail subdirectory. When unchecked, behavior is unchanged from the current "remove from registry only" flow.

This closes the gap from TASK-004 step 1 (where on-disk cleanup was noted as optional and then skipped) and from the QA review finding on INV-001 that deleted libraries currently leak their database, WAL/SHM sidecars, backup directory, and thumbnail cache on disk.

## Why

Today, deleting a library via `LibrarySelector.handleDelete` calls `RendererMessenger.deleteLibrary(id)` which invokes `LibraryRegistry.deleteLibrary` — and that method explicitly documents in its docstring that it "Does NOT delete the library's database, backups, or thumbnail cache — that is the caller's responsibility." No caller currently does that cleanup, so orphan files accumulate under `{userData}/libraries/{libraryId}/` and `{tempOrPortable}/.../{libraryId}/thumbnails/` forever.

Because database contents can be genuinely irreplaceable (the tag hierarchy, saved searches, and dismissed-duplicate history are not recoverable from the source photo files), the global `CLAUDE.md` rule forbids deleting data without explicit user confirmation. This task therefore defines the cleanup as **opt-in** behind a clearly labeled checkbox in the confirmation dialog, with copy that warns the data is unrecoverable.

See [INV-001](../../pending_qa/investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md) and the original (incomplete) on-disk cleanup note in step 1 of [TASK-004](../../pending_qa/tasks/TASK-004_DONE_FRONTEND_library-selector-ui.md).

## Implementation Steps

### UX (renderer)

- [x] 1. **Replace the `window.confirm` in `LibrarySelector.tsx` with a small inline confirmation dialog or two-stage modal** that contains:
  - Title: `Delete library "{name}"?`
  - Body paragraph 1: `This will remove the library from the list.`
  - A checkbox, **unchecked by default**, labeled: `Also permanently delete this library's database, backups, and thumbnail cache from disk. This cannot be undone.`
  - Two buttons: `Cancel` (default focus) and `Delete` (destructive styling — match the existing `IconSet.DELETE` / outlined-red convention used elsewhere).
  - When the checkbox is **checked** at the moment the user clicks `Delete`, a second confirmation step is required. Acceptable implementations (pick one that matches existing patterns in the codebase):
    - (a) The button label changes to `Delete files` (red) and the body text updates to show the absolute paths that will be removed (fetched via a new `RendererMessenger.getLibraryDiskPaths(id)` call — see step 3), OR
    - (b) A second `window.confirm` immediately after clicking `Delete` that types out the absolute paths and requires a final OK.
  - When the checkbox is **unchecked**, one click of `Delete` proceeds (matches today's behavior; this is a non-destructive metadata-only removal).

  Keep using `Button` / `ButtonGroup` / `IconSet` from `widgets`. Reuse any existing confirmation-dialog primitive in the codebase if one exists (search `containers/` for an existing "destructive confirm" pattern before introducing a new one).

  Verify: rendering both states (checked / unchecked) shows the correct button label and copy; focus defaults to `Cancel`; `Escape` dismisses the dialog.

- [x] 2. **Wire the dialog result into the delete flow.** `handleDelete` must now branch:
  - If confirmed with checkbox **unchecked**: call the existing `RendererMessenger.deleteLibrary(id)` (registry-only removal). Update local state as today.
  - If confirmed with checkbox **checked**: call the new `RendererMessenger.deleteLibraryAndFiles(id)` (defined in step 4) which atomically removes BOTH the on-disk data AND the registry entry in a single main-process operation. Update local state after it resolves.
  - The active-library guard (`if (libraries.length <= 1) { ... cannot delete the last library. ... }`) stays in place. Renaming/rewording the copy in the dialog is fine as long as the checkbox wording above is preserved exactly.

  Verify: deleting with checkbox off still leaves files on disk (matches today); deleting with checkbox on removes them.

### Backend (main process)

- [x] 3. **Add a path-query IPC endpoint** so the renderer can display the exact absolute paths that will be removed (required for UX step 1a):
  - `GET_LIBRARY_DISK_PATHS` in `src/ipc/messages.ts`.
  - `MainMessenger.onGetLibraryDiskPaths(cb)` in `src/ipc/main.ts`.
  - `RendererMessenger.getLibraryDiskPaths(id): Promise<{ libraryDir: string; thumbnailDir: string; dbPath: string }>` in `src/ipc/renderer.ts`.
  - Main-process handler in `src/main.ts` returns:
    ```
    {
      libraryDir:   path.join(basePath, 'libraries', libraryId),  // contains onefolder.db, -wal, -shm, backups/
      dbPath:       getSqliteDbPath(basePath, libraryId),         // informational (lives inside libraryDir)
      thumbnailDir: <resolved via the same logic as getDefaultThumbnailDirectory but for main>
    }
    ```
    For `thumbnailDir`: mirror `RendererMessenger.getDefaultThumbnailDirectory(libraryId)` logic in the main process — portable mode uses `{userData}/thumbnails/{libraryId}`, non-portable uses `{temp}/OneFolder/{libraryId}/thumbnails`. Extract the per-library thumbnail path computation into a shared helper in `common/library-registry.ts` (e.g. `getDefaultThumbnailDir(basePath, tempPath, isPortable, libraryId)`) so main and renderer share one source of truth.

  Verify: calling `getLibraryDiskPaths(id)` from the renderer returns the correct paths in both portable and non-portable mode.

- [x] 4. **Add the destructive IPC endpoint** that performs registry + filesystem deletion together:
  - `DELETE_LIBRARY_AND_FILES` in `src/ipc/messages.ts`.
  - `MainMessenger.onDeleteLibraryAndFiles(cb: (id: string) => Promise<DeleteLibraryAndFilesResult>)` in `src/ipc/main.ts`.
  - `RendererMessenger.deleteLibraryAndFiles(id): Promise<DeleteLibraryAndFilesResult>` in `src/ipc/renderer.ts`.
  - `DeleteLibraryAndFilesResult` DTO (define in `src/ipc/messages.ts`):
    ```
    { removedPaths: string[]; failedPaths: { path: string; error: string }[] }
    ```
  - Main-process handler in `src/main.ts`:
    1. **Safety gate**: refuse if `id === registry.getActiveLibraryId()` — return an error result. (LibrarySelector already hides the Delete button for the active library; this is defense in depth.)
    2. **Safety gate**: refuse if `registry.getLibraries().length <= 1` — return an error result. (Same reasoning.)
    3. Resolve the three absolute paths using the step-3 helpers.
    4. **Path-sanity assertion**: each resolved path MUST satisfy `path.resolve(p).startsWith(path.resolve(basePath))` for `libraryDir`, and must be inside the expected temp/userData root for `thumbnailDir`. Reject anything else to prevent a malformed library ID (e.g. `..`) from escaping the library root. If the assertion fails, return an error result with no filesystem changes.
    5. Attempt removal of each path in this order: thumbnail directory, then `{basePath}/libraries/{libraryId}/` (which recursively removes `onefolder.db`, `-wal`, `-shm`, and `backups/`). Use `fse.remove` (idempotent — does not throw if the path is absent). Collect per-path errors into `failedPaths` rather than aborting.
    6. **Only if all attempted removals succeeded** (or all failed paths were `ENOENT`), call `registry.deleteLibrary(id)` so the registry row is not orphaned relative to data that is still on disk. If any removal failed with a non-`ENOENT` error, leave the registry entry intact and return the error — this lets the user retry after fixing the underlying problem (e.g. a file-lock from an external tool).
    7. Return the `DeleteLibraryAndFilesResult` to the renderer.

  Verify: deleting a library with the checkbox on removes `{basePath}/libraries/{id}/` (including `onefolder.db`, any `-wal`/`-shm` sidecars, and `backups/`) AND the per-library thumbnail directory. The registry no longer lists the library. The `libraries.json` file is unchanged when deletion fails.

### Failure handling (renderer)

- [x] 5. **Surface partial-delete results in the UI.** After `deleteLibraryAndFiles` resolves:
  - If `failedPaths.length === 0`: remove the library from the local `libraries` state as today.
  - If `failedPaths.length > 0` AND the registry entry was NOT removed (handler step 6 aborted): show an error dialog listing the failed paths + error messages, keep the library in the list, and allow the user to retry. Recommended copy: `Could not delete some files for library "{name}". The library has been kept in the list so you can retry. Failed paths: ...`
  - (There is no "partial success" branch where only some filesystem paths were removed but the registry was still updated — the handler contract in step 4.6 prevents that.)

  Verify: simulate a locked file (e.g. open the SQLite file in another process) and confirm the UI shows a retryable error and the library remains in the list.

### Tests / manual QA

- [ ] 6. **Manual QA matrix.** Exercise each of these on both Windows-installed mode and portable mode: (deferred to QA — requires running app)
  - Delete with checkbox off → registry entry gone; `libraries/{id}/` and thumbnail dir still on disk.
  - Delete with checkbox on → registry entry gone; both directories removed; no stray WAL/SHM sidecars left.
  - Delete with checkbox on when thumbnail directory was customized by the user via `Settings > Advanced` (so it does not match the default) → the **default** thumbnail dir is what we remove. Document this in the dialog copy: e.g. `thumbnail cache (default location only)`. If time permits, also persist the actual `thumbnailDirectory` string per library in the registry so we can clean a user-customized dir too — but this is **out of scope** for this task; call it out in the comments and leave it as a follow-up.
  - Delete when another process holds the SQLite file open (simulate with `sqlite3.exe`) → renderer shows the retry dialog; registry entry remains; no half-deleted state.
  - Delete with a crafted library ID containing `..` (only reachable by editing `libraries.json` manually; still worth asserting in a unit test if one exists for `LibraryRegistry`) → handler rejects with the path-sanity error, no filesystem changes.

  Verify: capture screenshots of the new dialog in both checkbox states and attach to the QA record.

## Done When

- [x] `LibrarySelector` shows an opt-in checkbox to delete on-disk data; the checkbox is unchecked by default and requires a second confirmation when checked.
- [x] A new main-process IPC handler `DELETE_LIBRARY_AND_FILES` removes `{basePath}/libraries/{libraryId}/` (DB + WAL/SHM + backups) and the per-library default thumbnail directory, then updates `libraries.json` — all atomically relative to the registry.
- [x] The handler validates that the resolved paths are inside the expected roots and refuses to operate on the active library or the last remaining library.
- [x] Failures from individual `fse.remove` calls are surfaced to the UI with the per-path error, and the registry is not updated when cleanup fails.
- [x] Portable mode and installed mode both route to the correct base / temp paths via a shared helper in `common/library-registry.ts`.
- [x] Existing `DELETE_LIBRARY` behavior (registry-only removal) is preserved and remains the default branch.
- [ ] Manual QA matrix in step 6 passes on Windows portable + installed builds. (Deferred to QA review — requires live app execution.)
