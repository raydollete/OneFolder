# Optimize view loading and responsiveness for large libraries

Tier: 3 — cross-cutting architectural work: the load path spans the SQLite backend query layer, FileStore/entity materialization, MobX observability design, the masonry layout pipeline, and startup location reconciliation; not bounded to one subsystem.
Type: feature

## Why

Views containing thousands of media assets leave the interface unresponsive for seconds: every view load runs an unbounded O(N) chain — full-table SQL fetch with no LIMIT, N DTO allocations, N MobX-observable ClientFile constructions (each installing its own auto-save reaction), N filesystem existence checks, and a full-list masonry layout recompute — all on the renderer/UI thread, with a synchronous better-sqlite3 connection blocking it for the query duration. The codebase's own comments acknowledge the problem (a "57k+ files" workload note at `src/frontend/stores/FileStore.ts:1703`, "Do this in a web worker, not in the renderer thread!" at `src/frontend/stores/LocationStore.ts:144`).

## What Changes

- Bound the view-load pipeline: replace the load-everything `.all()` fetch + eager full-set ClientFile materialization with a windowed/incremental strategy so time-to-interactive no longer scales linearly with library size.
- Eliminate the per-ClientFile auto-save `reaction` (one live MobX reaction per file, N total) in favor of a centralized dirty-tracking mechanism with equivalent persistence semantics (debounced writes preserved).
- Make masonry layout incremental/debounced on the content path: stop re-crossing the JS↔WASM boundary once per file for the entire list on every `fileListLastModified` tick.
- Remove the duplicate full `fetchFiles` at startup in `watchLocations` and move the created/missing/moved reconciliation off the renderer thread (existing in-code TODOs).
- Replace the per-load N × `fs.pathExists` existence sweep with watcher-supplied existence state (existing in-code TODO).
- Address the default `ORDER BY RANDOM()` sort forcing a full unindexed sort of all rows on every fetch (stable seeded ordering), preserving the user-visible "random order" feature.
- Add lightweight load-phase instrumentation (timings per phase) so before/after gains are measurable and regressions detectable.
- Non-goals: the thumbnail pipeline (already visible-only with a bounded worker pool), DOM virtualization (already capped at 512 cells), and any change to the on-disk data model or EXIF/XMP philosophy.

## Capabilities

### New Capabilities
- `large-library-performance`: responsiveness requirements for views with thousands of assets — bounded time-to-interactive on view load, no unbounded per-file synchronous work on the UI thread, startup reconciliation off the render path, and layout/refetch work proportional to what changed rather than to library size.

### Modified Capabilities

None. Existing specs were reviewed: `location-watching` covers display names, watcher error surfacing, and slow-scan progress notes — moving reconciliation off-thread and dropping the duplicate fetch are implementation-level and leave those requirements intact; `media-type-filter`, `multi-select-tagging`, `video-playback`, `viewer-file-anchoring`, `video-metadata-display`, `inspector-metadata-reliability`, and `dependency-hygiene` state no timing/throughput requirements that this change alters.

## Impact

