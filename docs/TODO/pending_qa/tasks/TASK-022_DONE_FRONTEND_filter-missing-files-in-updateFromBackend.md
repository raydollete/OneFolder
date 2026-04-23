---
id: TASK-022
title: 'Filter missing files out of fileList after existence check in FileStore'
investigation: INV-004
status: done
priority: medium
blocked_by: [TASK-021]
date_created: 2026-04-22
date_completed: 2026-04-22
files:
  - src/frontend/stores/FileStore.ts
---

## What

Modify `FileStore.updateFromBackend` so that, after the async `fse.pathExists` existence-check batch resolves, broken files are spliced out of `this.fileList` when `uiStore.hideMissingFilesInBrowsing === true` AND the current content mode is NOT `Content.Missing`. Ensure `numMissingFiles` is still counted correctly before the splice so the Outliner warning badge remains accurate.

## Why

This is the single hook point where broken files enter `fileList` for every non-Missing content mode (All / Untagged / Query / Duplicates / Calendar / List). Filtering here gives us uniform behavior across every gallery renderer without touching each component. The hidden-tag filter at lines 916-921 proves this filtering layer is the right place.

See [INV-004](../investigations/INV-004_MEDIUM_FRONTEND_hide-missing-files-by-default.md) — root cause and blast radius sections describe the exact mechanics.

## Implementation Steps

- [x] 1. Open `src/frontend/stores/FileStore.ts` and locate `updateFromBackend` (line 909-966).

- [x] 2. Refactor the post-existence-check `.then()` block (lines 958-965) so that after `promiseAllLimit` resolves:

  a. Count broken files in `newClientFiles` (or `this.fileList` — they refer to the same ClientFile objects at this point) to derive `numMissingFiles`.

  b. If `this.rootStore.uiStore.hideMissingFilesInBrowsing === true` AND `!this.showsMissingContent`, replace `this.fileList` with only the non-broken files. Wrap in `transaction()` per the existing pattern (line 947).

  c. After the splice, re-run `cleanFileSelection()` so `uiStore.fileSelection` drops any broken files the user previously selected.

  d. Update the index map and `fileListLastModified` (mirroring the pattern in `fetchMissingFiles` at lines 742-752).

  e. Set `this.numMissingFiles` directly to the count from step (a). Do NOT rely on `updateFileListState()` alone, because after the splice `fileList` no longer contains broken files and the counter would read zero.

  Proposed structure:
  ```ts
  const N = 50;
  return promiseAllLimit(existenceCheckPromises, N)
    .then(() => {
      transaction(() => {
        // Count broken files BEFORE filtering so the Outliner badge stays accurate.
        const brokenCount = newClientFiles.reduce(
          (n, f) => n + (f.isBroken ? 1 : 0),
          0,
        );
        this.numMissingFiles = brokenCount;

        const shouldHide =
          this.rootStore.uiStore.hideMissingFilesInBrowsing &&
          !this.showsMissingContent;

        if (shouldHide && brokenCount > 0) {
          const visible = newClientFiles.filter((f) => !f.isBroken);
          this.fileList.clear();
          this.fileList.push(...visible);
          this.cleanFileSelection();
          this.fileListLastModified = new Date();
        }

        // Rebuild counters from whatever fileList looks like now.
        this.updateFileListState();
        // updateFileListState overwrites numMissingFiles from the current fileList,
        // so restore the pre-filter count explicitly.
        this.numMissingFiles = brokenCount;
      });
    })
    .catch((e) => console.error('An error occurred during existence checking!', e));
  ```

- [x] 3. Audit `updateFileListState()` (lines 1026-1047). Confirm that writing `this.numMissingFiles = brokenCount` AFTER calling `updateFileListState()` correctly overrides the `numMissingFiles = missingFiles` line inside that method. If the ordering is confusing, refactor `updateFileListState()` to accept an optional `overrideMissing?: number` parameter and thread the value through.

- [x] 4. Leave `fetchMissingFiles` (lines 705-766) completely untouched. That path explicitly builds a broken-only `fileList` and must continue to work. Verify by inspection that `this.setContentMissing()` runs at line 714 before the splice logic, so when any future call to `updateFromBackend` occurs while in Missing mode, the `!this.showsMissingContent` guard prevents the filter from firing.

- [x] 5. Confirm that `fetchDuplicatesFiles` (lines 790-800) — which goes through `updateFromBackend` — correctly omits broken files from the list. Duplicate-detection logic in `DuplicateGallery.tsx` operates on `fileList` and will naturally skip them.

- [x] 6. Run `yarn lint`. Manually test:
  - Populate a library, delete a few files from disk outside of OneFolder, launch the app.
  - Verify broken tiles do NOT appear in All Images view.
  - Verify the Outliner warning badge shows the correct missing count.
  - Click the badge; verify the Missing Files recovery view shows the broken files.
  - Search for a string that matches both a broken and a non-broken file; verify only the non-broken file appears in the Query view.
  - Switch to Calendar view; verify broken tiles are absent.

## Done When

- [ ] With `uiStore.hideMissingFilesInBrowsing === true` (the default), broken files never appear in any non-Missing gallery view (All / Untagged / Query / Duplicates / Calendar / List).
- [ ] `fileStore.numMissingFiles` reflects the true count of broken files in the query result regardless of whether they are visible in `fileList`.
- [ ] The Outliner warning badge displays the correct count and navigates to the Missing recovery view on click.
- [ ] `fetchMissingFiles` is unaffected — the Missing recovery view still shows broken files.
- [ ] When `hideMissingFilesInBrowsing === false` (user opt-in, via TASK-023), broken files DO appear inline with the existing desaturated-thumbnail + warning-overlay treatment.
- [ ] `uiStore.fileSelection` drops broken files after the splice (no stale references).
- [ ] `yarn lint` and `yarn test` pass.
