---
id: TASK-003
title: 'Plumb library ID through the full initialization chain (main process to renderer to stores)'
investigation: INV-001
status: DONE
priority: high
blocked_by: [TASK-001, TASK-002]
date_created: 2026-04-04
date_completed: 2026-04-20
files:
  - 'src/main.ts'
  - 'src/renderer.tsx'
  - 'src/frontend/stores/RootStore.ts'
  - 'src/frontend/stores/UiStore.ts'
  - 'src/frontend/stores/FileStore.ts'
  - 'src/frontend/stores/LocationStore.ts'
  - 'src/backend/sqlite-config.ts'
  - 'common/library-registry.ts'
  - 'src/ipc/renderer.ts'
  - 'src/ipc/messages.ts'
---

## What

Wire the active library ID from the main process through to the renderer process, and use it at every point where storage is accessed: database initialization, localStorage key construction, default thumbnail/backup directory paths, and backup scheduler setup.

## Why

TASK-001 created the library registry and TASK-002 parameterized all storage identifiers. This task connects them: when the app starts, the active library ID determines which database, localStorage namespace, and directories are used.

See [INV-001](../investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md).

## Implementation Steps

- [x] 1. **`src/main.ts`** — After initializing the `LibraryRegistry`, read the active library ID. Pass it to the renderer via the URL query parameter on the `loadURL` call:
  ```typescript
  const activeLibraryId = registry.getActiveLibraryId();
  // In createWindow():
  mainWindow.loadURL(`file://${__dirname}/index.html?libraryId=${activeLibraryId}`);
  // In createPreviewWindow():
  previewWindow.loadURL(`file://${__dirname}/index.html?preview=true&libraryId=${activeLibraryId}`);
  ```
  If `activeLibraryId` is null (fresh install before migration), pass nothing or a sentinel value handled by TASK-006.
  Verify: The URL contains the library ID query parameter. Inspect via DevTools.

- [x] 2. **`src/renderer.tsx`** — Extract the library ID from the URL and use it to build the SQLite path:
  ```typescript
  const params = new URLSearchParams(window.location.search.slice(1));
  const libraryId = params.get('libraryId') || undefined;

  const userDataPath = await RendererMessenger.getPath('userData');
  const dbPath = libraryId
    ? getSqliteDbPath(userDataPath, libraryId)                 // {userData}/libraries/{id}/onefolder.db
    : path.join(userDataPath, SQLITE_DB_FILENAME);             // legacy flat path — only reached pre-migration
  await fse.ensureDir(path.dirname(dbPath));
  const db = sqliteInit(dbPath);
  ```
  The `migrateIfNeeded(dbPath)` call that currently runs before `sqliteInit` must be passed the library-scoped `dbPath` so the IndexedDB → SQLite migration (if it has not yet run) writes into the correct location.
  Pass `libraryId` to `runMainApp()` and `runPreviewApp()`.
  Verify: The per-library `.db` file appears at `{userData}/libraries/{libraryId}/onefolder.db` on disk. The legacy flat path is no longer created for new libraries.

- [x] 3. **`src/renderer.tsx` — `runMainApp()`** — Use `libraryId` to construct the backup directory:
  ```typescript
  const defaultBackupDirectory = await RendererMessenger.getDefaultBackupDirectory(libraryId);
  ```
  `SQLiteBackupScheduler.init(db, dbPath, defaultBackupDirectory)` then writes backups into the library-specific directory automatically.
  Verify: Backup files are created in the library-specific subdirectory.

- [x] 4. **`src/frontend/stores/RootStore.ts`** — Accept `libraryId` in the constructor. Propagate it to:
  - `UiStore` (for localStorage key prefix and default thumbnail directory).
  - `FileStore` (for localStorage key prefix).
  - `LocationStore` (for localStorage key prefix via the shared preferences key).
  - `ExifIO` initialization (for the namespaced `hierarchical-separator` key).
  Modify both `RootStore.main()` and `RootStore.preview()` to accept and pass `libraryId`.
  Verify: All stores use the namespaced keys. Inspect localStorage in DevTools.

- [x] 5. **`src/frontend/stores/UiStore.ts`** — In `recoverPersistentPreferences()`, use the namespaced key to read preferences. In the default thumbnail directory fallback (line 1046-1051), pass `libraryId`:
  ```typescript
  RendererMessenger.getDefaultThumbnailDirectory(this.libraryId).then(...)
  ```
  Verify: Thumbnail directory defaults to the library-specific path.

- [x] 6. **Update `renderer.tsx` reactions** — The `reaction()` calls that persist preferences to localStorage must use the namespaced keys:
  ```typescript
  localStorage.setItem(getFileStorageKey(libraryId), JSON.stringify(preferences));
  localStorage.setItem(getPreferencesStorageKey(libraryId), JSON.stringify(preferences));
  ```
  Verify: Preferences are stored under namespaced keys in localStorage.

- [x] 7. **Add IPC handler for getting active library ID from renderer** — Add `RendererMessenger.getActiveLibraryId()` that queries the main process. This is needed for the library selector (TASK-004) and for teardown/switch (TASK-005).
  Verify: Renderer can query and receive the active library ID.

## Done When

- [x] The active library ID flows from `libraries.json` in the main process to every storage access point in the renderer.
- [x] The SQLite database is opened at a library-specific file path (`{userData}/libraries/{libraryId}/onefolder.db`).
- [x] All localStorage keys are namespaced with the library ID.
- [x] Default thumbnail and backup directories are library-specific.
- [x] The preview window receives the same library ID as the main window.
- [x] With a single library, the app behaves identically to before (just with namespaced storage).
