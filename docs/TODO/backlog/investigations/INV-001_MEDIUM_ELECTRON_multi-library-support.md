---
id: INV-001
title: 'Multi-library support: decentralize configuration to enable multiple independent libraries per install'
reported_bug: 'Feature request — the application is not portable and cannot support multiple separate libraries per install'
date: 2026-04-04
status: active
superseded_by:
tasks_spawned: [TASK-001, TASK-002, TASK-003, TASK-004, TASK-005, TASK-006]
root_cause_category: architectural-shortcoming
affects:
  - 'Electron main process (single-instance lock, basePath, preferences, window state)'
  - 'IndexedDB / Dexie database (hardcoded name "OneFolder")'
  - 'localStorage (renderer-side preferences, all keyed globally)'
  - 'Thumbnail cache (single shared temp directory)'
  - 'Backup scheduler (single shared userData/backups directory)'
  - 'ExifTool hierarchical separator setting (global localStorage key)'
  - 'File watcher workers (Chokidar, bound to location list from single DB)'
  - 'MobX stores (RootStore, FileStore, TagStore, LocationStore, UiStore, SearchStore)'
---

## Feature Request

### Observed Behavior

The application is locked to a single library instance. All configuration, data, and caches are stored in one shared location. There is no way for a user to maintain separate photo collections (e.g., "Personal" vs. "Client Work") with independent tag hierarchies, watched folders, and settings. The Electron single-instance lock (`requestSingleInstanceLock`) further prevents running two copies simultaneously.

### Expected Behavior

A user should be able to create and switch between multiple independent libraries. Each library should have its own:
- IndexedDB database (files, tags, locations, searches, visual hashes, dismissed duplicates)
- Thumbnail cache directory
- Database backups
- UI preferences (view settings, thumbnail size, search criteria, hotkeys)
- File sort preferences
- Watched folder locations
- Hierarchical tag separator setting

### Context

This is a feature request, not a bug. The current architecture was designed for a single-library use case. The TODO comment on line 24 of `src/main.ts` explicitly acknowledges this: `// TODO: change this when running in portable mode, see portable-improvements branch`.

---

## Root Cause Analysis

**Category:** architectural-shortcoming

### Diagnosis

The application was built assuming a single library per installation. This assumption is baked into multiple layers:

**1. Main Process — Hardcoded base path (`src/main.ts:25`)**

```typescript
const basePath = app.getPath('userData');
```

All main-process state files derive from this single path:
- `preferences.json` (auto-update settings)
- `windowState.json` (window position/size)

**2. Single-Instance Lock (`src/main.ts:369`)**

```typescript
const HAS_INSTANCE_LOCK = app.requestSingleInstanceLock();
```

This prevents any second instance from running, making it impossible to have two libraries open simultaneously (though this investigation focuses on the simpler sequential-switch model first).

**3. IndexedDB Name — Hardcoded constant (`src/backend/config.ts:7`)**

```typescript
export const DB_NAME = 'OneFolder';
```

This is used in `src/renderer.tsx:43`:
```typescript
const db = dbInit(DB_NAME);
```

Every library uses the same IndexedDB database. There is no mechanism to select an alternative.

**4. localStorage Keys — Global, unscoped (`src/frontend/stores/`)**

All renderer-side preferences are stored in `localStorage` with fixed keys:
- `PREFERENCES_STORAGE_KEY = 'preferences'` (UiStore — theme, thumbnail directory, view settings, search criteria, hotkeys, inspector state, etc.)
- `FILE_STORAGE_KEY = 'OneFolder_File'` (FileStore — sort order and direction)
- `WINDOW_STORAGE_KEY = 'OneFolder_Window'` (window fullscreen state)
- `'hierarchical-separator'` (ExifTool tag separator, read in RootStore constructor)
- `'tag-editor-height'` (FileTagEditor component)

None of these keys are namespaced per library.

**5. Thumbnail Cache — Single shared directory (`src/ipc/renderer.ts:166-168`)**

```typescript
static getDefaultThumbnailDirectory = async () => {
  const userDataPath = await RendererMessenger.getPath('temp');
  return path.join(userDataPath, 'OneFolder', 'thumbnails');
};
```

All libraries would share the same thumbnail directory. While the thumbnail directory is user-configurable via Settings > Advanced, the default is global.

**6. Backup Directory — Single shared directory (`src/ipc/renderer.ts:170-173`)**

```typescript
static getDefaultBackupDirectory = async () => {
  const userDataPath = await RendererMessenger.getPath('userData');
  return path.join(userDataPath, 'backups');
};
```

