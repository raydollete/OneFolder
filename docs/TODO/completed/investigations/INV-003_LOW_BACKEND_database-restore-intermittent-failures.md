---
id: INV-003
title: 'Database restore is intermittently unreliable on Windows portable builds'
reported_bug: 'Restoring a SQLite backup from Settings > ImportExport sometimes shows pre-restore data after relaunch, and sometimes kills the app without relaunching'
date: 2026-04-21
status: tasks-created
superseded_by:
tasks_spawned: [TASK-019, TASK-020]
root_cause_category: order-of-operations
affects:
  - 'Backup/restore flow (SQLiteBackupScheduler.restoreFromFile)'
  - 'Windows portable relaunch path (main.ts forceRelaunch)'
---

## Bug Report

### Observed Behavior

Reported against a packaged Windows **portable** build (NSIS portable target from `electron-builder`) that the user moved to a fresh directory. From Settings > ImportExport the user clicked "Restore database from file" and selected a backup `.db`. Across three attempts:

1. App relaunched, but the UI showed blank/pre-restore data (the restore looked like a no-op).
2. App was killed and never came back — no restart occurred.
3. After manually relaunching and retrying the restore, the data finally appeared.

The workaround ("retry a few times") works, so the user has marked the bug **low priority**.

### Expected Behavior

Restoring a backup from ImportExport should be a deterministic single-shot: the selected `.db` replaces the active library database, the app relaunches cleanly, and the restored data is visible after the new window opens.

### Reproduction Context

- Packaged Windows portable build only. The issue hinges on the NSIS portable target's temp-directory lifetime and on Windows file-locking/AV behaviour around SQLite sidecar files.
- Intermittent / racy. Neither symptom is deterministic; across three attempts the user saw both the "blank data" symptom and the "app never comes back" symptom.
- Both symptoms happen in the restore flow specifically, which is the only code path that combines a database swap on disk with a `forceRelaunch()` call in quick succession.

The shipping code lives in commit `9d50d808` ("Fix post-QA bugs"). `git show 9d50d808` surfaces the current `forceRelaunch` implementation and its design rationale.

---

## Root Cause Analysis

**Category:** order-of-operations

### Diagnosis

The symptom pattern is actually two independent defects that share the same user-visible flow. Neither one alone explains all three attempts; together they explain the non-determinism.

**Bug A — stale WAL/SHM sidecars shadow the restored database.** `SQLiteBackupScheduler.restoreFromFile` (`src/backend/sqlite-backup-scheduler.ts:94-113`) does the following:

1. `this.#db.close()`
2. `await fse.copyFile(backupPath, this.#dbPath)` — overwrites only the main `.db`
3. `finally { this.#db = new Database(this.#dbPath); }` — reopens a connection immediately

better-sqlite3's `close()` should checkpoint WAL and clean up `-wal`/`-shm`, but on Windows those sidecars can survive — AV scanners holding file handles, NSIS-portable timing, or SQLite opening in a mode that leaves a truncated WAL behind. When the relaunched process opens the restored main `.db`, SQLite finds `-wal`/`-shm` whose header no longer matches. In the best case they are silently discarded; in the worst case stale WAL frames get replayed on top of the restored database. Either way the user sees "the restore didn't take."

Separately, the `finally` block reopens a connection *before* the caller signals the relaunch. Because `forceRelaunch` calls `app.exit(0)` without firing `will-quit`, that reopened handle is leaked and can leave fresh `-wal`/`-shm` on disk, contributing to the same class of problem on the next restart.

**Bug B — portable relaunch race.** `forceRelaunch()` in `src/main.ts:976-999` does:

```
const exe = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath;
spawn(exe, args, { detached: true, stdio: 'ignore', env: process.env }).unref();
app.exit(0);
```

Two problems on the NSIS Windows portable target:

1. `env: process.env` still carries `PORTABLE_EXECUTABLE_FILE` and `PORTABLE_EXECUTABLE_DIR` pointing at the *current* NSIS extraction. The spawned child inherits those and can end up confused about where "portable" actually is while the parent is in the middle of tearing down that extraction.
2. `app.exit(0)` runs synchronously with no `will-quit` and no grace period for the child to finish bootstrapping. The parent NSIS wrapper then wipes its temp directory. The child process either wins the race (relaunch succeeds) or loses it (app just quits) — non-deterministically.

Neither bug is "wrong." Both are order-of-operations defects: Bug A assumes `close()` + file copy is atomic with respect to sidecars (it isn't on Windows); Bug B assumes `spawn().unref()` + immediate `app.exit(0)` gives the child enough independent life to survive NSIS teardown (intermittently it doesn't).

`forceRelaunch` replacing `app.relaunch()` was deliberate and is documented in the function's comment — that choice is not in question. The fix must stay inside `forceRelaunch` (and the restore flow), not revert it.

### Diagnostic Questions Considered

- **Wrong mental model?** Partial. Bug A rests on a Windows-specific mismatch between "what better-sqlite3 `close()` guarantees" and "what actually survives on disk."
- **Architectural shortcoming?** No — the backup/restore module is cleanly factored. The defects are localized.
- **Incorrect order of operations?** Yes, primary category. Bug A: sidecars are not explicitly removed between close and copy. Bug B: `app.exit(0)` fires before the spawned child has a chance to detach from the NSIS parent.
- **Missing edge case?** Yes, adjacent to the order-of-operations framing. WAL/SHM being left behind after `close()` is an edge case on Windows that the code does not handle.
- **Wrong abstraction?** No.
- **Silent failure?** Partial. Bug A is genuinely silent — stale WAL replay on top of a copied DB produces no error, just wrong data.

