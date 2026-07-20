# Design — optimize-large-library-performance

## Context

The view-load pipeline is unbounded O(N) on the renderer/UI thread end to end (see proposal Blast Radius): synchronous better-sqlite3 `.all()` with no LIMIT and a default `ORDER BY RANDOM()`, eager materialization of one MobX-observable ClientFile per row (each installing its own auto-save `reaction`), an N × `fs.pathExists` sweep per load, a full-list masonry recompute with one JS↔WASM call per file, and a startup `watchLocations` pass that re-fetches the whole library and reconciles it on the renderer thread. DOM virtualization (512-cell cap) and the visible-only thumbnail pipeline are already healthy and are untouched.

Binding repo constraints restated: frontend imports platform capabilities only via `src/frontend/platform` (never `fs-extra`/`electron`/Node `path`/`common/ExifIO` directly); the `DataStorage` interface is implemented by both the desktop SQLite backend and the headless web sidecar's HttpBackend, and desktop behavior must stay identical (`docs/headless-web-build.md`); Electron is pinned at 41.7.2 (better-sqlite3 native ceiling); this fork is portable-only; MobX stays at 6.x and `observableArray.replace()` is treated as broken for large arrays (MobX #3189, noted at `src/frontend/stores/FileStore.ts:1705`).

## Goals / Non-Goals

Goals: gallery interactive without any single UI-thread task scaling with library size; startup reconciliation off the interactive path; refetch/layout cost proportional to what changed; persistence semantics preserved; measurable per-phase timings; desktop/web interface parity.

Non-Goals: thumbnail pipeline, DOM virtualization, on-disk data model, EXIF/XMP philosophy, and the library-wide tag/metadata write storms found by bomb-squad (candidate follow-up change — see Bomb-squad findings).

## Approach

Phased, lowest-risk first; each phase lands independently and must show its win in the Phase-0 instrumentation before the next starts.

**Phase 0 — Instrumentation.** New `src/frontend/perf.ts`: a minimal phase tracer (start/end marks, console-retrievable summary per view load). Marks wired into `FileStore.updateFromBackend`/`filesFromBackend` (fetch, DTO map, materialize, existence), `MasonryWorkerAdapter.compute` (layout), and `LocationStore.watchLocations` (reconcile). Dev-build only output; no UI strings.

**Phase 1 — Delete redundant O(N) work (no interface changes).**
- 1a `src/frontend/stores/LocationStore.ts`: `watchLocations` reuses the file list already fetched at startup instead of a second full `fetchFiles` (existing TODO at `:129`); created/missing/moved matching replaces the O(missing×created) `.find` loops with Maps keyed by `ino` and relative path; the reconciliation pass moves off the renderer thread (into the existing `folderWatcher.worker` where possible, else time-yielded batches).
- 1b `src/frontend/stores/FileStore.ts`: remove the per-load `pathExists` sweep (`:1694`); existence derives from the chokidar initial scan (the watcher already stats every file); fallback is an on-demand check when an image/thumbnail load fails. Missing-file detection semantics preserved.
- 1c Seeded random ordering: `orderBy 'random'` stops issuing `ORDER BY RANDOM()`; the backend fetches on an indexed order and the client applies a seeded Fisher–Yates shuffle with a session-stable seed (re-seeded on explicit re-selection of random order). Kills the full-table sort and makes watcher refetches order-stable — also a precondition for any later windowing.

**Phase 2 — Bound materialization (no pagination).** `src/backend/sqlite-backend.ts` exposes an iterating fetch (better-sqlite3 `stmt.iterate()`); `FileStore` consumes it in time-budgeted batches (~8 ms) that yield to the event loop, building DTOs and ClientFiles incrementally: first batch renders immediately, later batches append via `push` inside MobX transactions (`replace()` stays banned). The existing fetch-generation guard (`FileStore.ts:96`) drops stale batch applies. `updateFileListState`/`initializeFileCounts` run once at completion, not per batch. The web sidecar's HttpBackend keeps the one-shot fetch (server boundary already async); interface addition is optional/additive so both backends stay conformant.

