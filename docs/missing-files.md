---
title: Missing Files — Detection, Filtering, and Recovery
author: @system
last_updated: 2026-04-22
scope: feature
aliases: ["missing-files", "broken-thumbnails"]
---

# Missing Files — Detection, Filtering, and Recovery

This document explains what "missing files" means in OneFolder, how they are detected, how the `hideMissingFilesInBrowsing` preference controls their visibility in browsing views, and how to reach the dedicated recovery view.

---

## Overview

A file is **missing** (also called "broken") when its `FileDTO` record exists in the database but `absolutePath` no longer resolves to a real file on disk at the time OneFolder loads it into the gallery. This can happen when files are deleted, moved, or renamed outside of OneFolder — for example via the OS file manager, a terminal command, or an external backup restoration.

Missing files are not automatically removed from the database. OneFolder follows a conservative approach: it keeps the record so the user can diagnose and recover the situation (e.g. by re-linking the location or restoring the file from a backup) rather than silently discarding metadata.

---

## Detection Flow

Detection runs inside `FileStore.updateFromBackend` (`src/frontend/stores/FileStore.ts`), the single entry point that populates `fileList` for every non-"Missing" content mode (All Images, Untagged, Search/Query, Duplicates, Calendar, List).

The detection sequence is:

1. Backend files are fetched from the database and converted to `ClientFile` instances. At this point every file's `isBroken` state is `undefined`.
2. The new `ClientFile[]` array is pushed into the observable `fileList` so the gallery renders immediately without blocking on disk I/O.
3. An async batch of `fse.pathExists(file.absolutePath)` calls is dispatched — one per file. These run concurrently.
4. When the batch resolves, each file whose path does not exist on disk has `file.isBroken` set to `true` via `setBroken()`. Files that resolve successfully remain `isBroken === false`.
5. The post-existence-check filter pass then runs (see next section), and `numMissingFiles` is updated.

Because the existence check is asynchronous, there is a short window (~50–500 ms depending on disk speed) after initial render where a missing file may be momentarily visible before the filter removes it. This matches the pre-existing behavior where the broken-link overlay would "pop in" after tiles were already rendered.

---

## Behavior When `hideMissingFilesInBrowsing = true` (Default)

This is the default for all new installs and for existing libraries that upgrade (the key defaults to `true` when absent from stored preferences).

**Affected views** — All Images, Untagged, Search/Query results, Duplicates, Calendar, List:

- After the async existence-check batch resolves, any `ClientFile` with `isBroken === true` is spliced out of `fileList`.
- `cleanFileSelection()` runs after the splice so previously-selected broken files are dropped from `uiStore.fileSelection`.
- The gallery re-renders showing only present-on-disk files. No broken-link overlay is ever displayed.
- `numMissingFiles` is computed from the pre-filter count (before the splice) and stored explicitly, so the Outliner warning badge remains accurate even though `fileList` no longer contains the broken files.
- `numTotalFiles` reflects the full database count, not the filtered visible count, so the "All Images" toolbar number may exceed `fileList.length` when missing files exist. The Outliner warning badge accounts for this delta.

**Unaffected view** — the dedicated Missing Files recovery view:

- `FileStore.fetchMissingFiles` populates `fileList` with *only* broken files. This path is guarded by `!this.showsMissingContent` so the post-filter splice never runs against it.
- The recovery view always shows the complete set of missing files regardless of the toggle state.

---

## Behavior When `hideMissingFilesInBrowsing = false`

When a user disables the default by enabling the "Show missing files in gallery" toggle, the filter splice is skipped. Behavior matches the pre-feature baseline:

- `GalleryItem.tsx` (`src/frontend/containers/ContentView/GalleryItem.tsx`) renders a desaturated, dimmed thumbnail with an `IconSet.WARNING_BROKEN_LINK` overlay icon for each `file.isBroken === true` tile.
- `CalendarGallery.tsx` (`src/frontend/containers/ContentView/CalendarGallery.tsx`) applies the same `thumbnail-broken` treatment in Calendar view.
- Clicking the overlay icon in either view navigates to the Missing Files recovery view.
- Right-clicking a broken tile shows `MissingFileMenuItems` (no "Open External" or "Reveal in Finder" — those are disabled for broken files).

---

## Accessing the Toggle

The preference is exposed in the Settings popup:

**Settings → Appearance → Thumbnail → "Show missing files in gallery"**

Open Settings via the `...` menu in the top toolbar (or `SecondaryCommands`). Navigate to the **Appearance** tab. Under the **Thumbnail** section the toggle appears after the resolution-overlay toggle. Its label uses an **inverted semantic**: the toggle is *off* by default (files are hidden by default). Enabling the toggle ("Show missing files in gallery" = on) sets `hideMissingFilesInBrowsing = false` and immediately triggers `fileStore.refetch()` so the gallery updates without requiring an app restart.

A helper line below the toggle reads: "When off, files that can no longer be found on disk are excluded from browsing views. They remain accessible via the warning badge in the left panel."

The preference is **per-library** — it is stored under each library's `storageKeyPrefix` via `UiStore.getPersistentPreferences` / `UiStore.recoverPersistentPreferences`. Switching libraries restores that library's saved value.

---

## Reaching the Missing Files Recovery View

The primary discovery path for missing files is the **Outliner warning badge** in the Tags Panel (left sidebar, `src/frontend/containers/Outliner/TagsPanel/index.tsx`).

When `fileStore.numMissingFiles > 0`, a warning toolbar button with the missing-file count as its badge is displayed at the top of the Tags Panel. Clicking it navigates to the dedicated Missing Files content mode (`Content.Missing`), which shows *only* broken files — populated by `FileStore.fetchMissingFiles`.

This badge and the Missing Files view are **always available regardless of the toggle state**. A user who has never changed the toggle (default: files hidden from gallery) still sees the badge count and can still navigate to the recovery view.

---

## Developer Notes

### Single filtering hook

The entire hide-on-default behavior is implemented at a single location: the post-existence-check block inside `FileStore.updateFromBackend`. There is no per-component filter logic. This means the filtering applies uniformly to all browsing fetchers (All, Untagged, Query, Duplicates, Calendar, List) by construction — they all converge on `updateFromBackend`.

### Guard for the Missing view

The filter splice is conditioned on `!this.showsMissingContent` (where `showsMissingContent` is `this.content === Content.Missing`). This prevents the filter from running against `fetchMissingFiles`, which must show broken files.

### `numMissingFiles` after the splice

`updateFileListState()` derives `numMissingFiles` from `fileList` directly. After the splice, `fileList` contains no broken files, so the derived count would be 0. The implementation overrides `this.numMissingFiles` with the pre-filter broken count immediately after calling `updateFileListState()`, ensuring the Outliner badge remains accurate.

### Runtime toggle reaction

A MobX `reaction` in `FileStore`'s constructor watches `uiStore.hideMissingFilesInBrowsing` and calls `this.refetch()` when it changes. The Settings toggle also calls `fileStore.refetch()` explicitly for immediate feedback. The result is a harmless double-refetch on toggle — one from the explicit call and one from the reaction — with no visible side effects.

### `numTotalFiles` preservation

`updateFileListState()` also sets `numTotalFiles = fileList.length` when the content mode is All Images. After the filter splice, `fileList` is smaller than the database total. The implementation overrides `this.numTotalFiles` with the pre-splice total after calling `updateFileListState()`, so the toolbar file count always reflects the database total rather than the filtered visible count.
