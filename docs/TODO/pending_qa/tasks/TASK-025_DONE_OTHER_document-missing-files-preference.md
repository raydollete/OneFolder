---
id: TASK-025
title: 'Document hide-missing-files preference and recovery flow'
investigation: INV-004
status: DONE
priority: low
blocked_by: [TASK-021, TASK-022, TASK-023]
date_created: 2026-04-22
date_completed: 2026-04-22
files:
  - docs/missing-files.md
  - docs/index.md
---

## What

Create `docs/missing-files.md` explaining:

1. When and why a file is considered "missing" (`fse.pathExists(absolutePath)` fails during `FileStore.updateFromBackend`).
2. The new `hideMissingFilesInBrowsing` preference: default true, library-scoped, persisted via `storageKeyPrefix`.
3. How the Missing Files recovery view (via the Outliner warning badge) interacts with the toggle — always available regardless of toggle state.
4. Where to find the toggle (Settings → Appearance → Thumbnail section).

Add a pointer to the new doc from `docs/index.md`.

## Why

Per CLAUDE.md, project documentation lives in `docs/` and should be read before making related changes. A future contributor investigating missing-file behavior needs a single reference describing the design. This is also the place to record the rationale (user wanted default-hide with opt-in) so later maintainers don't undo the default.

See [INV-004](../investigations/INV-004_MEDIUM_FRONTEND_hide-missing-files-by-default.md).

## Implementation Steps

- [x] 1. Create `docs/missing-files.md` with the following structure:
  - Front-matter (`title`, `author`, `last_updated`, `scope: feature`, `aliases: ["missing-files", "broken-thumbnails"]`) matching the style of `docs/location-loading.md`.
  - Overview: definition of "missing file" in OneFolder (file exists in the DB, but `absolutePath` no longer resolves on disk).
  - Detection flow: reference `FileStore.updateFromBackend` in `src/frontend/stores/FileStore.ts` and describe the async `fse.pathExists` check that flips `file.isBroken`.
  - Behavior with `hideMissingFilesInBrowsing = true` (default): describe which views are affected (All / Untagged / Query / Duplicates / Calendar / List) and which are not (the dedicated Missing recovery view).
  - Behavior with `hideMissingFilesInBrowsing = false`: describe the inline desaturated tile + warning overlay from `GalleryItem.tsx` / `CalendarGallery.tsx`.
  - How to access the toggle: Settings popup → Appearance tab → Thumbnail section → "Show missing files in gallery".
  - How to reach the Missing recovery view: Outliner warning badge (TagsPanel) — always visible when `numMissingFiles > 0` regardless of toggle state.
  - Developer notes: the single filtering hook is `FileStore.updateFromBackend`; the dedicated `fetchMissingFiles` bypasses the filter via a `!this.showsMissingContent` guard.

- [x] 2. Open `docs/index.md` and add a bullet or link to the new `missing-files.md` in the appropriate section (likely under a "Features" or "Behavior" heading — match the neighboring conventions).

- [x] 3. Verify the doc renders correctly in a Markdown viewer and that internal links work.

## Done When

- [x] `docs/missing-files.md` exists and documents the detection flow, the new preference, the default value, and the recovery path.
- [x] `docs/index.md` links to it.
- [x] A reader unfamiliar with this area can, from the docs alone, understand (a) why some files are missing, (b) why they don't appear by default, (c) how to show them if desired, and (d) how to triage them via the recovery view.
