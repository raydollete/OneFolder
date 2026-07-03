---
title: Media-Type Filter — Persistent Display Filter
author: @system
last_updated: 2026-07-03
scope: feature
aliases: ["video-only", "media-type-filter", "mediaTypeFilter", "images-only", "showVideosOnly"]
---

# Media-Type Filter — Persistent Display Filter

This document describes the **media-type filter**: a per-library display filter that
restricts the gallery to a chosen media type. It supersedes the original binary
"Video Only" checkbox (see history at the end).

---

## Overview

The Search toolbar hosts a dropdown with three mutually exclusive options:

| Option           | Value (`mediaTypeFilter`) | Effect                                              |
| ---------------- | ------------------------- | -------------------------------------------------- |
| Show All Media   | `'all'` (default)         | No filtering — every file is shown.                |
| Images Only      | `'images'`                | Hides recognized video files (shows everything else). |
| Video Only       | `'video'`                 | Shows only recognized video files (`mp4`, `webm`, `ogg`). |

- **Default state:** `'all'` — all media types are shown.
- **Scope:** per-library, persisted across restarts like every other UI preference.
- **UI control:** a native `<select className="media-type-filter">` sits to the right of
  the tag search input in the Search toolbar
  (`src/frontend/containers/AppToolbar/Searchbar.tsx`). It is rendered at the `Searchbar`
  level — a sibling of `QuickSearchList` / `CriteriaList` — so it remains visible even when
  the search is in criteria mode and the `TagSelector` is not rendered.

---

## What It Is Not

This filter is **not a search criterion**. It does not inject a synthetic `extension` entry
into `uiStore.searchCriteriaList`, does not appear as a removable search chip, and does not
interact with the AND/OR semantics of `searchMatchAny`. Implementing it as a search criterion
would pollute the visible chip list and conflict with the quick-search detection logic (which
requires all criteria to be tags). See [INV-017](TODO/completed/investigations/INV-017_MEDIUM_FRONTEND_video-only-filter-toggle-in-searchbar.md)
for the original analysis.

---

## Persistence

The preference is stored in `UiStore` alongside every other per-library display preference:

| Site | Detail |
| ---- | ------ |
| Observable | `@observable mediaTypeFilter: MediaTypeFilter = 'all'` (near `hideMissingFilesInBrowsing`) |
| Setter | `setMediaTypeFilter(value)` in `UiStore` |
| Persistence union | `PersistentPreferenceFields` includes `'mediaTypeFilter'` |
| Save | `getPersistentPreferences()` writes `mediaTypeFilter: this.mediaTypeFilter` |
| Restore | `recoverPersistentPreferences()` — see migration below |

The localStorage key is derived from the library's `storageKeyPrefix`, so the preference is
isolated per library.

### Legacy migration

The original feature persisted a boolean `showVideosOnly`. On load, `recoverPersistentPreferences`
uses a strict guard so a malformed value can never reach the gate as `undefined`:

1. If `prefs.mediaTypeFilter` is one of `'all' | 'images' | 'video'`, use it.
2. Else if the legacy `prefs.showVideosOnly === true`, use `'video'`.
3. Otherwise (missing, `false`, `null`, or any unrecognized value) use `'all'`.

Downgrade is non-destructive: an old build simply ignores the `mediaTypeFilter` string and reads
the (now-absent) boolean as `false`.

---

## Filter Implementation — the upstream gate

**Key difference from the original design:** the filter is now an **upstream gate** applied to the
raw `FileDTO[]` *before* any `ClientFile` is constructed, not a post-fetch splice. The original
implementation fetched every file, built `ClientFile`s, pushed them into `fileList`, rendered them,
and started loading thumbnails — *then* removed the non-matching ones. Users saw images flash into
the grid and disappear, and the app wasted thumbnail work. The upstream gate eliminates both.

The gate lives inside `FileStore.updateFromBackend` (`src/frontend/stores/FileStore.ts`), the single
convergence point for every non-Missing fetcher, immediately after the existing hidden-tags filter
and before `filesFromBackend` constructs any `ClientFile`:

```ts
const preGateFetchedCount = backendFiles.length;
const mediaFilter = this.rootStore.uiStore.mediaTypeFilter;
const mediaFilterActive = mediaFilter !== 'all' && !this.showsMissingContent;
if (mediaFilterActive) {
  backendFiles = backendFiles.filter((f) => mediaTypeMatches(mediaFilter, f.extension));
}

const [newClientFiles, reusedStatus] = this.filesFromBackend(backendFiles);
```

Key points:

