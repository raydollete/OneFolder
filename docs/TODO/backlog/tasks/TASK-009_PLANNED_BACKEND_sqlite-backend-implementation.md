---
id: TASK-009
title: 'Implement SQLiteBackend class with DataStorage interface'
investigation: INV-002
status: planned
priority: high
blocked_by: [TASK-007, TASK-008]
date_created: 2026-04-04
date_completed:
files:
  - 'src/backend/sqlite-backend.ts (new)'
  - 'src/api/data-storage.ts'
---

## What

Create `src/backend/sqlite-backend.ts` containing a `SQLiteBackend` class that implements the `DataStorage` interface using `better-sqlite3`. This replaces the Dexie-based `Backend` class with equivalent functionality powered by SQL queries with proper compound indexes, FTS5 text search, and native aggregation.

## Why

The current `Backend` class in `src/backend/backend.ts` uses Dexie/IndexedDB which cannot do compound queries, full-text search, or aggregation without full table scans. The `SQLiteBackend` implements the same `DataStorage` interface so the rest of the codebase (all MobX stores) requires no changes.

See [INV-002](../investigations/INV-002_HIGH_BACKEND_sqlite-migration-and-portable-mode.md).

## Implementation Steps

- [ ] 1. Install `better-sqlite3` and `@types/better-sqlite3` as dependencies: `yarn add better-sqlite3 && yarn add -D @types/better-sqlite3`.

- [ ] 2. Create `src/backend/sqlite-backend.ts`. Import `Database` from `better-sqlite3` and the `DataStorage` interface. The constructor accepts a `Database` instance and a `notifyChange` callback (matching the existing pattern).

- [ ] 3. Implement `static async init(db: Database, notifyChange: () => void): Promise<SQLiteBackend>` -- creates root tag if not exists (matching `Backend.init` logic at `src/backend/backend.ts:114-132`).

