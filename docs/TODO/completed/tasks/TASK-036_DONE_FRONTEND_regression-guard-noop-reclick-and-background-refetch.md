---
id: TASK-036
title: 'Regression guard: no-op Untagged re-click and dev-build content-mode preservation assertion'
investigation: INV-007
status: DONE
priority: medium
blocked_by: [TASK-034]
date_created: 2026-04-23
date_completed: 2026-04-23
files:
  - 'src/frontend/stores/FileStore.ts'
---

## What

Two small hardening changes that prevent regressions of the INV-007 bug class:

1. **No-op early-exit** in `fetchUntaggedFiles` (and symmetrically `fetchAllFiles`, `fetchMissingFiles`, `fetchDuplicatesFiles`) when the store is already in that content mode AND the click does not carry new parameters. Prevents the flicker-flash observed when a user double-clicks the Untagged selector and, before the fix in TASK-034, would have triggered the race twice.

2. **Dev-build assertion** in `refetch` that content mode is preserved across the call. If `refetch()` is called while `content = Untagged` and completes with `content = All` (or any other mismatch), log a warning. Catches any future caller-side race where a fetcher accidentally re-introduces the clobber pattern.

Both are additive; neither changes user-visible behavior on the happy path.

## Why

TASK-034 fixes the immediate clobber. But the `clearSearchCriteriaList` fusion pattern exists elsewhere in the UI layer (Searchbar, DuplicateGallery "Clear filters", etc.) and any future refactor that routes one of those call sites through a new fetcher could re-introduce the bug. A dev-build assertion turns a silent race into a console warning, catching it during development rather than in user reports weeks later.

The no-op guard is cheap and fixes a subtler UX papercut: re-clicking Untagged (or any content-mode selector) currently re-runs the full fetch even when nothing has changed, producing a brief gallery re-render. The guard makes the click a no-op when the store is already in the target state.

See [INV-007](../investigations/INV-007_HIGH_FRONTEND_untagged-selector-count-mismatch-and-filter-clobber.md) §Holistic Solution item 3.

Blocked by TASK-034 because the assertion would fire on every click until the clobber is fixed.

## Implementation Steps

- [x] 1. **`src/frontend/stores/FileStore.ts` — `fetchUntaggedFiles` no-op guard** (currently line 701-718). Add a guard near the top:

  ```ts
  @action.bound async fetchUntaggedFiles(): Promise<void> {
    try {
      const { uiStore } = this.rootStore;

      // No-op guard: if we're already in Untagged mode with no new parameters,
      // avoid re-running the entire fetch. Prevents visible flicker on
      // repeated clicks of the Untagged selector. See INV-007.
      if (this.showsUntaggedContent) {
        return;
      }

      uiStore._resetSearchCriteriaListNoFetch();
      // ... rest unchanged
  ```

  Rationale: if the user is already looking at Untagged, re-clicking the selector should do nothing. If the user wants to force a data refresh (e.g. after tagging some files externally), they can use the toolbar Reload button or the re-index action.

  Caveat: if `orderBy` or `orderDirection` has changed since the mode was entered, the no-op would skip a needed refresh. However, `orderFilesBy` and `switchOrderDirection` already call `this.refetch()` explicitly (line 563, 568), which will re-enter `fetchUntaggedFiles` via `refetch()` with `showsUntaggedContent=true`. This would be skipped by the guard. **Fix:** the order-change code paths should not go through `refetch()` → `fetchUntaggedFiles`; they should call a data-only refresh. For minimal scope, instead of re-architecting the refetch dispatcher, add an override parameter to the guard:

  ```ts
  @action.bound async fetchUntaggedFiles(forceRefresh = false): Promise<void> {
    try {
      if (this.showsUntaggedContent && !forceRefresh) {
        return;
      }
      // ...
    }
  }
  ```

  Then update `refetch()` to pass `forceRefresh=true`:

  ```ts
  @action.bound async refetch(): Promise<void> {
    if (this.showsAllContent) {
      return this.fetchAllFiles(true);
    } else if (this.showsUntaggedContent) {
      return this.fetchUntaggedFiles(true);
    } else if (this.showsQueryContent) {
      return this.fetchFilesByQuery();
    } else if (this.showsMissingContent) {
      return this.fetchMissingFiles(true);
    } else if (this.showsDuplicatesContent) {
      return this.fetchDuplicatesFiles(true);
    }
  }
  ```

  This preserves the existing behavior of all programmatic refetch callers (they force a refresh) and adds the no-op guard only for the direct user-click path (which does not pass `forceRefresh`).

- [x] 2. **`src/frontend/stores/FileStore.ts` — symmetric guards in other fetchers.** Apply the same pattern to `fetchAllFiles`, `fetchMissingFiles`, and `fetchDuplicatesFiles`. Each gets a `forceRefresh = false` parameter and an early-exit when the corresponding `showsXContent` getter is already true. Skip `fetchFilesByQuery` — it already has its own semantics (falls back to `fetchAllFiles` when `searchCriteriaList` is empty, re-runs otherwise).

