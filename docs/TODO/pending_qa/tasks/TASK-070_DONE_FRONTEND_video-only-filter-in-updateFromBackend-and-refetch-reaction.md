---
id: TASK-070
title: 'Apply video-only post-fetch filter in FileStore and refetch on toggle'
investigation: INV-017
status: DONE
priority: medium
blocked_by: [TASK-069]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - src/frontend/stores/FileStore.ts
---

## What

In `FileStore`, (a) add a `reaction` on `uiStore.showVideosOnly` that calls `refetch()` so toggling the checkbox re-applies the filter immediately, and (b) add a post-fetch client-side splice in `updateFromBackend` that, when `showVideosOnly` is set, keeps only files where `isFileExtensionVideo(extension)` is true — composing correctly with the existing broken-file splice and preserving Outliner count accuracy.

## Why

"Video Only" is a display filter applied to backend results, identical in shape to the INV-004 hide-missing-files filter. It must live in the same generation-guarded `updateFromBackend` transaction so stale fetches never apply it to the wrong result set, and be driven by a `watchUiPreferences` reaction.

See [INV-017](../investigations/INV-017_MEDIUM_FRONTEND_video-only-filter-toggle-in-searchbar.md).

## Implementation Steps

- [x] 1. Add the import at the top of `src/frontend/stores/FileStore.ts`: `import { isFileExtensionVideo } from 'common/fs';` (confirm the existing import path style used in this file for `common/` modules).
- [x] 2. In `watchUiPreferences()` (lines ~129–136), add a second reaction beside the existing one:
  ```ts
  reaction(
    () => this.rootStore.uiStore.showVideosOnly,
    () => this.refetch(),
  );
  ```
  Keep it inside `watchUiPreferences` (RootStore-invoked) — do NOT move reactions into the constructor (see the doc comment at lines 120–128 explaining why constructor reactions silently break).
- [x] 3. In `updateFromBackend`, inside the `transaction(() => { ... })` block (lines ~1281–1316), after the existing broken-file splice and before `this.updateFileListState();`, add the video-only splice:
  ```ts
  const showVideosOnly = this.rootStore.uiStore.showVideosOnly && !this.showsMissingContent;
  const videoCount = newClientFiles.reduce(
    (n, f) => n + (isFileExtensionVideo(f.extension) ? 1 : 0),
    0,
  );
  if (showVideosOnly) {
    // Re-derive from newClientFiles (not the possibly-already-spliced fileList)
    // so the two display filters compose: keep files that are BOTH video and,
    // if hide-missing is on, not broken.
    const visible = newClientFiles.filter(
      (f) => isFileExtensionVideo(f.extension) && !(shouldHide && f.isBroken),
    );
    this.fileList.clear();
    this.fileList.push(...visible);
    this.cleanFileSelection();
    this.fileListLastModified = new Date();
  }
  ```
  Note: this references `shouldHide` from the existing broken-file block (already in scope in the same transaction). If `showVideosOnly` is set, this single filter supersedes the earlier broken-only splice by rebuilding from `newClientFiles`, so the two compose without double-filtering bugs.
- [x] 4. Preserve count accuracy: the existing block already overrides `numMissingFiles = brokenCount` and (in All-content mode) `numTotalFiles = newClientFiles.length` when `shouldHide && brokenCount > 0`. Extend the `numTotalFiles` override condition so it also fires when `showVideosOnly` causes a splice in All-content mode:
  ```ts
  if (this.showsAllContent && ((shouldHide && brokenCount > 0) || showVideosOnly)) {
    this.numTotalFiles = newClientFiles.length;
  }
  ```
  This keeps the Outliner "All Images" badge at the true library size rather than the filtered count.
- [x] 5. Ensure `this.updateFileListState();` still runs exactly once after the splices (it already does), so derived state is rebuilt from the final `fileList`.
- [x] 6. Run `yarn lint`, `yarn build`, and `yarn test` to confirm no type or test regressions.

## Done When

- [x] Toggling `showVideosOnly` triggers a refetch via the new reaction (no restart needed).
- [x] With `showVideosOnly` true, `fileList` contains only files passing `isFileExtensionVideo(extension)`.
- [x] With both `showVideosOnly` and `hideMissingFilesInBrowsing` true, `fileList` contains only non-broken video files.
- [x] The Missing-files content view (`showsMissingContent`) is unaffected by the video-only filter.
- [x] Outliner "All Images" count still reflects the unfiltered library size in All-content mode.
- [x] `cleanFileSelection()` runs so selected non-video files are dropped from selection after the splice.
- [x] `yarn build` and `yarn test` pass.