- [ ] 4. Implement all DataStorage methods. Key implementation notes for each:

  **`fetchTags()`** -- `SELECT * FROM tags` then deserialize: parse `subTags` from JSON string to `ID[]`, parse `dateAdded` from ISO string to Date, convert `isHidden` from 0/1 to boolean.

  **`fetchFiles(order, fileOrder)`** -- Handle `order === 'random'` with `ORDER BY RANDOM()`. Otherwise `SELECT f.*, GROUP_CONCAT(ft.tagId) as tagIds FROM files f LEFT JOIN file_tags ft ON f.id = ft.fileId GROUP BY f.id ORDER BY ${order} ${fileOrder === Desc ? 'DESC' : 'ASC'}`. Parse the `tagIds` comma-separated string back into `ID[]`. Parse all Date fields from ISO strings.

  **`fetchFilesByID(ids)`** -- Use `WHERE id IN (${placeholders})` with parameterized query. Join with `file_tags` to reconstruct tags array.

  **`fetchFilesByKey(key, value)`** -- `SELECT ... WHERE ${key} = ?` with file_tags join.

  **`fetchLocations()`** -- `SELECT * FROM locations ORDER BY dateAdded`. Parse `subLocations` from JSON, `dateAdded` from ISO string.

  **`fetchSearches()`** -- `SELECT * FROM searches`. Parse `criteria` from JSON, `matchAny` from 0/1.

  **`searchFiles(criteria, order, fileOrder, matchAny)`** -- Translate each `ConditionDTO` into SQL WHERE clauses:
    - `ArrayConditionDTO` (tags): Use `EXISTS (SELECT 1 FROM file_tags WHERE fileId = f.id AND tagId IN (...))` for contains, `NOT EXISTS` for notContains. Empty array check: `NOT EXISTS (SELECT 1 FROM file_tags WHERE fileId = f.id)` for "no tags".
    - `StringConditionDTO`: Map operators to SQL: `equals` -> `= ?`, `contains` -> `LIKE '%' || ? || '%'`, `startsWith` -> `LIKE ? || '%'`, etc. Use `COLLATE NOCASE` for case-insensitive variants.
    - `NumberConditionDTO`: Direct SQL comparison operators.
    - `DateConditionDTO`: Compare ISO date strings with range logic (same day = between 00:00 and 23:59).
    - Conjoin with AND or OR based on `matchAny`.

  **`createTag(tag)`** -- `INSERT INTO tags`. Serialize `subTags` to JSON, `isHidden` to 0/1, `dateAdded` to ISO string.

  **`createFilesFromPath(path, files)`** -- Within a transaction: query existing absolutePaths with `WHERE absolutePath LIKE ? || '%'`, filter new files, then `INSERT INTO files` + `INSERT INTO file_tags` for each file's tags.

  **`createLocation(location)`** -- `INSERT INTO locations`. Serialize `subLocations` to JSON.

  **`createSearch(search)`** -- `INSERT INTO searches`. Serialize `criteria` to JSON.

  **`saveTag(tag)`** -- `INSERT OR REPLACE INTO tags`.

  **`saveFiles(files)`** -- Within a transaction: for each file, `INSERT OR REPLACE INTO files`, delete existing file_tags rows, insert new file_tags rows.

  **`saveLocation(location)`** -- `INSERT OR REPLACE INTO locations`.

  **`saveSearch(search)`** -- `INSERT OR REPLACE INTO searches`.

  **`removeTags(tags)`** -- Transaction: `DELETE FROM file_tags WHERE tagId IN (...)`, then `DELETE FROM tags WHERE id IN (...)`.

  **`mergeTags(tagToBeRemoved, tagToMergeWith)`** -- Transaction: `UPDATE file_tags SET tagId = ? WHERE tagId = ?` (handle unique constraint violations by deleting duplicates first), then `DELETE FROM tags WHERE id = ?`.

  **`removeFiles(files)`** -- `DELETE FROM files WHERE id IN (...)`. The `ON DELETE CASCADE` on file_tags handles tag cleanup.

  **`removeLocation(location)`** -- Transaction: `DELETE FROM files WHERE locationId = ?` (CASCADE handles file_tags), then `DELETE FROM locations WHERE id = ?`.

  **`removeSearch(search)`** -- `DELETE FROM searches WHERE id = ?`.

  **`countFiles()`** -- `SELECT COUNT(*) FROM files` for total count. `SELECT COUNT(*) FROM files f WHERE NOT EXISTS (SELECT 1 FROM file_tags WHERE fileId = f.id)` for untagged count. Both are O(index-scan), not O(n).

  **`clear()`** -- Drop all tables or delete the database file.

  **`clearFilesOnly()`** -- Transaction: `DELETE FROM files`, `DELETE FROM visualHashes`, `DELETE FROM dismissedDuplicateGroups`.

  **Visual hash methods** -- Direct SQL CRUD on `visualHashes` table. `fetchVisualHashes(absolutePaths)` uses `WHERE absolutePath IN (...)`.

  **Dismissed duplicate group methods** -- Direct SQL CRUD on `dismissedDuplicateGroups` table.

- [ ] 5. Create helper functions for DTO serialization/deserialization:
  - `fileRowToDTO(row): FileDTO` -- converts SQLite row (ISO dates, comma-separated tags) to FileDTO
  - `fileDTOToRow(dto): object` -- converts FileDTO to SQLite row values
  - `tagRowToDTO(row): TagDTO` -- parses JSON subTags, converts isHidden 0/1 to boolean
  - `locationRowToDTO(row): LocationDTO` -- parses JSON subLocations
  - `searchRowToDTO(row): FileSearchDTO` -- parses JSON criteria

- [ ] 6. Use `better-sqlite3`'s `transaction()` method for all multi-statement operations. This is synchronous and much simpler than Dexie's async transaction API.

- [ ] 7. Prepare all frequently-used SQL statements at init time using `db.prepare()` for optimal performance.

## Done When

- [ ] `SQLiteBackend` class compiles and implements every method of the `DataStorage` interface
- [ ] Tag queries use the `file_tags` junction table (not JSON arrays)
- [ ] `countFiles()` uses `SELECT COUNT(*)` (no full table scan)
- [ ] String "contains" queries use `LIKE` with proper escaping (or FTS5 for full-text)
- [ ] All Date fields are correctly serialized to/from ISO 8601 strings
- [ ] All array fields (`tags`, `subTags`, `subLocations`, `criteria`) are correctly serialized
- [ ] Prepared statements are used for hot-path queries
- [ ] `yarn lint` passes