- **Classifier:** `mediaTypeMatches(filter, extension)` from `common/fs.ts`, built on the single
  authoritative video-extension list `isFileExtensionVideo` (`mp4 | webm | ogg`). `'images'` is its
  complement. Hard-coding extensions inline is avoided so future format additions are picked up
  automatically.
- **Nothing downstream materializes:** because excluded files are removed from the `FileDTO[]`, no
  `ClientFile` is created for them, they never enter `fileList`, never render, and never trigger a
  thumbnail. There is no post-fetch splice of `fileList` anymore.
- **Selection cleanup for free:** `cleanFileSelection()` already runs in the main transaction against
  the post-gate `fileList`, so previously selected files hidden by the filter are dropped from
  `uiStore.fileSelection` with no extra code.
- **Missing-files view guard:** `!this.showsMissingContent`. The Missing view uses a separate inline
  path (`fetchMissingFiles`) that never calls `updateFromBackend`, so the guard is defensive parity —
  the Missing view is always unfiltered by design.
- **Generation guard:** the gate lives after the stale-generation early return at the top of
  `updateFromBackend` (INV-009), so no stale fetch can apply the filter to the wrong result set.

### Count semantics

`updateFileListState()` sets `numTotalFiles = fileList.length` in All-content mode. After the gate,
`fileList` is smaller than the true library size. To keep the Outliner total badge accurate, the
implementation overrides `numTotalFiles` with the **pre-gate** fetched count (captured after the
hidden-tags filter, before the media gate) — but only in the All-content view:

```ts
if (this.showsAllContent && ((shouldHide && brokenCount > 0) || mediaFilterActive)) {
  this.numTotalFiles = preGateFetchedCount;
}
```

Scoped views (Untagged / Query / Duplicates) are *not* overridden (the `showsAllContent` guard), so
their badges show the visible count. Tradeoff for the All view: the badge may read higher than the
visible gallery count when a filter is active. This matches the established convention (and the
broken-file splice's own override) and avoids a confusing shrinking badge.

---

## Runtime Reaction

A MobX `reaction` registered in `FileStore.watchUiPreferences` watches `uiStore.mediaTypeFilter` and
calls `this.refetch()` when it changes:

```ts
reaction(
  () => this.rootStore.uiStore.mediaTypeFilter,
  () => this.refetch(),
);
```

The `Searchbar` `<select>` also calls `fileStore.refetch()` explicitly on change (matching the
`SearchMatchButton` pattern), resulting in a harmless double-refetch on toggle with no visible side
effects. `refetch()` is content-mode-aware, so toggling the filter while in the Missing or Duplicates
view re-runs the correct fetcher rather than ejecting the user.

`watchUiPreferences` is called by `RootStore` after all stores are constructed, not in `FileStore`'s
constructor. A constructor-time reaction throws on an undefined `uiStore` reference and is silently
disabled forever. See the comment block above `watchUiPreferences` in `FileStore.ts`.

---

## Developer Notes

### Single filtering hook

The entire media-type behavior is implemented at a single location: the pre-`filesFromBackend` gate
inside `FileStore.updateFromBackend`. No per-component filter logic exists. All browsing fetchers
(All, Untagged, Query, Duplicates, Calendar, List) converge on `updateFromBackend`, so the filter
applies uniformly by construction.

### Future format additions

To add a new video extension, update `isFileExtensionVideo` in `common/fs.ts`. No changes to
`FileStore`, `UiStore`, or the Searchbar are needed.

### Future optimization: query-level gate

The gate still fetches the full file set from the backend and trims it in the renderer. A more
efficient design would push an `extension`-based filter into the DB query. This is *not* implemented
because the backend combines conditions with a single global `searchMatchAny` boolean and cannot
express `(tags) AND (extension in set)` without a new dedicated backend parameter threaded through
`DataStorage`, `sqlite-backend`, `http-backend`, and the IndexedDB backend. The DTO-boundary gate
already eliminates the flash and the thumbnail waste (both strictly downstream of it), so the
query-level gate is deferred as a possible future optimization.

### Settings parity (out of scope)

Other display preferences (hide-missing, tag overlay) also expose a Settings toggle. A Settings mirror
for `mediaTypeFilter` is intentionally out of scope — the user-stated requirement was specifically a
searchbar control.

---

## History

- Originally shipped as a binary **"Video Only"** checkbox backed by a boolean `showVideosOnly`
  preference and a **post-fetch splice** (INV-017, TASK-069→073).
- Evolved (change `media-type-filter-dropdown`) into a tri-state dropdown backed by
  `mediaTypeFilter` and an **upstream `FileDTO[]` gate**, to stop excluded files from flashing into
  the grid and to stop wasted thumbnail generation.

See also: [Missing Files](missing-files.md) — the sibling hide-missing-files display filter that the
gate composes with.
