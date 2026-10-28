import Database from 'better-sqlite3';

// The filename for the SQLite database file stored alongside application data
export const SQLITE_DB_FILENAME = 'onefolder.db';

// The applied schema version written to PRAGMA user_version is derived from the
// MIGRATIONS list (the true maximum applied version), not a hand-maintained
// constant — see sqliteInit. Add versioned schema changes to MIGRATIONS below.

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

// Core tables that mirror the 6 existing Dexie collections.
// Tags stored in FileDTO.tags (ID[]) are extracted into a file_tags junction
// table so that tag filtering can use indexed lookups instead of full scans.
// Exported for tests/sqlite-codec-migration.test.ts, which runs the real DDL
// against node:sqlite (better-sqlite3 is Electron-ABI and unloadable in jest).
export const SQL_CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS files (
    id             TEXT    PRIMARY KEY,
    ino            TEXT,
    locationId     TEXT    NOT NULL,
    relativePath   TEXT    NOT NULL,
    -- absolutePath is a DERIVED, per-OS column (recomputed from the resolved
    -- location root at load), NOT the durable identity. The durable identity is
    -- (locationId, relativePath) — see the composite unique index below. It is
    -- therefore no longer UNIQUE: on a shared dual-boot library the same file has
    -- a different absolutePath per OS.
    absolutePath   TEXT    NOT NULL,
    name           TEXT    NOT NULL,
    extension      TEXT    NOT NULL,
    size           INTEGER NOT NULL,
    width          INTEGER NOT NULL,
    height         INTEGER NOT NULL,
    dateAdded      TEXT    NOT NULL,
    dateModified   TEXT    NOT NULL,
    dateCreated    TEXT    NOT NULL,
    dateLastIndexed TEXT   NOT NULL,
    annotations    TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS file_tags (
    fileId  TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tagId   TEXT NOT NULL,
    PRIMARY KEY (fileId, tagId)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id       TEXT    PRIMARY KEY,
    name     TEXT    NOT NULL,
    dateAdded TEXT   NOT NULL,
    color    TEXT    NOT NULL DEFAULT '',
    subTags  TEXT    NOT NULL DEFAULT '[]',
    isHidden INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS locations (
    id           TEXT    PRIMARY KEY,
    path         TEXT    NOT NULL,
    dateAdded    TEXT    NOT NULL,
    subLocations TEXT    NOT NULL DEFAULT '[]',
    "index"      INTEGER NOT NULL DEFAULT 0,
    -- Portable anchor: a root-relative segment resolved against the portable
    -- directory per-OS at load (NULL = unanchored, fixed absolute path). See
    -- LocationDTO.portableRoot and the portable-location-roots spec.
    portableRoot TEXT
  );

  CREATE TABLE IF NOT EXISTS searches (
    id       TEXT    PRIMARY KEY,
    name     TEXT    NOT NULL,
    criteria TEXT    NOT NULL DEFAULT '[]',
    matchAny INTEGER NOT NULL DEFAULT 0,
    "index"  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS dismissedDuplicateGroups (
    id          TEXT PRIMARY KEY,
    groupHash   TEXT NOT NULL UNIQUE,
    algorithm   TEXT NOT NULL,
    fileIds     TEXT NOT NULL,
    dismissedAt TEXT NOT NULL,
    userNote    TEXT
  );

  CREATE TABLE IF NOT EXISTS visualHashes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Portable cache key: portableFileKey(locationId, relativePath), stable
    -- across OSes. Replaces the old per-OS absolutePath key so a shared
    -- perceptual-hash cache is reused on a dual-boot install, not recomputed.
    fileKey       TEXT    NOT NULL UNIQUE,
    fileSize      INTEGER NOT NULL,
    dateModified  TEXT    NOT NULL,
    hashType      TEXT    NOT NULL,
    hash          TEXT    NOT NULL,
    dateComputed  TEXT    NOT NULL,
    thumbnailPath TEXT
  );
`;

// ---------------------------------------------------------------------------
// Compound indexes
// ---------------------------------------------------------------------------

const SQL_CREATE_INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_files_locationId    ON files(locationId);
  CREATE INDEX IF NOT EXISTS idx_files_extension     ON files(extension);
  CREATE INDEX IF NOT EXISTS idx_files_absolutePath  ON files(absolutePath);
  -- Durable file identity: the same physical file has one identity across OSes,
  -- drive/mount prefixes, and location re-points. Replaces the old
  -- UNIQUE(absolutePath) constraint, which duplicated a shared library on a
  -- cross-OS boot because the same file has a different absolutePath per OS.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_files_location_relpath ON files(locationId, relativePath);
  CREATE INDEX IF NOT EXISTS idx_files_ino           ON files(ino);
  CREATE INDEX IF NOT EXISTS idx_files_dateAdded     ON files(dateAdded);
  CREATE INDEX IF NOT EXISTS idx_files_dateModified  ON files(dateModified);
  CREATE INDEX IF NOT EXISTS idx_files_dateCreated   ON files(dateCreated);
  CREATE INDEX IF NOT EXISTS idx_files_size          ON files(size);
  CREATE INDEX IF NOT EXISTS idx_files_width         ON files(width);
  CREATE INDEX IF NOT EXISTS idx_files_height        ON files(height);
  CREATE INDEX IF NOT EXISTS idx_files_name          ON files(name);
  CREATE INDEX IF NOT EXISTS idx_file_tags_tagId     ON file_tags(tagId);
  CREATE INDEX IF NOT EXISTS idx_file_tags_fileId    ON file_tags(fileId);
  CREATE INDEX IF NOT EXISTS idx_locations_dateAdded ON locations(dateAdded);
  CREATE INDEX IF NOT EXISTS idx_dismissed_groupHash   ON dismissedDuplicateGroups(groupHash);
  CREATE INDEX IF NOT EXISTS idx_dismissed_dismissedAt ON dismissedDuplicateGroups(dismissedAt);
  CREATE INDEX IF NOT EXISTS idx_visualHashes_fileKey ON visualHashes(fileKey);
`;

// ---------------------------------------------------------------------------
// FTS5 virtual table for full-text filename search
// ---------------------------------------------------------------------------
// The `content` and `content_rowid` options link the FTS shadow tables to the
// files table so that the FTS index stays in sync via the three triggers below.

// The FTS mirror indexes the portable identity component (relativePath) rather
// than the per-OS absolutePath, so the mirror stays stable across a cross-OS
// boot and consistent with the durable identity.
const SQL_CREATE_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    name,
    relativePath,
    content='files',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, name, relativePath)
    VALUES (new.rowid, new.name, new.relativePath);
  END;

  CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name, relativePath)
    VALUES ('delete', old.rowid, old.name, old.relativePath);
  END;

  CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name, relativePath)
    VALUES ('delete', old.rowid, old.name, old.relativePath);
    INSERT INTO files_fts(rowid, name, relativePath)
    VALUES (new.rowid, new.name, new.relativePath);
  END;
