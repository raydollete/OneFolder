---
id: INV-007
title: 'Untagged sidebar selector: count mismatch and filter clobber by async refetch'
reported_bug: 'With no tag selected, the "Untagged" selector in the tag panel shows qty 5161, but clicking it immediately changes that value to 998 and shows untagged media. A few seconds later the browsing window updates again, showing what looks like ALL images (some with tags). Net effect: the Untagged filter does not stick.'
date: 2026-04-23
status: superseded
superseded_by: INV-009
tasks_spawned: [TASK-034, TASK-035, TASK-036, TASK-037]
root_cause_category: architectural-shortcoming
affects:
  - 'src/frontend/stores/FileStore.ts (fetchUntaggedFiles, fetchAllFiles, updateFromBackend, updateFileListState, refetchFileCounts, numUntaggedFiles observable)'
  - 'src/frontend/stores/UiStore.ts (clearSearchCriteriaList → viewAllContent side effect)'
  - 'src/frontend/stores/LocationStore.ts (watchLocations, addFile → debouncedRefetch)'
  - 'src/frontend/stores/RootStore.ts (post-watchLocations refetch)'
  - 'src/frontend/containers/Outliner/TagsPanel/TagsTree.tsx (UntaggedItem count display, handleUntaggedClick)'
  - 'src/frontend/entities/SearchCriteria.ts (ClientTagSearchCriteria with empty value = "Untagged images" pseudo-criterion)'
---

## Superseded by INV-009 (2026-04-24)

**This investigation is superseded by [INV-009](./INV-009_HIGH_FRONTEND_stale-fetch-clobbers-user-filter-via-updateFromBackend.md).**

Post-TASK-037 QA reproduced a related-but-distinct bug:

- **What this investigation correctly fixed (keep):** user-initiated re-clicks of Untagged no longer self-clobber via `clearSearchCriteriaList` → `viewAllContent` → `fetchAllFiles`. TASK-034's `_resetSearchCriteriaListNoFetch` helper removed that fusion. Defect A's count-mismatch fix (TASK-035) also remains correct.
- **What it missed:** a different race in which a LONG-RUNNING earlier fetch (`fileStore.fetchAllFiles()` kicked off by `RootStore.main` on launch) resolves SECONDS after the user has already clicked a filter (tag, Missing, saved query, etc.), and its final `updateFromBackend(allFiles)` overwrites the user's `fileList` — even though the `content` flag and the `searchCriteriaList` have already been set to the user's choice. Result: criteria chips and selector pressed-state remain correct, but the gallery reverts to "All". Waiting several minutes for the initial scan to finish before clicking avoids the bug — confirming it is a stale-fetch-applied-on-completion race, not a self-clobber.

INV-009 re-classifies the root cause as **wrong-abstraction** at `FileStore.updateFromBackend`: it has no cancellation / generation check, so any stale fetch that completes after the user mutates the filter will overwrite the user's state. Full analysis and broader blast radius there.

The tasks TASK-034 / TASK-035 / TASK-036 remain valid and shipped work. TASK-037 (QA) must be re-run against INV-009's fix before advancing.

---

## Bug Report

### Observed Behavior

On app start with no tag selected and no active search criteria, the "Untagged" pseudo-tag at the bottom of the Tags panel displays a count (e.g. `Untagged (5161)`). Clicking it produces two wrong-looking state transitions:

1. **Immediate transition (within 1-2 seconds of click):** The displayed count drops from 5161 to 998 while the gallery populates with what do appear to be untagged images. The 5161→998 drop is visually jarring but, by itself, is a defensible UX artifact of the missing-file splice documented in INV-004 / TASK-022.

2. **Delayed transition (a few seconds later):** The gallery updates a second time and now shows images that clearly have tags — i.e. the content mode has silently reverted from `Content.Untagged` back to `Content.All`. The Untagged selector's "pressed" visual state also clears (because `fileStore.showsUntaggedContent` is now false). The Untagged filter did not stick.

Both symptoms are reproducible on any library large enough that (a) the initial chokidar scan / `LocationStore.watchLocations()` takes more than a second or two to complete, AND/OR (b) any file-watcher `add` event fires while the user is browsing Untagged.

### Expected Behavior

1. **Count consistency.** The count next to "Untagged" in the sidebar should mean the same thing before and after clicking. If the user's preference hides missing files from browsing (the default — see INV-004), then the sidebar count should be "untagged files that are NOT missing" (998 in the report) — matching what the gallery will actually display. There should not be a 5x jump from sidebar-number to gallery-count on click.

2. **Filter persistence.** Clicking Untagged must apply the filter AND keep it applied across any background refresh event — chokidar initial-scan completion, new-file `add` events during normal browsing, etc. A user-initiated content-mode change is a stronger signal than any of those background events and must not be overridden by them.

