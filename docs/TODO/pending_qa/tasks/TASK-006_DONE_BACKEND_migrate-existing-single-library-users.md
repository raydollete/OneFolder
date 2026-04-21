---
id: TASK-006
title: 'Migrate existing single-library users to the multi-library system on first launch'
investigation: INV-001
status: DONE
priority: critical
blocked_by: [TASK-001, TASK-002, TASK-003]
date_created: 2026-04-04
date_completed: 2026-04-20
files:
  - 'common/library-registry.ts'
  - 'src/renderer.tsx'
  - 'src/main.ts'
  - 'src/backend/sqlite-config.ts'
---

## What

On first launch after upgrading to the multi-library version, automatically detect that no `libraries.json` exists, create a default library entry, and migrate the existing SQLite database (`{userData}/onefolder.db`), localStorage keys, and backup directory into the new namespaced layout. This must be invisible to the user — their existing data must appear exactly as before.

## Why

Every existing user has data stored under the old hardcoded names: a SQLite file at `{userData}/onefolder.db`, bare `'preferences'` localStorage keys, and a shared `{userData}/backups/` directory. Without migration, upgrading to the multi-library version would appear to lose all their data because the app would look for library-specific files that do not exist yet.

**Background note:** The IndexedDB → SQLite migration already ran as part of INV-002 (commit `e0cad4cc`). Users upgrading to multi-library will already be on SQLite, so this task only needs to relocate existing SQLite artifacts — it does NOT need to re-run the IndexedDB export/import path.

See [INV-001](../investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md).

## Implementation Steps

- [x] 1. **`src/main.ts`** — At startup, after creating the `LibraryRegistry`, check if `libraries.json` exists:
  ```typescript
  const registry = new LibraryRegistry(basePath);
  if (registry.getLibraries().length === 0) {
    // First launch after upgrade (or truly fresh install): create default library
    const defaultLibrary = registry.createLibrary('My Library');
    registry.setActiveLibrary(defaultLibrary.id);
  }
  ```
  Verify: On a fresh install or first upgrade, `libraries.json` is created with one entry.

- [x] 2. **`src/renderer.tsx`** — Before calling `sqliteInit()`, check whether the legacy flat SQLite file exists and the library-scoped file does not:
  ```typescript
  const legacyDbPath = path.join(userDataPath, SQLITE_DB_FILENAME);
  const newDbPath = getSqliteDbPath(userDataPath, libraryId);
  const migrationNeeded =
    (await fse.pathExists(legacyDbPath)) && !(await fse.pathExists(newDbPath));
  ```
  Migration is required when the legacy file exists AND the new file does not. On a truly fresh install, neither exists, and the renderer proceeds straight to `sqliteInit(newDbPath)`, which creates an empty schema at the library-scoped path.
  Verify: Migration detection correctly distinguishes the upgrade scenario from a fresh install and from a subsequent launch after migration has already completed.

- [x] 3. **Migrate the SQLite database file** — When migration is needed, `fse.move` the file (and its WAL/SHM sidecars if present) into the library directory. This is a plain filesystem rename — orders of magnitude faster than the Dexie export/import path that was originally planned for this task:
  ```typescript
  await fse.ensureDir(path.dirname(newDbPath));
  await fse.move(legacyDbPath, newDbPath);
  // WAL and SHM sidecars only exist if the app previously crashed mid-write.
  // Move them only if present; ignore ENOENT otherwise.
  for (const suffix of ['-wal', '-shm']) {
    const legacySidecar = legacyDbPath + suffix;
    if (await fse.pathExists(legacySidecar)) {
      await fse.move(legacySidecar, newDbPath + suffix);
    }
  }
  ```
  Do NOT open the database before moving — `better-sqlite3` would lock the file and block the move on Windows. The existing `migrateIfNeeded(dbPath)` call that runs before `sqliteInit` must be passed `newDbPath` after the move so it can still perform its IndexedDB → SQLite backfill if needed for an edge-case user who never launched a post-SQLite version.
  Verify: `onefolder.db` (and any sidecars) have been moved from `{userData}/` to `{userData}/libraries/{libraryId}/`. Opening the moved file shows all tables (files, tags, locations, searches, visualHashes, dismissedDuplicateGroups, file_tags) with identical row counts to the pre-migration file.

