---
id: INV-009
title: 'Stale fetch clobbers user filter: updateFromBackend has no generation / cancellation check'
reported_bug: 'After INV-007 / TASK-034-036 shipped, users can still lose their selected filter several seconds after launch. Any selected filter — Untagged, single tag, multi-tag query, Missing, saved search criteria — reverts to "All" results shortly after the initial scan completes. The criteria chips and selector pressed state remain correct, but the gallery content reverts to All. Waiting several minutes for the scan to finish before clicking avoids the bug entirely.'
date: 2026-04-24
status: resolved
date_resolved: 2026-04-26
superseded_by:
tasks_spawned: [TASK-043, TASK-044, TASK-045, TASK-046]
root_cause_category: wrong-abstraction
affects:
  - 'src/frontend/stores/FileStore.ts (updateFromBackend, fetchAllFiles, fetchUntaggedFiles, fetchMissingFiles, fetchFilesByQuery, fetchDuplicatesFiles, refetch, debouncedRefetch)'
  - 'src/frontend/stores/RootStore.ts (RootStore.main initial fetchAllFiles / fetchFilesByQuery and post-watchLocations refetch)'
  - 'src/frontend/stores/LocationStore.ts (initLocation post-init refetch, watchLocations completion, addFile / hideFile debouncedRefetch)'
  - 'src/frontend/stores/UiStore.ts (viewAllContent / viewQueryContent fire-and-forget callers)'
  - 'src/renderer.tsx (preview-window updateFromBackend path)'
  - 'docs/missing-files.md (existence-check two-pass pattern is part of the clobber surface)'
---

## Bug Report

### Observed Behavior

Reported 2026-04-24 after TASK-034 / TASK-035 / TASK-036 shipped and TASK-037 (cross-mode QA) began. Three critical updates the prior investigation did not capture:

1. **Scope is broader than Untagged.** Any selected filter — single tag selection via `TagsTree` row click, multi-tag selection, Missing badge, saved search criteria with `numCriterias > 0` at launch — reverts to "All" results a few seconds after the user selects it.

