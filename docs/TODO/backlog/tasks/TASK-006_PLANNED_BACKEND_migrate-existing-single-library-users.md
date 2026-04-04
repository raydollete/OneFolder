---
id: TASK-006
title: 'Migrate existing single-library users to the multi-library system on first launch'
investigation: INV-001
status: planned
priority: critical
blocked_by: [TASK-001, TASK-002, TASK-003]
date_created: 2026-04-04
date_completed:
files:
  - 'common/library-registry.ts'
  - 'src/renderer.tsx'
  - 'src/main.ts'
  - 'src/backend/config.ts'
---

## What

On first launch after upgrading to the multi-library version, automatically detect that no `libraries.json` exists, create a default library entry, and migrate the existing IndexedDB database (named `'OneFolder'`) and localStorage keys to the new namespaced format. This must be invisible to the user -- their existing data must appear exactly as before.

## Why

Every existing user has data stored under the old hardcoded names (`'OneFolder'` IndexedDB, bare `'preferences'` localStorage key, etc.). Without migration, upgrading to the multi-library version would appear to lose all their data because the app would look for a library-specific database that does not exist yet.

See [INV-001](../investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md).

## Implementation Steps

- [ ] 1. **`src/main.ts`** — At startup, after creating the `LibraryRegistry`, check if `libraries.json` exists:
  ```typescript
  const registry = new LibraryRegistry(basePath);
  if (registry.getLibraries().length === 0) {
    // First launch after upgrade: create default library
    const defaultLibrary = registry.createLibrary('My Library');
    registry.setActiveLibrary(defaultLibrary.id);
    // Store the ID for the renderer to use during migration
  }
  ```
  Verify: On a fresh install or first upgrade, `libraries.json` is created with one entry.

- [ ] 2. **`src/renderer.tsx`** — Before normal initialization, check if migration is needed:
  - If the library ID is present in the URL AND an IndexedDB named `'OneFolder'` (the old default) exists AND no IndexedDB named `'OneFolder_{libraryId}'` exists, then migration is required.
  - Use `Dexie.exists('OneFolder')` to check for the old database.
  - Use `Dexie.exists(getDbName(libraryId))` to check for the new database.
  Verify: Migration detection correctly identifies the upgrade scenario vs. a truly fresh install.

- [ ] 3. **Migrate IndexedDB** — The safest approach is:
  - Open the old database: `const oldDb = dbInit('OneFolder');`
  - Export it: `const blob = await exportDB(oldDb);`
  - Close the old database.
  - Import under the new name: This requires modifying the export blob to change the database name. The `dexie-export-import` library's export format is JSON with a `data.databaseName` field. Parse the blob, change the name, re-serialize, and import.
  ```typescript
  const exportText = await blob.text();
  const exportData = JSON.parse(exportText);
  exportData.data.databaseName = getDbName(libraryId);
  const newBlob = new Blob([JSON.stringify(exportData)]);
  await importDB(newBlob);
  ```
  - Optionally delete the old database: `await Dexie.delete('OneFolder');` (or keep it as a safety backup for one version, then delete on subsequent launch).
  Verify: All tables (files, tags, locations, searches, visualHashes, dismissedDuplicateGroups) are present in the new database with identical data. Row counts match.

- [ ] 4. **Migrate localStorage keys** — Move data from old keys to namespaced keys:
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

- [ ] 5. **Migrate backup directory** — Move existing backup files from `{userData}/backups/` to `{userData}/libraries/{libraryId}/backups/`:
  ```typescript
  const oldBackupDir = path.join(userDataPath, 'backups');
  const newBackupDir = path.join(userDataPath, 'libraries', libraryId, 'backups');
  if (await fse.pathExists(oldBackupDir)) {
    await fse.ensureDir(path.dirname(newBackupDir));
    await fse.move(oldBackupDir, newBackupDir);
  }
  ```
  Verify: Backup files (auto-backup-*.json, daily.json, weekly.json) appear in the new directory.

- [ ] 6. **Thumbnail directory** — The user's customized thumbnail directory (if any) is stored in their `preferences` localStorage entry. The migration in step 4 preserves it. The default thumbnail directory changes from `{temp}/OneFolder/thumbnails/` to `{temp}/OneFolder/{libraryId}/thumbnails/`. Two options:
  - **Option A (simpler):** Move the old default thumbnail directory to the new location. If the user had customized it, leave their custom path as-is.
  - **Option B (safest):** Keep the old thumbnail directory path in the migrated preferences. The thumbnails stay where they are. Only newly generated thumbnails go to the new default. This avoids moving potentially gigabytes of thumbnails.
  Recommendation: Option B. The user can manually change the directory in Settings > Advanced if they want to clean up.
  Verify: Existing thumbnails continue to load correctly after migration.

- [ ] 7. **Show migration progress** — For large databases, the export/import could take a few seconds. Show a message on the splash screen: "Upgrading library format..." or similar. Use the existing `<SplashScreen />` component that is already rendered during initialization.
  Verify: User sees a brief progress indication during migration. No indefinite hang.

- [ ] 8. **Guard against repeated migration** — After successful migration, ensure the detection logic (step 2) does not trigger again on subsequent launches. The new database should exist, so `Dexie.exists(getDbName(libraryId))` returns true and migration is skipped.
  Verify: Second launch after migration completes instantly without re-running migration.

## Done When

- [ ] Existing users upgrading to the multi-library version see their data intact with zero manual intervention.
- [ ] The old `'OneFolder'` IndexedDB is migrated to `'OneFolder_{libraryId}'`.
- [ ] All localStorage keys are migrated to namespaced format.
- [ ] Backup files are moved to the library-specific directory.
- [ ] Existing thumbnail paths continue to work.
- [ ] Migration runs only once (idempotent on subsequent launches).
- [ ] A fresh install (no existing data) creates a default library without attempting migration.
- [ ] Large databases (10,000+ files) migrate within a reasonable time (<30 seconds) with progress indication.
