---
id: INV-002
title: 'Migrate from IndexedDB/Dexie to SQLite and implement full portable mode'
reported_bug: 'IndexedDB performance limitations (no compound indexes, no FTS, no aggregation, no joins) and lack of portable mode support'
date: 2026-04-04
status: tasks-created
superseded_by:
tasks_spawned: [TASK-007, TASK-008, TASK-009, TASK-010, TASK-011, TASK-012, TASK-013, TASK-014]
root_cause_category: architectural-shortcoming
affects:
  - 'Backend data persistence layer (IndexedDB/Dexie)'
  - 'Search and filtering system'
  - 'Backup/restore system'
  - 'Application startup and path resolution'
  - 'Electron packaging and distribution'
  - 'Multi-library support (INV-001)'
---

## Bug Report

### Observed Behavior

The application uses IndexedDB via Dexie.js for all data persistence. This creates two categories of problems:

**Performance and query limitations:**
- No compound indexes: cannot efficiently query `(locationId=X AND tags=Y)` -- must use a single indexed "where" clause then lambda-filter the rest (see `filter()` in `src/backend/backend.ts:347-403`)
- No full-text search: substring searches (e.g., filename contains "vacation") scan every row with JS lambdas (see `filterStringLambda` in `src/backend/backend.ts:500-521`)
- No aggregation: counting untagged files requires `this.#files.filter((file) => file.tags.length === 0).count()` -- a full table scan (see `countFiles()` at line 309-320)
- Complex OR queries force table scans when any criterion lacks an indexed "where" equivalent (see line 357-381)
- Dexie's `.reverse()` is ~5x slower than JS array `.reverse()` -- the code already works around this with a comment at line 190-193
- No joins: multi-table queries (e.g., `removeTags` at line 244-261) require separate fetches and client-side stitching within transactions
- `searchFiles` must sort results with `.sortBy()` after filtering because Dexie cannot combine WHERE + ORDER BY on different indexes

**Portability limitations:**
- All data stored via `app.getPath('userData')` -- tied to system user directories (see `src/main.ts:25`)
- The `src/main.ts:24` TODO comment explicitly references a "portable-improvements branch" that was never completed
- Electron-builder already has a Windows `portable` target configured in `package.json:69` but no path redirection was ever implemented
- Database is opaque browser storage, not a portable file

### Expected Behavior

1. Database operations should use SQL with compound indexes, FTS5 full-text search, and native aggregation
2. The database should be a single portable `.db` file
3. The application should support a portable mode where all data (DB, thumbnails, backups, preferences) lives next to the executable
4. Backups should use SQLite's native backup API instead of JSON serialization via dexie-export-import

### Reproduction Context

Performance issues are proportional to library size. The portability issue is deterministic -- there is currently no way to run the app portably.

---

## Root Cause Analysis

**Category:** architectural-shortcoming

### Diagnosis

The choice of IndexedDB/Dexie was reasonable for an early-stage Electron app, but it has become a structural bottleneck. The limitations are fundamental to IndexedDB's design:

1. **IndexedDB has no query planner.** Each Dexie "where" clause maps to a single index lookup. AND conjunctions beyond the first must use JS lambda filters (see `src/backend/backend.ts:386-402`). This is not a Dexie bug -- it is an IndexedDB limitation.

2. **IndexedDB has no text search.** The `filterStringLambda` functions at line 500-521 implement contains/startsWith in JS, iterating every row. SQLite's FTS5 would handle this with an inverted index.

3. **IndexedDB storage is opaque.** The data lives in Chromium's LevelDB files inside `userData`. It cannot be copied, moved, or inspected without Dexie's export API. This blocks portability, multi-library support (INV-001), and simple user backup.

4. **Path resolution is hardcoded.** `src/main.ts:25` uses `app.getPath('userData')` unconditionally. The renderer's `getDefaultThumbnailDirectory`, `getDefaultBackupDirectory`, and `getThemesDirectory` all derive from `app.getPath()` calls. There is no mechanism to override these for portable mode.