- **Backend**: `src/backend/sqlite-backend.ts` (fetch/search query shape, windowing), `src/backend/sqlite-config.ts` (indexes if new sort keys are introduced). Queries run synchronously on the renderer thread today; any windowing change must keep the `DataStorage` interface honored by both the desktop SQLite backend and the headless web sidecar's HttpBackend (platform-seam constraint: frontend imports only from `src/frontend/platform`; desktop behavior must stay identical per `docs/headless-web-build.md`).
- **Stores/entities**: `src/frontend/stores/FileStore.ts`, `src/frontend/entities/File.ts`, `src/frontend/stores/LocationStore.ts`, `src/frontend/stores/RootStore.ts`, `src/frontend/stores/UiStore.ts` — materialization, auto-save, startup ordering, selection observability.
- **Rendering**: `src/frontend/containers/ContentView/Masonry/` (worker adapter, renderer) — incremental layout; WASM masonry module interface may gain an incremental entry point (`wasm/` Rust crate).
- **Dependencies**: no new runtime dependencies planned. MobX stays at 6.x (`fileList.replace()` remains avoided — known broken for large lists, MobX #3189, noted at `src/frontend/stores/FileStore.ts:1705`).
- **Risk**: this touches the single hottest data path in the app; regressions would affect every view. Mitigated by phase instrumentation, existing Jest suites, and manual-QA evidence gates for GUI verification (REQUIRES MANUAL EXECUTION per `docs/TODO/QA-DISCIPLINE.md`).

## Blast Radius

1. `src/backend/sqlite-backend.ts:464` — `fetchFiles()` builds `${FILE_SELECT} ... ORDER BY` and calls `.all()` with no LIMIT/OFFSET; returns every row on every load.
2. `src/backend/sqlite-backend.ts:524` — `searchFiles()` same unbounded `.all()` shape.
3. `src/backend/sqlite-backend.ts:212` — `FILE_SELECT` joins + GROUP_CONCATs `file_tags` over the whole table per fetch; row mapping `fileRowToDTO` is O(N) on the UI thread (synchronous better-sqlite3, `src/backend/sqlite-backend.ts:370`).
4. `src/frontend/stores/FileStore.ts:1630` — `updateFromBackend()` runs two O(N) filter passes, then full clear+push of the observable `fileList` (`:1707`); `fileList.replace()` disabled as broken for large lists (`:1705`).
5. `src/frontend/stores/FileStore.ts:1845` — `filesFromBackend()` maps every DTO to a new ClientFile eagerly; in-code comment at `:1867` flags missing pooling.
6. `src/frontend/entities/File.ts:109` — every ClientFile constructor installs a MobX `reaction` on `serialize()` (auto-save): N files ⇒ N live reactions plus N observable tag Sets (`:103`).
7. `src/frontend/stores/FileStore.ts:1694` — existence check: one `fs.pathExists` per file per load, 50-way concurrent (`:1716`); refires on every refetch; TODO at `:1693` says chokidar could supply this.
8. `src/frontend/stores/FileStore.ts:78` — default `orderBy = 'random'` ⇒ `ORDER BY RANDOM()`, full unindexed sort of all rows each fetch.
9. `src/frontend/stores/LocationStore.ts:130` — `watchLocations()` re-fetches ALL files a second time at startup (TODO at `:129`); created/missing/moved reconciliation runs on the renderer thread (`:145`–`:328`, worst-case quadratic matching at `:206`; "web worker" TODO at `:144`).
10. `src/frontend/stores/RootStore.ts:137` — startup ordering: `fetchAllFiles()` then unconditional `watchLocations()` serializes two full-library passes before the UI settles.
11. `src/frontend/containers/ContentView/Masonry/MasonryWorkerAdapter.tsx:60` — `compute()` loops one WASM boundary call per file over the entire list.
12. `src/frontend/containers/ContentView/Masonry/MasonryRenderer.tsx:117` — layout recomputed over all items on every `numImages`/`fileListLastModified` change, undebounced on the content path (in-code comment at `:119`); `key={forceRerenderObj.getTime()}` remount at `:184`.
13. `src/frontend/stores/UiStore.ts:744` — `selectAllFiles()` replaces an observable Set with N entries; every visible cell observes it via `fileSelection.has(file)` (`src/frontend/containers/ContentView/GalleryItem.tsx:52`).
14. `src/frontend/stores/LocationStore.ts:626` — watcher new-file events → `debouncedRefetch()` (200 ms) re-runs the entire fetch→materialize→layout chain; file batches thrash it.
15. Audited and deliberately out of scope: thumbnail pipeline is already visible-only with a 4-worker pool and per-file dedup (`src/frontend/image/ThumbnailGeneration.tsx:24`, `src/frontend/image/ImageLoader.ts:104`; lazy request at `src/frontend/containers/ContentView/GalleryItem.tsx:133`); DOM virtualization already bounded to 512 cells (`src/frontend/containers/ContentView/Masonry/VirtualizedRenderer.tsx:70`). The deprecated Dexie backend (`src/backend/backend.ts:1`, marked superseded by sqlite-backend.ts) is dead code for file data and is not touched.
