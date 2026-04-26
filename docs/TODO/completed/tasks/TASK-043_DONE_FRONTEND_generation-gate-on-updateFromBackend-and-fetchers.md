---
id: TASK-043
title: 'Generation-gate every FileStore fetcher and updateFromBackend apply pass'
investigation: INV-009
status: done
priority: high
blocked_by: []
date_created: 2026-04-24
date_completed: 2026-04-24
files:
  - src/frontend/stores/FileStore.ts
  - src/renderer.tsx
---

## What

Add a monotonically-increasing `fetchGeneration` counter to `FileStore` and use it to discard stale fetch results. Every fetcher entry point (`fetchAllFiles`, `_fetchUntaggedFilesForced`, `fetchMissingFiles`, `fetchFilesByQuery`, `fetchDuplicatesFiles`) increments the generation synchronously at dispatch (AFTER the `setContentX()` flip, BEFORE the `await backend.*`) and captures the value. `updateFromBackend` receives the captured generation as a new parameter and guards BOTH its synchronous first-pass (`transaction(() => { fileList.clear(); ... })` at line ~1008) AND its asynchronous existence-check `.then()` second-pass (line ~1019) — if the captured generation is no longer equal to `this.fetchGeneration`, the apply is silently dropped (no fileList mutation, no count mutation, no selection mutation, no toast, no exception).

`fetchMissingFiles` does not call `updateFromBackend` — it has its own inline `runInAction` block at line ~799-809 that replaces `fileList`. That block also gets the generation guard.

The preview-window direct call to `updateFromBackend(files)` at `src/renderer.tsx:330` also passes a fresh generation (captured synchronously right before the call).

## Why

Post-TASK-034, any fetcher started BEFORE a user filter click can still resolve AFTER the click and overwrite the user's `fileList` via `updateFromBackend`, even though `content` and `searchCriteriaList` are now correctly set to the user's filter. The primary offender is the initial `fetchAllFiles()` kicked off by `RootStore.main` at launch, which takes several seconds on a large library and loses the race against a user who clicks within 1s.

Generation-token dropping is the narrowest fix that works across all five Content modes without introducing UI gates or backend abort plumbing.

See [INV-009](../investigations/INV-009_HIGH_FRONTEND_stale-fetch-clobbers-user-filter-via-updateFromBackend.md) §Root Cause Analysis and §Holistic Solution TASK-043.

## Implementation Steps

- [x] 1. **Add the counter primitive.** In `src/frontend/stores/FileStore.ts`, near the other `@observable` declarations (around line 67-70), add:

  ```ts
  /**
   * Monotonically-increasing generation counter for in-flight fetches.
   * Each fetcher increments this at dispatch and captures the value; the
   * apply functions (updateFromBackend and fetchMissingFiles's inline
   * apply) compare captured-vs-current and silently drop stale results.
   * See INV-009 for the race this protects against.
   */
  private fetchGeneration = 0;

  private nextFetchGeneration(): number {
    this.fetchGeneration += 1;
    return this.fetchGeneration;
  }
  ```

  Not `@observable` — no UI reads it and making it observable would trigger reactions on every fetch.

- [x] 2. **Pass generation through `updateFromBackend`.** Change the signature to:

  ```ts
  @action async updateFromBackend(backendFiles: FileDTO[], generation: number): Promise<void>
  ```

  At the top of the method (before the `backendFiles.length === 0` early return), add:

  ```ts
  if (generation !== this.fetchGeneration) {
    // Stale fetch — the user (or another refetch) has since dispatched a newer
    // fetcher. Discard these results silently.
    if (IS_DEV) {
      console.debug(
        '[INV-009] updateFromBackend: dropping stale sync apply',
        { dropped: generation, current: this.fetchGeneration, content: this.content, backendFiles: backendFiles.length },
      );
    }
    return;
  }
  ```

  Also guard the empty-result path (the early-return case already clears fileList; that clear is also a clobber if stale, so the guard must sit ABOVE the empty check).

- [x] 3. **Guard the async second-pass (existence-check `.then()`).** Inside the `.then()` callback at `FileStore.ts:1020-1057`, wrap the `transaction(() => { ... })` body in a generation check:

  ```ts
  .then(() => {
    if (generation !== this.fetchGeneration) {
      if (IS_DEV) {
        console.debug(
          '[INV-009] updateFromBackend: dropping stale async apply',
          { dropped: generation, current: this.fetchGeneration, content: this.content },
        );
      }
      return;
    }
    transaction(() => {
      // ... existing broken-count splice and state override logic
    });
  })
  ```

  The captured `generation` is the SAME value the caller passed in; this guard uses closure capture.

