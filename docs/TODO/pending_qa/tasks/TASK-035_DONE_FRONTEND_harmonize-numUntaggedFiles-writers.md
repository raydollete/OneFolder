---
id: TASK-035
title: 'Harmonize numUntaggedFiles writers so sidebar count matches gallery'
investigation: INV-007
status: DONE
priority: high
blocked_by: [TASK-034]
date_created: 2026-04-23
date_completed: 2026-04-23
files:
  - 'src/frontend/stores/FileStore.ts'
  - 'docs/missing-files.md'
---

## What

Make `fileStore.numUntaggedFiles` consistently mean "count of untagged files the user will actually see in the gallery" — i.e. the count AFTER the post-existence-check missing-file splice, when `uiStore.hideMissingFilesInBrowsing === true`.

Today `numUntaggedFiles` is written by three independent paths that disagree when a non-zero number of DB files are missing from disk:

1. `refetchFileCounts()` writes the raw DB count (`SELECT COUNT(*) ... WHERE NOT EXISTS file_tags`) — **includes missing files**.
2. `updateFileListState()` pre-splice pass writes the count from `fileList` before broken files are identified as broken — effectively includes missing files.
3. `updateFileListState()` post-splice pass writes the count from `fileList` AFTER broken files are spliced out — excludes missing files.

The sidebar "Untagged (N)" displays whichever writer ran most recently, producing the user-visible 5161 → 998 count mismatch reported in INV-007.

Fix: **`refetchFileCounts()` stops writing `numUntaggedFiles`.** `updateFileListState()`'s post-splice pass becomes the single source of truth. `refetchFileCounts()` continues to write `numTotalFiles` (that's the raw-DB-total "All Images" badge, which is correctly authoritative).

## Why

See [INV-007](../investigations/INV-007_HIGH_FRONTEND_untagged-selector-count-mismatch-and-filter-clobber.md) §Defect A for the full diagnosis. User-visible symptom #1: "the count displayed next to Untagged when nothing is selected (5161) does not match the count shown after clicking it (998)". The two numbers come from writers 1/2 (pre-click) and writer 3 (post-click); both are arithmetically "correct" for different definitions of "untagged", but the sidebar can only display one number at a time and the two writers have no ordering contract. Whichever wins, the user gets a jarring discontinuity.

The symmetric bug on `numTotalFiles` was caught and fixed during TASK-024 QA (BUG-1) by adding a post-splice override. That fix was not extended to `numUntaggedFiles`, presumably because there was no explicit QA step that cross-checked the Untagged sidebar number against the gallery count. This task closes that gap.

Blocked by TASK-034 because the filter-clobber bug would keep the user out of Untagged mode long enough to observe the count behavior; fix the stickiness first, then the count consistency.

## Implementation Steps

- [x] 1. **`src/frontend/stores/FileStore.ts` (`refetchFileCounts`, currently line 1097-1103)** — Remove the write to `this.numUntaggedFiles`. Change:

  ```ts
  async refetchFileCounts(): Promise<void> {
    const [numTotalFiles, numUntaggedFiles] = await this.backend.countFiles();
    runInAction(() => {
      this.numUntaggedFiles = numUntaggedFiles;
      this.numTotalFiles = numTotalFiles;
    });
  }
  ```

  to:

  ```ts
  async refetchFileCounts(): Promise<void> {
    // numTotalFiles = raw DB row count. This value intentionally disregards
    // the `hideMissingFilesInBrowsing` preference — it is the "All Images"
    // toolbar badge which always shows the DB total (see docs/missing-files.md).
    //
    // numUntaggedFiles is NOT written here. It is derived from fileList
    // by updateFileListState()'s post-splice pass in updateFromBackend(),
    // which is the only writer aware of `hideMissingFilesInBrowsing`.
    // Writing a raw DB count here would overwrite the post-splice value
    // and produce the sidebar/gallery count mismatch documented in INV-007.
    const [numTotalFiles, _rawDbUntagged] = await this.backend.countFiles();
    runInAction(() => {
      this.numTotalFiles = numTotalFiles;
    });
  }
  ```

  Keep the destructuring of `[numTotalFiles, _rawDbUntagged]` so the call signature of `backend.countFiles()` doesn't need to change. The underscore prefix signals intentional disuse.