2. **UI desync (key signal).** The selected filter "still appears in the UI" (criteria chips in the Searchbar, selector's pressed visual state in the Tags panel) even though the file list has reverted to All. The clobber path touches `fileList` / `fileListLastModified` / `numTotalFiles` / `numUntaggedFiles` but does NOT touch `content` or `searchCriteriaList`. This is fundamentally different from INV-007 Defect B's symptom (where `clearSearchCriteriaList` also emptied the chips) and tells us the TASK-034 fix has correctly isolated `searchCriteriaList` mutation. The remaining clobber is one layer deeper — it writes fileList/counts only.

3. **Timing is deterministic on library scan duration.** User confirmed: "if I wait several minutes for the results to load, the problem goes away." If the user clicks a filter BEFORE the initial launch fetch completes, the clobber happens. If they wait until the "Looking for new images" toast finishes (and the initial `fetchAllFiles` / `fetchFilesByQuery` has settled), the clobber never fires. This is not a race against chokidar or `watchLocations` — it is a race against the INITIAL fetch kicked off by `RootStore.main` at launch.

### Expected Behavior

Any user-initiated content-mode change (clicking Untagged, selecting a tag, clicking Missing, running a search) must stick. A background or still-in-flight fetch that resolves AFTER the user has committed to a different view must not silently replace the user's `fileList`. If the background fetch's data is stale, the application must discard it rather than apply it.

Concretely:

1. Launch app on a large library. Within 1s of the Outliner appearing, click a tag in the Tags panel.
2. Gallery populates with that tag's files (query fetch is fast, backend is indexed).
3. Wait 10-30 seconds. Initial `fetchAllFiles()` from `RootStore.main` completes.
4. **Expected:** gallery stays populated with tag's files. `fileList.length` = tag match count.
5. **Actual:** gallery reverts to all files. `fileList.length` = total count. `content === Content.Query` and `searchCriteriaList` still has the tag criterion (so the UI chip and selector-pressed state are misleadingly still set), but the data is wrong.

### Reproduction Context

Deterministic on any library where the initial `fetchAllFiles()` call from `RootStore.main:124` (or `fetchFilesByQuery()` if the user had persisted search criteria) takes longer than the user's time-to-click. On the reporter's library that's several seconds. On smaller libraries it can drop below click latency and the bug appears "fixed" — which is why TASK-037 QA missed it when run on a smaller test library.

Triggering sequences:

1. **Initial fetch race (primary).** `RootStore.main` at line 113-124 calls `fileStoreInit()`, which is either `rootStore.fileStore.fetchAllFiles` (when `numCriterias === 0`) or a closure that calls `fetchFilesByQuery()` (when criteria are persisted). Either function starts with a synchronous `setContentAll()` / `setContentQuery()` (as of uncommitted work-in-progress), then awaits `backend.fetchFiles()` / `backend.searchFiles()`, then calls `updateFromBackend()`. On large DBs, the backend call plus the file-existence check in `updateFromBackend` (runs `fse.pathExists` on every file with N=50 concurrency) takes 5-30 seconds. During that window, the user clicks a filter. The second fetcher completes first (its query is smaller). At T≈5-30s, the initial fetcher's `updateFromBackend(allFiles)` second-pass runs, sees a stale `newClientFiles` from its closure, and rewrites `fileList` with all files.

2. **`watchLocations` completion (secondary, already mitigated).** `RootStore.ts:141-145` calls `refetch()` after `watchLocations` resolves. `refetch()` now dispatches to the current content mode (after TASK-034). That correct dispatch still goes through `updateFromBackend`, which is also vulnerable to the same race if the user mutates the filter BETWEEN `refetch()`'s backend call being kicked off and its resolution. But the primary `fetchAllFiles` from step 1 is the more common and longer-running offender.

3. **Debounced chokidar refetch (tertiary).** `LocationStore.addFile` / `hideFile` call `fileStore.debouncedRefetch()` (200ms debounce). Same vulnerability — the refetch's backend call can resolve after the user has committed to a different view.

4. **`initLocation` completion.** `LocationStore.initLocation:459` calls `await this.rootStore.fileStore.refetch()` after adding a new location. Same vulnerability if user interacts during the refetch.

5. **`deleteFiles` / `removeSublocationFiles` / `changeLocationPath`.** Each calls `refetch()` without awaiting from a user-driven async path. Same vulnerability for a brief window.

6. **`hideMissingFilesInBrowsing` reaction (FileStore constructor line 88-91).** The reaction triggers `refetch()` when the preference toggles. Same vulnerability.

Platforms: all. Dexie and SQLite backends both exhibit the race (backend-agnostic — the race is in the renderer's apply-result stage).

---

## Root Cause Analysis

**Category:** wrong-abstraction

### Diagnosis

`FileStore.updateFromBackend(backendFiles)` and its async existence-check `.then()` have no concept of whether the `backendFiles` they are about to apply still represent the current content mode. The function's contract is fire-and-forget: "I was handed a list of files from the backend, therefore I will replace fileList with them." It does not ask "did the user change their mind while I was awaiting?".

Concretely the abstraction gap is:

- Every fetcher (`fetchAllFiles`, `fetchUntaggedFiles`, `fetchMissingFiles`, `fetchFilesByQuery`, `fetchDuplicatesFiles`) is structured as: `setContentX()` → `await backend.fetchFiles(...)` → `await updateFromBackend(results)`. The `setContentX()` flip IS synchronous-before-await (thanks to the uncommitted changes on `FileStore.ts`), so the `content` observable accurately reflects the latest user intent. Likewise the criteria list mutation now uses the silent `_resetSearchCriteriaListNoFetch` from TASK-034 and does not clobber itself.

- **But `updateFromBackend` does not check `this.content` or `this.searchCriteriaList` before applying its results.** If fetcher A starts on launch (content flipped to All, query kicked off), user then triggers fetcher B (content flipped to Query, query kicked off and resolved fast), then fetcher A's backend call eventually resolves — A's `updateFromBackend(allFilesResult)` runs against a store where `content === Content.Query`. It still writes fileList = allFiles.

- **Worse, `updateFromBackend` has a TWO-PASS structure** (line 1008-1058 of `src/frontend/stores/FileStore.ts`). The first pass synchronously replaces fileList with `newClientFiles`. Then it kicks off a `promiseAllLimit` on existence checks (N=50) and schedules a `.then()` that runs a SECOND fileList replacement (with broken-file splicing if `hideMissingFilesInBrowsing` is on). That second pass captures `newClientFiles` in its closure — meaning even if a subsequent fetcher has already updated fileList between the first and second passes, the second pass will rewrite it again with the original (stale) dataset.

So there are actually TWO clobber events per stale fetch:
  - **Clobber event 1:** The sync first-pass of the stale fetcher's `updateFromBackend` replaces the user's fileList when the backend call resolves.
  - **Clobber event 2:** A few hundred ms to seconds later (existence-check duration), the async `.then()` replaces fileList again with the same stale data (plus the hide-missing splice).

Either event produces the user-observed "gallery reverts to All".

The conceptual mistake: **fetchers treat their in-flight backend query as a universal truth to apply on completion, rather than as a request that may have been invalidated by subsequent user intent**. This is a classic stale-request / "last-write-wins across unrelated awaits" pattern. The correct abstraction is either:

- **(a) Generation / request ID:** each fetcher captures a monotonically-increasing generation ID on dispatch; `updateFromBackend` checks that the generation is still the latest before applying. Stale fetches discard their results.
- **(b) AbortController / cancellation:** user-initiated fetcher cancels any in-flight prior fetcher via an AbortSignal that the backend check honors. Requires backend plumbing and graceful abort.
- **(c) Content-mode assertion:** each fetcher captures `content` at dispatch; `updateFromBackend` compares current `content` to the captured value and discards the result if they diverge.
- **(d) Serialize fetches:** a mutex that prevents more than one fetcher from being in-flight at once. Newer fetchers wait; or, newer fetchers cancel-and-replace older ones.

Option (c) is closest to the current design and has the smallest diff: add a captured `contentAtDispatch` parameter to `updateFromBackend`. But (c) is not sufficient alone — it would drop a legitimate background refetch that the user triggered from e.g. `watchLocations` completion, where `contentAtDispatch === currentContent` but the user has ALSO triggered a new fetcher with the same content mode. A pure content-mode check cannot distinguish two back-to-back fetches of the same content mode.

**Recommended: option (a), generation ID.** A single `@observable fetchGeneration = 0` on FileStore; every fetcher entry point increments it and captures the new value. `updateFromBackend` (and its async `.then()`) checks the captured value against current and aborts if stale. This works for every mode without special-casing and cleanly handles the "same mode back-to-back" case. A stale existence-check pass that happens to fire against a different generation simply drops its fileList replacement.

Option (c) can be layered ON TOP as a cheap sanity check but the primary gate must be generation.

### Diagnostic Questions Considered

- **Wrong mental model?** Adjacent. The fetchers were written as if only one fetch can be in flight at a time, or as if any in-flight fetch's result is safe to apply. That is a mental-model error. Category: secondary.

- **Architectural shortcoming?** Partial. The FileStore was designed around "one view at a time, reload on change" — which works when fetches are fast and sequential. When fetches are slow (large DB + missing-file check) and users are fast (click within 1s), the design's implicit assumption breaks. Category: corroborating evidence for wrong-abstraction.

- **Incorrect order of operations?** No. Each fetcher's internal order (set content → await backend → update) is correct. The issue is cross-fetcher ordering: two concurrent fetchers can't coexist safely.

- **Missing edge case?** No. This is systemic, not an edge case. Every fetcher is affected identically.

- **Wrong abstraction?** PRIMARY. `updateFromBackend` takes a result set and applies it unconditionally. It should take a result set + a generation token and apply only if the token is still current. The absence of any staleness check is the architectural defect.

- **Silent failure?** Yes, corroborating. The stale fetch's `updateFromBackend` completes successfully from its own perspective — no exception, no error log. The user sees the wrong fileList and the dev sees nothing in the console. The TASK-036 dev-build regression assertion (`[INV-007 regression] refetch() changed content mode from X to Y`) does not fire for this bug because `content` is NOT changed by the stale fetch — only `fileList` is. The assertion was designed to catch the old Defect B, which is a different symptom shape.

### Why TASK-034 missed this

TASK-034 correctly identified that `clearSearchCriteriaList` → `viewAllContent` → `fetchAllFiles` was fusing list-mutation with view-switching, and correctly eliminated that fusion. With the fusion gone, calling `fetchUntaggedFiles` no longer recursively schedules a concurrent `fetchAllFiles`. That closed one self-clobber vector.

But it did not address the broader pattern: ANY two fetchers running concurrently race on `updateFromBackend`, regardless of whether one "recursively scheduled" the other. The primary example — the initial `fetchAllFiles` from `RootStore.main` racing the user's first tag click — has nothing to do with `clearSearchCriteriaList`. That fetcher was dispatched directly by the app's bootstrap code; the user's fetcher was dispatched directly by their click. Two independent callers, same apply-results function, no staleness guard.

TASK-037's QA was written against INV-007's symptom shape (`content` flips, chips clear) and so its stickiness checks watched `fileStore.showsUntaggedContent` etc. After TASK-034, those checks pass — `content` does stay put. What the QA did not explicitly check was "did the gallery content also stay put". The selector-pressed state followed `content`, the chips followed `searchCriteriaList`, and both stayed consistent — but `fileList` is not directly gated by the QA steps. That is the visual symptom the user is reporting and the QA missed.

---

## Blast Radius

Every async callback site where a fetch can complete after user interaction and land in an unchecked `updateFromBackend` apply.

### Stale-apply surface (fetchers that enter `updateFromBackend`)

1. **`src/frontend/stores/FileStore.ts:714-727` (`fetchAllFiles`)** — Direct `updateFromBackend` caller at line 723. Vulnerable to being out-raced by any user-initiated fetch. The primary offender in RootStore.main's initial call.

2. **`src/frontend/stores/FileStore.ts:729-760` (`fetchUntaggedFiles` / `_fetchUntaggedFilesForced`)** — Direct `updateFromBackend` caller at line 756. Vulnerable when a user clicks tag/Missing/Query after Untagged click.

3. **`src/frontend/stores/FileStore.ts:762-823` (`fetchMissingFiles`)** — Does NOT call `updateFromBackend`; has its own `fileList.replace(missingClientFiles)` block at line 801. The inline block is ALSO vulnerable to the same stale-apply race: if a user clicks elsewhere while `fetchMissingFiles` is doing its existence checks (which is the whole body of the function), its final `runInAction` at line 799-809 will overwrite the user's fileList. Needs the same generation check.

4. **`src/frontend/stores/FileStore.ts:825-848` (`fetchFilesByQuery`)** — Direct `updateFromBackend` caller at line 844. Vulnerable.

5. **`src/frontend/stores/FileStore.ts:850-861` (`fetchDuplicatesFiles`)** — Direct `updateFromBackend` caller at line 857. Vulnerable.

6. **`src/frontend/stores/FileStore.ts:970-1059` (`updateFromBackend`)** — The apply function itself. Needs a generation parameter and a guard at the start of both the sync first-pass AND the async `.then()` second-pass. Without the `.then()` guard, the existence-check writer can still clobber after the sync guard passed.

### Dispatch surface (callers that kick off fetchers during user-interactive windows)

7. **`src/frontend/stores/RootStore.ts:113-124` (initial `fetchAllFiles` / `fetchFilesByQuery`)** — The primary race trigger. Fires at app launch, resolves seconds later. User's click between dispatch and resolution loses.

8. **`src/frontend/stores/RootStore.ts:141-145` (post-`watchLocations` `refetch`)** — Secondary race trigger. Fires when the initial scan completes.

9. **`src/frontend/stores/FileStore.ts:83` (`debouncedRefetch = debounce(this.refetch, 200)`)** — 200ms debounce on `refetch`. Bound to `fileStore.hideFile` / `LocationStore.addFile` / `LocationStore.hideFile`. Fires for every chokidar add/remove burst.

10. **`src/frontend/stores/LocationStore.ts:459` (`initLocation` → `refetch`)** — After adding a location and importing its files, refetches.

11. **`src/frontend/stores/LocationStore.ts:479-480` (`delete` → `refetch` + `refetchFileCounts`)** — After deleting a location.

12. **`src/frontend/stores/LocationStore.ts:355` (`changeLocationPath` → `refetch`)** — After changing a location's path.

13. **`src/frontend/stores/LocationStore.ts:562` (`removeSublocationFiles` → `refetch`)** — After removing a sublocation.

14. **`src/frontend/stores/FileStore.ts:656` (`deleteFiles` → `refetch`)** — After deleting files.

15. **`src/frontend/stores/FileStore.ts:88-91` (constructor `reaction` on `hideMissingFilesInBrowsing`)** — Toggling the preference fires `refetch`. Already benefits from `refetch` dispatching to current mode, but the underlying stale-apply race still applies.

16. **`src/frontend/stores/FileStore.ts:564, 569` (`switchOrderDirection` / `orderFilesBy` → `refetch`)** — User changes sort; refetch. Short-duration race window but still exists.

### Consumer surface (UI places that read from fileList and would show wrong data during a clobber)

17. **`src/frontend/containers/ContentView` (gallery tiles, thumbnail loader, MasonryRenderer)** — Consumes `fileList` as observable. Re-renders instantly when a clobber happens. Includes `GalleryItem`, `DuplicateGallery`, `CalendarGallery`, `MasonryRenderer`. No code change needed; once the clobber is gone, these stay correct.

18. **`src/frontend/stores/UiStore.ts` (`fileSelection`, `firstItem`)** — Selection state is kept in sync by `cleanFileSelection()` in `updateFromBackend`. If we drop a stale apply, we also must not call `cleanFileSelection()` for that apply. The generation guard handles this by early-returning before any state mutation.

19. **`src/frontend/containers/Outliner/TagsPanel/TagsTree.tsx:770` (Untagged badge `count={fileStore.numUntaggedFiles}`)** — Displays `numUntaggedFiles`. The clobber also rewrites `numUntaggedFiles` (via `updateFileListState` inside `updateFromBackend`), so the badge shows the stale count. Fixed once the apply is dropped.

20. **`src/renderer.tsx:330` (preview-window `updateFromBackend`)** — Preview window calls `updateFromBackend` directly with a one-shot file list. Separate code path, separate lifecycle (preview window doesn't race the main-window scan). Low risk but worth a generation check for symmetry. If the preview window ever accrues multiple in-flight update requests it would exhibit the same bug.

### Interaction with INV-004 hide-missing splice

21. **`src/frontend/stores/FileStore.ts:1019-1058` (existence-check `.then()`)** — The hide-missing splice runs in this `.then()`. If we add a generation guard, we must guard BOTH the sync first-pass AND the async `.then()` second-pass. Otherwise the second pass can still write a stale `fileList` even if the sync pass was correctly dropped.

### Interaction with TASK-036 regression assertion

22. **`src/frontend/stores/FileStore.ts:697-709` (dev-build `[INV-007 regression]` warning)** — Only fires when `refetch()` causes `content` to change. This bug does NOT change content; only `fileList`. The assertion needs to be extended (or a parallel assertion added) to detect `updateFromBackend` applying stale data.

### Non-changes (out of scope)

- **`countFiles()` SQL / Dexie implementations** — Unchanged.
- **`numTotalFiles` / `numUntaggedFiles` writers** — TASK-035's harmonization stays correct. The stale-apply race would incidentally rewrite these, but fixing the apply race makes the writers consistent again.
- **Backend `fetchFiles` / `searchFiles` contract** — Not changed. The race is in the renderer.

---

## UX / Requirements Specification

### Purpose

Any user-initiated content-mode change must produce a sticky view. A filter the user selects must win over any background refresh that happens to resolve after the click. The app must never silently apply stale data over a user's current view.

### User-Stated Design Decisions

1. **Filter stickiness is non-negotiable across ALL content modes, not just Untagged.** Tag selection, multi-tag selection, Missing, saved search criteria — all must stick.

2. **The fix must not rely on user-perceptible timing.** No `setTimeout` guards. No "wait for scan to complete before allowing clicks". The user's words (paraphrased): "if I wait several minutes for the results to load, the problem goes away" is the evidence of the race, not the intended UX.

3. **The fix must not be a UI workaround.** Do not "if content flips to All, re-apply the chip list" — that masks the bug. The underlying state must be correct; the UI is a pure observer.

4. **`fetchAllFiles` must still work when it is the right answer.** When the user really is on All and a background refetch fires, the apply must succeed. The generation gate must not reject legitimate applies.

5. **Preserve the work from INV-007.** TASK-034's criteria-list-silent-clear, TASK-035's count harmonization, and TASK-036's regression assertion all stay. The INV-007 investigation correctly identified Defect A and the user-click half of Defect B; this investigation addresses the remaining stale-apply half.

### Behavioral Specifications

1. **Stale-apply rejection.** A fetcher dispatched at generation G that tries to apply results after generation G+1 (or later) was dispatched must discard its results — both the sync first-pass and the async `.then()` second-pass. No fileList mutation, no count mutation, no selection mutation, no content mutation.

2. **In-flight fetch count tolerance.** The system must correctly handle 2+ fetches in flight simultaneously. It must not assume one-at-a-time.

3. **Last-dispatched-wins semantics.** When multiple fetches are in flight, the LAST one dispatched is the one whose results get applied. Earlier ones are discarded regardless of which resolves first.

4. **Coverage across all five Content modes.** All / Untagged / Missing / Query / Duplicates must each survive both the initial-scan race AND the concurrent-user-click race.

5. **Silent discard (no toast, no error).** A discarded stale apply produces no user-visible feedback. It is the correct behavior for an invalidated request.

6. **Dev-build observability.** A dev-build log line when a stale apply is discarded so we can detect regressions. Not a console.warn (not an error); `console.debug` or similar. Format should include the dropped generation and current generation for diagnosis.

7. **Preview-window symmetry.** Preview window's direct `updateFromBackend(files)` call at `renderer.tsx:330` must pass the generation check too, so a future preview-window race doesn't reintroduce the same bug class. Can be handled by exposing a preview-specific entry point that increments the generation synchronously.

### Explicit Rejections

- **Do not serialize fetches via a mutex.** Waiting for the current fetch to finish before starting the user's fetch would make the UI feel laggy (user waits seconds for their click to take effect). Generation-based drop-then-replace is preferred.

- **Do not introduce an AbortController end-to-end.** The Dexie and SQLite backends don't natively support abort; plumbing AbortSignal through `backend.fetchFiles` / `backend.searchFiles` is a much larger change. Generation check in the renderer is sufficient — the backend completes its work and the renderer discards the results, which is only wasted I/O but no correctness issue.

- **Do not rely solely on a `content`-mode assertion in `updateFromBackend`.** It fails for same-mode back-to-back fetches (e.g. two rapid Untagged refetches during a chokidar burst). Generation is strictly more powerful and also works for cross-mode races.

- **Do not change the existence-check architecture.** INV-004 / TASK-022's two-pass pattern (sync first-pass with all fetched, async second-pass with hide-missing splice) is correct. The fix scopes the generation check to both passes; it does not restructure them.

- **Do not remove the initial `fetchAllFiles()` from `RootStore.main`.** It is the correct startup behavior. The fix is to make its result discardable, not to delay it.

- **Do not add a loading-state UI gate ("don't allow clicks while scanning").** Would hurt UX. The user must be able to filter immediately; the fix is to honor their filter correctly when the background fetch eventually resolves.

### Uncertainty resolution

- **Does `fetchMissingFiles` share the bug?** Yes, at lines 799-809 (`runInAction { fileList.replace(missingClientFiles); ... }`). It doesn't go through `updateFromBackend` but it has the same pattern. Must get its own generation guard.

- **Does the preview-window path race?** No under current usage — preview is a one-shot load. But add the guard for symmetry and future-proofing.

- **Does `refetchFileCounts` race?** Less severely — it only writes `numTotalFiles` (after TASK-035), not `fileList`. A stale `numTotalFiles` write is a cosmetic badge problem, not a filter clobber. Lower priority, but should still be guarded for correctness.

- **Is the uncommitted WIP on FileStore.ts load-bearing for the fix?** Partially. The synchronous `setContentX()` flip before the await DOES help in that it makes `content` resistant to stale rewrites by the content-mode assertion layer. Keep that change. The core fix is the additional generation gate on `updateFromBackend`.

- **Could the `watchLocations` `.then(foundNewFiles && refetch)` path re-introduce the bug?** No, once `refetch` → `fetchX` → `updateFromBackend` is generation-gated, the whole chain becomes discardable.

---

## Reproduction Matrix

Tested on a library with ~5000 files and ~4000 missing, where initial `fetchAllFiles` takes ~8 seconds to resolve.

### Setup (shared across all rows)

- Launch app fresh. `numCriterias === 0` at startup (preferences don't have persisted criteria).
- `RootStore.main` kicks off `rootStore.fileStore.fetchAllFiles()` at `RootStore.ts:124`.
- Content flips to `Content.All` synchronously; backend call begins.

### Row 1: Untagged race (original INV-007 bug, broader repro)

1. Within 1-2s of app appearing, click Untagged selector.
2. `fetchUntaggedFiles` runs. Content flips to `Content.Untagged`. Criteria chip added. Query returns fast; gallery populates with ~1000 untagged files. Count shows 1000.
3. Wait 5-10s.
4. Initial `fetchAllFiles` resolves from launch. Its `updateFromBackend(allFiles)` first-pass replaces fileList with ~5000 files. `numUntaggedFiles` is rewritten by `updateFileListState`.
5. A few hundred ms later (existence-check) the `.then()` second-pass runs the hide-missing splice on allFiles. fileList becomes ~1000 visible (all-mode) files, numbered counts all re-derived.
6. **Observed state:** `content === Content.Untagged`, `searchCriteriaList` has the Untagged pseudo-criterion, Untagged selector is visually pressed, but `fileList` contains the All-mode visible set. User sees tagged images in the gallery.

**Expected after fix:** step 4's `updateFromBackend` is dropped because its captured generation is stale. Gallery stays on Untagged.

### Row 2: Tag selection race (new in INV-009 report)

1. Within 1-2s of app appearing, click a tag in the Tags panel.
2. `addSearchCriteria(new ClientTagSearchCriteria('tags', tagId))` runs. Criteria chip added. `viewQueryContent()` calls `fetchFilesByQuery`. Content flips to `Content.Query`. Query returns fast (indexed on tag); gallery populates with tag matches.
3. Wait 5-10s.
4. Initial `fetchAllFiles` resolves. `updateFromBackend(allFiles)` first-pass + second-pass rewrite fileList with all files.
5. **Observed state:** `content === Content.Query`, criteria chip still shows tag, tag still visually selected in Tags tree, but gallery shows all files.

**Expected after fix:** step 4 is dropped. Gallery stays on tag query.

### Row 3: Multi-tag race

1. Within 1-2s, click tag A. Tag A chip appears, gallery populates with A's files.
2. Within another 1-2s, ctrl+click tag B to add to criteria. Chip for B appears; `fetchFilesByQuery` re-runs with A+B.
3. Wait 5-10s.
4. Initial `fetchAllFiles` resolves. Rewrites fileList.
5. **Observed state:** chips show A, B; gallery shows all files.

**Expected after fix:** step 4 dropped. Gallery shows A+B match.

### Row 4: Missing race

1. Within 1-2s, click the Missing warning badge (TagsPanel/index.tsx line 104).
2. `fetchMissingFiles` runs. Content flips to `Content.Missing`. Backend fetches all files; existence check filters to broken. Gallery populates.
3. Wait 5-10s.
4. Initial `fetchAllFiles` resolves. `updateFromBackend(allFiles)` rewrites fileList.
5. **Observed state:** `content === Content.Missing`, Missing badge visually pressed, but gallery shows all (non-broken) files.

**Expected after fix:** step 4 dropped. Gallery stays on Missing.

### Row 5: Persisted-criteria race (launch variant)

1. Before quit, have an active search with criteria persisted. Restart app.
2. `RootStore.main` sees `numCriterias > 0`, calls `refetchFileCounts().catch(console.error); return fetchFilesByQuery()`. Content flips to Query, backend search begins.
3. Within 1-2s of Outliner appearing, user clicks Untagged.
4. `fetchUntaggedFiles` runs. Content flips to Untagged. Query fast; gallery populates.
5. Wait 5-10s.
6. Initial `fetchFilesByQuery` from step 2 resolves. `updateFromBackend(queryResults)` rewrites fileList with the persisted query's matches.
7. **Observed state:** `content === Content.Untagged`, chips show Untagged pseudo-criterion (wait — actually the persisted criteria were cleared by `_resetSearchCriteriaListNoFetch` in `fetchUntaggedFiles`, so chips show Untagged), but gallery shows persisted query matches.

**Expected after fix:** step 6 dropped. Gallery stays on Untagged.

### Row 6: Control (user waits)

1. Launch app. Do nothing for 30 seconds.
2. Watch "Looking for new images" toast disappear (indicates initial scan + refetch both done).
3. Click Untagged.
4. Gallery populates with untagged files and stays.

**Expected:** PASS (and already passes today). Confirms the bug is tied to the initial-scan window.

### Row 7: Chokidar add during filter

1. Complete control Row 6 (wait, click Untagged).
2. Drop a new untagged image into a watched folder.
3. Chokidar fires `add`, LocationStore.addFile calls `debouncedRefetch`. 200ms later `refetch` → `_fetchUntaggedFilesForced` → backend → `updateFromBackend`.
4. **Expected:** Untagged mode stays, new file appears.

This row should pass today as-is (no stale fetch from launch still in flight). Included to verify the fix does not break the legitimate refetch path.

---

## Holistic Solution

### Approach

Four tasks, ordered to ship the fix behind a generation-token primitive before the dev-build observability and cross-mode QA sweep.

1. **TASK-043 — Add `fetchGeneration` to FileStore and gate every fetcher on it.** The core fix. Add a `@observable fetchGeneration = 0` (or a private counter) and a `private nextFetchGeneration(): number` helper that increments and returns. Each fetcher entry point (`fetchAllFiles`, `_fetchUntaggedFilesForced`, `fetchMissingFiles`, `fetchFilesByQuery`, `fetchDuplicatesFiles`, and any other path that calls `updateFromBackend`) captures the generation at dispatch AFTER the synchronous content-mode flip and passes it through to `updateFromBackend` as a new parameter. `updateFromBackend` guards both its sync first-pass and its async existence-check second-pass by comparing the captured generation to `this.fetchGeneration` — if stale, drops everything (no fileList mutation, no count update, no selection mutation, no toast). Same guard applied to `fetchMissingFiles`'s inline `fileList.replace` block. Preview-window entry point at `renderer.tsx:330` also passes a generation (nextFetchGeneration captured synchronously). The `debouncedRefetch`, all LocationStore refetch callers, and the `RootStore.main` initial fetch all get the guard transparently by going through the fetchers. This is the user-visible fix for the filter-revert symptom.

2. **TASK-044 — Extend the dev-build regression assertion to detect stale applies.** TASK-036 added a content-mode-change detector. Extend it (or add a parallel one) so that when `updateFromBackend` (or `fetchMissingFiles`'s inline block) drops an apply due to stale generation, a `console.debug('[INV-009] dropped stale apply', { dropped: genDropped, current: this.fetchGeneration, content: this.content })` line is emitted. Also add a counter observable (dev-only, TagStore or similar) so the test suite can assert that a known-race scenario produces exactly N drops. Zero console errors. Observability only — not user-facing.

3. **TASK-045 — Update `docs/missing-files.md` and `docs/index.md` with the two-pass + generation invariant.** The current docs describe the hide-missing splice pattern (`missing-files.md` lines ~100+). Append a parallel section documenting that both passes are gated on `fetchGeneration` and that any new caller of `updateFromBackend` must pass the generation from dispatch.

4. **TASK-046 — Re-run TASK-037's cross-mode QA sweep against the fix, extended with stale-fetch reproduction matrix rows 1-5 above.** Treat as the replacement for TASK-037 (which is still in-progress but based on the old assumption that INV-007 covered the behavior). Produces a QA transcript with PASS/FAIL for each row of the matrix in §Reproduction Matrix, plus the original TASK-037 step set. Runs on a library large enough to reproduce the race (initial `fetchAllFiles` > 3 seconds — use the reporter's library if possible, or pad a test library to ~5000 files).

Task order: 43 (fix) → 44 (observability, depends on 43's hook points) → 45 (docs, can run in parallel with 43/44) → 46 (QA, depends on 43 + 44). TASK-037 is marked as replaced-by-TASK-046 and closed without advancing; its planned work is a subset of TASK-046.

### Expected Outcomes

- **Filter-revert gone for all content modes.** Rows 1-5 of §Reproduction Matrix all pass after the fix. Row 7 (legitimate refetch) still passes. Row 6 (control) still passes.
- **No UI-level workarounds.** `searchCriteriaList`, `content`, and selector-pressed state are all unchanged by the fix — they were already correct. Only `fileList` / count observables become stable.
- **No loading gate.** Users can click filters immediately on launch; their click wins.
- **Same-mode back-to-back fetches work.** Chokidar burst + user toggle sort + watchLocations-complete, all happening within 500ms, all dispatching to the same mode — only the last one's result is applied. Earlier ones silently drop.
- **`yarn build`, `yarn test`, `yarn start` pass.** No TypeScript errors. No console warnings under normal operation.
- **Dev-build drops are observable but not noisy.** On the reporter's library, an average session fires 0-2 drops during the initial-scan window (one for the original `fetchAllFiles`, possibly one for a `watchLocations` refetch).
- **TASK-036's `[INV-007 regression]` warning still does not fire.** This fix does not reintroduce the content-mode flip; it prevents the fileList clobber.

### Risks and Tradeoffs

- **Wasted backend I/O.** Each stale fetch completes its backend work (fetches DTOs, runs existence checks) and then discards the result. On a large library that's 5-30 seconds of wasted I/O per stale fetch. Acceptable: the alternative is user-perceived latency or UI gates. Generation-drop is cheaper than any synchronization-based alternative.

- **Closure captures of `newClientFiles`.** The existence-check `.then()` captures `newClientFiles` from the enclosing scope. That array holds ClientFile objects which themselves have MobX observers, disposables, etc. If we drop the apply, we must also make sure not to leak these ClientFile instances. Mitigation: `updateFromBackend`'s current first-pass pattern creates ClientFile instances via `filesFromBackend`. If the sync first-pass is dropped, the newly-created ClientFile instances are never added to `fileList` and become GC-eligible. That's fine. For the async second-pass, the ClientFile instances ARE in `fileList` (added by the sync first-pass that already ran and was not dropped). If ONLY the second-pass is dropped (e.g. user clicked between first and second pass), the sync first-pass's write stays — meaning gallery would briefly show all-mode data for 50-200ms before the user's fetcher completes its own apply. Acceptable flicker. TODO for follow-up: consider dropping the sync first-pass too if generation is stale even at sync-pass time.

- **Generation wraparound.** `Number.MAX_SAFE_INTEGER` is ~9e15. At 10 fetches per second that's 28 million years. Not a concern. Use plain number, no modular arithmetic.

- **Preview-window regression.** The preview window at `renderer.tsx:330` calls `updateFromBackend(files)` directly. After TASK-043, that call needs a generation too. Easy to pass — just call `fileStore.nextFetchGeneration()` or equivalent at the call site. But if it's missed, preview window breaks. TASK-043 must include the preview-window change in its implementation steps.

- **TASK-036 assertion coverage gap.** The existing dev-build assertion only checks `content` changes. It does not catch the fileList clobber this bug is about. TASK-044 fixes the gap; ensure it ships before TASK-046 QA so the QA transcript can rely on the dev-build signal.

- **Test-library scale.** If TASK-046 is run on a library that is too small (initial fetch < 1s), the stale-fetch race cannot be reproduced and the QA becomes a null check. Task spec must mandate a library large enough to trigger the race, or inject an artificial delay in the initial fetcher (dev-only) to force the race deterministically. The latter is more reliable.

- **Interaction with future work.** If someone later adds a fetcher that bypasses `updateFromBackend` (like `fetchMissingFiles` does today), they must remember to add the generation guard. TASK-045's docs call this out. A lint rule or a grep-based CI check could enforce it but that's deferred.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Update: `docs/missing-files.md` — append a section documenting the `fetchGeneration` invariant and the two-pass generation guard pattern.
- [x] Update: `docs/index.md` — add a one-line pointer under the FileStore section: "fetches are generation-gated; stale results are dropped".