**Phase 3 — ClientFile cost reduction.** Remove the per-file auto-save `reaction` (`src/frontend/entities/File.ts:109`). Entity setters call `fileStore.markDirty(fileId)` into a central dirty set; one debounced flusher (same 500 ms envelope) serializes only dirty files and batch-saves; an explicit flush runs on window close/quit so pending edits are never lost. ClientFile instances are pooled/reused across refetches (extend the existing `this.get(f.id)` reuse in `filesFromBackend`).

**Phase 4 — Layout.** `MasonryWorkerAdapter` passes all dimensions in one bulk transfer (Float32Array; the Rust crate in `wasm/` gains a `set_dimensions(slice)` entry point) instead of N `set_dimension` calls; the content-path recompute is debounced (~150 ms, matching the existing resize debounce) and skipped when (count, dimensions-hash) is unchanged.

**Phase 5 — Windowing decision gate (explicitly conditional).** Only if Phase-2 measurements still show the SQL fetch/map phase blocking beyond budget on 50k+ rows: add optional windowing/split-query (lightweight `(id,width,height)` projection for layout + windowed full-row materialization, keyset pagination) to `DataStorage`, mirrored in HttpBackend and the sidecar routes (`src/server/routes/data.ts:130`, `:202` — which currently serialize the whole library per request). This is the peers' preferred end-state (see Review Feedback); it is sequenced last because it forks the interface across desktop+web and requires ID-based selection and DB-side tag counts as preconditions. If triggered, it is scoped as its own follow-up change with user approval rather than silently expanding this one.

**In-scope repairs from bomb-squad** (inside files this change already touches):
- `src/frontend/stores/FileStore.ts:743` — `removeFilesById` uses `fileList.replace()` on the survivor array, the exact API the load path bans for large lists; unify on the splice/push policy chosen here.
- `src/frontend/stores/FileStore.ts:1904` — `updateFileListState` rebuilds the entire id→index Map on every mutation (a single delete pays O(N)); make index maintenance incremental for splice/remove paths.

## Decisions

- **Time-sliced full materialization now; windowing later behind a measured gate** — over the peers' viewport-only lazy materialization — because every consumer of `fileList` (selection Sets holding ClientFile refs, tag counts, groupers, viewer anchoring) assumes a fully materialized list; changing that assumption everywhere at once on the hottest path maximizes regression risk, while time-slicing achieves the responsiveness requirement without breaking any consumer contract. Phase 5 preserves the escalation path with instrumentation as the tripwire.
- **`stmt.iterate()` on the renderer thread, not a DB worker/utilityProcess** — better-sqlite3 is loaded in-process by architecture (portable fork, Electron pin); moving it behind a worker boundary is a larger architectural change with native-module risk. Time-budgeted iteration bounds UI-thread stalls to the batch budget instead.
- **Client-side seeded shuffle, not SQL-side seeded hash ordering** — avoids new SQL surface and keeps HttpBackend parity trivial; the full ordered fetch is index-assisted and the shuffle is O(N) but a single cheap pass.
- **Central dirty-set autosave, not N reactions** — one flusher preserves the debounce envelope with O(dirty) work instead of N standing observers; explicit quit-flush closes the existing loss window.

## UX / Requirements

No new user-facing display strings, labels, options, errors, or empty states are introduced. The gallery fills progressively during large-view loads (items append as batches materialize); ordering, selection behavior, missing-file flagging, and metadata persistence remain behaviorally identical.

### Explicit Rejections

- Loading spinner/skeleton overlay during materialization — rejected: progressive fill of real content is strictly better and adds no new UI surface.
- Viewport-only lazy ClientFile materialization as the first-line fix — rejected for this change (consumer-contract blast radius; see Decisions); preserved as the Phase-5 end-state shape.
- `ORDER BY (id * seed) % p` style SQL pseudo-random ordering — rejected: adds SQL surface and HttpBackend divergence for no win over a client-side seeded shuffle.
- Moving better-sqlite3 into a worker/utilityProcess — rejected: native-module + Electron-pin risk out of proportion to the win once fetches are time-sliced.
- Raising or removing the 512-rendered-cell cap — rejected: virtualization is healthy; the problem is upstream of the DOM.

