/**
 * Tests for migrateToMultiLibraryLayout (extracted to src/renderer-migration.ts
 * via Approach A — pure refactor, no behavioral change from the original
 * inline function in src/renderer.tsx).
 *
 * Uses real fs-extra against unique temp directories (cleaned up in afterEach)
 * and an in-memory localStorage polyfill — no module mocks.
 */

import * as crypto from 'crypto';
import fse from 'fs-extra';
import * as os from 'os';
import path from 'path';

import { migrateToMultiLibraryLayout } from '../src/renderer-migration';

// ---------------------------------------------------------------------------
// In-memory localStorage polyfill for the Node test environment
// ---------------------------------------------------------------------------

const store = new Map<string, string>();
(global as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    store.set(k, String(v));
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => {
    store.clear();
  },
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() {
    return store.size;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return path.join(os.tmpdir(), `onefolder-migrate-test-${crypto.randomUUID()}`);
}

const LIBRARY_ID = '00000000-0000-0000-0000-000000000001';
const DB_FILENAME = 'onefolder.db';
const KNOWN_MARKER = Buffer.from('SQLITE_TEST_MARKER');

function legacyDbPath(tmpDir: string): string {
  return path.join(tmpDir, DB_FILENAME);
}

function newDbPath(tmpDir: string, libraryId = LIBRARY_ID): string {
  return path.join(tmpDir, 'libraries', libraryId, DB_FILENAME);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateToMultiLibraryLayout', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fse.ensureDirSync(tmpDir);
    localStorage.clear();
  });

  afterEach(() => {
    fse.removeSync(tmpDir);
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  // 1. No-op when the legacy DB does not exist
  it('is a no-op when the legacy DB does not exist (fresh install)', async () => {
    // tmpDir is empty
    await expect(migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID)).resolves.toBeUndefined();
    // Nothing should have been created
    const librariesDir = path.join(tmpDir, 'libraries');
    expect(await fse.pathExists(librariesDir)).toBe(false);
  });

  // 2. No-op when the library-scoped DB already exists
  it('is a no-op when the library-scoped DB already exists (already migrated)', async () => {
    // Pre-create both legacy and new paths
    const legacy = legacyDbPath(tmpDir);
    const newDb = newDbPath(tmpDir);
    await fse.ensureDir(path.dirname(newDb));
    await fse.writeFile(legacy, Buffer.from('legacy'));
    await fse.writeFile(newDb, Buffer.from('already-migrated'));

    await migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID);

    // Legacy file must be UNTOUCHED (precondition guards against clobbering)
    const legacyContent = await fse.readFile(legacy);
    expect(legacyContent.toString()).toBe('legacy');
    // New file is also untouched
    const newContent = await fse.readFile(newDb);
    expect(newContent.toString()).toBe('already-migrated');
  });

  // 3. Second invocation is a no-op
  it('second invocation is a no-op (core idempotency guarantee)', async () => {
    const legacy = legacyDbPath(tmpDir);
    await fse.writeFile(legacy, KNOWN_MARKER);

    // First run performs the migration
    await migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID);

    // Confirm the file moved
    const newDb = newDbPath(tmpDir);
    expect(await fse.pathExists(newDb)).toBe(true);
    expect(await fse.pathExists(legacy)).toBe(false);

    // Second run — should not throw and the new file should remain intact
    await expect(migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID)).resolves.toBeUndefined();
    expect(await fse.pathExists(newDb)).toBe(true);
    const content = await fse.readFile(newDb);
    expect(content).toEqual(KNOWN_MARKER);
  });

  // -------------------------------------------------------------------------
  // SQLite WAL/SHM sidecar handling
  // -------------------------------------------------------------------------

  // 4. Moves onefolder.db alone when no sidecars exist
  it('moves onefolder.db alone when no WAL/SHM sidecars exist', async () => {
    const legacy = legacyDbPath(tmpDir);
    await fse.writeFile(legacy, KNOWN_MARKER);

    await migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID);

    const newDb = newDbPath(tmpDir);
    expect(await fse.pathExists(newDb)).toBe(true);
    expect((await fse.readFile(newDb))).toEqual(KNOWN_MARKER);
    expect(await fse.pathExists(legacy)).toBe(false);
    // No sidecars at either location
    expect(await fse.pathExists(legacy + '-wal')).toBe(false);
    expect(await fse.pathExists(legacy + '-shm')).toBe(false);
    expect(await fse.pathExists(newDb + '-wal')).toBe(false);
    expect(await fse.pathExists(newDb + '-shm')).toBe(false);
  });

  // 5. Moves onefolder.db AND its -wal / -shm sidecars when they exist
  it('moves onefolder.db and both -wal and -shm sidecars', async () => {
    const legacy = legacyDbPath(tmpDir);
    const walMarker = Buffer.from('WAL_CONTENT');
    const shmMarker = Buffer.from('SHM_CONTENT');
    await fse.writeFile(legacy, KNOWN_MARKER);
    await fse.writeFile(legacy + '-wal', walMarker);
    await fse.writeFile(legacy + '-shm', shmMarker);

    await migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID);

    const newDb = newDbPath(tmpDir);
    // All three present at new location with correct content
    expect(await fse.readFile(newDb)).toEqual(KNOWN_MARKER);
    expect(await fse.readFile(newDb + '-wal')).toEqual(walMarker);
    expect(await fse.readFile(newDb + '-shm')).toEqual(shmMarker);
    // None remain at the legacy location
    expect(await fse.pathExists(legacy)).toBe(false);
    expect(await fse.pathExists(legacy + '-wal')).toBe(false);
    expect(await fse.pathExists(legacy + '-shm')).toBe(false);
  });

  // 6. Moves onefolder.db and only the -wal sidecar when -shm is missing
  it('moves onefolder.db and only the -wal sidecar when -shm is absent', async () => {
    const legacy = legacyDbPath(tmpDir);
    await fse.writeFile(legacy, KNOWN_MARKER);
    await fse.writeFile(legacy + '-wal', Buffer.from('WAL_ONLY'));
    // -shm deliberately not created

    await expect(migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID)).resolves.toBeUndefined();

    const newDb = newDbPath(tmpDir);
    expect(await fse.pathExists(newDb)).toBe(true);
    expect(await fse.pathExists(newDb + '-wal')).toBe(true);
    expect(await fse.pathExists(newDb + '-shm')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // localStorage key migration
  // -------------------------------------------------------------------------

  // 7. Migrates all four keys
  it('migrates all four localStorage keys to namespaced equivalents', async () => {
    const legacy = legacyDbPath(tmpDir);
    await fse.writeFile(legacy, KNOWN_MARKER);

    localStorage.setItem('preferences', '{"theme":"dark"}');
    localStorage.setItem('OneFolder_File', '{"orderBy":"name"}');
    localStorage.setItem('hierarchical-separator', '|');
    localStorage.setItem('location-store-preferences', '{"extensions":[]}');

    await migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID);

    // Bare keys must be gone
    expect(localStorage.getItem('preferences')).toBeNull();
    expect(localStorage.getItem('OneFolder_File')).toBeNull();
    expect(localStorage.getItem('hierarchical-separator')).toBeNull();
    expect(localStorage.getItem('location-store-preferences')).toBeNull();

    // Namespaced keys must carry the original values
    expect(localStorage.getItem(`${LIBRARY_ID}:preferences`)).toBe('{"theme":"dark"}');
    expect(localStorage.getItem(`${LIBRARY_ID}:OneFolder_File`)).toBe('{"orderBy":"name"}');
    expect(localStorage.getItem(`${LIBRARY_ID}:hierarchical-separator`)).toBe('|');
    expect(localStorage.getItem(`${LIBRARY_ID}:location-store-preferences`)).toBe(
      '{"extensions":[]}',
    );
  });

  // 8. Leaves global keys in place
  it('leaves global localStorage keys (OneFolder_Window, tag-editor-height) untouched', async () => {
    const legacy = legacyDbPath(tmpDir);
    await fse.writeFile(legacy, KNOWN_MARKER);

    localStorage.setItem('OneFolder_Window', '{"isFullScreen":false}');
    localStorage.setItem('tag-editor-height', '200');

    await migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID);

    expect(localStorage.getItem('OneFolder_Window')).toBe('{"isFullScreen":false}');
    expect(localStorage.getItem('tag-editor-height')).toBe('200');
  });

  // 9. Does NOT guard against overwriting an existing namespaced key
  it('unconditionally overwrites an existing namespaced key (documented current behavior)', async () => {
    // TODO: TASK-017 — The current implementation calls setItem(newKey, value)
    // unconditionally, so an existing namespaced key is overwritten by the bare
    // key's value. This test pins the current behavior; if overwrite-guarding is
    // ever desired it requires its own investigation and deliberate code change.
    const legacy = legacyDbPath(tmpDir);
    await fse.writeFile(legacy, KNOWN_MARKER);

    localStorage.setItem('preferences', 'old');
    localStorage.setItem(`${LIBRARY_ID}:preferences`, 'new');

    await migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID);

    // 'old' overwrites 'new' — document the current (potentially surprising) behavior
    expect(localStorage.getItem(`${LIBRARY_ID}:preferences`)).toBe('old');
  });

  // 10. No-op when none of the legacy keys are present
  it('does not create namespaced keys when none of the bare keys are present', async () => {
    const legacy = legacyDbPath(tmpDir);
    await fse.writeFile(legacy, KNOWN_MARKER);
    // localStorage is empty (cleared in beforeEach)

    await migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID);

    expect(localStorage.getItem(`${LIBRARY_ID}:preferences`)).toBeNull();
    expect(localStorage.getItem(`${LIBRARY_ID}:OneFolder_File`)).toBeNull();
    expect(localStorage.getItem(`${LIBRARY_ID}:hierarchical-separator`)).toBeNull();
    expect(localStorage.getItem(`${LIBRARY_ID}:location-store-preferences`)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Backup directory move
  // -------------------------------------------------------------------------

  // 11. Moves backups/ to libraries/{id}/backups/ when legacy dir exists
  it('moves the legacy backups/ directory to the library-scoped location', async () => {
    const legacy = legacyDbPath(tmpDir);
    await fse.writeFile(legacy, KNOWN_MARKER);

    const backupMarker = Buffer.from('BACKUP_CONTENT');
    const oldBackupDir = path.join(tmpDir, 'backups');
    const oldSnapshot = path.join(oldBackupDir, 'snapshot.db');
    await fse.ensureDir(oldBackupDir);
    await fse.writeFile(oldSnapshot, backupMarker);

    await migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID);

    const newBackupDir = path.join(tmpDir, 'libraries', LIBRARY_ID, 'backups');
    const newSnapshot = path.join(newBackupDir, 'snapshot.db');
    expect(await fse.pathExists(newSnapshot)).toBe(true);
    expect(await fse.readFile(newSnapshot)).toEqual(backupMarker);
    expect(await fse.pathExists(oldBackupDir)).toBe(false);
  });

  // 12. Skips the backup move when the legacy dir does not exist
  it('skips the backup move when the legacy backups/ directory does not exist', async () => {
    const legacy = legacyDbPath(tmpDir);
    await fse.writeFile(legacy, KNOWN_MARKER);
    // No backups/ directory

    await expect(migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID)).resolves.toBeUndefined();

    // Should not create the backup dir at the new location
    const newBackupDir = path.join(tmpDir, 'libraries', LIBRARY_ID, 'backups');
    expect(await fse.pathExists(newBackupDir)).toBe(false);
  });

  // 13. Skips the backup move when the new backup dir already exists
  it('leaves the legacy backups/ in place when the new backup dir already exists', async () => {
    const legacy = legacyDbPath(tmpDir);
    const newDbFile = newDbPath(tmpDir); // pre-create to skip DB migration
    await fse.ensureDir(path.dirname(newDbFile));
    await fse.writeFile(legacy, KNOWN_MARKER);
    await fse.writeFile(newDbFile, Buffer.from('already-migrated'));

    // Pre-create both old and new backup dirs
    const oldBackupDir = path.join(tmpDir, 'backups');
    const oldSnapshot = path.join(oldBackupDir, 'snapshot.db');
    await fse.ensureDir(oldBackupDir);
    await fse.writeFile(oldSnapshot, Buffer.from('OLD_BACKUP'));

    const newBackupDir = path.join(tmpDir, 'libraries', LIBRARY_ID, 'backups');
    await fse.ensureDir(newBackupDir);

    await migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID);

    // Legacy backup dir is left alone because the new one already existed
    expect(await fse.pathExists(oldSnapshot)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Integration sanity check
  // -------------------------------------------------------------------------

  // 14. Full migration leaves the expected on-disk layout
  it('full migration: leaves expected on-disk layout with all keys and files moved', async () => {
    const legacy = legacyDbPath(tmpDir);
    const walMarker = Buffer.from('WAL');
    const shmMarker = Buffer.from('SHM');
    const backupMarker = Buffer.from('BACKUP');

    // Seed legacy DB + sidecars + backups
    await fse.writeFile(legacy, KNOWN_MARKER);
    await fse.writeFile(legacy + '-wal', walMarker);
    await fse.writeFile(legacy + '-shm', shmMarker);
    const oldBackupDir = path.join(tmpDir, 'backups');
    await fse.ensureDir(oldBackupDir);
    await fse.writeFile(path.join(oldBackupDir, 'snapshot.db'), backupMarker);

    // Seed all four localStorage keys
    localStorage.setItem('preferences', 'pref-value');
    localStorage.setItem('OneFolder_File', 'file-value');
    localStorage.setItem('hierarchical-separator', '::');
    localStorage.setItem('location-store-preferences', 'loc-value');

    await migrateToMultiLibraryLayout(tmpDir, LIBRARY_ID);

    const newDb = newDbPath(tmpDir);
    const newBackupDir = path.join(tmpDir, 'libraries', LIBRARY_ID, 'backups');

    // Legacy paths must NOT exist
    expect(await fse.pathExists(legacy)).toBe(false);
    expect(await fse.pathExists(legacy + '-wal')).toBe(false);
    expect(await fse.pathExists(legacy + '-shm')).toBe(false);
    expect(await fse.pathExists(oldBackupDir)).toBe(false);

    // New paths must exist with correct content
    expect(await fse.readFile(newDb)).toEqual(KNOWN_MARKER);
    expect(await fse.readFile(newDb + '-wal')).toEqual(walMarker);
    expect(await fse.readFile(newDb + '-shm')).toEqual(shmMarker);
    expect(await fse.readFile(path.join(newBackupDir, 'snapshot.db'))).toEqual(backupMarker);

    // All four namespaced localStorage keys populated; bare keys gone
    expect(localStorage.getItem('preferences')).toBeNull();
    expect(localStorage.getItem('OneFolder_File')).toBeNull();
    expect(localStorage.getItem('hierarchical-separator')).toBeNull();
    expect(localStorage.getItem('location-store-preferences')).toBeNull();

    expect(localStorage.getItem(`${LIBRARY_ID}:preferences`)).toBe('pref-value');
    expect(localStorage.getItem(`${LIBRARY_ID}:OneFolder_File`)).toBe('file-value');
    expect(localStorage.getItem(`${LIBRARY_ID}:hierarchical-separator`)).toBe('::');
    expect(localStorage.getItem(`${LIBRARY_ID}:location-store-preferences`)).toBe('loc-value');
  });
});