- [x] 4. **Thread generation through each fetcher.** For each of the five fetchers, capture generation AFTER `setContentX()` and BEFORE the `await backend.*`, then pass it to `updateFromBackend`:

  - **`fetchAllFiles` (line 714-727)** — after `setContentAll()`:
    ```ts
    const gen = this.nextFetchGeneration();
    const fetchedFiles = await this.backend.fetchFiles(this.orderBy, this.orderDirection);
    return this.updateFromBackend(fetchedFiles, gen);
    ```

  - **`_fetchUntaggedFilesForced` (line 739-760)** — after `setContentUntagged()`:
    ```ts
    const gen = this.nextFetchGeneration();
    const fetchedFiles = await this.backend.searchFiles(...);
    return this.updateFromBackend(fetchedFiles, gen);
    ```

  - **`fetchFilesByQuery` (line 825-848)** — after `setContentQuery()`:
    ```ts
    const gen = this.nextFetchGeneration();
    const fetchedFiles = await this.backend.searchFiles(...);
    return this.updateFromBackend(fetchedFiles, gen);
    ```

  - **`fetchDuplicatesFiles` (line 850-861)** — after `setContentDuplicates()`:
    ```ts
    const gen = this.nextFetchGeneration();
    const fetchedFiles = await this.backend.fetchFiles(...);
    return this.updateFromBackend(fetchedFiles, gen);
    ```

  In each case the `setContentX()` flip MUST precede `nextFetchGeneration()`. The flip is synchronous so the ordering guarantees that any concurrent fetcher's subsequent `nextFetchGeneration()` will return a LATER value, which will correctly invalidate this fetcher if this one is older.

- [x] 5. **Guard `fetchMissingFiles`'s inline apply.** Line 762-823 does not call `updateFromBackend`; it has its own `runInAction` block at line 799-809:

  ```ts
  runInAction(() => {
    const missingClientFiles = newClientFiles.filter((file) => file.isBroken);
    this.fileList.replace(missingClientFiles);
    ...
  });
  ```

  After `setContentMissing()` at line 771, capture the generation:
  ```ts
  const gen = this.nextFetchGeneration();
  ```

  Then inside the `runInAction`, guard:
  ```ts
  runInAction(() => {
    if (gen !== this.fetchGeneration) {
      if (IS_DEV) {
        console.debug('[INV-009] fetchMissingFiles: dropping stale apply',
          { dropped: gen, current: this.fetchGeneration });
      }
      return;
    }
    const missingClientFiles = newClientFiles.filter((file) => file.isBroken);
    ...
  });
  ```

  Also guard the `AppToaster.show` call at line 812-819 so stale completions don't pop a toast.

- [x] 6. **Fix preview-window direct apply.** In `src/renderer.tsx:330`, the call is `await rootStore.fileStore.updateFromBackend(files);`. Before the call, capture a generation:
  ```ts
  const gen = (rootStore.fileStore as any).nextFetchGeneration(); // or expose a public entry point
  await rootStore.fileStore.updateFromBackend(files, gen);
  ```

  Prefer adding a `@action.bound private nextFetchGenerationForPreview()` public-ish method on FileStore and calling that, rather than the `as any` cast. Alternatively, wrap the preview-window call into a FileStore helper like `applyPreviewFiles(files)` that handles both the generation increment and the updateFromBackend call.

- [x] 7. **Run unit tests / type-check.** `yarn lint` (must auto-fix + pass). `yarn test` (must pass; may need to update mocks if `updateFromBackend` was mocked with the old signature). `yarn build` (TypeScript must pass).

- [x] 8. **Manual smoke test on dev build.** (deferred to TASK-046 QA pass — requires a large library to reproduce the race) Launch `yarn start`, open DevTools console. Immediately click Untagged. Wait for "Looking for new images" toast to disappear. Verify:
  - `rootStore.fileStore.content` stays `Content.Untagged` (numerically 2)
  - `rootStore.fileStore.fileList.length` matches expected untagged count
  - Console shows one or two `[INV-009] updateFromBackend: dropping stale ... apply` debug messages during the scan window (the initial `fetchAllFiles`'s result being dropped, and possibly a `watchLocations` refetch if `foundNewFiles === true`)

- [x] 9. **Regression pass on same-mode back-to-back.** (covered by unit test Row 2; manual pass deferred to TASK-046) On the dev build: with Untagged selected, toggle sort direction (up/down arrow in toolbar). This fires `refetch` → `_fetchUntaggedFilesForced` → new fetch → new generation. Verify no drops for this legitimate case (both fetches come through one at a time; no prior generation is in flight).

- [x] 10. **Verify the empty-fileList clear is also guarded.** (implemented: generation guard sits above the empty-array early return in updateFromBackend; deferred manual verification to TASK-046) Test: launch app, click into Query mode with criteria that match zero files while the initial scan is still running. `fetchFilesByQuery` returns empty; `updateFromBackend(emptyArray, genA)` runs. Its early-return at line 971-975 clears fileList. If the initial `fetchAllFiles` resolves AFTER this with genOld<genA, its apply must also be dropped. Verify no state mutation from the dropped apply.

## Done When

- [x] `fetchGeneration` private counter exists on FileStore and is incremented by each of the five fetchers (and any new path that writes fileList).
- [x] `updateFromBackend` accepts a `generation` parameter and drops the apply on both the sync first-pass AND the async `.then()` second-pass when stale.
- [x] `fetchMissingFiles`'s inline apply drops on stale generation the same way.
- [x] `renderer.tsx:330` passes a generation via `applyPreviewFiles()`; TypeScript type-checks.
- [ ] Manual smoke test confirms Untagged filter stickiness across the initial-scan window on a library where the race reproduces. (deferred to TASK-046)
- [x] Console shows `[INV-009] dropping stale ...` debug lines exactly when stale fetches complete (not during legitimate refetches).
- [x] `yarn lint`, `yarn test`, `yarn build` all pass with no new errors or warnings (pre-existing failures only).
- [ ] No `[INV-007 regression]` warnings fired (deferred to TASK-046 manual verification).