3. **No self-overwrite on background refetch.** A background `refetch()` that happens while the user is in Untagged mode must re-run the Untagged query, not secretly escalate itself into a full `fetchAllFiles()` that clobbers the user's selection.

### Reproduction Context

Deterministic on any library where:

- `uiStore.hideMissingFilesInBrowsing === true` (the INV-004 default), AND
- A material fraction of DB files are missing from disk (creates the 5161 vs. 998 gap), AND
- Either chokidar's initial scan produces a `foundNewFiles` result, OR a file is added/moved into a watched location within ~seconds of launch.

Triggering sequences:

1. **Initial-scan trigger.** Launch the app. `RootStore.main` calls `rootStore.fileStore.fetchAllFiles()` synchronously (when there are no persisted criteria). In parallel it launches `rootStore.locationStore.watchLocations()` (see `src/frontend/stores/RootStore.ts:141-145`). While `watchLocations` is still walking every location's disk tree (10+ seconds on large libraries), the user clicks the sidebar Untagged selector. A few seconds later `watchLocations` resolves with `foundNewFiles=true` (because any file in the last incremental scan, or files chokidar discovered during the walk that were not already in the DB, flips that flag), which calls `rootStore.fileStore.refetch()`. `refetch` branches on current content and lands in `fetchUntaggedFiles` (second invocation) — which then clobbers itself into Content.All via `clearSearchCriteriaList` → `viewAllContent` → `fetchAllFiles`. See Root Cause below.

2. **Chokidar add trigger.** User clicks Untagged. A file-watcher `add` event fires (e.g. user drops a new image into a watched folder, or ExifTool writes a sidecar that chokidar sees as an add-then-remove). `LocationStore.addFile` calls `fileStore.debouncedRefetch()` (200ms debounce). That debounce resolves while the user is still in Untagged mode → same clobber path.

3. **Any other `refetch()` caller while in Untagged mode.** `TagStore.refetch`, `LocationStore.removeSublocationFiles`, `LocationStore.changeLocationPath`, `useFileDnD` drop handler (setTimeout 500ms), `Searchbar`'s match-any toggle, etc. All route through `FileStore.refetch` → `fetchUntaggedFiles` → clobber.

Platforms: all (Windows 11 Pro tested). Dexie/IndexedDB and SQLite backends both exhibit the race (the race is in the renderer, not the storage layer).

---

## Root Cause Analysis

**Category:** architectural-shortcoming

### Diagnosis

Two independent architectural defects combine to produce the reported behavior. They share a common root — **`fileStore.numUntaggedFiles` and "the active content filter" are both derived observables whose values can be clobbered by an unrelated async side-effect firing on a different code path** — but each deserves its own fix.

#### Defect A — Count overloading

`fileStore.numUntaggedFiles` is a single observable that is set by at least three different writers with three different meanings:

| Writer | When it fires | Value meaning |
|---|---|---|
| `refetchFileCounts()` (line 1097-1103) | Explicit post-write calls (`LocationStore.initLocation`, `delete`, RootStore query-restore branch, `reIndexAllFiles`) | Raw DB count — `SELECT COUNT(*) FROM files WHERE NOT EXISTS file_tags` — **includes missing files** |
| `updateFileListState()` synchronous pass (line 1073-1094) inside `updateFromBackend`'s first transaction | After every `fetchAllFiles` / `fetchFilesByQuery` / `fetchDuplicatesFiles` | Count of untagged files in `fileList` **before** the post-existence-check splice — effectively includes missing files (their `isBroken` flag is still undefined at this instant) |
| `updateFileListState()` second pass (after async existence check, line 995) | After the `fse.pathExists` batch resolves and `hideMissingFilesInBrowsing` splices broken files out | Count of untagged files in the **visible** (non-missing) `fileList` |

When `hideMissingFilesInBrowsing === true` (the INV-004 default) these three writers produce **different numbers** for a library with non-zero missing files. Which number the sidebar shows at any given moment is entirely a function of which writer ran most recently.

Concretely, on the bug reporter's library:
- `refetchFileCounts()` sees 5161 untagged rows in the DB (4163 missing + 998 present).
- The post-splice writer sees 998 (missing files spliced out of `fileList`).

So the sidebar will show 5161 whenever `refetchFileCounts` is the most recent writer, and 998 whenever `updateFromBackend`'s post-splice pass is the most recent writer. The reporter's "5161 → 998 on click" transition is exactly that: before the click, `refetchFileCounts` or the pre-splice pass had set 5161; after the click, `fetchUntaggedFiles` → `updateFromBackend`'s post-splice pass overwrites with 998.