## Risks / Trade-offs

- [Progressive append changes list-arrival timing; consumers that assumed a single atomic fileList swap may observe partial lists] → all post-load passes (`updateFileListState`, `initializeFileCounts`, selection restoration) run once at batch-completion; fetch-generation guard drops stale batches; Jest coverage over materialization order.
- [Removing the per-file reaction could drop saves if a setter path forgets `markDirty`] → `markDirty` is called from the entity's mutation methods themselves (single choke point), plus a quit-time flush; bulk-tag-edit persistence covered by the spec's reload scenario.
- [Watcher-derived existence misses files deleted while the app was closed] → chokidar initial scan reconciliation (Phase 1a) still detects them; on-demand check on load failure is the second net.
- [Seeded shuffle changes "random" semantics (stable within session)] → this is the spec'd intent (order-stable refetches); re-shuffle on explicit re-selection preserves the feature.
- [Rust/WASM interface change (`set_dimensions` slice) breaks the masonry build] → keep the old per-item API until the bulk path is proven; wasm build verified in CI/dev before adapter switch.
- [Web sidecar drift] → any `DataStorage` signature change is additive/optional; `yarn build:web` + `yarn build:server` are gating verifications on the relevant tasks.

## Migration Plan

Phases land in order 0 → 1 → 2 → 3 → 4, each independently revertible (no data-model or on-disk changes anywhere in this change; rollback = revert the commit). Phase 5 requires a recorded decision from measurements plus user approval as a follow-up change.

## Implementation Amendments (recorded during apply)

Three deviations from the drafted approach, each driven by facts established during implementation:

1. **Phase 2 mechanism: id-projection + chunked by-id fetches, not `stmt.iterate()`.** Holding a better-sqlite3 iterator open across event-loop yields is unsafe: the renderer shares ONE connection, and a watcher-triggered write (`saveFiles` from ingest, debounced saves) landing inside the yielded window would throw ("database connection busy"). Instead the backend gained optional `fetchFileIds`/`searchFileIds` (`src/backend/sqlite-backend.ts:495`, `:581`) returning the cheap ordered id list; `FileStore.runProgressiveFetch` (`src/frontend/stores/FileStore.ts:2038`) then fetches full rows in bounded 800-id batches via the pre-existing `fetchFilesByID`, yielding between chunks. Same bounded-stall goal, no open-iterator hazard, and the optional-method shape keeps HttpBackend conformant untouched.
2. **Phase 4 mechanism: delta dimension writes, not a Rust bulk `set_dimensions`.** No Rust/wasm toolchain exists on this machine (`cargo` absent in both shells; the crate needs a pinned nightly), so the wasm crate cannot be rebuilt here. The adapter instead keeps a JS `Float32Array` mirror of what the WASM side already holds (`dimensionDiff.ts`) and writes only changed indices through the existing per-item API — zero boundary calls on a same-items refetch, only the appended tail during progressive loads. Boundary traffic is proportional to what changed, which is the requirement's intent; the bulk Rust entry point remains a recorded follow-up for when a toolchain is available.
3. **MobX #3189 verdict (task 6.1): `replace()` is NOT broken on the pinned MobX 6.x.** Empirical repro (`tests/mobx-replace-large.test.ts`) replaces a 70k-element observable array without throwing, including the filtered-survivors shape. The unified policy is still clear()+push(...) everywhere (one blessed mutation shape, and chunked pushes avoid spread-arg stack limits that `push(...70k)` itself risks), but the ban is now documented as belt-and-braces, not load-bearing.

Also recorded: removing the per-load existence sweep eliminated `updateFromBackend`'s async second-pass entirely — the INV-028 scroll-during-window race and the INV-009 'async' drop phase for that path are structurally impossible now (single synchronous commit transaction). `tests/file-store-firstitem-scroll-during-fetch.test.ts` was rewritten to test the replacement invariants. The Missing-files view deliberately KEEPS its full existence sweep: that view is the explicit existence audit, and it now refreshes `missingFileIds` so regular loads inherit verified state.