- [x] 2. **`src/frontend/stores/FileStore.ts` (`updateFileListState`, currently line 1073-1094)** — Review the existing writer to confirm it is correct. Read carefully:

  ```ts
  @action updateFileListState(): void {
    let missingFiles = 0;
    let untaggedFiles = 0;
    this.index.clear();
    for (let index = 0; index < this.fileList.length; index++) {
      const file = this.fileList[index];
      if (file.isBroken) {
        missingFiles += 1;
      } else if (file.tags.size === 0) {
        untaggedFiles += 1;
      }
      this.index.set(file.id, index);
    }
    this.numMissingFiles = missingFiles;
    if (this.showsAllContent) {
      this.numTotalFiles = this.fileList.length;
      this.numUntaggedFiles = untaggedFiles;
    } else if (this.showsUntaggedContent) {
      this.numUntaggedFiles = this.fileList.length;
    }
    // Don't set numUntaggedFiles for other content types to avoid race conditions
  }
  ```

  **This is correct** when called from `updateFromBackend`'s post-splice pass (line 995 in the `.then()` callback). At that point `fileList` contains only non-broken files, so both `showsAllContent` (untaggedFiles counted in the visible set) and `showsUntaggedContent` (fileList.length is the visible untagged count) branches produce the correct "visible untagged count".

  **No change needed to the function body.** Add an inline comment explaining the invariant:

  ```ts
  // Invariant: this function is the SOLE writer of numUntaggedFiles.
  // When called from updateFromBackend's post-splice pass with
  // hideMissingFilesInBrowsing=true, fileList contains only non-broken
  // files, so the count reflects what the gallery will actually render.
  // refetchFileCounts() intentionally does NOT write numUntaggedFiles
  // to avoid overwriting this with the raw DB count. See INV-007.
  ```

- [x] 3. **`src/frontend/stores/FileStore.ts` — audit `incrementNumUntaggedFiles` / `decrementNumUntaggedFiles` / `resetFileCounts`** (lines 817-838).

  - `incrementNumUntaggedFiles` — called from `ClientFile` when a file's last tag is removed (grep `incrementNumUntaggedFiles` across `src/`). Keeps the observable incrementally accurate between `updateFromBackend` passes. **Leave as-is.**
  - `decrementNumUntaggedFiles` — called from `hideFile` (line 612) when a broken file with no tags is taken out of the visible set. Also called from `ClientFile` when a first tag is added. **Leave as-is.**
  - `resetFileCounts` — called from library teardown. Sets all three counters to 0. **Leave as-is.**

  These three methods are compatible with the "updateFileListState is the authoritative pass" model — they maintain the count between passes. Do not remove them.

  However: do **audit the callers** to ensure no caller is writing `numUntaggedFiles` directly (i.e. `this.numUntaggedFiles = someValue`) outside of `updateFileListState` and `refetchFileCounts` (which we are now removing). Grep:

  ```
  Grep for `numUntaggedFiles\s*=` in src/
  ```

  Expected matches: the observable declaration, the two `updateFileListState` branches, the incrementor and decrementor, `resetFileCounts`, and (before this task) `refetchFileCounts`. No other writers. If the grep returns additional writers, investigate and add them to this task.

- [ ] 4. **Interactive smoke test — count parity in All mode.** DISPLAY REQUIRED. Deferred to TASK-037 formal QA pass.

  1. Launch fresh. App lands in All mode (assumes no persisted criteria).
  2. Wait for `updateFromBackend`'s existence-check to settle (~few seconds on large libraries).
  3. Observe the "Untagged (N)" count in the sidebar.
  4. Click Untagged. Count the visible gallery items (via Outliner "All Images" badge comparison, or by clicking the last visible tile to see its index).
  5. **Expected:** sidebar count matches gallery item count.
  6. **Before the fix:** sidebar count = 5161 (DB raw), gallery = 998 (post-splice).

