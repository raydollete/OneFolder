/**
 * TASK-006 / TASK-017: One-time migration from the legacy single-library layout
 * to the per-library layout introduced by INV-001.
 *
 * Extracted from src/renderer.tsx so that the function can be exercised by
 * Jest tests without pulling in the full renderer dependency tree (React,
 * MobX, Electron IPC, etc.).  The function body is identical to the original —
 * only the module boundary changes.
 */

import fse from 'fs-extra';
import path from 'path';

import { getSqliteDbPath } from 'common/library-registry';
import { SQLITE_DB_FILENAME } from './backend/sqlite-config';

/**
 * Migrates legacy single-library data to the multi-library layout.
 *
 * Migration is triggered when:
 *   - The legacy flat SQLite file ({userDataPath}/onefolder.db) EXISTS, AND
 *   - The library-scoped file ({userDataPath}/libraries/{id}/onefolder.db) does NOT exist.
 *
 * This function is idempotent: after the first successful run the precondition
 * no longer holds (the legacy file is gone), so subsequent launches skip it.
 */
export async function migrateToMultiLibraryLayout(
  userDataPath: string,
  libraryId: string,
): Promise<void> {
  const legacyDbPath = path.join(userDataPath, SQLITE_DB_FILENAME);
  const newDbPath = getSqliteDbPath(userDataPath, libraryId);

  const migrationNeeded =
    (await fse.pathExists(legacyDbPath)) && !(await fse.pathExists(newDbPath));

  if (!migrationNeeded) {
    return; // Already migrated or fresh install
  }

  console.info('TASK-006: Migrating legacy single-library data to multi-library layout...');

  // 1. Move the SQLite database (and any WAL/SHM sidecars).
  //    Do NOT open the database before moving — better-sqlite3 would lock the
  //    file and block the move on Windows.
  await fse.ensureDir(path.dirname(newDbPath));
  await fse.move(legacyDbPath, newDbPath);
  for (const suffix of ['-wal', '-shm']) {
    const legacySidecar = legacyDbPath + suffix;
    if (await fse.pathExists(legacySidecar)) {
      await fse.move(legacySidecar, newDbPath + suffix);
    }
  }
  console.info('TASK-006: SQLite database moved to', newDbPath);

  // 2. Migrate localStorage keys from bare names to library-namespaced names.
  //    Keys that remain global (OneFolder_Window, tag-editor-height) are left in place.
  const keysToMigrate: [oldKey: string, newKey: string][] = [
    ['preferences', `${libraryId}:preferences`],
    ['OneFolder_File', `${libraryId}:OneFolder_File`],
    ['hierarchical-separator', `${libraryId}:hierarchical-separator`],
    ['location-store-preferences', `${libraryId}:location-store-preferences`],
  ];
  for (const [oldKey, newKey] of keysToMigrate) {
    const value = localStorage.getItem(oldKey);
    if (value !== null) {
      localStorage.setItem(newKey, value);
      localStorage.removeItem(oldKey);
    }
  }
  console.info('TASK-006: localStorage keys migrated.');

  // 3. Move existing backup files from {userData}/backups/ to
  //    {userData}/libraries/{libraryId}/backups/.
  const oldBackupDir = path.join(userDataPath, 'backups');
  const newBackupDir = path.join(userDataPath, 'libraries', libraryId, 'backups');
  if ((await fse.pathExists(oldBackupDir)) && !(await fse.pathExists(newBackupDir))) {
    await fse.ensureDir(path.dirname(newBackupDir));
    await fse.move(oldBackupDir, newBackupDir);
    console.info('TASK-006: Backup directory moved to', newBackupDir);
  }

  // 4. Thumbnail directory — keep existing thumbnails in place (Option B from
  //    the task spec) to avoid moving potentially gigabytes of data.
  //    New thumbnails for this library will be generated in the new default
  //    directory. Users can change it manually in Settings > Advanced.

  console.info('TASK-006: Migration complete.');
}