Symmetrically for `numTotalFiles`, the companion observable, the inverse bug was caught in QA (TASK-024 BUG-1) and fixed inline by **always overriding `numTotalFiles` with the pre-splice tally** when `shouldHide && brokenCount > 0 && showsAllContent`. That fix was not extended to `numUntaggedFiles`, which is why the badge still carries the 5161-vs-998 divergence.

The conceptual mistake: the Outliner badge "Untagged (N)" is asking for a **single well-defined number** — "how many untagged files would the user see if they clicked this?". That question has one correct answer ("visible untagged count", which equals 998 in the reporter's library when hide-missing is on). But the implementation exposes a bag of three independently-set numbers and picks whichever was most recent, which is not a specification at all.

#### Defect B — `clearSearchCriteriaList` has a silent side effect that clobbers content mode

`FileStore.fetchUntaggedFiles` (line 701-718):

```ts
@action.bound async fetchUntaggedFiles(): Promise<void> {
  try {
    const { uiStore } = this.rootStore;
    uiStore.clearSearchCriteriaList();                          // ⚠
    const criteria = new ClientTagSearchCriteria('tags');
    uiStore.searchCriteriaList.push(criteria);
    const fetchedFiles = await this.backend.searchFiles(
      criteria.toCondition(this.rootStore),
      this.orderBy,
      this.orderDirection,
      uiStore.searchMatchAny,
    );
    this.setContentUntagged();
    return this.updateFromBackend(fetchedFiles);
  } catch (err) { ... }
}
```

And `UiStore.clearSearchCriteriaList` (line 788-794):

```ts
@action.bound clearSearchCriteriaList(): void {
  if (this.searchCriteriaList.length > 0) {
    this.searchCriteriaList.forEach((c) => c.dispose());
    this.searchCriteriaList.clear();
    this.viewAllContent();                                       // ⚠ fire-and-forget fetchAllFiles()
  }
}
```

And `UiStore.viewAllContent` (line 1155-1157):

```ts
@action private viewAllContent(): void {
  this.rootStore.fileStore.fetchAllFiles();                      // not awaited
}
```

**The chain:** on the SECOND invocation of `fetchUntaggedFiles` (first invocation leaves `searchCriteriaList.length === 1` with the Untagged pseudo-criterion pushed at line 706), `clearSearchCriteriaList` sees a non-empty list, clears it, and synchronously dispatches `fetchAllFiles()`. That `fetchAllFiles()` is not awaited anywhere. It runs concurrently with the rest of `fetchUntaggedFiles`.

The two coroutines race:

- **Coroutine U (untagged):** push criterion → `await backend.searchFiles(untagged)` → `setContentUntagged()` → `await updateFromBackend(untaggedFiles)`.
- **Coroutine A (all):** `clearSearchCriteriaList()` (now no-op, list empty) → `await backend.fetchFiles()` → `setContentAll()` → `await updateFromBackend(allFiles)`.

Whichever coroutine's `updateFromBackend` resolves last wins — it overwrites `content`, `fileList`, `fileListLastModified`, and all derived counts. For libraries where the untagged subset is small and the full set is large, U finishes first, then A finishes and clobbers U. Result: `content = Content.All`, `fileList = [all files]`, and the user sees tagged images while the Untagged selector loses its "pressed" highlight.

When is `fetchUntaggedFiles` called a SECOND time? Any of:

1. `watchLocations()` completes with `foundNewFiles = true` → `RootStore.main` calls `rootStore.fileStore.refetch()` (line 141-145). `refetch()` branches to `fetchUntaggedFiles` because `showsUntaggedContent` is true. Matches the "a few seconds later" timing exactly — `watchLocations` is precisely the async job that takes seconds on a large library.

2. `LocationStore.addFile` → `fileStore.debouncedRefetch()` (200ms debounce). Same branch in `refetch()`.

3. `LocationStore.hideFile` → `fileStore.hideFile` → `debouncedRefetch`. Same branch.

4. Direct clicks on Untagged twice in a row (the handler unconditionally calls `fetchUntaggedFiles` even if we're already in Untagged mode).

5. Any of the half-dozen other `fileStore.refetch()` callers (`TagStore`, `LocationStore` on location mutations, drag-and-drop timeout, etc.) while in Untagged mode.

The conceptual mistake: `clearSearchCriteriaList` is named and scoped like a pure setter ("empty this list"), but it has a hidden behavioral side effect ("also switch the content view to All"). That side effect is correct when the caller's intent is "user cleared search and there is no other filter to fall back to" (e.g. the Searchbar clear button). It is wrong when the caller's intent is "I am about to set up a non-query content mode (Untagged) and I need the user-facing criteria chip list re-initialized first" — which is `fetchUntaggedFiles`'s intent. The list-mutation and the content-switch should not be fused.

Note the sibling path `fetchMissingFiles` (line 720-781) already avoids this bug — it uses `uiStore.searchCriteriaList.clear()` directly (line 728) rather than `uiStore.clearSearchCriteriaList()`, skipping the `viewAllContent()` side effect. That asymmetry is evidence that the side effect is not load-bearing for non-query fetchers; `fetchUntaggedFiles` simply wasn't converted.

### Diagnostic Questions Considered

- **Wrong mental model?** Partial. The author of `fetchUntaggedFiles` appears to have modelled `clearSearchCriteriaList` as "clear the chip list" without noticing it also fires a fetch. That is a local mental-model error, but the deeper issue is that a method named `clearSearchCriteriaList` *has* that side effect at all. Category fit: secondary.

- **Architectural shortcoming?** Yes. Two long-standing shortcomings:
  - `numUntaggedFiles` is a single observable treated as three different derived values depending on writer; the callers never agree on which value they want. No invariant, no single source of truth.
  - `clearSearchCriteriaList` fuses list-mutation with view-mode-switching. Any caller that mutates the list for internal setup (not "user cleared the chip list") triggers an unintended fetch cascade.
  - Additionally, `viewAllContent` fires `fetchAllFiles()` without awaiting, which is the mechanism that turns a latent fusion into a race. This matches INV-005's "narrowest hammer" shape — the architectural layer is correctly separated at the API surface but the internal call-wiring leaks async side effects that compose badly.
  Category fit: PRIMARY.

- **Incorrect order of operations?** Adjacent. Inside `fetchUntaggedFiles` the order `clearSearchCriteriaList()` → push new criterion → `searchFiles` → `setContentUntagged()` looks plausible on paper. The problem is not the order — it's that step 1 has a hidden concurrent side effect that races with steps 2-4. Reordering does not fix it; the side effect must be removed or made caller-scoped.

- **Missing edge case?** Minor. `fetchUntaggedFiles` never considers "what if I was already in Untagged mode when called?" — in that case the second call should be a no-op (or just a data refresh), but today it re-runs the full clobber sequence. That is a symptom of the core defect, not an independent edge-case miss.

- **Wrong abstraction?** Yes, corroborating architectural-shortcoming. `numUntaggedFiles` models "a number shown next to Untagged" but conflates three semantically-distinct numbers. The right abstraction is: one derived value `visibleUntaggedCount` (a MobX `@computed` over `fileList` filtered by hide-missing), never written by any fetcher, never overwritten by any DB-level count.

- **Silent failure?** Partial. `fetchAllFiles()` fired from `viewAllContent` is not awaited and has no error handler wired into the caller, so its promise rejections would be uncaught. Not the root cause of this bug, but a subsidiary hazard worth noting.

---

## Blast Radius

Every site affected by one or both of the two defects. Numbered so the task breakdown in §Holistic Solution can map cleanly.

### Count-overloading sites (Defect A)

1. **`src/frontend/stores/FileStore.ts:67` (`@observable numUntaggedFiles = 0`)** — The observable itself. Three different writer paths set it to three different values. Must be converted to a `@computed` over `fileList` (plus hide-missing awareness), OR the three writers must be harmonized to all produce the same "visible untagged count" number.

2. **`src/frontend/stores/FileStore.ts:1097-1103` (`refetchFileCounts`)** — Writes `numUntaggedFiles = <DB count including missing>`. This writer disagrees with the other two. Either (a) stop writing `numUntaggedFiles` from here and let the computed take over, or (b) keep the method but rename/scope it (`numTotalFiles` still makes sense as a raw DB total).

3. **`src/frontend/stores/FileStore.ts:1073-1094` (`updateFileListState`)** — Writes `numUntaggedFiles` based on whether the content is All or Untagged. In All mode it counts untagged-among-fileList (which post-splice excludes missing, good). In Untagged mode it sets `= fileList.length` (post-splice count, good). Both writes agree IF hide-missing is on and the splice has run. The writer does NOT align with `refetchFileCounts`. If we keep this writer, `refetchFileCounts` must stop writing `numUntaggedFiles`.

4. **`src/frontend/stores/FileStore.ts:817-826` (`incrementNumUntaggedFiles` / `decrementNumUntaggedFiles`)** — Per-file mutations (e.g. when `hideFile` decrements because a broken file with no tags is taken out of the visible set). If `numUntaggedFiles` becomes `@computed`, these mutators become dead code and must be deleted (they currently hand-maintain a count that would be derived automatically).

5. **`src/frontend/stores/FileStore.ts:834-838` (`resetFileCounts`)** — Sets all three counters to 0. If `numUntaggedFiles` becomes computed, drop it from here.

6. **`src/frontend/entities/File.ts` (ClientFile)** — Grep for any direct call to `incrementNumUntaggedFiles` / `decrementNumUntaggedFiles`. These are the hand-wired count maintainers. If the observable becomes computed, every call site must be removed.

7. **`src/frontend/containers/Outliner/TagsPanel/TagsTree.tsx:770` (`count={fileStore.numUntaggedFiles}`)** — Consumer. If the observable's meaning tightens to "visible untagged count", the consumer is correct as-is.

8. **`src/renderer.tsx:219` (`untaggedFiles: rootStore.fileStore.numUntaggedFiles`)** — Debug stats consumer (dev-only). Same: if meaning tightens, correct as-is.

### Filter-clobber sites (Defect B)

9. **`src/frontend/stores/FileStore.ts:701-718` (`fetchUntaggedFiles`)** — The direct source of the clobber. Replace `uiStore.clearSearchCriteriaList()` with the pattern used by `fetchMissingFiles`: `uiStore.searchCriteriaList.forEach(c => c.dispose()); uiStore.searchCriteriaList.clear();` (or a dedicated helper on UiStore that mutates the list without firing a fetch).

10. **`src/frontend/stores/FileStore.ts:690-699` (`fetchAllFiles`)** — Also calls `uiStore.clearSearchCriteriaList()`. When a pre-existing criterion triggers `viewAllContent()`, `fetchAllFiles()` recursively schedules another `fetchAllFiles()` asynchronously. This is a wasteful duplicate fetch (two identical async passes) but is not load-bearing for the bug since both passes produce the same result. Still, fix for symmetry — use the same list-mutating helper.

11. **`src/frontend/stores/FileStore.ts:720-781` (`fetchMissingFiles`)** — Already uses `uiStore.searchCriteriaList.clear()` directly. No change needed, but this is the positive example to imitate.

12. **`src/frontend/stores/UiStore.ts:788-794` (`clearSearchCriteriaList`)** — The fused behavior lives here. Options:
    - **12a.** Keep the fused method as the public API that the Searchbar's "Clear" button calls (which is its correct use case — user-initiated clear should fall back to All view), AND add a separate `_resetCriteriaListSilently()` (or equivalent) that only mutates the list. Fetchers call the silent version.
    - **12b.** Remove the fused method; rename to `clearSearchCriteriaListAndViewAll` (longer but honest); callers pick the right one. Larger diff, breaks readability of the Searchbar clear path.
    - **12c.** Leave the fused method alone and fix only the fetcher callers (pattern 9+10). Smallest change, addresses the reported bug completely.
    - **Recommended: 12c, with an additive helper** on UiStore so the fetchers don't hand-roll list clearing: `@action.bound _clearSearchCriteriaListNoFetch(): void`. Keeps the Searchbar clear button's UX unchanged (clearing the chip-list view returns you to "All images", which is correct) and gives fetchers a non-fusing primitive.

13. **`src/frontend/stores/UiStore.ts:1155-1157` (`viewAllContent`)** — Kicks off `fetchAllFiles()` without awaiting. This is the mechanism that makes fusion race-able. Two orthogonal hardening options:
    - **13a.** Have `viewAllContent` return the promise so callers can await if they want. `clearSearchCriteriaList` would NOT await it (the Searchbar clear button fire-and-forget is still correct). But any future fetcher that wants to `await` the transition could.
    - **13b.** Do nothing here; fixing 9+10+12 is sufficient because no fetcher will call `viewAllContent` any more.
    - **Recommended: 13b** (minimal diff). Revisit 13a if future work needs it.

### Timing / async-cascade sites (both defects touch here)

14. **`src/frontend/stores/RootStore.ts:141-145` (post-watchLocations refetch)** — The "a few seconds later" trigger. Left alone once Defect B is fixed, because `refetch() → fetchUntaggedFiles` will then correctly re-run the Untagged query.

15. **`src/frontend/stores/LocationStore.ts:529` (`fileStore.debouncedRefetch()` from `addFile`)** — Same trigger class. Fixed transparently once Defect B is fixed.

16. **`src/frontend/stores/LocationStore.ts:542` (`fileStore.debouncedRefetch()` from `hideFile`)** — Same.

17. **`src/frontend/stores/FileStore.ts:676-688` (`refetch`)** — The dispatcher. No change needed once its callees are fixed.

### Consumer sites for `numUntaggedFiles` (sanity check after Defect A fix)

18. **`src/frontend/containers/Outliner/TagsPanel/TagsTree.tsx:186-188`** — The UntaggedItem label template `Untagged ({count})` and its tooltip `Untagged images (${count})`. No code change; behavior improves as the value becomes consistent.

19. **`src/renderer.tsx:219`** — Debug helper. No change; dev-only, benefits from accuracy.

### Non-changes (intentionally left alone)

- **SQLite `countFiles()` implementation** (`src/backend/sqlite-backend.ts:790-805`) — The SQL is correct ("how many DB rows have no file_tags"). That number happens not to match what the sidebar wants to show when hide-missing filters broken files out, but that is the renderer's job to bridge, not the backend's. Do not add a second `countVisibleUntaggedFiles()` overload — the renderer already has the filtered list in memory.
- **Dexie `countFiles()` implementation** (`src/backend/backend.ts:312-324`) — Same reasoning.
- **`fetchFilesByQuery`** — Not involved in this bug (it doesn't call `clearSearchCriteriaList`; it reads from the existing list). Keep.
- **`fetchDuplicatesFiles`** — Calls `updateFromBackend`, inherits the Defect-A count semantics only if someone reads `numUntaggedFiles` from Duplicates mode (no one does today). No change.
- **The `hideMissingFilesInBrowsing` reaction in `FileStore` constructor (line 87-90)** — Correct as-is. Fires a refetch when the preference changes; after the Defect-B fix, that refetch will keep Untagged mode stable too.

---

## UX / Requirements Specification

### Purpose

The Untagged sidebar selector must display a number that accurately predicts the gallery result, and clicking it must produce a sticky content-mode change that no background refresh silently undoes.

### User-Stated Design Decisions

1. **Count must match what the click produces.** If the sidebar says "Untagged (998)" and the user clicks, they should see 998 items. Not 5161 → 998. The user's words: "One of these is wrong."

2. **The filter must stick.** Clicking Untagged and then having the view silently flip back to All is unacceptable even if it takes "a few seconds". The user's words: "clicking `Untagged` doesn't actually stick — the filter disappears."

3. **The fix must address the root cause, not paper over the symptom.** The user specifically asked to "trace the root cause" and identified the candidate surfaces (sidebar count source, click handler, async background refresh) — they want a structural fix, not a "hide the number" workaround.

4. **Look for other latent bugs with the same root cause.** The user explicitly asked for blast-radius work: other sidebar selectors with the same count-mismatch pattern, other filters that might get clobbered by the same async refresh. This investigation enumerates both.

### Behavioral Specifications

1. **Count parity.** `Untagged (N)` in the sidebar equals the number of items the gallery will render after clicking, when `hideMissingFilesInBrowsing === true` (the default). When `hideMissingFilesInBrowsing === false`, the sidebar count equals the raw DB untagged count and the gallery renders that many items (including broken ones with a placeholder tile). Either way: sidebar and gallery agree.

2. **Click stickiness across `watchLocations` completion.** On a fresh launch, user clicks Untagged within the first second. Five seconds later, `watchLocations` resolves. The content mode must remain `Content.Untagged`; the Untagged selector must remain visually pressed; the gallery must still show only untagged files (with whatever new additions the scan found, if any are untagged).

3. **Click stickiness across chokidar `add` events.** With Untagged selected, the user drops a new image into a watched folder. After the 200ms debounce + refetch, the gallery refreshes. The new file appears IF it is untagged; does not appear if it arrives already-tagged (e.g. from ExifTool reading sidecar metadata). Content mode stays `Content.Untagged`.

4. **No console errors from unhandled rejections.** The existing fire-and-forget `fetchAllFiles()` from `viewAllContent` has no caller-side error handler. After the fix, the fetcher functions (`fetchUntaggedFiles` / `fetchAllFiles`) do not call `viewAllContent` for their own internal setup, so this hazard surface shrinks. The Searchbar clear-button call is unaffected.

5. **Double-click / reclick tolerance.** Clicking Untagged when already in Untagged mode must be either a no-op or a safe data-refresh — must never briefly flip to All and back.

6. **Count stability across refetches.** While in Untagged mode, a background refetch (chokidar, tagstore, etc.) must not briefly set the Untagged count to 5161 before the splice-pass corrects it back to 998. The observable should have one consistent value across the refetch.

### Explicit Rejections

- **Do not add a second backend method** like `countVisibleUntaggedFiles()`. The renderer has `fileList` in memory and knows which files are broken; a second round-trip to SQLite to count is the wrong direction.

- **Do not introduce a "fork mode" or preference flag** for the filter-stickiness fix. This is a bug, not a configuration choice. Matches INV-005/INV-006's narrowest-hammer pattern.

- **Do not change `hideMissingFilesInBrowsing`'s default** as part of this investigation. INV-004 established `true` as the default and documented why; untangling the count / clobber bugs is orthogonal.

- **Do not remove `clearSearchCriteriaList`'s `viewAllContent()` side effect.** The Searchbar's "Clear" button depends on it (user-initiated clear of the chip list should return to All view; that IS the expected UX of the clear button). The fix scopes which callers invoke that fused behavior vs. a new silent variant — it does not remove the fused behavior itself.

- **Do not rewrite `numUntaggedFiles` as a `@computed` in this investigation** unless the small refactor (converting the three writer sites to agree) turns out to be insufficient. Start with the minimum fix: have `refetchFileCounts` stop writing `numUntaggedFiles`, keep the other two in-sync-by-construction. A computed-based rewrite is a TODO for a future INV if the observable pattern needs deeper harmonization across the store.

### Uncertainty resolution

- **Does `fetchAllFiles` also self-clobber?** Yes, in a benign way: when its `clearSearchCriteriaList` fires `viewAllContent` → another `fetchAllFiles`, both pass through the same code path and produce the same result. The second call is duplicate work, not a correctness bug. Still fixed for symmetry (Blast Radius #10).

- **Could the Searchbar "Clear" button be broken by the fix?** No. Option 12c (recommended) leaves `UiStore.clearSearchCriteriaList` unchanged. The Searchbar calls it from the `<QuickSearchList onClear={...}>` and the CriteriaList's Clear IconButton; both expect the chip list to clear AND the view to return to All. Behavior preserved.

- **Could `fetchMissingFiles` have a symmetric bug?** No. It uses `uiStore.searchCriteriaList.clear()` directly (line 728), bypassing the fused `clearSearchCriteriaList`. It is the correct pattern and is what the fixed `fetchUntaggedFiles` will imitate.

- **Does the `reaction` on `hideMissingFilesInBrowsing` (FileStore constructor line 87-90) race with Untagged mode?** No — it calls `this.refetch()`, which in Untagged mode correctly dispatches to `fetchUntaggedFiles`. After the Defect-B fix, that call will stay in Untagged mode.

- **Is `debouncedRefetch` a problem?** Only indirectly. It's a correct 200ms debounce of `refetch`. Once `refetch`'s Untagged branch stops self-clobbering, the debounce becomes harmless.

- **Could this bug occur on `Content.Missing`, `Content.Duplicates`, or `Content.Query`?** Missing: no (uses direct `searchCriteriaList.clear()`). Duplicates: `fetchDuplicatesFiles` doesn't touch the criteria list at all — no clobber. Query: `fetchFilesByQuery` re-reads the existing list — no clobber, but a related hazard exists (if `searchCriteriaList` is empty it falls back to `fetchAllFiles`, line 787). Not exercised by this bug, out of scope for the fix but noted.

---

## Holistic Solution

### Approach

Four tasks, grouped by defect and ordered so that behavioral fixes ship before the observable cleanup (which is a refactor):

1. **TASK-034 — Stop `fetchUntaggedFiles` and `fetchAllFiles` from self-clobbering via `clearSearchCriteriaList`.** Covers Blast Radius items 9, 10, 12. Add a new UiStore helper `_resetSearchCriteriaListSilently()` (or equivalent name) that mutates the list without firing `viewAllContent()`. Convert `fetchUntaggedFiles` and `fetchAllFiles` to use it. Keep the fused `clearSearchCriteriaList` public API unchanged so the Searchbar's Clear button still returns the user to All view. This is the user-visible fix for symptom #2 and #3 (filter stickiness).

2. **TASK-035 — Harmonize `numUntaggedFiles` writers so all three agree on "visible untagged count".** Covers Blast Radius items 1-6, 18-19. `refetchFileCounts` stops writing `numUntaggedFiles` (keeps writing `numTotalFiles`, which is correct for the "All Images" DB-total badge). `updateFileListState` stays authoritative — its post-splice pass is the single source of truth. Verify the per-file mutators (`incrementNumUntaggedFiles`, `decrementNumUntaggedFiles`) still make sense; if yes, keep them; if they are now only called from the file-hide-file-delete paths that already update `fileList`, make them computed-friendly. This is the user-visible fix for symptom #1 (count parity).

3. **TASK-036 — Add regression guard: no-op re-click of Untagged, and stability across background refetches.** Adds a small guard at the top of `fetchUntaggedFiles` (e.g. if `showsUntaggedContent && orderBy/orderDirection unchanged`, branch to a cheaper refresh path). Adds a short-lived "background refetches preserve content mode" assertion in dev builds to catch future regressions. Independent from TASK-034/35 but a cheap belt-and-suspenders.

4. **TASK-037 — QA the fix across all five Content modes.** Cross-check All / Missing / Untagged / Query / Duplicates. For each, verify that (a) the sidebar count matches the gallery, (b) clicking the selector makes that mode sticky across a `watchLocations` completion AND a chokidar `add` event. Produces a QA transcript in TASK-024 style (DISPLAY REQUIRED for visual confirmations, PASS / FAIL per sub-step).

The task order is dependency-safe: TASK-034 is the behavior fix (closes the bug report). TASK-035 is the count refactor (closes the aesthetic half of the bug report and reduces future racket from the three-writer overload). TASK-036 is hardening. TASK-037 is verification.

Each task enumerates the exact file set it touches in its `files:` frontmatter so a developer implementing one task does not need to read the others.

### Expected Outcomes

- **Symptom #3 (filter clobber) gone.** Clicking Untagged and waiting 10+ seconds keeps the user in Untagged mode regardless of whether `watchLocations` or any chokidar `add` event fires during that window.
- **Symptom #1 (count mismatch) gone.** Sidebar shows `Untagged (998)` and clicking lands on 998 items. If the user toggles hide-missing-files off, sidebar shows `Untagged (5161)` and clicking lands on 5161 items (including broken-tile placeholders).
- **Symptom #2 (immediate 5161 → 998 drop) gone** as a consequence of #1.
- **No regression** in the Searchbar's "Clear" chip-list button (still returns user to All view after clearing).
- **No regression** in `fetchMissingFiles` (unchanged).
- **Fewer duplicate `fetchAllFiles` calls** during normal operation (the self-clobber path is eliminated), so on large libraries the "couple-seconds flicker" that some users perceive as "loading twice" goes away.
- **`yarn build`, `yarn test`, and `yarn start` all succeed** with no TypeScript errors or console warnings.

### Risks and Tradeoffs

- **Low-risk behavior change.** The only semantic shift is "`fetchUntaggedFiles` / `fetchAllFiles` no longer trigger a concurrent `fetchAllFiles` via `clearSearchCriteriaList`". That concurrent call is always redundant or destructive. No known caller relies on it.

- **Upstream merges.** When rebasing onto upstream, the new UiStore helper (`_resetSearchCriteriaListSilently`) may conflict if upstream changes `UiStore.clearSearchCriteriaList`. The conflict should always resolve in favor of the fork — the fused method stays for Searchbar, the silent helper is additive.

- **`numUntaggedFiles` refactor in TASK-035 is larger in diff than TASK-034.** If the harmonization surfaces unexpected consumers (Inspector, stats panel, etc.), scope it narrower: leave the `@observable` alone, just make `refetchFileCounts` stop writing it. The user-visible symptom is fully resolved even if Defect A is only half-fixed.

- **`incrementNumUntaggedFiles` / `decrementNumUntaggedFiles` removal risk.** These are called from `hideFile` (`FileStore.ts:607-614`) and possibly from `ClientFile` when tags change. If removed prematurely they break the count in the intermediate window before the next `updateFileListState` pass. Mitigation: do not remove them in TASK-035; leave them as hand-maintainers; the refactor is a "stop writing from `refetchFileCounts`" change, not a "replace observable with computed" rewrite. The full computed-based rewrite is a future INV if it ever becomes necessary.

- **`viewAllContent` left as-is.** Option 13a (have it return the promise) is tempting but changes the `UiStore` method signature for a speculative benefit. Skip unless a later task needs to await the transition.

- **QA burden in TASK-037.** The cross-Content-mode sweep is real work (~1-2 hours of interactive display-required testing). Worth it — similar investigations (INV-004) benefited from the explicit QA transcript; caught TASK-024's BUG-1 `numTotalFiles` regression that would otherwise have shipped.

- **No crash-reporter wiring** (INV-006 removed it). The race this bug describes produces no exceptions, only wrong state — so diagnostic logs are the only trail. TASK-036's dev-build assertion is the mitigation.

- **`preferences.json` / persisted search criteria** — On restore with `numCriterias > 0`, `RootStore.main` runs `fetchFilesByQuery` instead of `fetchAllFiles`. That path does not exhibit the bug (no `clearSearchCriteriaList` call inside `fetchFilesByQuery`). No migration or cleanup needed.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: `docs/missing-files.md` already documents the `numTotalFiles` / `numMissingFiles` post-splice override pattern (lines 103-113). Append a parallel note for `numUntaggedFiles` once TASK-035 lands — document that `refetchFileCounts` intentionally does NOT write `numUntaggedFiles` and that `updateFileListState`'s post-splice pass is the single source of truth. Do not split into a new doc; the missing-files page is the correct home for "hide-missing interaction with sidebar counts".