All auto-backups (rolling, daily, weekly) go into one directory regardless of which data they represent.

**7. Themes Directory — Single shared directory (`src/ipc/renderer.ts:175-178`)**

```typescript
static getThemesDirectory = async () => {
  const userDataPath = await RendererMessenger.getPath('userData');
  return path.join(userDataPath, 'themes');
};
```

Themes could reasonably stay global (shared across libraries), but this is a design decision.

### Diagnostic Questions Considered

- **Wrong mental model?** No — the single-library model was intentional, not a mistake.
- **Architectural shortcoming?** YES — this is the core issue. The architecture lacks any concept of a "library" as a first-class entity that scopes configuration and data.
- **Incorrect order of operations?** Not applicable.
- **Missing edge case?** Not applicable — this is a missing feature, not an edge case.
- **Wrong abstraction?** Partially — configuration and database references are scattered (main process files, IndexedDB name, localStorage keys, default directories) rather than being centralized behind a "library config" abstraction.
- **Silent failure?** No.

---

## Blast Radius

1. **Main process startup (`src/main.ts`)** — `basePath`, `preferencesFilePath`, `windowStateFilePath` are all derived from a single `app.getPath('userData')`. The single-instance lock must be rethought (either scoped per library or relaxed to allow switching).

2. **IndexedDB database name (`src/backend/config.ts`)** — The `DB_NAME` constant `'OneFolder'` is used to create the Dexie instance. Each library needs its own database name (e.g., `OneFolder_LibraryName` or `OneFolder_{uuid}`).

3. **Renderer initialization (`src/renderer.tsx`)** — `dbInit(DB_NAME)` must accept a dynamic name from library selection. The `BackupScheduler` must use a library-specific backup directory.

4. **UiStore preferences (`src/frontend/stores/UiStore.ts`)** — `PREFERENCES_STORAGE_KEY` stores thumbnail directory, view settings, search criteria, and many other settings in a single unscoped localStorage entry. Must be namespaced per library.

5. **FileStore preferences (`src/frontend/stores/FileStore.ts`)** — `FILE_STORAGE_KEY` stores sort order. Must be namespaced per library.

6. **LocationStore preferences (`src/frontend/stores/LocationStore.ts`)** — Reads `PREFERENCES_STORAGE_KEY` for enabled file extensions. Must share the namespaced key.

7. **Window state (`src/main.ts`)** — `windowState.json` could reasonably stay global (same window position regardless of library), but `preferences.json` (auto-update check) is also global and can stay that way.

8. **Thumbnail cache directory (`src/ipc/renderer.ts`)** — Default must be per-library to avoid thumbnail collisions between libraries that might contain files at the same paths (or avoid orphaned thumbnails when switching libraries).

9. **Backup directory (`src/ipc/renderer.ts`)** — Auto-backups must be per-library. A backup from Library A must not overwrite Library B's backup.

10. **ExifTool hierarchical separator (`src/frontend/stores/RootStore.ts:56`)** — Stored in localStorage under the bare key `'hierarchical-separator'`. Must be namespaced per library.

11. **Tag editor height (`src/frontend/containers/AppToolbar/FileTagEditor.tsx`)** — Minor, but stored with bare key `'tag-editor-height'`. Could stay global or be namespaced.

12. **Single-instance lock (`src/main.ts:369`)** — Currently prevents any second instance. For multi-library, the lock might need to be per-library, or the app needs a library-selector that operates before the main window loads.

---

## UX / Requirements Specification

### Purpose

Enable users to maintain multiple independent photo libraries within a single OneFolder installation, each with fully isolated data, settings, and caches.

### User-Stated Design Decisions

1. **Library selector at launch** — When the app starts (or via a menu action), the user should be able to choose which library to open. This could be a lightweight dialog before the main window loads.
2. **Per-library config directories** — Each library should have its own subdirectory for database backups and thumbnail cache.
3. **Database isolation** — Each library must have its own IndexedDB database. Tags, locations, files, searches, and all other DB tables must be completely separate.
4. **Thumbnail cache separation** — Each library should have its own default thumbnail directory to prevent collisions.
5. **Per-library preferences** — View settings, sort order, search criteria, enabled extensions, and other preferences should be per-library.

### Behavioral Specifications

- The library selector should show all known libraries with their names and last-opened dates.
- Creating a new library should be straightforward (name input, then starts fresh).
- Switching libraries should fully tear down the current state and reinitialize with the target library's data.
- Deleting a library should optionally delete its database, backups, and thumbnail cache.
- The library registry itself (list of libraries with their metadata) must be stored at the global level (not per-library).

