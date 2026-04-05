---
id: TASK-002
title: 'Namespace all per-library storage (IndexedDB, localStorage, directories) by library ID'
investigation: INV-001
status: planned
priority: high
blocked_by: [TASK-001]
date_created: 2026-04-04
date_completed:
files:
  - 'src/backend/config.ts'
  - 'src/ipc/renderer.ts'
  - 'src/frontend/stores/UiStore.ts'
  - 'src/frontend/stores/FileStore.ts'
  - 'src/frontend/stores/LocationStore.ts'
  - 'src/frontend/stores/RootStore.ts'
  - 'common/window.ts'
---

## What

Change every hardcoded storage identifier (IndexedDB name, localStorage keys, default directories) to accept a library ID parameter, so that each library's data is fully isolated.

## Why

Currently the IndexedDB is named `'OneFolder'`, localStorage keys are bare strings like `'preferences'` and `'OneFolder_File'`, and default directories for thumbnails and backups point to a single shared location. All of these must be scoped per library to prevent data collisions when switching between libraries.

See [INV-001](../investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md).

## Implementation Steps

- [ ] 1. **`src/backend/config.ts`** — Change `DB_NAME` from a constant to a function:
  ```typescript
  export const DEFAULT_DB_NAME = 'OneFolder'; // kept for migration
  export function getDbName(libraryId: string): string {
    return `OneFolder_${libraryId}`;
  }
  ```
  Keep exporting `DB_NAME` temporarily as an alias to `DEFAULT_DB_NAME` so existing code does not break until TASK-003 wires up the library ID.
  Verify: TypeScript compiles. No runtime changes yet.

- [ ] 2. **`src/ipc/renderer.ts`** — Parameterize default directory functions:
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

- [ ] 3. **`src/frontend/stores/UiStore.ts`** — Make `PREFERENCES_STORAGE_KEY` dynamic:
  - Add a module-level function: `export function getPreferencesStorageKey(libraryId?: string): string { return libraryId ? \`${libraryId}:preferences\` : 'preferences'; }`
  - Keep `PREFERENCES_STORAGE_KEY` as the default export for backward compatibility.
  - In `recoverPersistentPreferences()`, `getPersistentPreferences()`, and `clearPersistentPreferences()`, use the key provided by RootStore (which will hold the library ID once TASK-003 is done). For now, add a `storageKeyPrefix` parameter to the UiStore constructor (defaulting to empty string).
  Verify: With empty prefix, behavior is identical to current. With a prefix, keys are namespaced.

- [ ] 4. **`src/frontend/stores/FileStore.ts`** — Make `FILE_STORAGE_KEY` dynamic:
  - Same pattern as UiStore: add a `storageKeyPrefix` constructor parameter.
  - The key becomes `{prefix}:OneFolder_File` when prefix is non-empty, otherwise `'OneFolder_File'`.
  Verify: Same verification approach as step 3.

- [ ] 5. **`src/frontend/stores/LocationStore.ts`** — The LocationStore reads `PREFERENCES_STORAGE_KEY` directly on line 58. It must use the same namespaced key as UiStore. Pass the key through from RootStore or accept the same prefix parameter.
  Verify: Enabled extensions are read from the correct namespaced key.

- [ ] 6. **`common/window.ts`** — Make `WINDOW_STORAGE_KEY` available for namespacing. Window state (fullscreen) is stored per this key. Decision: keep this GLOBAL (not per-library) since window position is a system concern, not a library concern. Document this decision with a comment.
  Verify: No functional change.

- [ ] 7. **`src/frontend/stores/RootStore.ts` line 56** — The `'hierarchical-separator'` localStorage key must also be namespaced. Change to: `localStorage.getItem(\`${prefix}:hierarchical-separator\`) || undefined`.
  Verify: ExifIO is initialized with the correct separator for the active library.

## Done When

- [ ] `getDbName(libraryId)` function exists and returns a unique DB name per library.
- [ ] All localStorage keys used by UiStore, FileStore, LocationStore, and RootStore accept a prefix parameter.
- [ ] Default thumbnail and backup directory functions accept an optional library ID.
- [ ] With no library ID provided, all behavior is 100% identical to current behavior (backward compatible).
- [ ] TypeScript compiles cleanly with no errors.