`;

// ---------------------------------------------------------------------------
// Migration table
// ---------------------------------------------------------------------------
// Each migration entry has a version number and the SQL to apply.  Migrations
// are applied in order, and the applied version is recorded in PRAGMA
// user_version so that re-runs on an already-migrated database are no-ops.

type Migration = {
  version: number;
  description: string;
  sql: string;
};

// Exported for the codec-migration test (tests/sqlite-codec-migration.test.ts):
// the migration SQL must run against a real SQLite engine, and better-sqlite3
// (Electron ABI) does not load under jest.
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema: core tables, compound indexes, FTS5 virtual table, sync triggers',
    sql: SQL_CREATE_TABLES + SQL_CREATE_INDEXES + SQL_CREATE_FTS,
  },
  // The codec columns deliberately live ONLY in this migration, not in
  // SQL_CREATE_TABLES: a brand-new database runs v1 then v2 in one pass, so
  // putting them in both would fail the ALTER with "duplicate column" on
  // every fresh install, while the migration alone serves new and
  // already-created databases identically.
  {
    version: 2,
    description:
      'MOV playback: nullable videoCodec/audioCodec/codecVersion columns on files',
    sql: `
      ALTER TABLE files ADD COLUMN videoCodec TEXT;
      ALTER TABLE files ADD COLUMN audioCodec TEXT;
      ALTER TABLE files ADD COLUMN codecVersion TEXT;
    `,
  },
  // Same precedent as the v2 codec columns: the container fact lives ONLY in
  // this migration, never in SQL_CREATE_TABLES. A brand-new database runs v1 →
  // v2 → v3 in one pass, so declaring it in both would fail the ALTER with
  // "duplicate column" on every fresh install.
  {
    version: 3,
    description:
      'MKV/TS playback: nullable formatName column on files',
    sql: `
      ALTER TABLE files ADD COLUMN formatName TEXT;
    `,
  },
];

// ---------------------------------------------------------------------------
// Portable-shared-library schema migration (idempotent, re-entrant)
// ---------------------------------------------------------------------------
// Transforms a pre-portable database in place to the portable identity model:
// (locationId, relativePath) uniqueness + portable-keyed caches. Guarded by
// schema introspection (pragma / sqlite_master) so it detects exactly what is
// missing and re-running is a no-op — this is the shared-`data/` requirement:
// the same DB is opened from both OSes, and the second boot must not repeat or
// undo the first's work. A brand-new database (created from the current
// SQL_CREATE_* which already carries the portable schema) needs nothing here.

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function objectExists(db: Database.Database, type: 'index' | 'table', name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?`)
      .get(type, name) !== undefined
  );
}