### Explicit Rejections

- This investigation does NOT cover running multiple libraries simultaneously (multi-window). The scope is sequential switching: close one library, open another.
- Theme files can remain global (shared across libraries).
- Window position/size state can remain global.
- Auto-update preferences can remain global.

---

## Holistic Solution

### Approach

Introduce a **Library** abstraction that scopes all per-library state. The implementation is broken into phases:

**Phase 1: Library Registry and Config Infrastructure (TASK-001)**

Create a `LibraryRegistry` that persists to a JSON file in the global `userData` directory. Each library entry contains:
- `id`: UUID
- `name`: user-chosen name
- `createdAt`: timestamp
- `lastOpenedAt`: timestamp

The registry file lives at `{userData}/libraries.json`. The active library ID is stored in a separate `{userData}/active-library.json` file.

**Phase 2: Namespace All Per-Library Storage (TASK-002)**

- Change `DB_NAME` from a constant to a function: `getDbName(libraryId: string) => 'OneFolder_' + libraryId`
- Namespace all `localStorage` keys with the library ID prefix: `{libraryId}:preferences`, `{libraryId}:OneFolder_File`, etc.
- Create per-library subdirectories for backups: `{userData}/libraries/{libraryId}/backups/`
- Create per-library default thumbnail directories: `{temp}/OneFolder/{libraryId}/thumbnails/`

**Phase 3: Plumb Library ID Through Initialization (TASK-003)**

- Main process reads `active-library.json` at startup to determine which library to load.
- Pass the library ID to the renderer (via IPC or query parameter on `index.html`).
- `renderer.tsx` uses the library ID to construct the correct DB name, localStorage prefix, and default directories.
- `BackupScheduler`, `RootStore`, `UiStore`, `FileStore`, and `LocationStore` all receive the namespaced keys/paths.

**Phase 4: Library Selector UI (TASK-004)**

- Before the main app renders, show a library selector if there are multiple libraries (or always show it with a "don't show again" option).
- The selector lists all libraries from the registry. User can: Open, Create New, Rename, Delete.
- On selection, write the chosen library ID to `active-library.json` and proceed with initialization.
- Add a menu item or settings option to "Switch Library" which saves current state, tears down, and shows the selector again.

**Phase 5: Library Switching / Teardown (TASK-005)**

- When switching libraries, the app must: close ExifTool, stop all file watchers, close the Dexie database, clear MobX stores, then reinitialize with the new library's data.
- This is effectively a "soft restart" of the renderer without restarting the Electron process.
- The `RootStore.close()` method already handles ExifTool cleanup. Extend it to handle full teardown.

**Phase 6: Migration for Existing Users (TASK-006)**

- On first launch after the update, if no `libraries.json` exists, automatically create a default library entry (e.g., "My Library") and associate the existing database, backups, and thumbnail cache with it.
- Rename the existing IndexedDB from `'OneFolder'` to `'OneFolder_{defaultLibraryId}'` (Dexie does not support rename, so this requires export + import under the new name).
- Migrate existing localStorage keys to the namespaced format.

### Expected Outcomes

- Users can create multiple independent libraries, each with fully isolated data.
- Switching between libraries is seamless — like opening a different project in an IDE.
- Existing users experience zero data loss; their current library is automatically migrated.
- The "Your files, your folder, forever" philosophy is preserved — each library tracks its own set of folders with its own tag hierarchy.

### Risks and Tradeoffs

1. **IndexedDB migration complexity** — Renaming an IndexedDB requires exporting and reimporting. This is a one-time cost but must handle large databases gracefully. The existing `BackupScheduler.backupToFile` / `restoreFromFile` methods provide a foundation.
2. **localStorage migration** — Must handle the case where users have existing preferences that need to be moved to namespaced keys without losing data.
3. **Memory/performance** — No impact during normal operation (only one library is loaded at a time). Switching libraries has a cost similar to a fresh app launch.
4. **Single-instance lock** — The current lock prevents running two instances. This is fine for sequential switching but would need revisiting if simultaneous multi-library is ever desired.
5. **Thumbnail directory user customization** — If a user has customized their thumbnail directory, the migration must preserve that choice for the default library. New libraries get the per-library default.

---

## Documentation Updates

- [ ] Updated: `docs/` should get a new `multi-library.md` explaining the library concept and architecture
- [ ] Updated: `CLAUDE.md` should mention the library abstraction in the Architecture section
