---
id: TASK-010
title: 'Implement SQLite-based backup scheduler replacing dexie-export-import'
investigation: INV-002
status: planned
priority: high
blocked_by: [TASK-008]
date_created: 2026-04-04
date_completed:
files:
  - 'src/backend/sqlite-backup-scheduler.ts (new)'
  - 'src/api/data-backup.ts'
---

## What

Create `src/backend/sqlite-backup-scheduler.ts` containing a `SQLiteBackupScheduler` class that implements the `DataBackup` interface. Replace the current JSON serialization approach (dexie-export-import) with SQLite's `backup` API or simple file copy of the `.db` file. The periodic backup strategy (rotating auto-backups, daily, weekly) is preserved.

## Why

The current `BackupScheduler` in `src/backend/backup-scheduler.ts` depends on `dexie-export-import` to serialize the entire database to JSON blobs. With SQLite, backups are vastly simpler and faster: copy the `.db` file, or use `better-sqlite3`'s `backup()` API for online backup.

See [INV-002](../investigations/INV-002_HIGH_BACKEND_sqlite-migration-and-portable-mode.md).

## Implementation Steps

- [ ] 1. Create `src/backend/sqlite-backup-scheduler.ts`. Import `Database` from `better-sqlite3` and the `DataBackup` interface from `src/api/data-backup.ts`.

- [ ] 2. Implement the constructor: accepts a `Database` instance and a `backupDirectory` string. Preserve the same scheduling constants from `src/backend/config.ts`: `NUM_AUTO_BACKUPS = 6`, `AUTO_BACKUP_TIMEOUT = 600000` (10 minutes).

- [ ] 3. Implement `schedule()`: same debounce logic as current `BackupScheduler` -- wait 10 seconds after last change, then create a rotating backup.

- [ ] 4. Implement `backupToFile(path: string)`: Use `better-sqlite3`'s `db.backup(path)` method which returns a Promise. This performs a safe online backup even while the database is in use. The backup file extension should be `.db` instead of `.json`. Note: the periodic backups (auto-backup-0.db through auto-backup-5.db, daily.db, weekly.db) use the same rotation logic as the current implementation.

- [ ] 5. Implement `restoreFromFile(path: string)`: Close the current database connection, copy the backup file over the active database file using `fse.copyFile()`, then reopen the connection. The caller (renderer.tsx) should trigger an app relaunch after restore, as with the current implementation.

- [ ] 6. Implement `peekFile(path: string)`: Open the backup file as a read-only SQLite database, run `SELECT COUNT(*) FROM tags` and `SELECT COUNT(*) FROM files`, close, and return `[tagCount, fileCount]`. This replaces the `peakImportFile` (sic) from dexie-export-import.

- [ ] 7. Preserve the `#copyFileIfCreatedBeforeDate` static helper for daily/weekly backup rotation (copy from current `backup-scheduler.ts` -- this logic is filesystem-based and unchanged).

## Done When

- [ ] `SQLiteBackupScheduler` class implements all methods of the `DataBackup` interface
- [ ] `backupToFile` uses `better-sqlite3`'s `backup()` API (not JSON serialization)
- [ ] `restoreFromFile` safely replaces the active database with the backup
- [ ] `peekFile` reads tag/file counts from a backup `.db` file without loading it fully
- [ ] Rotating auto-backup strategy (6 slots, daily, weekly) is preserved
- [ ] No dependency on `dexie-export-import`
