/**
 * Converts a legacy OneFolder Dexie/IndexedDB JSON backup into a SQLite .db
 * file that the current app can import via File -> Restore.
 *
 * Usage:
 *   yarn convert-backup <input.json> [output.db]
 *
 * If [output.db] is omitted, the output is written alongside the input with the
 * same base name and a .db extension.
 *
 * Must be run via Electron (not plain Node) because better-sqlite3 in this
 * project is compiled against Electron's Node ABI. The yarn script handles that.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// SQLite schema (verbatim from src/backend/sqlite-config.ts, v1)
// ---------------------------------------------------------------------------

const SQL_CREATE_SCHEMA = `
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
// Helpers
// ---------------------------------------------------------------------------

function toIso(value) {
  if (value == null) return new Date().toISOString();
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  }
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function rowsFor(tables, name) {
  const entry = tables.find((t) => t.tableName === name);
  return entry && Array.isArray(entry.rows) ? entry.rows : [];
}

function die(msg) {
  console.error('Error:', msg);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Electron prepends its own argv; strip everything up to the script path.
const argv = process.argv.slice(process.argv.findIndex((a) => a.endsWith('convert-dexie-backup.js')) + 1);

if (argv.length < 1) {
  die('Usage: yarn convert-backup <input.json> [output.db]');
}

const inputPath = path.resolve(argv[0]);
const outputPath = argv[1]
  ? path.resolve(argv[1])
  : path.join(path.dirname(inputPath), path.basename(inputPath, path.extname(inputPath)) + '.db');

if (!fs.existsSync(inputPath)) {
  die(`Input file not found: ${inputPath}`);
}
if (fs.existsSync(outputPath)) {
  die(`Output file already exists: ${outputPath}\nDelete it or choose a different path.`);
}

console.info(`Reading  ${inputPath}`);
const raw = fs.readFileSync(inputPath, 'utf8');

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  die(`Input is not valid JSON: ${e.message}`);
}

if (parsed.formatName !== 'dexie' || !parsed.data || !Array.isArray(parsed.data.data)) {
  die('Input does not look like a dexie-export-import JSON backup.');
}

const dbName = parsed.data.databaseName;
const tables = parsed.data.data;

const files = rowsFor(tables, 'files');
const tags = rowsFor(tables, 'tags');
const locations = rowsFor(tables, 'locations');
const searches = rowsFor(tables, 'searches');
const dismissed = rowsFor(tables, 'dismissedDuplicateGroups');
const visualHashes = rowsFor(tables, 'visualHashes');

console.info(
  `Source   database="${dbName}" — ${files.length} files, ${tags.length} tags, ` +
    `${locations.length} locations, ${searches.length} searches, ` +
    `${dismissed.length} dismissed duplicate groups, ${visualHashes.length} visual hashes.`,
);

console.info(`Writing  ${outputPath}`);
const db = new Database(outputPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SQL_CREATE_SCHEMA);
db.pragma('user_version = 1');

const insertFile = db.prepare(`
  INSERT OR IGNORE INTO files
    (id, ino, locationId, relativePath, absolutePath, name, extension, size,
     width, height, dateAdded, dateModified, dateCreated, dateLastIndexed, annotations)
  VALUES
    (@id, @ino, @locationId, @relativePath, @absolutePath, @name, @extension, @size,
     @width, @height, @dateAdded, @dateModified, @dateCreated, @dateLastIndexed, @annotations)
`);
const insertFileTag = db.prepare('INSERT OR IGNORE INTO file_tags (fileId, tagId) VALUES (?, ?)');
const insertTag = db.prepare(`
  INSERT OR IGNORE INTO tags (id, name, dateAdded, color, subTags, isHidden)
  VALUES (@id, @name, @dateAdded, @color, @subTags, @isHidden)
`);
const insertLocation = db.prepare(`
  INSERT OR IGNORE INTO locations (id, path, dateAdded, subLocations, "index")
  VALUES (@id, @path, @dateAdded, @subLocations, @index)
`);
const insertSearch = db.prepare(`
  INSERT OR IGNORE INTO searches (id, name, criteria, matchAny, "index")
  VALUES (@id, @name, @criteria, @matchAny, @index)
`);
const insertDismissed = db.prepare(`
  INSERT OR IGNORE INTO dismissedDuplicateGroups
    (id, groupHash, algorithm, fileIds, dismissedAt, userNote)
  VALUES (@id, @groupHash, @algorithm, @fileIds, @dismissedAt, @userNote)
`);
const insertVisualHash = db.prepare(`
  INSERT OR IGNORE INTO visualHashes
    (absolutePath, fileSize, dateModified, hashType, hash, dateComputed, thumbnailPath)
  VALUES
    (@absolutePath, @fileSize, @dateModified, @hashType, @hash, @dateComputed, @thumbnailPath)
`);

try {
  db.transaction(() => {
    for (const file of files) {
      insertFile.run({
        id: file.id,
        ino: file.ino || '',
        locationId: file.locationId,
        relativePath: file.relativePath,
        absolutePath: file.absolutePath,
        name: file.name,
        extension: file.extension,
        size: file.size,
        width: file.width,
        height: file.height,
        dateAdded: toIso(file.dateAdded),
        dateModified: toIso(file.dateModified),
        dateCreated: toIso(file.dateCreated),
        dateLastIndexed: toIso(file.dateLastIndexed || file.dateAdded),
        annotations: file.annotations || '{}',
      });
      const tagIds = Array.isArray(file.tags) ? file.tags : [];
      for (const tagId of tagIds) {
        insertFileTag.run(file.id, tagId);
      }
    }

    for (const tag of tags) {
      insertTag.run({
        id: tag.id,
        name: tag.name,
        dateAdded: toIso(tag.dateAdded),
        color: tag.color || '',
        subTags: JSON.stringify(Array.isArray(tag.subTags) ? tag.subTags : []),
        isHidden: tag.isHidden ? 1 : 0,
      });
    }

    for (const location of locations) {
      insertLocation.run({
        id: location.id,
        path: location.path,
        dateAdded: toIso(location.dateAdded),
        subLocations: JSON.stringify(
          Array.isArray(location.subLocations) ? location.subLocations : [],
        ),
        index: location.index || 0,
      });
    }

    for (const search of searches) {
      insertSearch.run({
        id: search.id,
        name: search.name,
        criteria: JSON.stringify(Array.isArray(search.criteria) ? search.criteria : []),
        matchAny: search.matchAny ? 1 : 0,
        index: search.index || 0,
      });
    }

    for (const group of dismissed) {
      insertDismissed.run({
        id: group.id,
        groupHash: group.groupHash,
        algorithm: group.algorithm,
        fileIds: group.fileIds,
        dismissedAt: toIso(group.dismissedAt),
        userNote: group.userNote ?? null,
      });
    }

    for (const vh of visualHashes) {
      insertVisualHash.run({
        absolutePath: vh.absolutePath,
        fileSize: vh.fileSize,
        dateModified: toIso(vh.dateModified),
        hashType: vh.hashType,
        hash: vh.hash,
        dateComputed: toIso(vh.dateComputed),
        thumbnailPath: vh.thumbnailPath ?? null,
      });
    }
  })();

  console.info('Success. Import the output file via File -> Restore in OneFolder.');
  console.info(`Output:  ${outputPath}`);
} catch (e) {
  console.error('Conversion failed. Output file may be incomplete.');
  console.error(e);
  try {
    fs.unlinkSync(outputPath);
  } catch (_) {
    // ignore
  }
  process.exit(1);
} finally {
  db.close();
}

// Force exit — Electron's event loop sometimes keeps the process alive.
process.exit(0);
