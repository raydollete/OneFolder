---
id: TASK-008
title: 'Design and implement SQLite schema with compound indexes and FTS5'
investigation: INV-002
status: done
priority: high
blocked_by: []
date_created: 2026-04-04
date_completed: 2026-04-04
files:
  - 'src/backend/sqlite-config.ts (new)'
---

## What

Create `src/backend/sqlite-config.ts` containing the complete SQLite schema definition, migration versioning system, and database initialization function. The schema must mirror the 6 existing Dexie tables (files, tags, locations, searches, dismissedDuplicateGroups, visualHashes) plus a `file_tags` junction table for efficient tag queries, and an FTS5 virtual table for full-text filename search.

## Why

The current Dexie schema in `src/backend/config.ts` defines indexes that cannot support compound queries, full-text search, or aggregation. A properly designed SQL schema with compound indexes and FTS5 solves all performance limitations identified in INV-002.

See [INV-002](../investigations/INV-002_HIGH_BACKEND_sqlite-migration-and-portable-mode.md).

## Implementation Steps

- [x] 1. Create `src/backend/sqlite-config.ts`. Define the SQL schema:

  ```sql
  -- Core tables
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    ino TEXT,
    locationId TEXT NOT NULL,
    relativePath TEXT NOT NULL,
    absolutePath TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    extension TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    dateAdded TEXT NOT NULL,        -- ISO 8601
    dateModified TEXT NOT NULL,     -- ISO 8601
    dateCreated TEXT NOT NULL,      -- ISO 8601
    dateLastIndexed TEXT NOT NULL,  -- ISO 8601
    annotations TEXT NOT NULL DEFAULT '{}'
  );

  -- Junction table for file<->tag many-to-many
  CREATE TABLE IF NOT EXISTS file_tags (
    fileId TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tagId TEXT NOT NULL,
    PRIMARY KEY (fileId, tagId)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dateAdded TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    subTags TEXT NOT NULL DEFAULT '[]',   -- JSON array of tag IDs
    isHidden INTEGER NOT NULL DEFAULT 0   -- SQLite boolean
  );

  CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    dateAdded TEXT NOT NULL,
    subLocations TEXT NOT NULL DEFAULT '[]',  -- JSON
    "index" INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS searches (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    criteria TEXT NOT NULL DEFAULT '[]',  -- JSON
    matchAny INTEGER NOT NULL DEFAULT 0,
    "index" INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS dismissedDuplicateGroups (
    id TEXT PRIMARY KEY,
    groupHash TEXT NOT NULL UNIQUE,
    algorithm TEXT NOT NULL,
    fileIds TEXT NOT NULL,           -- JSON array
    dismissedAt TEXT NOT NULL,
    userNote TEXT
  );

  CREATE TABLE IF NOT EXISTS visualHashes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    absolutePath TEXT NOT NULL UNIQUE,
    fileSize INTEGER NOT NULL,
    dateModified TEXT NOT NULL,
    hashType TEXT NOT NULL,
    hash TEXT NOT NULL,
    dateComputed TEXT NOT NULL,
    thumbnailPath TEXT
  );
  ```

- [x] 2. Define compound indexes:

  ```sql
  CREATE INDEX IF NOT EXISTS idx_files_locationId ON files(locationId);
  CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
  CREATE INDEX IF NOT EXISTS idx_files_absolutePath ON files(absolutePath);
  CREATE INDEX IF NOT EXISTS idx_files_ino ON files(ino);
  CREATE INDEX IF NOT EXISTS idx_files_dateAdded ON files(dateAdded);
  CREATE INDEX IF NOT EXISTS idx_files_dateModified ON files(dateModified);
  CREATE INDEX IF NOT EXISTS idx_files_dateCreated ON files(dateCreated);
  CREATE INDEX IF NOT EXISTS idx_files_size ON files(size);
  CREATE INDEX IF NOT EXISTS idx_files_width ON files(width);
  CREATE INDEX IF NOT EXISTS idx_files_height ON files(height);
  CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
  CREATE INDEX IF NOT EXISTS idx_file_tags_tagId ON file_tags(tagId);
  CREATE INDEX IF NOT EXISTS idx_file_tags_fileId ON file_tags(fileId);
  CREATE INDEX IF NOT EXISTS idx_locations_dateAdded ON locations(dateAdded);
  CREATE INDEX IF NOT EXISTS idx_dismissed_groupHash ON dismissedDuplicateGroups(groupHash);
  CREATE INDEX IF NOT EXISTS idx_dismissed_dismissedAt ON dismissedDuplicateGroups(dismissedAt);
  CREATE INDEX IF NOT EXISTS idx_visualHashes_absolutePath ON visualHashes(absolutePath);
  ```

- [x] 3. Define FTS5 virtual table for full-text filename search:

  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    name,
    absolutePath,
    content='files',
    content_rowid='rowid'
  );

  -- Triggers to keep FTS in sync
  CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
    INSERT INTO files_fts(rowid, name, absolutePath) VALUES (new.rowid, new.name, new.absolutePath);
  END;
  CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name, absolutePath) VALUES('delete', old.rowid, old.name, old.absolutePath);
  END;
  CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
    INSERT INTO files_fts(files_fts, rowid, name, absolutePath) VALUES('delete', old.rowid, old.name, old.absolutePath);
    INSERT INTO files_fts(rowid, name, absolutePath) VALUES (new.rowid, new.name, new.absolutePath);
  END;
  ```

- [x] 4. Implement a schema versioning system using a `pragma user_version` integer. Export a `sqliteInit(dbPath: string): Database` function that opens the database, runs `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`, creates all tables/indexes if they do not exist, and applies any version migrations.

- [x] 5. Export constants: `SQLITE_DB_FILENAME = 'onefolder.db'`.

## Done When

- [x] `src/backend/sqlite-config.ts` exists with complete schema, indexes, FTS5, and initialization function
- [x] Schema supports all 6 existing tables plus `file_tags` junction table and `files_fts` FTS5 table
- [x] `sqliteInit()` function creates the database file, applies schema, and returns a `better-sqlite3` Database instance
- [x] Version migration system is in place using `PRAGMA user_version`
