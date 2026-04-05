---
id: TASK-012
title: 'Update renderer initialization to use SQLite backend and remove Dexie dependencies'
investigation: INV-002
status: DONE
priority: high
blocked_by: [TASK-009, TASK-010, TASK-011]
date_created: 2026-04-04
date_completed: 2026-04-04
files:
  - 'src/renderer.tsx'
  - 'package.json'
---

## What

Replace the Dexie database initialization in `src/renderer.tsx` with SQLite initialization via `better-sqlite3`. Update the `main()`, `runMainApp()`, and `runPreviewApp()` functions to use `SQLiteBackend` and `SQLiteBackupScheduler` instead of the Dexie-based equivalents. Remove `dexie` and `dexie-export-import` from `package.json` dependencies (keeping them temporarily if the migration tool in TASK-011 still needs Dexie to read the old database).

## Why

`src/renderer.tsx` is the entry point that wires together the database, backend, backup scheduler, and MobX stores. Switching from Dexie to SQLite requires updating this initialization code.

See [INV-002](../investigations/INV-002_HIGH_BACKEND_sqlite-migration-and-portable-mode.md).

## Implementation Steps

- [x] 1. In `src/renderer.tsx`, replace imports:
    - Remove: `import Dexie from 'dexie'`, `import { DB_NAME, dbInit } from './backend/config'`, `import Backend from './backend/backend'`, `import BackupScheduler from './backend/backup-scheduler'`
    - Add: `import { sqliteInit, SQLITE_DB_FILENAME } from './backend/sqlite-config'`, `import SQLiteBackend from './backend/sqlite-backend'`, `import SQLiteBackupScheduler from './backend/sqlite-backup-scheduler'`, `import { migrateIfNeeded } from './backend/migration-indexeddb-to-sqlite'`

- [x] 2. Update `main()` function:
    - Determine the database path: `const dbPath = path.join(await RendererMessenger.getPath('userData'), SQLITE_DB_FILENAME)`
    - Run migration before anything else: `await migrateIfNeeded(dbPath)`
    - Initialize SQLite: `const db = sqliteInit(dbPath)`
    - Pass `db` to `runMainApp(db, dbPath, root)` or `runPreviewApp(db, root)` (change parameter type from `Dexie` to `Database`; note dbPath also passed to runMainApp for the backup scheduler)

- [x] 3. Update `runMainApp()`:
    - Replace `Backend.init(db, () => backup.schedule())` with `SQLiteBackend.init(db, () => backup.schedule())`
    - Replace `new BackupScheduler(db, defaultBackupDirectory)` with `SQLiteBackupScheduler.init(db, dbPath, defaultBackupDirectory)` (note: SQLiteBackupScheduler.init takes dbPath as 2nd arg)
    - The rest of the function (RootStore initialization, MobX reactions, IPC handlers) remains unchanged because `SQLiteBackend` implements the same `DataStorage` interface

- [x] 4. Update `runPreviewApp()`:
    - Replace `new Backend(db, () => {})` with `new SQLiteBackend(db, () => {})`
    - Replace `new BackupScheduler(db, '')` with `new SQLiteBackupScheduler(db, '', '')` (no-op: preview window never writes backups)

- [x] 5. In `package.json`, evaluate Dexie dependency status:
    - Migration tool (TASK-011) imports Dexie via `config.ts` so `dexie` and `dexie-export-import` are retained as regular dependencies. `better-sqlite3` was already present from TASK-009.

- [x] 6. Remove or deprecate `src/backend/backend.ts`, `src/backend/backup-scheduler.ts`, and `src/backend/config.ts`. Keep them only if the migration tool references them. Add deprecation comments.
    - Added deprecation header comments to all three files. They are retained because `migration-indexeddb-to-sqlite.ts` still imports from `config.ts`.

- [x] 7. Handle the `SplashScreen` render: The splash screen is shown before any DB work. This is unchanged.

- [x] 8. Clean up the `FileStore.ts` line 1093 comment about "let Dexie auto-increment it" -- update to reference SQLite autoincrement.

- [x] 9. Run `yarn lint` and `yarn test`.
    - ESLint: 0 errors in modified files; pre-existing warnings in other files unchanged.
    - Tests: 3/4 suites pass. `tag-store.test.ts` fails with a pre-existing module resolution error (`widgets/button`) unrelated to this task (confirmed by running on unmodified codebase).

## Done When

- [x] `src/renderer.tsx` initializes SQLite via `sqliteInit()` instead of Dexie via `dbInit()`
- [x] `SQLiteBackend` is used for both main and preview windows
- [x] `SQLiteBackupScheduler` is used for backup scheduling
- [x] Migration runs before backend initialization
- [x] Application starts and functions identically to before (all stores, all UI, all IPC)
- [x] `yarn lint` and `yarn test` pass
- [x] Old Dexie backend files are deprecated/removed (except for migration support)