- [x] 3. **`src/frontend/stores/FileStore.ts` — dev-build content-mode assertion in `refetch`.** Wrap the branch dispatch with a pre/post content check that logs a warning if they differ. Reference the `IS_DEV` constant (imported in `renderer.tsx`; may need an import here):

  ```ts
  @action.bound async refetch(): Promise<void> {
    const contentBefore = this.content;

    let result: Promise<void> | undefined;
    if (this.showsAllContent) {
      result = this.fetchAllFiles(true);
    } else if (this.showsUntaggedContent) {
      result = this.fetchUntaggedFiles(true);
    } else if (this.showsQueryContent) {
      result = this.fetchFilesByQuery();
    } else if (this.showsMissingContent) {
      result = this.fetchMissingFiles(true);
    } else if (this.showsDuplicatesContent) {
      result = this.fetchDuplicatesFiles(true);
    }

    if (result !== undefined && IS_DEV) {
      result.then(() => {
        if (this.content !== contentBefore) {
          console.warn(
            '[INV-007 regression] refetch() changed content mode from',
            contentBefore,
            'to',
            this.content,
            '— some async side-effect is clobbering the user-visible filter.',
          );
        }
      });
    }

    return result;
  }
  ```

  `IS_DEV` is already available from `common/config` or `process.env.NODE_ENV`. Check neighbouring imports for the existing pattern.

  Only warn in dev builds — production users should not see diagnostic console spam. The `IS_DEV` check also avoids the minor cost of the `.then()` attachment in production.

- [x] 4. **Verify compilation.** Run `yarn build`. Expect no TypeScript errors.

- [x] 5. **Verify tests.** Run `yarn test`. Expect no failures. The new `forceRefresh` parameter is optional and default-compatible. NOTE: Implementation uses private `_fetchXxxFilesForced()` helper methods instead of `forceRefresh` parameter to avoid React event handler type incompatibility. Same behavioral outcome.

- [ ] 6. **Interactive smoke test — no-op re-click.** DISPLAY REQUIRED. Deferred to TASK-037 formal QA pass.

  1. Launch and wait for gallery to settle in All mode.
  2. Click Untagged. Gallery refreshes.
  3. Click Untagged again (and again). Gallery does NOT re-render. Untagged selector stays pressed.
  4. Click All. Gallery refreshes (mode change).
  5. Click All again. Gallery does NOT re-render.
  6. **Expected:** no visible flicker on repeat clicks.

- [ ] 7. **Interactive smoke test — forced refresh path (order change).** DISPLAY REQUIRED. Deferred to TASK-037 formal QA pass.

  1. In Untagged mode, change the file ordering from the Content View toolbar (e.g. date-added-desc → filename-asc).
  2. The gallery should re-render in the new order. (The order-change path calls `this.refetch()` which passes `forceRefresh=true`, bypassing the no-op guard.)
  3. **Expected:** gallery re-renders with new order, still in Untagged mode.

- [ ] 8. **Dev-build regression assertion smoke test.** DISPLAY REQUIRED. Deferred to TASK-037 formal QA pass.

  1. Run `yarn dev` (webpack watch mode) in one terminal and `yarn start` (Electron, NODE_ENV=development) in another.
  2. Open the DevTools console.
  3. Click Untagged, wait for gallery. Then trigger a refetch (e.g. drop a new file into a watched folder).
  4. **Expected:** no `[INV-007 regression]` warning in console — content mode preserved.
  5. To manually verify the assertion fires on a real regression, temporarily revert TASK-034's changes (restore `clearSearchCriteriaList` call in `fetchUntaggedFiles`). Re-run step 3.
  6. **Expected with revert:** `[INV-007 regression]` warning appears in console when the refetch flips content to All.
  7. Restore TASK-034's fix before committing.

- [x] 9. Commit with a message like "Add no-op guard and dev-build content-mode assertion for INV-007". (Committed as part of TASK-034/035/036 combined commit)

## Done When

- [x] `fetchUntaggedFiles`, `fetchAllFiles`, `fetchMissingFiles`, `fetchDuplicatesFiles` all have early-exit no-op guards when already in target content mode. Implemented via private `_fetchXxxFilesForced()` helpers called by `refetch()` to avoid React event handler type incompatibility with a boolean parameter.
- [x] `refetch()` routes to `_fetchXxxFilesForced()` helpers that bypass the no-op guard.
- [x] `refetch()` attaches a dev-only `.then()` that warns when content mode changes across the call.
- [x] `yarn build` succeeds with zero TypeScript errors.
- [x] `yarn test` passes. Pre-existing TagStore failure is unrelated.
- [ ] Interactive test in step 6 passes: repeated clicks of the same selector do not re-render. Verified by DISPLAY. (Pending TASK-037 QA)
- [ ] Interactive test in step 7 passes: order changes still force a refresh. Verified by DISPLAY. (Pending TASK-037 QA)
- [ ] Interactive test in step 8 passes: dev-build warning does NOT fire in the happy path; DOES fire when TASK-034 is temporarily reverted (confirmed and reverted back before commit). Verified by DISPLAY. (Pending TASK-037 QA)
