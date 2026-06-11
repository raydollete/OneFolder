---
title: Video Only — Persistent Display Filter
author: @system
last_updated: 2026-06-11
scope: feature
aliases: ["video-only", "showVideosOnly"]
---

# Video Only — Persistent Display Filter

This document describes the **"Video Only"** display filter: what it does, how it is stored, and how it is implemented inside `FileStore`. It follows the same post-fetch filter pattern as the hide-missing-files preference (`docs/missing-files.md`).

---

## Overview

When **Video Only** is enabled, the gallery is restricted to files whose extension is a recognized video format (`mp4`, `webm`, `ogg`). All other files are hidden from the gallery view.

- **Default state:** unchecked (`false`) — all media types are shown.
- **Scope:** per-library, persisted across restarts like every other UI preference.
- **UI control:** a `Checkbox` labeled "Video Only" sits to the right of the tag search input in the Search toolbar (`src/frontend/containers/AppToolbar/Searchbar.tsx`). It is rendered at the `Searchbar` level — a sibling of `QuickSearchList` / `CriteriaList` — so it remains visible even when the search is in criteria mode and the `TagSelector` is not rendered.

---

## What It Is Not

This filter is **not a search criterion**. It does not inject a synthetic `extension` entry into `uiStore.searchCriteriaList`, does not appear as a removable search chip, and does not interact with the AND/OR semantics of `searchMatchAny`. Implementing it as a search criterion would pollute the visible chip list and conflict with the quick-search detection logic (which requires all criteria to be tags). See [INV-017](TODO/backlog/investigations/INV-017_MEDIUM_FRONTEND_video-only-filter-toggle-in-searchbar.md) for the full analysis.

---

## Persistence

The preference is stored in `UiStore` alongside every other per-library display preference:

| Site | Detail |
| ---- | ------ |
| Observable | `@observable showVideosOnly: boolean = false` (near `hideMissingFilesInBrowsing`) |
| Setter / toggle | `setShowVideosOnly(value)` and `toggleShowVideosOnly()` in `UiStore` |
| Persistence union | `PersistentPreferenceFields` includes `'showVideosOnly'` |
| Save | `getPersistentPreferences()` writes `showVideosOnly: this.showVideosOnly` |
| Restore | `recoverPersistentPreferences()` reads `Boolean(prefs.showVideosOnly ?? false)` |

The localStorage key is derived from the library's `storageKeyPrefix`, so the preference is isolated per library.

---

## Filter Implementation

The filter is applied inside `FileStore.updateFromBackend` (`src/frontend/stores/FileStore.ts`), the single convergence point for every non-Missing fetcher.

### Post-fetch splice

After the broken-file splice (the hide-missing-files pass), a second optional splice filters for video files:

```
const showVideosOnly = this.rootStore.uiStore.showVideosOnly && !this.showsMissingContent;
if (showVideosOnly) {
  const visible = newClientFiles.filter(
    (f) => isFileExtensionVideo(f.extension) && !(shouldHide && f.isBroken),
  );
  this.fileList.clear();
  // … push visible into fileList …
}
```

Key points:

- **Extension test:** `isFileExtensionVideo(f.extension)` from `common/fs.ts` — the single authoritative list of video extensions (`mp4 | webm | ogg`). Hard-coding extensions inline is explicitly avoided so future format additions are picked up automatically.
- **Missing-files view guard:** `!this.showsMissingContent` prevents the splice from running against `fetchMissingFiles`, which must always show broken files regardless of display filters.
- **Composing with broken-file splice:** The two display filters compose via a combined predicate on `newClientFiles` (the full pre-splice array), so a file must pass *both* filters when both are active. The net result is: broken files removed (if `hideMissingFilesInBrowsing` is on) AND non-video files removed (if `showVideosOnly` is on).
- **`cleanFileSelection()` runs after the splice** so previously selected non-video files are dropped from `uiStore.fileSelection`.
- **Generation guard:** The splice lives inside the existing `if (gen !== this.fetchGeneration) return;` transaction from INV-009, so no stale fetch can apply the filter to the wrong result set.

### Count semantics

`updateFileListState()` sets `numTotalFiles = fileList.length` in All-content mode. After a video-only splice, `fileList` is smaller than the true library size. To keep the "All Images" toolbar badge accurate, the implementation overrides `this.numTotalFiles` with the pre-splice fetched count immediately after calling `updateFileListState()`:

```
if (this.showsAllContent && ((shouldHide && brokenCount > 0) || showVideosOnly)) {
  this.numTotalFiles = newClientFiles.length;
}
```

This matches the behavior of the broken-file splice override. Tradeoff: the "All Images" badge may read higher than the visible gallery count when the filter is active. This is the established convention in this codebase and avoids a confusing shrinking badge.

---

## Runtime Reaction

A MobX `reaction` registered in `FileStore.watchUiPreferences` watches `uiStore.showVideosOnly` and calls `this.refetch()` when it changes:

```
reaction(
  () => this.rootStore.uiStore.showVideosOnly,
  () => this.refetch(),
);
```

The `Searchbar` checkbox also calls `fileStore.refetch()` explicitly on change (matching the `SearchMatchButton` pattern), resulting in a harmless double-refetch on toggle with no visible side effects.

`watchUiPreferences` is called by `RootStore` after all stores are constructed, not in `FileStore`'s constructor. This is required because a constructor-time reaction throws on an undefined `uiStore` reference and is silently disabled forever. See the comment block above `watchUiPreferences` in `FileStore.ts` for details.

---

## Developer Notes

### Single filtering hook

Like the hide-missing-files filter, the entire video-only behavior is implemented at a single location: the post-fetch block inside `FileStore.updateFromBackend`. No per-component filter logic exists. All browsing fetchers (All, Untagged, Query, Duplicates, Calendar, List) converge on `updateFromBackend`, so the filter applies uniformly by construction.

### Future format additions

To add a new video extension, update `isFileExtensionVideo` in `common/fs.ts`. No changes to `FileStore`, `UiStore`, or the Searchbar are needed.

### Settings parity (out of scope)

Other display preferences (hide-missing, tag overlay) also expose a Settings toggle. A Settings mirror for `showVideosOnly` is intentionally out of scope for the initial implementation — the user-stated requirement was specifically a searchbar checkbox. A future task may add a Settings toggle if desired.

---

See also: [Missing Files](missing-files.md) — same post-fetch filter pattern.