5. **The DataStorage interface leaks Dexie types.** `fetchFilesByKey` in `src/api/data-storage.ts:24` accepts `IndexableType` from Dexie, coupling the interface to its implementation.

### Diagnostic Questions Considered

- **Wrong mental model?** No -- the original choice was pragmatic for a prototype.
- **Architectural shortcoming?** Yes -- IndexedDB's query model cannot scale to the app's needs, and path resolution has no abstraction for portable vs. installed mode.
- **Incorrect order of operations?** No.
- **Missing edge case?** The portable mode TODO has been present since 2021 but was never implemented.
- **Wrong abstraction?** Partially -- the `DataStorage` interface is well-designed and makes the swap feasible, but it leaks `IndexableType`.
- **Silent failure?** No -- the limitations manifest as performance degradation, not errors.

---

## Blast Radius

1. **`src/backend/backend.ts`** -- The entire Dexie implementation must be replaced with a SQLite equivalent. All 6 table operations, transaction handling, and the `filter()` query engine.
2. **`src/backend/config.ts`** -- Dexie schema versioning and `dbInit()` must be replaced with SQLite schema creation and migration.
3. **`src/backend/backup-scheduler.ts`** -- Uses `dexie-export-import` (exportDB, importDB, peakImportFile). Must switch to SQLite backup API or file copy.
4. **`src/api/data-storage.ts`** -- `IndexableType` import from Dexie must be replaced with a generic type (e.g., `string | number | Date`).
5. **`src/renderer.tsx`** -- Initializes Dexie via `dbInit(DB_NAME)` and passes the `Dexie` instance to `Backend` and `BackupScheduler`. Must switch to `better-sqlite3` initialization.
6. **`src/main.ts`** -- `basePath` must support portable mode override. Auto-updater must be disabled in portable mode.
7. **`src/ipc/renderer.ts`** -- `getDefaultThumbnailDirectory`, `getDefaultBackupDirectory`, `getThemesDirectory` must respect portable data directory.
8. **`common/process.ts`** -- Needs a `IS_PORTABLE` detection flag.
9. **`package.json`** -- electron-builder config for portable targets; `dexie` and `dexie-export-import` dependencies replaced with `better-sqlite3`.
10. **INV-001 (multi-library support)** -- SQLite makes each library a separate `.db` file, which simplifies the multi-library architecture planned in TASK-001 through TASK-006.
11. **`src/frontend/stores/FileStore.ts`** -- Line 1093 references "let Dexie auto-increment it" for visual hash IDs. SQLite uses `INTEGER PRIMARY KEY AUTOINCREMENT` instead.
12. **`src/api/visual-hash.ts`** -- The `id?: ID` optional field pattern assumes Dexie auto-increment. SQLite handles this differently (ROWID or explicit autoincrement).

---

## UX / Requirements Specification

### Purpose

Migrate the data layer from IndexedDB/Dexie to SQLite for performance, portability, and future multi-library support. Simultaneously implement portable mode so the app can run from a USB drive.

### User-Stated Design Decisions

1. **Use `better-sqlite3`** -- Synchronous SQLite access in Electron main process. Rationale: better-sqlite3 is the fastest SQLite binding for Node.js and its synchronous API avoids callback complexity.
2. **Implement as a new `SQLiteBackend` class** -- Implements the existing `DataStorage` interface. Rationale: clean swap with minimal disruption to frontend code.
3. **Design proper SQL schema** -- Compound indexes for common queries, FTS5 for text search. Rationale: addresses all query performance issues.
4. **One-time migration tool** -- Export from IndexedDB, import into SQLite. Rationale: existing users must not lose data.
5. **Portable mode detection via marker file** -- Presence of `portable.txt` or `data/` folder next to EXE. Rationale: simple, user-controllable mechanism.
6. **Override `app.setPath('userData', './data/')` before other code** -- Redirects all Chromium storage. Rationale: single override point for all path-dependent code.
7. **Redirect thumbnails to `./data/thumbnails/`** and backups to `./data/backups/` in portable mode.
8. **Disable auto-updates in portable mode** -- Portable users manage their own updates.
9. **Configure electron-builder** for Windows portable EXE and Linux AppImage.
10. **Replace backup system** -- SQLite backup API or file copy of `.db` file instead of JSON serialization.

