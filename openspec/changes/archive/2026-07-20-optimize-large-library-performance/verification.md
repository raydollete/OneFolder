# Verification — optimize-large-library-performance

Date: 2026-07-19
Tier: 3 (from proposal)

## Verdict: PASS-WITH-FINDINGS

Fresh-context audit. All 15 checked boxes verified by opening the cited files; the two
machine-checkable gates (full Jest suite, desktop production build) were re-executed by the
auditor rather than taken on faith. No fabricated evidence found. Findings are advisory;
the change's own manual-QA gates (1.2, 7.3, 7.4) remain honestly unchecked.

## Dimensions

- **Implemented: PASS.** Every checked box's evidence location contains the claimed change
  (quotes below). The four new modules (`perf.ts`, `locationReconciliation.ts`,
  `seededShuffle.ts`, `dimensionDiff.ts`) exist with the claimed contents; the per-file
  autosave `reaction` is confirmed removed from `File.ts` (git diff shows
  `-    this.saveHandler = reaction(`); grep confirms zero `ORDER BY RANDOM` in SQL
  (comment mentions only); the one remaining bulk `pathExists` sweep is the Missing-files
  audit view, which the design amendment deliberately retains (`FileStore.ts:1190-1192`).
- **Reachable: PASS.** All new code is wired: `perf` imported and marked in FileStore,
  LocationStore, MasonryWorkerAdapter; `matchMissingToCreated`/`matchMissingToDbDuplicates`
  called from `LocationStore.watchLocations` (:218, :220); `orderBySeededRank`/
  `orderIdsBySeededRank` called from `applyClientOrder` (:1537) and `runProgressiveFetch`
  (:2050); `fetchFileIds`/`searchFileIds` routed from the fetchers (:1108-1111, :1152,
  :1296); `verifyFileExistence` called from GalleryItem's image-error handler (:182);
  `syncDimensions` called in `MasonryWorkerAdapter.compute` (:76); the quit-flush is
  registered in the FileStore constructor (`beforeunload`, :165) and `handleBeforeUnload`
  (:169-172) bypasses BOTH debounces (`flushDirtyFiles()` then direct `saveFilesToSave()`),
  so the pending-edit loss window is genuinely closed. `RootStore` sequences
  `watchLocations` after the initial fetch (:158) so `consumeStartupFetchDTOs` has a cache.
- **Tested: PASS.** Auditor re-ran `yarn test`: 37 suites, **309 passed, exit 0** —
  matching 7.2's claim. The 39 new tests exist and cover the claims (test names verified in
  all 7 new test files, incl. "performs zero disk existence checks during a load or
  refetch", "a refetch of an unchanged view allocates zero new ClientFiles", "no per-file
  MobX autosave reaction is constructed anymore", "deleting the tail file does not iterate
  the whole list", MobX #3189 70k-element repro). Auditor re-ran `yarn build` (desktop):
  exit 0, webpack compiled with the 1 pre-existing warning — exactly as 7.1 recorded.
  Jest prints a pre-existing "worker process failed to exit gracefully" teardown warning
  (non-fatal, exit 0). Manual large-library QA (7.3) is still outstanding — see Findings.
- **Optimal: advisory.** Code is idiomatic (MobX transactions for batch commits, additive
  optional `DataStorage` members preserving HttpBackend parity, platform-seam respected —
  the seam grep reproduces only pre-existing hits; `File.ts`'s `ExifIO` import predates the
  change per git diff). One documented behavioral micro-delta noted (Finding 4).

## Evidence audited

