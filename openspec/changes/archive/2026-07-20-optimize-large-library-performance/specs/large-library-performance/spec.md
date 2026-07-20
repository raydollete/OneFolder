# large-library-performance

## Purpose

Defines responsiveness requirements for gallery views over large libraries (thousands to tens of thousands of assets): bounded time-to-interactive on view load, no unbounded per-file synchronous work on the UI thread, startup reconciliation off the interactive path, and refetch/layout work that does not silently regress to full-library sweeps.

## ADDED Requirements

### Requirement: View load becomes interactive without blocking on full-library materialization
The gallery SHALL become interactive — first content painted and user input handled — without a single synchronous UI-thread pass that scales with total library size (SQL row mapping, DTO allocation, ClientFile construction). Remaining items SHALL materialize progressively in bounded batches that yield to the event loop.

#### Scenario: Cold load of a large view
- **WHEN** a view containing at least 10,000 assets is loaded
- **THEN** the first screenful of gallery content renders and responds to input before the full file list has been materialized, and no single uninterrupted UI-thread task processes the entire result set

#### Scenario: Full list still reachable
- **WHEN** progressive materialization completes
- **THEN** the view contains exactly the same file set, order, and selection behavior as a non-progressive load would have produced

### Requirement: Startup location reconciliation stays off the interactive path
Startup watcher reconciliation (created/missing/moved matching) SHALL NOT issue a duplicate full-library fetch and SHALL NOT run its matching passes as a blocking task on the renderer thread while the gallery is interactive.

#### Scenario: App start with watched locations
- **WHEN** the app starts and `watchLocations` reconciles disk state against the database
- **THEN** the file list already fetched for the initial view is reused (no second full `fetchFiles`), and reconciliation work runs off-thread or in yielded batches such that the gallery remains responsive throughout

### Requirement: File existence is not re-verified by a full per-load disk sweep
A view fetch or refetch SHALL NOT stat every file in the result set on disk. Existence state SHALL derive from watcher-supplied information, with an on-demand per-file check as fallback when a file fails to load.

#### Scenario: Refetch of a large view
- **WHEN** a loaded view of N files refetches (sort change, filter toggle, or watcher-triggered refetch)
- **THEN** the number of filesystem existence checks performed is not proportional to N

#### Scenario: Missing file still detected
- **WHEN** a file was deleted outside the app while it was not running or its thumbnail fails to load
- **THEN** the file is still flagged missing (watcher initial-scan reconciliation or on-demand check), matching current missing-file behavior

### Requirement: Random ordering is session-stable and does not force a full-table sort per fetch
The "random" sort order SHALL be produced from a session-stable seed such that (a) refetches within a session preserve the existing order instead of reshuffling, and (b) the database query does not perform an unindexed full-table `ORDER BY RANDOM()` on every fetch. A new shuffle SHALL occur when the user explicitly re-selects random ordering or a new session begins.

#### Scenario: Watcher-triggered refetch under random sort
- **WHEN** files are added to a watched folder while the gallery is in random order
- **THEN** existing items keep their positions after the refetch and new items are inserted per the seeded order

### Requirement: Layout dimension transfer is proportional to change and content recomputes are debounced
Masonry layout recomputation SHALL transfer item dimensions across the JS↔WASM boundary in volume proportional to what changed — a bulk transfer or delta writes of only changed indices — never one boundary call per file on every compute, and SHALL debounce content-driven recomputes so bursts of file-list changes coalesce into one layout pass. A recompute whose inputs (item count, dimensions, container, options) are unchanged SHALL be skipped entirely.

#### Scenario: Batch of watcher events
- **WHEN** a batch of new files lands in a watched folder causing multiple refetches within the debounce window
- **THEN** at most one full layout recompute runs for the burst, and only changed/new item dimensions cross the JS↔WASM boundary

#### Scenario: Refetch of identical content
- **WHEN** a refetch returns the same items with the same dimensions and the container is unchanged
- **THEN** zero dimension writes cross the boundary and the layout computation is skipped

Note: amended during apply from the original "bulk transfer" wording (design.md → Implementation Amendments #2) — implemented as delta writes through the existing per-item API because no Rust/wasm toolchain exists on this machine to add a bulk entry point; the normative guarantee is boundary traffic proportional to change.

### Requirement: Metadata persistence semantics survive observability restructuring
Reducing per-file MobX reaction count SHALL NOT change persistence behavior: an edit to file metadata (tags, annotations) SHALL still be persisted automatically within the current debounce envelope, and no edit SHALL be lost when many files change in one action.

#### Scenario: Bulk tag edit persists
- **WHEN** a tag is applied to a multi-file selection
- **THEN** every affected file's change is persisted to the database (verifiable by reload), matching pre-change behavior

### Requirement: Load-phase instrumentation exists
The view-load pipeline SHALL record per-phase timings (backend fetch, DTO mapping, ClientFile materialization, existence resolution, layout) retrievable from the developer console, so performance regressions are measurable.

#### Scenario: Timings observable after load
- **WHEN** a view load completes in a development build
- **THEN** per-phase durations for that load are available in the console/log output

### Requirement: Desktop and headless web builds keep interface parity
Any change to the `DataStorage` fetch interface (windowing, projection, ordering parameters) SHALL be implemented for both the desktop SQLite backend and the headless web sidecar's HTTP-backed storage, and the frontend SHALL keep importing platform capabilities only via `src/frontend/platform`.

#### Scenario: Web sidecar still builds and serves
- **WHEN** the fetch interface changes land
- **THEN** `yarn build:web` and `yarn build:server` succeed and the web build serves a gallery view using the same store code paths