- [x] 4. **Migrate localStorage keys** — Move data from old keys to namespaced keys:
  ```typescript
  function migrateLocalStorageKey(oldKey: string, newKey: string) {
    const value = localStorage.getItem(oldKey);
    if (value !== null) {
      localStorage.setItem(newKey, value);
      localStorage.removeItem(oldKey);
    }
  }
  migrateLocalStorageKey('preferences', `${libraryId}:preferences`);
  migrateLocalStorageKey('OneFolder_File', `${libraryId}:OneFolder_File`);
  migrateLocalStorageKey('hierarchical-separator', `${libraryId}:hierarchical-separator`);
  ```
  Keys that remain global (`OneFolder_Window`, `tag-editor-height`) are left in place.
  Verify: After migration, `localStorage.getItem('preferences')` returns null, and `localStorage.getItem(\`${libraryId}:preferences\`)` returns the old preferences data.

- [x] 5. **Migrate backup directory** — Move existing backup files from `{userData}/backups/` to `{userData}/libraries/{libraryId}/backups/`:
  ```typescript
  const oldBackupDir = path.join(userDataPath, 'backups');
  const newBackupDir = path.join(userDataPath, 'libraries', libraryId, 'backups');
  if (await fse.pathExists(oldBackupDir)) {
    await fse.ensureDir(path.dirname(newBackupDir));
    await fse.move(oldBackupDir, newBackupDir);
  }
  ```
  Post-SQLite backups are `.db` files (produced by `SQLiteBackupScheduler` via `db.backup()`), not JSON. The move is format-agnostic, so this step works whether the user's previous backups are the old Dexie JSON exports or new SQLite `.db` snapshots.
  Verify: Backup files appear in the new directory and the old `backups/` directory is either gone (post-move) or empty.

- [x] 6. **Thumbnail directory** — The user's customized thumbnail directory (if any) is stored in their `preferences` localStorage entry. The migration in step 4 preserves it. The default thumbnail directory changes from `{temp}/OneFolder/thumbnails/` to `{temp}/OneFolder/{libraryId}/thumbnails/`. Two options:
  - **Option A (simpler):** Move the old default thumbnail directory to the new location. If the user had customized it, leave their custom path as-is.
  - **Option B (safest):** Keep the old thumbnail directory path in the migrated preferences. The thumbnails stay where they are. Only newly generated thumbnails go to the new default. This avoids moving potentially gigabytes of thumbnails.

  Recommendation: Option B. The user can manually change the directory in Settings > Advanced if they want to clean up.
  Verify: Existing thumbnails continue to load correctly after migration.

- [x] 7. **Show migration progress** — The SQLite file move is effectively instantaneous (a filesystem rename on the same volume). No progress UI is strictly required, but the existing `<SplashScreen />` is already rendered during initialization, so it covers the brief pause naturally. If a cross-volume move is detected (slower, because `fse.move` falls back to copy + unlink), consider surfacing a status message.
  Verify: User sees no perceptible delay on same-volume migrations; sees a status message for large cross-volume moves.

- [x] 8. **Guard against repeated migration** — After a successful move, the detection logic in step 2 no longer triggers because the legacy path no longer exists. On subsequent launches, `sqliteInit(newDbPath)` opens the already-migrated file directly.
  Verify: Second launch after migration completes instantly without re-running migration. Manually re-creating an empty file at the legacy path does not overwrite the migrated library — the "new file does not exist" precondition protects against this.

- [x] 9. **Portable mode** — Verify the migration works in portable mode, where `userData` points to `{appDir}/data`. The same move semantics apply: `{appDir}/data/onefolder.db` → `{appDir}/data/libraries/{libraryId}/onefolder.db`. No code changes should be required — this is purely a verification step. Run the upgrade with both a flat portable install and a fresh portable install and confirm the expected on-disk layout in each case.

## Done When

- [x] Existing users upgrading to the multi-library version see their data intact with zero manual intervention.
- [x] The legacy `{userData}/onefolder.db` is moved to `{userData}/libraries/{libraryId}/onefolder.db` along with any `-wal` / `-shm` sidecars.
- [x] All localStorage keys are migrated to namespaced format.
- [x] Backup files are moved to the library-specific directory.
- [x] Existing thumbnail paths continue to work.
- [x] Migration runs only once (idempotent on subsequent launches — the precondition protects against repeats).
- [x] A fresh install (no existing data) creates a default library without attempting migration.
- [x] The one-time IndexedDB → SQLite migration path (`migrateIfNeeded`) is still reachable for any user whose previous launch predates the SQLite migration, using the library-scoped `dbPath`.
- [x] Portable mode behaves identically, with libraries nesting inside `{appDir}/data/libraries/`.
