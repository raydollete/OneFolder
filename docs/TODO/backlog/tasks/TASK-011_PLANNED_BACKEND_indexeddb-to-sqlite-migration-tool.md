---
id: TASK-011
title: 'Build one-time IndexedDB-to-SQLite migration tool for existing users'
investigation: INV-002
status: planned
priority: high
blocked_by: [TASK-008, TASK-009]
date_created: 2026-04-04
date_completed:
files:
  - 'src/backend/migration-indexeddb-to-sqlite.ts (new)'
  - 'src/renderer.tsx'
---

## What

Create a one-time migration module that detects an existing IndexedDB/Dexie database, exports all data from it, imports it into the new SQLite database, and then marks the migration as complete. Update `src/renderer.tsx` to run this migration on first launch after the update.

## Why

Existing users have data in IndexedDB (tags, files, locations, searches, dismissed duplicates, visual hashes). This data must be preserved when upgrading to the SQLite backend. The migration must be automatic, safe, and idempotent.

See [INV-002](../investigations/INV-002_HIGH_BACKEND_sqlite-migration-and-portable-mode.md).

## Implementation Steps

- [ ] 1. Create `src/backend/migration-indexeddb-to-sqlite.ts`. Export an async function `migrateIfNeeded(sqliteDbPath: string): Promise<boolean>` that returns `true` if migration was performed.

- [ ] 2. Detection logic: Check if the SQLite database file already exists and has data (e.g., `SELECT COUNT(*) FROM files` > 0). If so, skip migration. Also check a migration flag: store `migrated_from_indexeddb = true` in a `metadata` SQLite table or as a file marker (`migration-complete.flag` in the userData directory).

- [ ] 3. If migration is needed:
    - a. Open the existing Dexie database using `dbInit(DB_NAME)` from `src/backend/config.ts` (keep the old config around for migration only).
    - b. Read all data from each table: `db.table('files').toArray()`, `db.table('tags').toArray()`, `db.table('locations').toArray()`, `db.table('searches').toArray()`, `db.table('dismissedDuplicateGroups').toArray()`, `db.table('visualHashes').toArray()`.
    - c. Open the SQLite database using `sqliteInit(sqliteDbPath)` from `src/backend/sqlite-config.ts`.
    - d. Within a single SQLite transaction, insert all data:
      - For each file: insert into `files` table, then insert each tag ID into `file_tags` junction table.
      - For each tag: serialize `subTags` to JSON, `isHidden` to 0/1, dates to ISO strings.
      - For each location: serialize `subLocations` to JSON, dates to ISO strings.
      - For each search: serialize `criteria` to JSON, `matchAny` to 0/1.
      - For dismissed duplicate groups and visual hashes: straightforward field mapping with date serialization.
    - e. After successful insert, write the migration-complete marker.
    - f. Log the migration result: number of files, tags, locations migrated.

- [ ] 4. Error handling: If migration fails partway through, the SQLite transaction rolls back automatically. The migration-complete marker is NOT written, so it will be retried on next launch. Log the error clearly.

- [ ] 5. Important: Do NOT delete the IndexedDB database after migration. Keep it as a safety net. Users can manually clear it later via DevTools or a future cleanup option.

- [ ] 6. Update `src/renderer.tsx` `main()` function: Before initializing the SQLite backend, call `await migrateIfNeeded(sqliteDbPath)`. The migration runs before `Backend.init()` or `SQLiteBackend.init()`.

- [ ] 7. Handle date conversion carefully:
    - Dexie stores JS `Date` objects natively.
    - SQLite stores ISO 8601 strings.
    - `file.dateAdded.toISOString()` for each date field.
    - Null/undefined date fields should fallback to `new Date().toISOString()`.

- [ ] 8. Handle the `VisualHashDTO.id` field: In Dexie it is auto-incremented. In SQLite the `visualHashes` table uses `INTEGER PRIMARY KEY AUTOINCREMENT`. Do NOT carry over the Dexie auto-increment ID -- let SQLite assign new ones.

## Done When

- [ ] Migration runs automatically on first launch after update
- [ ] All 6 tables are correctly migrated with proper type conversions
- [ ] `file_tags` junction table is populated from `FileDTO.tags` arrays
- [ ] Migration is idempotent -- running it twice does not duplicate data
- [ ] Failed migration rolls back cleanly and retries on next launch
- [ ] Original IndexedDB data is preserved (not deleted)
- [ ] Migration completes in under 30 seconds for a 50,000 file library
