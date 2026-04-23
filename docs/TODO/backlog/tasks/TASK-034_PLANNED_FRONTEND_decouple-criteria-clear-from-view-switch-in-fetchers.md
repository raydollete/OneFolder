---
id: TASK-034
title: 'Stop fetchUntaggedFiles and fetchAllFiles from self-clobbering via clearSearchCriteriaList'
investigation: INV-007
status: PLANNED
priority: high
blocked_by: []
date_created: 2026-04-23
date_completed:
files:
  - 'src/frontend/stores/UiStore.ts'
  - 'src/frontend/stores/FileStore.ts'
---

## What

Add a new silent helper `_resetSearchCriteriaListNoFetch()` (exact name flexible — see step 1) to `UiStore` that mutates `searchCriteriaList` without firing `viewAllContent()`. Convert `FileStore.fetchUntaggedFiles` and `FileStore.fetchAllFiles` to call the silent helper instead of the fused `UiStore.clearSearchCriteriaList`. Leave `UiStore.clearSearchCriteriaList` itself unchanged so the Searchbar's "Clear" button still returns the user to All view as part of its fused behavior.

After this task: clicking the sidebar "Untagged" selector will not silently dispatch a concurrent `fetchAllFiles()` that races with and overwrites the Untagged query. The content mode stays stuck to Untagged across `watchLocations()` completions, chokidar `add` events, and any other `fileStore.refetch()` caller.

## Why

`FileStore.fetchUntaggedFiles` calls `uiStore.clearSearchCriteriaList()` on entry. When that method sees a non-empty criteria list (the case on every call after the first — because the first call pushes the Untagged pseudo-criterion at line 706), it synchronously calls `this.viewAllContent()` which in turn fires `this.rootStore.fileStore.fetchAllFiles()` **without awaiting**. That `fetchAllFiles()` runs concurrently with the rest of `fetchUntaggedFiles` and — because it fetches the full file set rather than the untagged subset — typically resolves last, clobbering `content = Content.Untagged` with `content = Content.All` and blowing `fileList` away with all files (tagged and untagged).