/** True when files_fts still mirrors the old per-OS absolutePath (needs rebuild). */
function ftsMirrorsAbsolutePath(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE name = 'files_fts'`)
    .get() as { sql?: string } | undefined;
  return row?.sql?.includes('absolutePath') ?? false;
}

/**
 * Whether {@link migratePortableSchema} has anything to do on this database.
 * Cheap (a handful of pragma / sqlite_master reads); used to gate the one-time
 * backup and the migration itself so steady-state boots pay nothing.
 */
export function needsPortableSchemaMigration(db: Database.Database): boolean {
  return (
    !columnExists(db, 'locations', 'portableRoot') ||
    !objectExists(db, 'index', 'idx_files_location_relpath') ||
    !columnExists(db, 'visualHashes', 'fileKey') ||
    ftsMirrorsAbsolutePath(db)
  );
}

/**
 * Apply the portable-identity schema transform in a single transaction. Each
 * step is guarded so the function is idempotent (safe to run every boot and on
 * the second OS of a shared `data/`). Callers should back up the DB first when
 * {@link needsPortableSchemaMigration} is true.
 */
export function migratePortableSchema(db: Database.Database): void {
  db.transaction(() => {
    // (a) Location anchor column.
    if (!columnExists(db, 'locations', 'portableRoot')) {
      db.exec('ALTER TABLE locations ADD COLUMN portableRoot TEXT');
    }

    // (b) Durable file identity = (locationId, relativePath). Resolve any legacy
    // duplicate identity rows (keeping the lowest rowid) BEFORE the unique index
    // so its creation cannot fail. The old UNIQUE(absolutePath) is left in place
    // (dropping it needs a full table rebuild; per-OS absolutePaths stay unique,
    // so it never fires) — absolutePath is simply demoted to a derived column.
    if (!objectExists(db, 'index', 'idx_files_location_relpath')) {
      db.exec(
        `DELETE FROM files
         WHERE rowid NOT IN (SELECT MIN(rowid) FROM files GROUP BY locationId, relativePath)`,
      );
      db.exec(
        'CREATE UNIQUE INDEX idx_files_location_relpath ON files(locationId, relativePath)',
      );
    }

    // (c) Rebuild the FTS mirror off relativePath (was absolutePath).
    if (ftsMirrorsAbsolutePath(db)) {
      db.exec(`
        DROP TRIGGER IF EXISTS files_ai;
        DROP TRIGGER IF EXISTS files_ad;
        DROP TRIGGER IF EXISTS files_au;
        DROP TABLE IF EXISTS files_fts;
      `);
      db.exec(SQL_CREATE_FTS);
      db.exec(
        `INSERT INTO files_fts(rowid, name, relativePath) SELECT rowid, name, relativePath FROM files`,
      );
    }

    // (d) Visual-hash cache re-keyed on the portable fileKey. Add the column,
    // backfill from the files table (the legacy row's absolutePath matches a
    // file's stored absolutePath), then enforce uniqueness. The SQL below MUST
    // match portableFileKey(): `${locationId}/${relativePath}` with backslashes
    // folded to '/' and leading separators stripped. Unmatched rows keep a NULL
    // fileKey (harmless; the hash regenerates lazily under the portable key).
    if (columnExists(db, 'visualHashes', 'absolutePath') && !columnExists(db, 'visualHashes', 'fileKey')) {
      db.exec('ALTER TABLE visualHashes ADD COLUMN fileKey TEXT');
      db.exec(`
        UPDATE visualHashes
        SET fileKey = (
          SELECT f.locationId || '/' || ltrim(replace(f.relativePath, char(92), '/'), '/')
          FROM files f
          WHERE f.absolutePath = visualHashes.absolutePath
        )
        WHERE fileKey IS NULL
      `);
      // Drop rows that could not be matched so the unique index below is clean and
      // the cache regenerates lazily under the portable key.
      db.exec('DELETE FROM visualHashes WHERE fileKey IS NULL');
    }
    if (columnExists(db, 'visualHashes', 'fileKey') && !objectExists(db, 'index', 'idx_visualHashes_fileKey')) {
      db.exec('DROP INDEX IF EXISTS idx_visualHashes_absolutePath');
      db.exec('CREATE UNIQUE INDEX idx_visualHashes_fileKey ON visualHashes(fileKey)');
    }
  })();
}

// ---------------------------------------------------------------------------
// Public initialization function
// ---------------------------------------------------------------------------

/** The minimum surface both better-sqlite3's Database and node:sqlite's
 *  DatabaseSync satisfy — exec plus a row-returning prepare (PRAGMA reads). */
export interface MigrationTarget {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/**
 * Apply every pending MIGRATIONS entry and record the TRUE maximum applied
 * version in PRAGMA user_version, so re-runs on an already-migrated database
 * are no-ops (the highest of what was already stored and what we just ran —
 * on a shared `data/` this must reflect reality so the other OS's launch does
 * not re-run or skip migrations based on a stale constant).
 *
 * The version is re-read INSIDE a BEGIN IMMEDIATE: Electron boots two renderer
 * windows that each open the same DB file; a window that read user_version
 * before the other's migration committed must WAIT for the write lock (paired
 * with the busy_timeout set by sqliteInit), then see the committed version and
 * skip — otherwise it prepares statements against the mid-migration schema and
 * dies with a SqliteError ("no such column: f.videoCodec"). The immediate
 * transaction ensures a partial failure leaves the database at its previous
 * clean version.
 *
 * Exported for tests/sqlite-codec-migration.test.ts, which drives this same
 * apply loop through node:sqlite: better-sqlite3's native binary is built
 * against the Electron ABI and cannot load under plain node/jest.
 */
export function applyMigrations(db: MigrationTarget): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    const storedVersion = row?.user_version ?? 0;
    const pendingMigrations = MIGRATIONS.filter((m) => m.version > storedVersion);
    if (pendingMigrations.length === 0) {
      db.exec('COMMIT');
      return;
    }
    for (const migration of pendingMigrations) {
      console.info(`SQLite: applying migration v${migration.version} — ${migration.description}`);
      db.exec(migration.sql);
    }
    const appliedMax = Math.max(storedVersion, ...pendingMigrations.map((m) => m.version));
    db.exec(`PRAGMA user_version = ${appliedMax}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Opens (or creates) the SQLite database at `dbPath`, applies any pending
 * schema migrations, and returns the ready-to-use `better-sqlite3` Database
 * instance.
 *
 * WAL journal mode is enabled for improved concurrent read performance.
 * Foreign key enforcement is turned on so that ON DELETE CASCADE in file_tags
 * is honoured automatically.
 */
export function sqliteInit(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Busy timeout FIRST so every statement below (and the migration's BEGIN
  // IMMEDIATE) waits out a concurrent window's write lock instead of throwing
  // SQLITE_BUSY — Electron boots two renderers against this same file.
  db.pragma('busy_timeout = 5000');

  // WAL mode gives significantly better read/write concurrency in Electron
  // where the renderer and main process may access the file simultaneously.
  db.pragma('journal_mode = WAL');

  // Enforce referential integrity (e.g. file_tags.fileId -> files.id CASCADE).
  db.pragma('foreign_keys = ON');

  // Apply every migration whose version number exceeds the stored version
  // (version re-read under the write lock — see applyMigrations).
  applyMigrations(db);

  // Portable-shared-library schema transform: idempotent and independent of
  // user_version (it targets pre-portable databases created before this schema,
  // which are already at the latest user_version). Back up first — a real
  // thousands-entry library is being restructured — using SQLite's consistent
  // snapshot (VACUUM INTO). Skipped for in-memory databases (tests).
  if (dbPath !== ':memory:' && needsPortableSchemaMigration(db)) {
    try {
      const backupPath = `${dbPath}.pre-portable-${Date.now()}.bak`;
      db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
      console.info(`SQLite: backed up pre-portable database to ${backupPath}`);
    } catch (e) {
      // A failed backup must not silently proceed into a destructive migration.
      console.error('SQLite: pre-portable backup failed; aborting schema migration', e);
      throw e;
    }
  }
  if (needsPortableSchemaMigration(db)) {
    console.info('SQLite: applying portable-shared-library schema migration...');
    migratePortableSchema(db);
  }

  return db;
}
