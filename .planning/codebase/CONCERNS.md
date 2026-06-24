<!-- refreshed: 2026-06-24 -->
# Codebase Concerns

**Analysis Date:** 2026-06-24

## Dependency & Upgrade Constraints

### Electron Pinned at 41.7.2 — Upgrade Blocked by better-sqlite3

**Files:** `package.json`, `src/main.ts`

**Issue:** Electron upgrade ceiling pinned at **41.7.2** (Chromium ~144). Electron 42 cannot be used.

**Root cause:** better-sqlite3 V8 API incompatibility. Electron 42's V8 made the third `ExternalPointerTypeTag` argument to `v8::External::New` mandatory, but better-sqlite3 (v12.10.0, the latest stable as of June 2026) still uses the two-argument form at `src/better_sqlite3.cpp:60`. The native module fails to rebuild under Electron 42's MSVC toolchain.

**Impact:** 
- Security patches in Chromium releases between 41 and current are not available.
- API improvements and performance optimizations in newer Electron are unavailable.
- Eventually this will become a blocker when Electron 41 reaches EOL or a security-critical Chromium CVE demands a newer version.

**Current status:** better-sqlite3 development has a history of lagging V8 API changes (see WiseLibs/better-sqlite3#1416 for the prior Electron 39 incident). No immediate fix is available.

**Mitigation approach:** Before upgrading past 41, verify that a newer better-sqlite3 release compiles against the target Electron's headers. Fast check without a full build: `node_modules/.bin/electron-rebuild --version <target> --only better-sqlite3 --force`. Alternative: migrate to `sql.js` (pure JS, slower) or `@journeyapps/sqlcipher` (via C++ binding rewrite).

---

## Fragile & High-Risk Areas

### Location Loading & Display Name Fallback (INV-013)

**Files:** `src/frontend/entities/Location.ts`, `src/frontend/stores/LocationStore.ts`, `src/frontend/workers/folderWatcher.worker.ts`, `src/backend/sqlite-backend.ts`

**Bugs (active, under TASK-055/056/057):**
1. **Empty location name on drive-root paths** — `ClientLocation.name` derives from `SysPath.basename(this.path)`, which returns empty string for drive roots (`D:\`, `E:\` on Windows; `/` on POSIX; `\\nas\share` UNC roots). This empty name propagates to sidebar labels, toasts, and dialogs, rendering them unusable (e.g., `An error has occurred while initializing location ""`).
2. **20-second "taking longer than usual" toast floods startup** — A fixed 20-second `readyTimeout` in `watchLocations()` fires on every cold start when a location's initial scan exceeds 20 seconds (common on large or slow storage). The toast is misleading because (a) the operation is not hung, just slow, and (b) the only action is "Retry?" which reloads the app and restarts the scan from scratch, making things worse.
3. **Chokidar initial-scan permission errors show as generic toasts** — When a drive-root location is watched, chokidar emits `error` events for system-protected directories (`System Volume Information`, `$RECYCLE.BIN`, etc.) during initial scan. These fire a generic `An error has occurred` toast with no actionable details.
4. **Worker→main error-channel type mismatch** — `folderWatcher.worker.ts` posts a raw `Error` object into a `value: string` slot; the receiver treats it as opaque, losing error code and path information.
5. **Latent: `ClientLocation.isReady` never set to true** — Declared but never assigned, so the toast always says "initializing" even hours into the session.
6. **No validation on persisted location paths** — `path` column is `TEXT NOT NULL` but allows empty string; `createLocation` does not validate; migration does not filter. A corrupted row with `path=''` silently becomes a "broken link" with no UI to remove it.

**Design issue:** The model assumed every location has a non-empty `basename(path)`. Drive roots and UNC roots violate this.

**Planned fix:** TASK-055 (location.name fallback + isReady wiring + structured worker error), TASK-056 (60s threshold + softer copy), TASK-057 (validation on create/migration).

---

### Viewer Pin Invariant During Media Operations

**Files:** `src/frontend/stores/FileStore.ts`, `src/frontend/stores/MediaQueueStore.ts`, `src/frontend/containers/MediaQueue/index.tsx`, `src/media/MediaJobService.ts`

**Constraint (documented in memory):** During encode/normalize/clip operations, **never drop the viewer to the index**. Pin by identity, verify-then-swap; failures as a modal.

**Known fragility:** The ingest suppression mechanism (`LocationStore.suppressIngest()` / `unsuppressIngest()`) prevents the file watcher from auto-ingesting outputs while the renderer is ingesting deterministically, but timing is critical:
1. Media job finishes.
2. `finalizeEncodedOutput` suppresses the output path.
3. `MediaJobService.place()` moves temp → final.
4. `LocationStore.ingestFile()` creates the row deterministically.
5. Unsuppress.

A race where the watcher fires `add()` before the suppress is set, or `unsuppressIngest()` is called before `ingestFile()` completes, or the suppress is somehow never cleared, can result in:
- Duplicate rows (watcher + renderer both create).
- Orphaned temp files (never moved).
- The viewer pinned to the wrong file or index.

**Impact:** The media subsystem (re-encode, normalize, clip) was rebuilt (TASK-038 through TASK-042, TASK-089-TASK-091) specifically to fix these races. The ingest suppression is the linchpin. No code changes should touch `LocationStore.addFile`, `ingestFile`, `MediaJobService.place()`, or the suppress/unsuppress calls without understanding this invariant.

---

### Media Queue Drawer — UI & IPC Boundary (INV-036)

**Files:** `src/frontend/stores/MediaQueueStore.ts`, `src/frontend/containers/MediaQueue/index.tsx`, `src/frontend/containers/Main.tsx`, `resources/style/media-queue.scss`

**Bugs (active, under TASK-146 through TASK-150):**
1. **MobX proxy cloning crash on Create/Subtract Clip** — `MediaQueueStore.runItem` passes `item.clip` (a MobX observable proxy) directly into `RendererMessenger.startMediaJob()`, which serializes across `ipcRenderer.invoke`. The structured clone algorithm cannot clone the proxy; crash with "An object could not be cloned". Rotate/re-encode/normalize (no clip) work fine. Fix: `toJS(item.clip)` at the boundary.
2. **Drawer auto-opens on enqueue and unmounts when empty** — No stable surface; `isDrawerOpen = true` in `enqueue` and `if (!hasItems) return null` in render. User wants always-present, default-collapsed, never auto-opening.
3. **Resolved rows spliced away, no bulk clear** — Keep/Dismiss actions remove the row entirely; no record of resolution; resolved work clutters live work; failed-row Dismiss button mislabeled.
4. **Drawer confined to content area** — Mounted in `<main id="main">` with `position: absolute`; stops at the left Outliner sidebar. User wants full-window-width fixed position.

**Impact:** Users cannot reliably create/subtract clips (crash on enqueue), cannot see what media jobs completed, and the drawer obscures parts of the gallery.

**Planned fix:** TASK-146 (toJS at boundary), TASK-147 (always-visible default-collapsed), TASK-148 (resolved status + clear), TASK-149 (full-width fixed position).

---

### Platform Seam Invariant (Frontend Web Build)

**Files:** `src/frontend/platform/index.ts`, `src/frontend/platform/platform.electron.ts`, `src/frontend/platform/platform.web.ts`, `webpack.prod.js`

**Constraint:** Frontend code **must import platform capabilities from `src/frontend/platform`** — never directly from `fs-extra`, `electron`, `path` (Node), or `common/ExifIO`. Violating this breaks the web bundle at compile time.

**How it works:** A webpack alias selects `platform.electron.ts` (faithful pass-through to Node APIs) or `platform.web.ts` (HTTP-backed stubs + loud rejects for writes) at bundle time. The Electron build is unaffected.

**Current violations:** Workers (`src/frontend/workers/thumbnailGenerator.worker.ts`, `src/frontend/workers/visualSimilarity.worker.ts`) directly import `fs-extra`. This is acceptable because workers are Electron-only and do not ship in the web build; their imports are not aliased. But any future shared code imported by both the main renderer and workers must use the platform seam.

**Risk:** Accidentally importing Node APIs in shared renderer code breaks the web SPA bundle with cryptic module-not-found errors. The error manifests at bundle time (good), not at runtime.

---

## Tech Debt & Design Shortcuts

### LocationStore Initialization — Timeout Heuristic Not Root-Caused

**Files:** `src/frontend/stores/LocationStore.ts:140-155`

**Issue:** The 20-second `readyTimeout` in `watchLocations()` was added as a band-aid for intermittent hangs (`// TODO: Add a maximum timeout for init: sometimes it's hanging for me`). The author admitted they could not find the root cause.

**Current status:** TASK-056 raises the threshold to 60 seconds and reframes the toast as a calm progress note, but does not investigate the original hang. If the hang recurs after 60 seconds, it will be ignored (the toast just says "this can take a while").

**Next step:** If user reports a sustained hang beyond 60 seconds in QA, the hang itself (not the timeout) becomes the investigation target. Look for:
- `fse.pathExists()` or `chokidar.watch()` blocked on a network filesystem.
- A broken symlink loop in the location hierarchy.
- A massive subdirectory that chokidar scans slowly.
- The `refreshSublocations()` SQL query on a very large Locations table.

---

### Portable-Only Mode — Installed-Mode Code Paths Are Dead Weight

**Files:** `src/main.ts`, `package.json` (build config)

**Status:** This OneFolder fork ships **portable-only** (`package:portable` is the canonical build target). Installed-mode code paths (if any) are dead weight.

**Design pattern:** Portable data lives in `{executable_dir}\data` (`app.setPath('userData', ...)` in `main.ts`). Thumbnails, backups, and the SQLite database travel with the app.

**Maintenance concern:** Absolute paths persisted in preferences or the DB (e.g., location paths, thumbnail directory, backup directory) go stale when the portable folder is moved to a new drive letter or computer. Always re-derive root-relative paths at launch instead of trusting persisted absolutes.

**Example:** If a user unzips `OneFolder.zip` to `X:\app`, the app persists `userData` path as `X:\app\data`. If they later move the folder to `D:\app`, the old `X:\app\data` path is stale. The app must re-derive the actual path at startup.

---

### Path Comparison Mismatch — Forward Slashes vs. Backslashes

**Files:** `src/frontend/entities/File.ts` (ClientFile.absolutePath), renderer-side path handling

**Constraint (documented in memory):** Never `===` compare a main-process path (backslashes on Windows) against `ClientFile.absolutePath` (forward slashes). Normalize separators and case first.

**Why it matters:** The renderer uses forward slashes throughout (URL-safe). The main process uses OS-native separators (backslashes on Windows, forward slashes on POSIX). A direct comparison fails on Windows.

**Pattern:** `ClientFile.absolutePath` is built as `Path.join(location.path, relativePath)` by the renderer; `location.path` may come from the main process and use backslashes, but the result is normalized to forward slashes by the Dexie/IndexedDB serialization boundary.

**Risk:** If code mistakenly compares renderer paths against main-process paths without normalizing, it will silently miss matches or produce wrong results.

---

### Duplicate Code in Thumbnail & Image Generation

**Files:** `src/frontend/workers/thumbnailGenerator.worker.ts:generateThumbnailData`, `src/frontend/image/util.ts:generateThumbnail`

**Issue:** Two independent implementations of image-to-thumbnail conversion (canvas-based scaling). The TODO comment admits they should be merged.

**Impact:** 
- Changes to thumbnail generation (quality, format, sizing) must be made in two places.
- If the implementations diverge, the two paths produce different thumbnails (e.g., different aspect-ratio handling).
- Code review burden.

**Low priority:** Merging them requires careful handling of Worker vs. main-thread contexts (the worker uses `OffscreenCanvas` and `FileReaderSync`, the main-thread version may use different APIs).

---

## Test Coverage Gaps

**Files:** `tests/` (21 test files for a ~39K LOC codebase)

**Coverage:** Low. Most tests are integration tests for specific stores or edge cases, not systematic coverage of core paths.

**High-risk untested areas:**
1. **Location initialization and error handling** — No tests for the chokidar flow, initial-scan timeout behavior, or empty-name rendering.
2. **Media job lifecycle** — No tests for the suppress/unsuppress invariant or the viewer-pin reselection on clip output arrival.
3. **Multi-library database migration** — No tests for the migration from single-library to multi-library, or handling of corrupted legacy rows.
4. **File deduplication and move merging** — The `mergeMovedFile` logic and ino-based dedup in `LocationStore.addFile` are untested.
5. **Platform seam** — No tests that actually run the web-build aliases or verify that Node APIs fail loudly on the web platform.

**Mitigation:** The project relies on manual QA and spot-check integration tests. High-risk changes (media jobs, location loading, migrations) should be accompanied by new tests or explicit manual QA passes.

---

## Security Considerations

### No Formal Input Validation on Persisted Paths

**Files:** `src/backend/sqlite-backend.ts`, `src/backend/migration-indexeddb-to-sqlite.ts`, `src/frontend/stores/LocationStore.ts`

**Issue:** Location paths are persisted in the SQLite `locations` table with minimal validation:
- `path TEXT NOT NULL` — allows empty string.
- No check for invalid characters or absolute-vs-relative semantics.
- Migration does not validate rows being copied from legacy Dexie stores.

**Risk:** 
- A corrupted import or manual DB edit with `path=''` or `path='invalid'` could cause silent failures or app instability.
- No protection against path-traversal attacks if user input is ever loaded from untrusted sources (currently not applicable, but a maintenance concern).

**Current status:** TASK-057 adds defensive filtering on load and validation on create, but does not enforce a SQL `CHECK` constraint (deferred).

---

### ExifTool Process Spawning

**Files:** `common/ExifTool.ts`, `src/backend/sqlite-backend.ts` (EXIF read/write paths)

**Concern:** ExifTool is spawned as a subprocess to read and write EXIF metadata. No input sanitization is applied to file paths passed to ExifTool.

**Mitigation:** File paths come from the filesystem (via the watcher and `LocationStore.addFile`) and are not user-supplied strings, so path-injection risk is low. But if the app ever allows users to enter file paths directly (e.g., a "custom source" import), that input must be validated before passing to ExifTool.

**Pattern:** Use proper shell escaping or quote-wrapping (the ExifTool node library should handle this, but verify on upgrade).

---

## Performance Bottlenecks

### FileStore.fetchFromBackend — N=50 Hardcoded Concurrent Fetches

**Files:** `src/frontend/stores/FileStore.ts:1070`

**Issue:** `const N = 50; // TODO: same here as in fetchFromBackend: number of concurrent checks should be system dependent`

A fixed concurrency limit of 50 parallel file stat/metadata checks is used in multiple places. This is a guess and does not adapt to the user's system:
- On a fast SSD with fast network, 50 may be too conservative.
- On a slow HDD or network storage, 50 may thrash and cause timeouts.

**Impact:** Large libraries with tens of thousands of files may experience slower re-indexing.

**Mitigation:** TASK-043/044 (fetch generation gates) reduce the number of times large refetches occur, but the concurrency limit itself is unchanged.

---

### DuplicateGallery Component — 2048 Lines

**Files:** `src/frontend/containers/ContentView/DuplicateGallery.tsx`

**Issue:** The duplicate-detection UI is a single 2048-line component with complex state management, sorting, and layout logic all in one file.

**Impact:** 
- Hard to debug rendering issues.
- Difficult to unit-test individual features (highlight logic, group selection, sort order).
- Changes to duplicate detection require touching a massive component.

**Low priority:** The feature works; refactoring would be cosmetic. But the next time a rendering bug occurs in the duplicate gallery, consider splitting it into smaller sub-components.

---

### FileStore — 2051 Lines, Complex Fetch Generation Logic

**Files:** `src/frontend/stores/FileStore.ts`

**Issue:** A large store with complex fetch-generation gating to handle concurrent concurrent requests, stale-result drops (INV-009), and multi-view state.

**Impact:** 
- Hard to trace the exact code path for a given user action.
- Race conditions are subtle (see the `fetchGeneration` counter and INV-009 remediation).
- Changes require understanding the fetch-generation protocol.

**Mitigation:** `FileStore` is well-commented (see lines 27-100 about INV-007 and INV-009 regressions). The fetch-generation mechanism is intentional and necessary; further refactoring is lower priority.

---

## Scaling Limits

### Single SQLite Database Per Library — No Partitioning

**Files:** `src/backend/sqlite-backend.ts`, `src/backend/sqlite-config.ts`

**Current capacity:** The design assumes one SQLite database per library. Tested and stable with hundreds of thousands of files.

**Limit:** SQLite is single-threaded and uses file-level locking. On a library with millions of files:
- Initial-scan indexing will be very slow (one insert per file).
- Concurrent reads and writes will block each other.
- The SQLite file size may approach limits on some filesystems (though SQLite's WAL mode mitigates this).

**Scaling path:** 
1. Short term: Batch inserts into 1000-file transactions (the current code does this; see `FileStore.saveFilesToSave`).
2. Medium term: Async indexing in a worker thread (already done via the FfmpegRunner pattern; extend to IndexedDB writes).
3. Long term: If libraries exceed 10+ million files, consider partitioning the database or migrating to a multi-table schema.

**Current status:** Not urgent; the user's largest library is ~100k files.

---

## Missing Critical Features

### No Incremental Progress Signal from File Watcher

**Files:** `src/frontend/stores/LocationStore.ts:135-200`, `src/frontend/workers/folderWatcher.worker.ts`

**Gap:** The watcher reports only "ready" (initial files loaded) or "error". There is no progress update stream (e.g., "scanned 1000 files", "scanned 10000 files") during the initial scan.

**Impact:** The renderer cannot distinguish "scanning a large library" from "hung waiting for a syscall". This is why the 20-second timeout exists as a band-aid.

**Fix approach (deferred):** Wire a progress channel from the worker back to the main thread:
1. The worker counts `'add'` events during initial scan.
2. Every N adds (e.g., every 1000 files), post a progress update.
3. The renderer renders a live "Scanned X files…" progress bar instead of a timeout toast.
4. This eliminates the need for a fixed-time heuristic.

**Effort:** Medium (worker contract change, progress UI component, debounce/throttle handling). Deferred as TASK-056 Approach B.

---

## Architectural Debt

### ReEncodeManager.ts Deleted; Replace-in-Progress

**Files:** `src/media/FfmpegRunner.ts`, `src/media/MediaJobService.ts`, `src/frontend/stores/MediaQueueStore.ts`

**Status:** The monolithic `ReEncodeManager.ts` was deleted and split into a 3-layer architecture (FfmpegRunner, MediaJobService, ingestFile). All three layers are in place and tested (TASK-038 through TASK-091).

**Remaining work:**
- INV-036 QA fixes (TASK-146 through TASK-150) for the media queue drawer.
- Documentation updates to the tool docs (normalize-audio.md, reencode-x264.md, create-clip.md).

**Risk:** The 3-layer design is young; unexpected interactions may surface in extended real-world use. The ingest suppression invariant is the most fragile point.

---

## Known Bugs (Minor / Deferred)

### Typo in Location Error Toast

**Files:** `src/frontend/entities/Location.ts:302-310`

**Issue:** `An error has occured` (should be "occurred"). Fixed in TASK-055 when the toast copy is rewritten.

---

### Disabled Hotkey & Keyboard Navigation

**Files:** `src/frontend/stores/UiStore.ts:83`, `src/frontend/containers/AppToolbar/TagButton.tsx:93`

**Issues:**
1. `viewSlide: 'space'` hotkey — "backspace and escape are hardcoded hotkeys to exit slide mode" (comment at line 83). The space hotkey is disabled.
2. TagButton — `tabIndex` comment: "FIXME: Implement toolbar keyboard navigation." Toolbar buttons are not keyboard-navigable.

**Impact:** Accessibility and power-user workflow. Low priority for current user; deferred.

---

### Thumbnail Format Inference

**Files:** `src/frontend/image/ThumbnailGeneration.tsx:21`, `src/frontend/workers/thumbnailGenerator.worker.ts:42-47`

**Issue:** Multiple TODOs about using `native-image` resizing APIs for better performance and quality. Current canvas-based approach works but is not optimized for large images.

---

## Documentation & Operational Gaps

### Portable Persistence Policy Not Fully Documented

**Files:** `docs/`, `src/main.ts` (app.setPath calls)

**Issue:** The portable-only fork stores data in `{executable_dir}\data`, but this behavior is not documented in a user-facing guide. Users moving the portable folder to a new location may not realize their library and settings are preserved.

**Mitigation:** TASK-054 (deferred) proposes documenting the portable persistence policy and adding a startup diagnostic to verify the data folder is writable and contains the expected library.

---

### Multi-Library Migration Not Tested at Scale

**Files:** `src/backend/migration-indexeddb-to-sqlite.ts`, `scripts/convert-dexie-backup.js`

**Issue:** The migration from the legacy single-library (Dexie-based) to multi-library (SQLite-based) is a one-time path run on startup. It has not been tested with users upgrading from very old versions that may have corrupted Dexie data.

**Mitigation:** TASK-057 adds defensive filtering during migration to skip malformed rows. A larger test suite for the migration would be beneficial but is deferred.

---

## Summary of Active Investigations

| ID | Title | Status | Planned Tasks | Root Cause Category |
|----|----|--------|-----------|-----------------|
| INV-013 | Startup empty-location toast and fragile watch timeout | active | TASK-055, TASK-056, TASK-057 | missing-edge-case, UX-threshold |
| INV-036 | Media queue drawer QA fixes (clip clone crash, always-visible, resolved rows, full-width) | active | TASK-146, TASK-147, TASK-148, TASK-149, TASK-150 | silent-failure |

---

*Concerns audit: 2026-06-24*