User-visible result (reported as INV-007 symptoms #2 and #3): the Untagged filter is applied on click, then "a few seconds later" (when `watchLocations()` completes and fires `rootStore.fileStore.refetch()` from `src/frontend/stores/RootStore.ts:141-145`) the gallery silently reverts to All images and the Untagged selector loses its pressed highlight.

`fetchAllFiles` exhibits the same pattern in a benign form (it self-dispatches a duplicate `fetchAllFiles` rather than clobbering to a different mode). Fix it in parallel for symmetry.

`fetchMissingFiles` is already the correct pattern — it uses `uiStore.searchCriteriaList.clear()` directly (line 728). This task converts the other two fetchers to match, via a proper UiStore method so the intent is documented at the call site rather than through raw observable mutation.

See [INV-007](../investigations/INV-007_HIGH_FRONTEND_untagged-selector-count-mismatch-and-filter-clobber.md) for the full root-cause analysis.

## Implementation Steps

- [ ] 1. **`src/frontend/stores/UiStore.ts`** — Add a new action method that clears `searchCriteriaList` without any view-mode side effect. Place it directly below the existing `clearSearchCriteriaList` (currently line 788-794). Recommended name: `_resetSearchCriteriaListNoFetch` (underscore prefix signals "internal helper for fetchers, not for UI"). Implementation:

  ```ts
  /**
   * Clears the search criteria list WITHOUT triggering viewAllContent().
   *
   * Intended for fetcher internals that need to reset the user-visible
   * criteria chip list before setting up a new non-query content mode
   * (Untagged, All). Callers are responsible for setting the content mode
   * themselves afterward (via setContentUntagged / setContentAll / etc).
   *
   * Do NOT call from UI code — the Searchbar "Clear" button and anywhere
   * else the user clears the list should use clearSearchCriteriaList() so
   * that clearing returns the user to All view.
   */
  @action.bound _resetSearchCriteriaListNoFetch(): void {
    if (this.searchCriteriaList.length > 0) {
      this.searchCriteriaList.forEach((c) => c.dispose());
      this.searchCriteriaList.clear();
    }
  }
  ```

  Do NOT modify `clearSearchCriteriaList` itself. Its fused behavior (clear + viewAllContent) is correct for the Searchbar Clear button's UX.

- [ ] 2. **`src/frontend/stores/FileStore.ts` (fetchUntaggedFiles, ~line 701-718)** — Replace the first statement inside the `try` block. Change:

  ```ts
  uiStore.clearSearchCriteriaList();
  ```

  to:

  ```ts
  uiStore._resetSearchCriteriaListNoFetch();
  ```

  Keep the rest of the function unchanged (push Untagged criterion → await `searchFiles` → `setContentUntagged` → `updateFromBackend`).

- [ ] 3. **`src/frontend/stores/FileStore.ts` (fetchAllFiles, ~line 690-699)** — Replace:

  ```ts
  this.rootStore.uiStore.clearSearchCriteriaList();
  ```

  with:

  ```ts
  this.rootStore.uiStore._resetSearchCriteriaListNoFetch();
  ```

  Rationale: same self-dispatch problem in benign form; fixing for symmetry prevents the duplicate `fetchAllFiles` pass on every call that had pre-existing criteria.

- [ ] 4. **Do NOT change `fetchMissingFiles`** (line 720-781). It uses `uiStore.searchCriteriaList.clear()` directly, which works but bypasses the proper `dispose()` pass over each criterion. That is a minor leak but out of scope for this task — do not widen the diff. A future cleanup can switch `fetchMissingFiles` to `_resetSearchCriteriaListNoFetch()` too.

- [ ] 5. **Verify no other call sites of `clearSearchCriteriaList`** need the silent variant. Grep `clearSearchCriteriaList` across `src/`:

  - `src/frontend/stores/FileStore.ts:692` — fetchAllFiles (step 3, updated).
  - `src/frontend/stores/FileStore.ts:704` — fetchUntaggedFiles (step 2, updated).
  - `src/frontend/containers/AppToolbar/Searchbar.tsx:96` — QuickSearchList `onClear={uiStore.clearSearchCriteriaList}`. **Do not touch** — this is the user-initiated Clear button and the fused behavior (clear + view All) is the correct UX.
  - `src/frontend/containers/AppToolbar/Searchbar.tsx:164` — CriteriaList Clear IconButton. **Do not touch** — same as above.
  - `src/frontend/containers/ContentView/DuplicateGallery.tsx:751` — "Clear filters" in the Duplicates gallery. **Do not touch** — user-initiated clear, same fused UX.

  Confirm no other call sites remain by rerunning the grep after steps 2-3.

- [ ] 6. **Verify compilation.** Run `yarn build`. Expect no TypeScript errors.

- [ ] 7. **Verify startup.** Run `yarn start` against a watch-mode build. The app must launch without errors. No console warnings referencing `_resetSearchCriteriaListNoFetch` or fetcher paths.

- [ ] 8. **Interactive smoke test — filter stickiness (PRIMARY regression test).** DISPLAY REQUIRED.

  1. Launch the app fresh. Wait for gallery to populate (All mode).
  2. Immediately click the "Untagged" selector at the bottom of the Tags panel.
  3. Verify the gallery switches to untagged images within ~1 second. Untagged selector is visually pressed.
  4. **Wait at least 10 seconds.** `watchLocations` should complete during this window (toast "New images detected" may appear, or the "Looking for new images" progress toast disappears).
  5. **Expected:** gallery remains showing only untagged files; Untagged selector stays pressed.
  6. **Before the fix:** gallery silently flips to show ALL files (tagged ones appear); Untagged selector visually unpresses.

- [ ] 9. **Interactive smoke test — chokidar add event during Untagged mode.** DISPLAY REQUIRED.

  1. With the app running in Untagged mode (from step 8), drop a new untagged image into a watched location via the OS file explorer.
  2. Within ~1-2 seconds, the gallery should refresh. The new file should appear IF it is untagged.
  3. Untagged selector remains pressed. Content mode remains `Content.Untagged`.
  4. **Before the fix:** the refresh would trigger `LocationStore.addFile → fileStore.debouncedRefetch → fetchUntaggedFiles (second call) → clearSearchCriteriaList → viewAllContent → fetchAllFiles` race. Gallery would flip to All.

- [ ] 10. **Interactive smoke test — Searchbar Clear button unchanged.** DISPLAY REQUIRED.

  1. Type a tag name into the Searchbar QuickSearchList (or add a search criterion via the Tags panel) so `searchCriteriaList` is non-empty.
  2. Click the Clear (×) button inside the Searchbar input.
  3. **Expected:** criteria list clears AND the gallery switches to All view. Same as before the fix.
  4. **Regression check:** if the Searchbar Clear now leaves you in Query mode with an empty criteria list, the `clearSearchCriteriaList` method was modified incorrectly — revert step 1's edits to UiStore that touched `clearSearchCriteriaList`.

- [ ] 11. **Interactive smoke test — re-clicking Untagged.** DISPLAY REQUIRED.

  1. With Untagged mode active, click the Untagged selector again.
  2. **Expected:** no visible flicker, no brief flip to All. The gallery either stays exactly the same or performs a quiet data refresh.
  3. **Before the fix:** second click also ran `clearSearchCriteriaList` on a non-empty list, firing the race a second time.

- [ ] 12. Commit with a message like "Decouple criteria-list mutation from view-mode switch in fetchers (INV-007)".

## Done When

- [ ] `src/frontend/stores/UiStore.ts` has a new `_resetSearchCriteriaListNoFetch()` action adjacent to `clearSearchCriteriaList`. The existing `clearSearchCriteriaList` is UNCHANGED.
- [ ] `src/frontend/stores/FileStore.ts:692` (`fetchAllFiles`) and `src/frontend/stores/FileStore.ts:704` (`fetchUntaggedFiles`) both call `uiStore._resetSearchCriteriaListNoFetch()` instead of `uiStore.clearSearchCriteriaList()`.
- [ ] `yarn build` succeeds with zero TypeScript errors.
- [ ] `yarn start` launches the app without console errors.
- [ ] Interactive smoke test in step 8 passes: Untagged filter remains applied across `watchLocations()` completion. Verified by DISPLAY.
- [ ] Interactive smoke test in step 9 passes: chokidar `add` event does not flip content mode. Verified by DISPLAY.
- [ ] Interactive smoke test in step 10 passes: Searchbar Clear button behavior unchanged (still returns to All view). Verified by DISPLAY.
- [ ] Interactive smoke test in step 11 passes: re-clicking Untagged is a no-op flicker-wise. Verified by DISPLAY.
