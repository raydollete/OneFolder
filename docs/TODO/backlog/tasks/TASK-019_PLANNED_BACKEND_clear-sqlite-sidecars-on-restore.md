---
id: TASK-019
title: 'Clear stale SQLite WAL/SHM sidecars during database restore'
investigation: INV-003
status: planned
priority: low
blocked_by: []
date_created: 2026-04-21
date_completed:
files:
  - 'src/backend/sqlite-backup-scheduler.ts'
  - 'src/backend/__tests__/sqlite-backup-scheduler.test.ts (new or existing)'
---

## What

In `SQLiteBackupScheduler.restoreFromFile` (`src/backend/sqlite-backup-scheduler.ts:94-113`), explicitly remove the three potential SQLite sidecar files (`-wal`, `-shm`, `-journal`) alongside the main `.db` after closing the connection and before copying the backup over. Also stop leaking a fresh reopened connection across the subsequent `forceRelaunch`/`app.exit(0)` — either skip the reopen (the caller always relaunches in the user-facing flow) or reopen and immediately close so no live handle survives into teardown.

## Why

Today, `restoreFromFile` closes the DB then copies the backup file over the main `.db` only. better-sqlite3's `close()` is *supposed* to checkpoint WAL and clean sidecars, but on Windows (AV holding handles, NSIS portable timing) they can survive. When the relaunched process opens the restored main `.db`, SQLite either silently discards the mismatched sidecars or — worst case — replays stale WAL frames on top of the copied database, producing "the restore didn't take" symptoms with no error.

The `finally { this.#db = new Database(...) }` block compounds this by opening a fresh handle right before the caller fires `app.exit(0)`, leaving new `-wal`/`-shm` files on disk at process death.

See [INV-003](../investigations/INV-003_LOW_BACKEND_database-restore-intermittent-failures.md).

## Implementation Steps

- [ ] 1. In `src/backend/sqlite-backup-scheduler.ts`, after `this.#db.close()` and before the `fse.copyFile(backupPath, this.#dbPath)` call, add explicit removal of sidecars. Use `fse.remove` (no-op if missing) for each of `${this.#dbPath}-wal`, `${this.#dbPath}-shm`, `${this.#dbPath}-journal`. Await the three removals (parallel with `Promise.all` is fine; order does not matter relative to each other, only that they complete before the copy).

- [ ] 2. Change the `finally` block behaviour. The caller (`RootStore.restoreDatabaseFromFile` -> `ImportExport.tsx`) always triggers a relaunch on success, so a fresh connection right before `app.exit(0)` is strictly a liability. Two acceptable approaches; pick one and document it in a comment:
  - **(a)** Leave `this.#db` set to the closed `Database` instance (or `null` with a guard) and do not reopen. Add a code comment noting the caller is expected to relaunch. If any future call site needs to keep running after `restoreFromFile`, it must reopen explicitly.
  - **(b)** Reopen only on the error path (inside `catch`), so a successful restore leaves no live handle. The `finally` becomes a `catch` that reopens before rethrowing.

- [ ] 3. Preserve the existing `console.info` / `console.error` logging semantics. Add one `console.debug` or `console.info` line noting which sidecars were removed (helpful when diagnosing future recurrences).

- [ ] 4. Write a unit-style test (co-located with any existing backup scheduler tests, or create `src/backend/__tests__/sqlite-backup-scheduler.test.ts`). The test should:
  - Use `fs-extra` on a real temp directory (`fse.mkdtempSync` under `os.tmpdir()`).
  - Create a dummy "active" `.db` via `better-sqlite3` with a single table and one row.
  - Plant a stale sidecar file — a non-empty buffer at `${dbPath}-wal` is enough to assert removal.
  - Create a separate dummy "backup" `.db` with a distinguishable row.
  - Call `restoreFromFile(backupPath)` on a scheduler instance pointed at the active DB.
  - Assert: main `.db` content matches the backup (reopen and read the distinguishable row), and `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal` no longer exist on disk.
  - Clean up the temp dir with `fse.remove` in a `finally`.

- [ ] 5. Run `yarn test` and confirm the new test passes and no existing tests regress.

## Done When

- [ ] `restoreFromFile` removes `-wal`, `-shm`, and `-journal` before the main `.db` copy.
- [ ] No live `Database` connection is held across the method's return on the success path.
- [ ] A unit test plants a stale `-wal` and proves it is gone after `restoreFromFile` returns.
- [ ] `yarn test` passes.
- [ ] The `console.info('SQLite: Database restored from ...')` log line is preserved so existing diagnostic habits still work.
