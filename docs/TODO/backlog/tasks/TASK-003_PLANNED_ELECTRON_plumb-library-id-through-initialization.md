---
id: TASK-003
title: 'Plumb library ID through the full initialization chain (main process to renderer to stores)'
investigation: INV-001
status: planned
priority: high
blocked_by: [TASK-001, TASK-002]
date_created: 2026-04-04
date_completed:
files:
  - 'src/main.ts'
  - 'src/renderer.tsx'
  - 'src/frontend/stores/RootStore.ts'
  - 'src/frontend/stores/UiStore.ts'
  - 'src/frontend/stores/FileStore.ts'
  - 'src/frontend/stores/LocationStore.ts'
  - 'src/backend/config.ts'
  - 'src/ipc/renderer.ts'
  - 'src/ipc/messages.ts'
---

## What

Wire the active library ID from the main process through to the renderer process, and use it at every point where storage is accessed: database initialization, localStorage key construction, default thumbnail/backup directory paths, and backup scheduler setup.

## Why

TASK-001 created the library registry and TASK-002 parameterized all storage identifiers. This task connects them: when the app starts, the active library ID determines which database, localStorage namespace, and directories are used.

See [INV-001](../investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md).

## Implementation Steps

- [ ] 1. **`src/main.ts`** — After initializing the `LibraryRegistry`, read the active library ID. Pass it to the renderer via the URL query parameter on the `loadURL` call:
  ```typescript
  const activeLibraryId = registry.getActiveLibraryId();
  // In createWindow():
  mainWindow.loadURL(`file://${__dirname}/index.html?libraryId=${activeLibraryId}`);
  // In createPreviewWindow():
  previewWindow.loadURL(`file://${__dirname}/index.html?preview=true&libraryId=${activeLibraryId}`);
  ```
  If `activeLibraryId` is null (fresh install before migration), pass nothing or a sentinel value handled by TASK-006.
  Verify: The URL contains the library ID query parameter. Inspect via DevTools.

- [ ] 2. **`src/renderer.tsx`** — Extract the library ID from the URL:
  ```typescript
  const params = new URLSearchParams(window.location.search.slice(1));
  const libraryId = params.get('libraryId') || undefined;
  ```
  Pass `libraryId` to `dbInit()`:
  ```typescript
  const dbName = libraryId ? getDbName(libraryId) : DB_NAME; // fallback for migration
  const db = dbInit(dbName);
  ```
  Pass `libraryId` to `runMainApp()` and `runPreviewApp()`.
  Verify: The correct IndexedDB name appears in DevTools > Application > IndexedDB.

- [ ] 3. **`src/renderer.tsx` — `runMainApp()`** — Use `libraryId` to construct the backup directory:
  ```typescript
  const defaultBackupDirectory = await RendererMessenger.getDefaultBackupDirectory(libraryId);
  ```
  Verify: Backup files are created in the library-specific subdirectory.

- [ ] 4. **`src/frontend/stores/RootStore.ts`** — Accept `libraryId` in the constructor. Propagate it to:
  - `UiStore` (for localStorage key prefix and default thumbnail directory).
  - `FileStore` (for localStorage key prefix).
  - `LocationStore` (for localStorage key prefix via the shared preferences key).
  - `ExifIO` initialization (for the namespaced `hierarchical-separator` key).
  Modify both `RootStore.main()` and `RootStore.preview()` to accept and pass `libraryId`.
  Verify: All stores use the namespaced keys. Inspect localStorage in DevTools.

- [ ] 5. **`src/frontend/stores/UiStore.ts`** — In `recoverPersistentPreferences()`, use the namespaced key to read preferences. In the default thumbnail directory fallback (line 1046-1051), pass `libraryId`:
  ```typescript
  RendererMessenger.getDefaultThumbnailDirectory(this.libraryId).then(...)
  ```
  Verify: Thumbnail directory defaults to the library-specific path.

- [ ] 6. **Update `renderer.tsx` reactions** — The `reaction()` calls that persist preferences to localStorage must use the namespaced keys:
  ```typescript
  localStorage.setItem(getFileStorageKey(libraryId), JSON.stringify(preferences));
  localStorage.setItem(getPreferencesStorageKey(libraryId), JSON.stringify(preferences));
  ```
  Verify: Preferences are stored under namespaced keys in localStorage.

- [ ] 7. **Add IPC handler for getting active library ID from renderer** — Add `RendererMessenger.getActiveLibraryId()` that queries the main process. This is needed for the library selector (TASK-004) and for teardown/switch (TASK-005).
  Verify: Renderer can query and receive the active library ID.

## Done When

- [ ] The active library ID flows from `libraries.json` in the main process to every storage access point in the renderer.
- [ ] IndexedDB is created with a library-specific name.
- [ ] All localStorage keys are namespaced with the library ID.
- [ ] Default thumbnail and backup directories are library-specific.
- [ ] The preview window receives the same library ID as the main window.
- [ ] With a single library, the app behaves identically to before (just with namespaced storage).