### Behavioral Specifications

- On first launch after migration: detect existing IndexedDB data, export it, import into SQLite, then continue normally
- Portable mode must be detectable before `app.whenReady()` fires (i.e., at module load time in `src/main.ts`)
- Single-instance lock (`requestSingleInstanceLock`) must still work in portable mode
- The `.db` file should be stored at a user-visible location, not buried in opaque browser storage
- With SQLite, the `countFiles()` method should use `SELECT COUNT(*) ... WHERE tags = '[]'` instead of full table scan

### Explicit Rejections

- Do NOT use an async SQLite driver (e.g., `sql.js` or `better-sqlite3` with worker threads for basic queries) -- synchronous access is preferred for simplicity
- Do NOT remove the `DataStorage` interface -- it is the clean abstraction boundary
- Do NOT change the DTO shapes -- `FileDTO`, `TagDTO`, `LocationDTO`, etc. remain the same

---

## Holistic Solution

### Approach

The work is divided into two parallel tracks that converge:

**Track A: SQLite Migration (TASK-007 through TASK-011)**

1. Clean up the `DataStorage` interface by removing the Dexie `IndexableType` leak
2. Design the SQLite schema with proper indexes, FTS5, and migration versioning
3. Implement `SQLiteBackend` class implementing `DataStorage`
4. Implement `SQLiteBackupScheduler` class implementing `DataBackup`
5. Build a one-time migration tool that exports IndexedDB data and imports into SQLite
6. Update `src/renderer.tsx` initialization to use SQLite instead of Dexie

**Track B: Portable Mode (TASK-012 through TASK-014)**

1. Add portable mode detection in `common/process.ts`
2. Override paths in `src/main.ts` before any other code runs
3. Update `src/ipc/renderer.ts` path helpers to respect portable mode
4. Disable auto-updates in portable mode
5. Configure electron-builder portable targets

### Expected Outcomes

- Search queries with compound conditions run in milliseconds instead of scanning all rows
- `countFiles()` uses `SELECT COUNT(*)` instead of full iteration
- Full-text filename search uses FTS5
- Database is a single `.db` file, visible and portable
- App can run from USB drive with all data alongside the executable
- Backup/restore uses SQLite file copy (fast, atomic)
- Foundation laid for INV-001 multi-library support (each library = one `.db` file)

### Risks and Tradeoffs

1. **better-sqlite3 is a native module** -- requires rebuild for each Electron version. Mitigated by electron-rebuild in build pipeline.
2. **Migration data loss risk** -- the one-time migration must be thoroughly tested. Mitigated by keeping IndexedDB intact until migration is verified, and creating a pre-migration backup.
3. **Date serialization** -- IndexedDB stores JS Date objects natively; SQLite stores them as ISO strings or Unix timestamps. The migration and all read/write paths must handle this conversion.
4. **Array fields** -- `FileDTO.tags` is `ID[]` (a multi-value field). IndexedDB has `MultiEntry` index support for arrays. In SQLite, this requires either a junction table (`file_tags`) or JSON storage. A junction table is strongly preferred for query performance.
5. **`better-sqlite3` runs in the main process or renderer** -- since the current backend runs in the renderer process (see `src/renderer.tsx`), the SQLite instance will also live in the renderer. This is fine for `better-sqlite3`'s synchronous API but means the DB file must be accessible from the renderer process (which it is, since `nodeIntegration: true`).

---

## Documentation Updates

- [ ] Updated: `CLAUDE.md` -- update Backend description from "IndexedDB via Dexie" to "SQLite via better-sqlite3"
- [ ] Updated: `Docs/` -- add SQLite schema documentation
