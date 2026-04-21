---
id: TASK-002
title: 'Namespace all per-library storage (SQLite file, localStorage, directories) by library ID'
investigation: INV-001
status: DONE
priority: high
blocked_by: [TASK-001]
date_created: 2026-04-04
date_completed: 2026-04-20
files:
  - 'src/backend/sqlite-config.ts'
  - 'src/ipc/renderer.ts'
  - 'src/frontend/stores/UiStore.ts'
  - 'src/frontend/stores/FileStore.ts'
  - 'src/frontend/stores/LocationStore.ts'
  - 'src/frontend/stores/RootStore.ts'
  - 'common/library-registry.ts'
  - 'common/window.ts'
---

## What

Change every hardcoded storage identifier (SQLite database path, localStorage keys, default directories) to accept a library ID parameter, so that each library's data is fully isolated.

## Why

Currently the SQLite file is `{userData}/onefolder.db`, localStorage keys are bare strings like `'preferences'` and `'OneFolder_File'`, and default directories for thumbnails and backups point to a single shared location. All of these must be scoped per library to prevent data collisions when switching between libraries.

See [INV-001](../investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md).

## Implementation Steps

- [x] 1. **`src/backend/sqlite-config.ts` + `common/library-registry.ts`** — Introduce a helper that returns the per-library SQLite path. The filename constant `SQLITE_DB_FILENAME = 'onefolder.db'` stays; add the library-scoped directory around it:
  ```typescript
  // common/library-registry.ts (add alongside getLibraryPaths from TASK-001)
  export function getSqliteDbPath(basePath: string, libraryId: string): string {
    return path.join(basePath, 'libraries', libraryId, SQLITE_DB_FILENAME);
  }
  ```
  Re-export `SQLITE_DB_FILENAME` from `library-registry.ts` or import it from `sqlite-config.ts` directly — whichever keeps dependencies tidy. Do NOT remove the legacy `DB_NAME` constant in `src/backend/config.ts`; it is still referenced by `migration-indexeddb-to-sqlite.ts` for the one-time IndexedDB read.
  Verify: TypeScript compiles. No runtime changes yet — `renderer.tsx` still uses the flat path.

- [x] 2. **`src/ipc/renderer.ts`** — Parameterize default directory functions:
  ```typescript
  static getDefaultThumbnailDirectory = async (libraryId?: string) => {
    const tempPath = await RendererMessenger.getPath('temp');
    const subdir = libraryId ? `OneFolder/${libraryId}/thumbnails` : 'OneFolder/thumbnails';
    return path.join(tempPath, subdir);
  };

  static getDefaultBackupDirectory = async (libraryId?: string) => {
    const userDataPath = await RendererMessenger.getPath('userData');
    const subdir = libraryId ? `libraries/${libraryId}/backups` : 'backups';
    return path.join(userDataPath, subdir);
  };
  ```
  The optional parameter preserves backward compatibility until TASK-003 passes the library ID.
  Verify: Calling without arguments returns the old paths. Calling with an ID returns namespaced paths.

- [x] 3. **`src/frontend/stores/UiStore.ts`** — Make `PREFERENCES_STORAGE_KEY` dynamic:
  - Add a module-level function: `export function getPreferencesStorageKey(libraryId?: string): string { return libraryId ? \`${libraryId}:preferences\` : 'preferences'; }`
  - Keep `PREFERENCES_STORAGE_KEY` as the default export for backward compatibility.
  - In `recoverPersistentPreferences()`, `getPersistentPreferences()`, and `clearPersistentPreferences()`, use the key provided by RootStore (which will hold the library ID once TASK-003 is done). For now, add a `storageKeyPrefix` parameter to the UiStore constructor (defaulting to empty string).
  Verify: With empty prefix, behavior is identical to current. With a prefix, keys are namespaced.

- [x] 4. **`src/frontend/stores/FileStore.ts`** — Make `FILE_STORAGE_KEY` dynamic:
  - Same pattern as UiStore: add a `storageKeyPrefix` constructor parameter.
  - The key becomes `{prefix}:OneFolder_File` when prefix is non-empty, otherwise `'OneFolder_File'`.
  Verify: Same verification approach as step 3.

- [x] 5. **`src/frontend/stores/LocationStore.ts`** — The LocationStore reads `PREFERENCES_STORAGE_KEY` directly on line 58. It must use the same namespaced key as UiStore. Pass the key through from RootStore or accept the same prefix parameter.
  Verify: Enabled extensions are read from the correct namespaced key.

- [x] 6. **`common/window.ts`** — Make `WINDOW_STORAGE_KEY` available for namespacing. Window state (fullscreen) is stored per this key. Decision: keep this GLOBAL (not per-library) since window position is a system concern, not a library concern. Document this decision with a comment.
  Verify: No functional change.

- [x] 7. **`src/frontend/stores/RootStore.ts` line 56** — The `'hierarchical-separator'` localStorage key must also be namespaced. Change to: `localStorage.getItem(\`${prefix}:hierarchical-separator\`) || undefined`.
  Verify: ExifIO is initialized with the correct separator for the active library.

## Done When

- [x] `getSqliteDbPath(basePath, libraryId)` helper exists and returns a unique per-library SQLite file path (`{basePath}/libraries/{libraryId}/onefolder.db`).
- [x] All localStorage keys used by UiStore, FileStore, LocationStore, and RootStore accept a prefix parameter.
- [x] Default thumbnail and backup directory functions accept an optional library ID.
- [x] With no library ID provided, all behavior is 100% identical to current behavior (backward compatible).
- [x] The legacy Dexie `DB_NAME` constant in `src/backend/config.ts` is left untouched so `migrateIfNeeded` still compiles and runs for users who have not yet completed the IndexedDB → SQLite migration.
- [x] TypeScript compiles cleanly with no errors.