- [ ] 5. **Interactive smoke test — count parity with hide-missing OFF.** DISPLAY REQUIRED. Deferred to TASK-037 formal QA pass.

  1. Open Settings → Appearance → uncheck "Hide missing images from browsing views" (or the equivalent `hideMissingFilesInBrowsing` toggle). The FileStore constructor's reaction (line 87-90) should trigger a refetch automatically.
  2. Wait for gallery refresh.
  3. Observe the "Untagged (N)" count in the sidebar.
  4. Click Untagged.
  5. **Expected:** sidebar count matches gallery item count. Both should now equal the raw DB untagged count (5161 in the reporter's library).

- [ ] 6. **Interactive smoke test — count stability across background refetches.** DISPLAY REQUIRED. Deferred to TASK-037 formal QA pass.

  1. In All mode, note the sidebar "Untagged (N)".
  2. Trigger a background refetch: e.g. add a new image to a watched folder (chokidar `add` → `LocationStore.addFile` → `debouncedRefetch`). Or toggle hide-missing and toggle it back.
  3. Watch the sidebar count during the refetch cycle.
  4. **Expected:** count stays at N the whole time (or transiently bumps to N+1 / N-1 if the added file is itself untagged, via the incrementor).
  5. **Before the fix:** the refetch could briefly set count to the raw DB total (e.g. jump to 5161) before the post-splice pass corrects it back.

- [ ] 7. **Verify no regression on `numTotalFiles`.** DISPLAY REQUIRED. Deferred to TASK-037 formal QA pass.

  1. With hide-missing ON, the "All Images" toolbar badge (TagsPanel/index.tsx line 97, shows `fileStore.numTotalFiles`) should still show the DB total, not the visible count.
  2. Example: DB has 50,000 files, 4,163 are missing on disk. Badge shows 50,000. Gallery in All mode shows ~45,837 tiles. **This is correct behavior** (see docs/missing-files.md line 48-49).
  3. Confirm by checking the badge number against `rootStore.fileStore.numTotalFiles` in the DevTools console.

- [ ] 8. **Verify no regression on `numMissingFiles`.** DISPLAY REQUIRED. Deferred to TASK-037 formal QA pass.

  1. The Missing toolbar badge (TagsPanel/index.tsx line 104-112, `fileStore.numMissingFiles`) should show the correct missing count. Example: 4,163. This value comes from `numMissingFiles = brokenCount` override in `updateFromBackend.then()` (line 1000) — unchanged by this task.

- [x] 9. **`docs/missing-files.md`** — Add a short section after the existing `numMissingFiles after the splice` / `numTotalFiles preservation` sections documenting the `numUntaggedFiles` invariant:

  ```markdown
  ### `numUntaggedFiles` single-writer invariant

  `updateFileListState()` (called from `updateFromBackend`'s post-splice pass) is the **single authoritative writer** of `numUntaggedFiles`. When `hideMissingFilesInBrowsing === true`, this writer runs after broken files have been spliced out of `fileList`, so the count reflects what the gallery will actually render.

  `refetchFileCounts()` intentionally does NOT write `numUntaggedFiles` — the raw DB count (`SELECT COUNT(*) ... WHERE NOT EXISTS file_tags`) includes missing files and would not match the rendered gallery. It only writes `numTotalFiles`, which is the DB-total "All Images" badge value.

  See [INV-007](TODO/backlog/investigations/INV-007_HIGH_FRONTEND_untagged-selector-count-mismatch-and-filter-clobber.md) for the bug this invariant prevents.
  ```

  Place it directly below the existing `numTotalFiles preservation` section (around line 113 of the current doc). Adjust the link path to be correct relative to `docs/missing-files.md`.

- [x] 10. **Verify compilation.** Run `yarn build`. Expect no TypeScript errors.

- [x] 11. **Verify tests.** Run `yarn test`. No new failures. Pre-existing TagStore test failure is unrelated.

- [x] 12. Commit with a message like "Make updateFileListState the sole writer of numUntaggedFiles (INV-007)". (Committed as part of TASK-034/035/036 combined commit)

## Done When

- [x] `src/frontend/stores/FileStore.ts` (`refetchFileCounts`) no longer writes `this.numUntaggedFiles`. It still writes `this.numTotalFiles`.
- [x] `src/frontend/stores/FileStore.ts` (`updateFileListState`) has an inline comment documenting its authoritative-writer status.
- [x] Grep confirms no writer outside of `updateFileListState`, `incrementNumUntaggedFiles`, `decrementNumUntaggedFiles`, and `resetFileCounts` touches `numUntaggedFiles`.
- [x] `yarn build` succeeds with zero TypeScript errors.
- [x] `yarn test` passes (or fails in a way that is addressed in this task's commit). Pre-existing TagStore failure is unrelated.
- [ ] Interactive test in step 4 passes: sidebar Untagged count matches gallery count in All mode with hide-missing ON. Verified by DISPLAY. (Pending TASK-037 QA)
- [ ] Interactive test in step 5 passes: sidebar Untagged count matches gallery count with hide-missing OFF. Verified by DISPLAY. (Pending TASK-037 QA)
- [ ] Interactive test in step 6 passes: sidebar count is stable during background refetches. Verified by DISPLAY. (Pending TASK-037 QA)
- [ ] Step 7 confirms `numTotalFiles` still shows DB total in the "All Images" badge. No regression. (Pending TASK-037 QA)
- [ ] Step 8 confirms `numMissingFiles` still shows correct missing count. No regression. (Pending TASK-037 QA)
- [x] `docs/missing-files.md` has a new subsection documenting the single-writer invariant.