- [1.1 perf tracer] — src/frontend/perf.ts:20 — "export class LoadPhaseTracer {"
- [1.1 tests] — tests/perf-tracer.test.ts:24 — "it('accumulates multiple slices of the same phase and prints one summary', () => {"
- [2.1 startup-fetch reuse] — src/frontend/stores/LocationStore.ts:130 — "this.rootStore.fileStore.consumeStartupFetchDTOs() ??"
- [2.1 Map-indexed matcher] — src/frontend/stores/locationReconciliation.ts:59 — "export function matchMissingToCreated("
- [2.1 startup sequencing] — src/frontend/stores/RootStore.ts:158 — ".then(() => rootStore.locationStore.watchLocations())"
- [2.2 yielded slices] — src/frontend/stores/LocationStore.ts:301-302 — "if (++scanned % 2000 === 0) { await yieldToEventLoop();"
- [2.2 bounded concurrency] — src/frontend/stores/LocationStore.ts:206 — "const createdFiles = await promiseAllLimit("
- [2.3 watcher-derived existence] — src/frontend/stores/FileStore.ts:1470 — "@action reconcileMissingFiles(missingIds: ReadonlySet<ID>): void {"
- [2.3 on-demand fallback] — src/frontend/stores/FileStore.ts:1497 — "async verifyFileExistence(file: ClientFile): Promise<void> {"
- [2.3 load-failure hook] — src/frontend/containers/ContentView/GalleryItem.tsx:182 — "fileStore.verifyFileExistence(file).catch(() => {});"
- [2.4 seeded rank] — src/frontend/stores/seededShuffle.ts:17 — "export function seededRank(seed: number, id: string): number {"
- [2.4 indexed fetch order] — src/backend/sqlite-backend.ts:473 — "`${FILE_SELECT} ${FILE_GROUP_BY} ORDER BY f.id`" (grep: no `ORDER BY RANDOM` in any SQL string; comments only)
- [2.4 client ordering] — src/frontend/stores/FileStore.ts:1537 — "return orderBySeededRank(files, this.randomSeed);"
- [3.1 id projection] — src/backend/sqlite-backend.ts:495 — "async fetchFileIds(order: OrderBy<FileDTO>, fileOrder: OrderDirection): Promise<ID[]> {"
- [3.1 search variant] — src/backend/sqlite-backend.ts:581 — "async searchFileIds("
- [3.1 additive interface] — src/api/data-storage.ts:36 — "fetchFileIds?(order: OrderBy<FileDTO>, fileOrder: OrderDirection): Promise<ID[]>;"
- [3.2 progressive fetch] — src/frontend/stores/FileStore.ts:2038 — "@action private async runProgressiveFetch("
- [3.2 routing guard] — src/frontend/stores/FileStore.ts:2033 — "return typeof this.backend.fetchFileIds === 'function' && this.orderBy !== 'tagCountRandom';"
- [3.2 bounded chunks] — src/frontend/stores/FileStore.ts:2036 — "private static readonly PROGRESSIVE_CHUNK_SIZE = 800;"
- [4.1 markDirty choke point] — src/frontend/entities/File.ts:113-114 — "private markDirty(): void { this.store.markFileDirty(this); }" (calls at :129, :147, :231, :248; reaction removal confirmed in git diff)
- [4.1 central flusher] — src/frontend/stores/FileStore.ts:1449 — "flushDirtyFiles(): void {"
- [4.1 quit-flush] — src/frontend/stores/FileStore.ts:170-171 — "this.flushDirtyFiles(); void this.saveFilesToSave();"
- [4.2 instance pooling] — src/frontend/stores/FileStore.ts:2115 — "const [chunkClientFiles, chunkReused] = this.filesFromBackend(dtos, (id) => oldById.get(id));"
- [4.2 reuseFrom param] — src/frontend/stores/FileStore.ts:2224 — "reuseFrom?: (id: ID) => ClientFile | undefined,"
- [5.1 delta writes] — src/frontend/containers/ContentView/Masonry/dimensionDiff.ts:31 — "export function syncDimensions("
- [5.1 adapter wiring] — src/frontend/containers/ContentView/Masonry/MasonryWorkerAdapter.tsx:76 — "syncDimensions(mirror, imgs.slice(0, numImgs), (i, w, h) => worker.set_dimension(i, w, h)),"
- [5.2 debounced content path] — src/frontend/containers/ContentView/Masonry/MasonryRenderer.tsx:148 — "return debounce(onItemOrderChange, 150);"
- [5.2 skip cache] — MasonryWorkerAdapter.tsx:85-88 — "dimensionWrites === 0 && !numChanged && computeKey === this.lastComputeKey"
- [6.1 #3189 repro] — tests/mobx-replace-large.test.ts:25 — "it('replace() with a 70k-element array works on the pinned MobX version', () => {"
- [6.1 unified policy] — src/frontend/stores/FileStore.ts:830-831 — "this.fileList.clear(); this.fileList.push(...survivors);" (policy comment :822-825)
- [6.2 incremental index] — src/frontend/stores/FileStore.ts:851-852 — "for (let i = minRemovedIndex; i < this.fileList.length; i++) { this.index.set(this.fileList[i].id, i);"
- [7.1 builds] — auditor re-ran `yarn build`: exit 0, "webpack 5.105.4 compiled with 1 warning" (matches recorded evidence); dist-web/dist-server bundles modified in working tree corroborate the web/server builds
- [7.1 seam grep] — reproduced: only pre-existing hits (workers, platform layer, shell/FileInput imports, File.ts ExifIO import unchanged in this change's diff)
- [7.2 full suite] — auditor re-ran `yarn test`: "Test Suites: 37 passed — Tests: 309 passed", exit 0

No boxes skipped (15 checked boxes, all verified).

## Findings

1. **Low (process)** — openspec/changes/optimize-large-library-performance/design.md:89-92 —
   radflow-lint WARN: peer-review caller agreement 0.8 < 0.9 floor (exit 1, not a
   structural exit 2). design.md:114 carries an explicit reconciliation: the divergence is
   sequencing only (peers' windowed model adopted as the gated Phase-5 end-state with
   instrumentation as tripwire). Advisory; carried here so it is not silent.
2. **Low (degraded controls, doctor)** — `openspec/templates/lessons.md` missing (re-run
   `~/dev/radflow/adopt.sh` in this repo) and playwright-cli skill not installed, so no
   in-agent browser UI pass is possible; the compensating control is task 7.3's
   REQUIRES-MANUAL-EXECUTION evidence gate, which is still open.
3. **Medium (open work, not a defect)** — tasks 1.2, 7.3, 7.4 are honestly unchecked:
   baseline timings, the five-scenario manual large-library QA (cold start, sort refetch,
   watcher batch under random sort, tag-then-quit persistence, delete stall), and the
   Phase-5 go/no-go decision record. These are the change's own GUI evidence gates per
   `docs/TODO/QA-DISCIPLINE.md`. Recommend completing 7.3 (and 7.4's decision record)
   before archive, or archiving with them explicitly carried into a follow-up.
4. **Info (advisory)** — src/frontend/stores/FileStore.ts:846-847 — the incremental
   counter update in `removeFilesFromListInPlace` documents a deliberate micro-delta:
   a delete no longer zeroes the hidden-missing tally while hide-missing is active
   (transient counter drift until the next full derived-state pass). Documented in-code;
   follow-up appended to tasks.md.

## Live UI pass

n/a — playwright-cli is not installed in this environment (doctor warning), and the changed
surface is a desktop Electron gallery requiring a large local library; the change's own task
7.3 (REQUIRES MANUAL EXECUTION) is the designated evidence gate for the five UI scenarios
and remains open.