## Open Questions

- Whether MobX #3189 (`replace()` broken for large arrays) still reproduces on the pinned MobX 6.x — resolving it would simplify both the load path and `removeFilesById`; until verified, both sites avoid `replace()`.
- Whether `folderWatcher.worker` can host the reconciliation matching without duplicating DB state, or a yielded-batch renderer implementation is the pragmatic form of "off the interactive path."

## External Review

### Peer Review Verdict

Quorum: achieved (weight 4/3, escalated to tier 2)
Certainty: 1
Caller Agreement: 0.8
Arbiter: ok
Sources:
- gemini-flash (google/gemini-3.5-flash) — ok, agreement 1
- qwen (qLLM) — ok, agreement 1
- deepseek-flash (deepseek-v4-flash) — ok, agreement 1
- gemini-pro (google/gemini-3.1-pro-preview) — error, agreement n/a

### Review Feedback

Consensus feedback recorded verbatim:
- "transitioning to a sparse-index or windowed-materialization model ... implementing cursor-based pagination or split-query interfaces (fetching lightweight layout metadata first, then batch-fetching details)" — ACCEPTED as the shape of the Phase-5 end-state and its split-query design; NOT adopted as the first move (see reconciliation below).
- "replacing 'ORDER BY RANDOM()' with indexed sorting or pseudo-random seeds" — ACCEPTED: Phase 1c seeded session-stable ordering.
- "Lazy-materializing ClientFile observables only for the visible viewport plus a buffer" — REJECTED for this change: every fileList consumer (selection, counts, groupers, anchoring) assumes a materialized list; converting them all is the Phase-5/follow-up scope, not the bounded first intervention. Time-sliced full materialization (Phase 2) meets the responsiveness requirement without breaking consumer contracts.
- "replacing individual auto-save reactions with a centralized save coordinator/dirty-set" — ACCEPTED: Phase 3 verbatim.
- "Optimizing the WASM masonry layout boundary by batching data (e.g., via a single Float32Array buffer) and debouncing/off-loading the computation" — ACCEPTED: Phase 4 verbatim.
- "Moving existence sweeps and watcher reconciliation to background/worker threads using O(1) lookups" — ACCEPTED: Phases 1a/1b verbatim.
- "selection state (must be strictly ID-based)" — ACCEPTED as a recorded Phase-5 precondition; with full materialization retained in this change, the existing object-keyed selection Set remains contract-valid, so the conversion is deliberately deferred to the windowing change.
- "tag/facet counts (must be computed via DB-side SQL aggregation)" — REJECTED for this change, ACCEPTED as a Phase-5 precondition: counts stay in-memory while the full list is resident; DB aggregation becomes necessary only once the list is windowed.
- "viewer anchoring (requires pre-fetching/keyset anchoring)" — ACCEPTED as a recorded Phase-5 precondition (viewer-file-anchoring spec interacts with windowing, not with this change's phases).
- "metadata edits (requires flushing pending edits on window close)" — ACCEPTED: explicit quit-time flush added to Phase 3 in response to this point.
- "performance budgets (<16ms frame budget, memory limits), codebase invariants (no sync SQL on renderer, max active ClientFile instances), automated testing (load stress tests with 50k+ files, watcher chaos testing, web parity tests), and a phased rollout starting with instrumentation" — ACCEPTED with one amendment: "no sync SQL on renderer" is not achievable under the in-process better-sqlite3 architecture (portable fork, Electron pin); the adopted invariant is "no unbounded sync SQL consumption on the renderer" — per-batch time budgets bound each stall. Stress-scale fixtures and web-parity builds are gating verifications in tasks.md; watcher chaos testing is recorded as a stretch verification.

Caller-agreement reconciliation (0.8, below the 0.9 floor): the divergence is sequencing, not architecture. Peers rank windowed/lazy materialization as the primary intervention; the draft sequences behavior-preserving deletions of redundant work first, bounds materialization second, and gates the peers' windowed model behind Phase-2 measurements (Phase 5) because it forks the shared desktop/web `DataStorage` interface and requires ID-based selection, DB-side counts, and anchoring changes — a strictly larger blast radius than this change's bounded phases. The peers' end-state is adopted as the recorded escalation path with instrumentation as the objective tripwire; their concrete guardrails (quit-flush, ID-based-selection precondition, stress/parity tests) were folded into the phases above. Residual disagreement is confined to whether windowing ships now or behind the gate — resolved in favor of the gate to keep this change's regression surface bounded.

## Bomb-squad findings

Read-only hunt over the unsearched remainder for the same failure class (unbounded per-item work scaling with library size). Findings, with disposition:

- `src/frontend/stores/TagStore.ts:104` — tag `delete()` collects affected files via a full `fileList.filter` per subtree tag, then writes ExifTool metadata **sequentially per file, unbounded** (`:139`); deleting a broadly-applied tag monopolizes ExifTool for minutes–hours. Disposition: out of scope; primary driver of the follow-up-change recommendation below.
- `src/frontend/stores/TagStore.ts:195` — `merge()` fires a detached `setTimeout` sequential per-file ExifTool write storm with no progress UI and per-file `console.error` only (silent partial failure on quit). Disposition: follow-up change.
- `src/frontend/stores/FileStore.ts:212` / `:370` — `readTagsFromFiles` / `writeTagsToFiles` iterate the **entire** fileList with one ExifTool round-trip per file (concurrency 3 and 1 respectively); `common/ExifIO.ts:525` documents ExifTool's multi-file batch syntax that none of these sites use. Disposition: follow-up change.
- `src/frontend/containers/ContentView/Commands.tsx:279` — tag drag-drop onto a full selection runs a synchronous O(N) observable-mutation loop and arms N unbounded-concurrency debounced metadata writes (worst discipline of the four tag paths; no progress surface). Disposition: follow-up change.
- `src/frontend/containers/AppToolbar/FileTagEditor.tsx:51` — `counter` computed is O(selection × tags) per recompute; tolerable, flagged for review in the follow-up. Disposition: follow-up change (low priority).
- `src/server/routes/data.ts:130` / `:202` — sidecar `GET /api/files` and `POST /api/files/search` serve the entire library as one JSON payload per request (server-side twin of the renderer's full materialization). Disposition: recorded as a Phase-5 requirement — windowing must thread through these routes; until then the spec's parity requirement keeps both backends conformant on the current interface.
- `src/frontend/stores/FileStore.ts:743` — `removeFilesById` calls `fileList.replace()` on a ~N-element survivor array while the load path bans `replace()` as broken for large lists (`:1705`): two contradictory models of the same MobX API. Disposition: **in scope** — unified in this change.
- `src/frontend/stores/FileStore.ts:1904` — `updateFileListState` clears and rebuilds the full id→index Map on every mutation; a single-file delete pays O(N) synchronously. Disposition: **in scope** — incremental index maintenance in this change.
- `src/frontend/containers/ContentView/CalendarGallery.tsx:27` — `groupFilesByMonth` re-traverses the whole list on every fileList change while Calendar view is active. Disposition: follow-up change (view-specific).
- `src/frontend/workers/VisualSimilarityManager.ts:314` — O(M²) `filesToProcess.find` over uncached hash results; bounded to explicit dedup runs. Disposition: follow-up change (low priority).
- Clean categories (explicitly audited, no in-class defect): startup/backup/orphan sweeps; inspector/metadata MobX computeds; desktop renderer IPC large-array messages.
- Root-cause synthesis: the codebase-wide assumption that the file list is a small, cheap-to-traverse, fully-resident collection — with no owned "operate over many files" batch primitive, so each feature independently re-derived naive traversal with inconsistent concurrency/batching/progress. Recommendation recorded: a follow-up OpenSpec change introducing a single bounded, cancellable, progress-surfacing bulk file-metadata primitive (using ExifTool's native multi-file batching) and routing TagStore/FileStore/Commands write paths through it — pending user approval to scope.