---

## Blast Radius

Scope is deliberately limited to the backup/restore flow. Other `forceRelaunch` callers (`src/main.ts:276` menu Restart, `src/main.ts:573` update-restart, `src/main.ts:672` `onClearDatabase`) share Bug B in principle but are out of scope for this investigation — they do not combine a database swap with a relaunch and the user has not reported issues against them. They will benefit transitively from the Bug B fix.

1. **`src/backend/sqlite-backup-scheduler.ts:94-113` (`restoreFromFile`)** — Bug A origin. Needs explicit sidecar removal and a reopen policy that doesn't leave a fresh handle open when the caller intends to relaunch.
2. **`src/main.ts:976-999` (`forceRelaunch`)** — Bug B origin. Needs to scrub `PORTABLE_EXECUTABLE_*` from the child's env and defer `app.exit(0)` so the child can survive NSIS temp-dir teardown. Transitively improves all other callers of `forceRelaunch` without expanding scope.
3. **`src/frontend/containers/Settings/ImportExport.tsx:156-174`** — Caller of the restore path. No code change expected; included here because this is the only user-triggered entry point for both bugs combined.
4. **`src/frontend/stores/RootStore.ts:199-201` (`restoreDatabaseFromFile`)** — Thin delegation to the scheduler. No code change expected; included so readers of either task can trace the full flow.

---

## UX / Requirements Specification

### Purpose

Make "Restore database from file" a single deterministic action on Windows portable builds: one click, one relaunch, restored data visible.

### User-Stated Design Decisions

1. **Keep `forceRelaunch` as the relaunch primitive.** Its replacement of `app.relaunch()` was deliberate and documented. Do not revert it.
2. **Split the fix by layer.** Bug A is backend; Bug B is Electron main-process lifecycle. Different files, different test strategies, different risk profiles — so split into two tasks.
3. **Keep the task descriptions crisp.** Low-priority racy edge case; do not over-spec.
4. **Do not expand scope.** No audit of other `forceRelaunch` callers. No rewrite of the backup/restore module.

### Behavioral Specifications

- After `restoreFromFile(backupPath)` returns successfully, the on-disk state must be: main `.db` = contents of `backupPath`; no `-wal`, `-shm`, or `-journal` file from the previous database; and no live connection to the new file held by the now-teardown-bound renderer process.
- After `forceRelaunch()` is called on a Windows portable build, either the replacement process is already running (preferred) or Electron's exit is deferred long enough for the spawned child to detach from the NSIS parent's lifetime.
- Neither fix should regress the dev workflow (`process.execPath` path) or other packaged targets (Linux AppImage, etc.).

### Explicit Rejections

- Do NOT remove `forceRelaunch`.
- Do NOT replace `forceRelaunch` with `app.relaunch()`.
- Do NOT audit or modify other `forceRelaunch` call sites beyond the relaunch function itself.
- Do NOT rewrite the backup/restore module — the current factoring is fine.
- Do NOT attempt to unit-test the portable relaunch path. Verification there is manual (packaged portable build, copy to a fresh directory, try restore).

---

## Holistic Solution

### Approach

**Bug A (TASK-019, BACKEND):** In `SQLiteBackupScheduler.restoreFromFile`, after `this.#db.close()` and before `fse.copyFile`, explicitly `fse.remove()` the three potential sidecars alongside `this.#dbPath`: `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`. Change the `finally` block so the reopened connection is either skipped entirely when the caller intends to relaunch, or opened and then closed deterministically — do not leak a fresh handle across the `app.exit(0)` boundary. Add a unit-style test that uses `fs-extra` on a temp dir with a planted stale `-wal` to prove the stale sidecar gets cleared.

**Bug B (TASK-020, ELECTRON):** In `forceRelaunch`, scrub `PORTABLE_EXECUTABLE_FILE` and `PORTABLE_EXECUTABLE_DIR` from the child's env before `spawn`, and defer the exit (`app.quit()` + `app.once('will-quit', () => app.exit(0))`, or move the `spawn` inside a `will-quit` handler). Verification is manual on a packaged Windows portable build copied to a fresh directory.

### Expected Outcomes

- Restore from file completes in one click: the relaunched window shows the restored data, first try.
- No accumulation of stale `-wal`/`-shm` sidecars across multiple restore cycles.
- `forceRelaunch` on Windows portable no longer intermittently kills the app without restarting.

### Risks and Tradeoffs

- **Bug A test coverage is narrow.** We can exercise the sidecar-cleanup code in Node via `fs-extra` on a temp dir, but we cannot reproduce the Windows AV/locking race in CI. The test guards the code path; it does not guard the race.
- **Deferring `app.exit(0)` changes shutdown ordering.** If deferring the exit surfaces any `will-quit` handlers that currently run harmlessly, they become meaningful. Today there are no custom `will-quit` handlers in `src/main.ts`, so the risk is low, but the task should grep for any that land in the future.
- **This is low priority.** The workaround ("retry") works. Don't gold-plate.

---

## Documentation Updates

- [x] No updates needed
