import Database from 'better-sqlite3';

// The filename for the SQLite database file stored alongside application data
export const SQLITE_DB_FILENAME = 'onefolder.db';

// Increment this constant whenever a schema migration is added to MIGRATIONS below.
// It is written to the database via PRAGMA user_version so that future launches can
// detect which migrations have already been applied.
const CURRENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Schema DDL
// ---------------------------------------------------------------------------

// Core tables that mirror the 6 existing Dexie collections.
// Tags stored in FileDTO.tags (ID[]) are extracted into a file_tags junction
// table so that tag filtering can use indexed lookups instead of full scans.
const SQL_CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS files (
    id             TEXT    PRIMARY KEY,
    ino            TEXT,
    locationId     TEXT    NOT NULL,
    relativePath   TEXT    NOT NULL,
    absolutePath   TEXT    NOT NULL UNIQUE,
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
    "index"      INTEGER NOT NULL DEFAULT 0
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
    absolutePath  TEXT    NOT NULL UNIQUE,
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
  CREATE INDEX IF NOT EXISTS idx_visualHashes_absolutePath ON visualHashes(absolutePath);
`;

// ---------------------------------------------------------------------------
// FTS5 virtual table for full-text filename search
// ---------------------------------------------------------------------------
// The `content` and `content_rowid` options link the FTS shadow tables to the
// files table so that the FTS index stays in sync via the three triggers below.

const SQL_CREATE_FTS = `
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    name,
    absolutePath,
    content='files',
    content_rowid='rowid'
  );

  CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, name, absolutePath)
    VALUES (new.rowid, new.name, new.absolutePath);
  END;

  CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name, absolutePath)
    VALUES ('delete', old.rowid, old.name, old.absolutePath);
  END;

  CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name, absolutePath)
    VALUES ('delete', old.rowid, old.name, old.absolutePath);
    INSERT INTO files_fts(rowid, name, absolutePath)
    VALUES (new.rowid, new.name, new.absolutePath);
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

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: 'Initial schema: core tables, compound indexes, FTS5 virtual table, sync triggers',
    sql: SQL_CREATE_TABLES + SQL_CREATE_INDEXES + SQL_CREATE_FTS,
  },
];

// ---------------------------------------------------------------------------
// Public initialization function
// ---------------------------------------------------------------------------

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

  // WAL mode gives significantly better read/write concurrency in Electron
  // where the renderer and main process may access the file simultaneously.
  db.pragma('journal_mode = WAL');

  // Enforce referential integrity (e.g. file_tags.fileId -> files.id CASCADE).
  db.pragma('foreign_keys = ON');

  // Read the version recorded in the database (0 for a brand-new file).
  const currentVersion = db.pragma('user_version', { simple: true }) as number;

  // Apply every migration whose version number exceeds the stored version.
  // Wrapping the whole sequence in a single transaction ensures that a
  // partial failure leaves the database at the previous clean version.
  const pendingMigrations = MIGRATIONS.filter((m) => m.version > currentVersion);

  if (pendingMigrations.length > 0) {
    db.transaction(() => {
      for (const migration of pendingMigrations) {
        console.info(`SQLite: applying migration v${migration.version} — ${migration.description}`);
        db.exec(migration.sql);
      }
      // Record the highest applied version.
      db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    })();
  }

  return db;
}
