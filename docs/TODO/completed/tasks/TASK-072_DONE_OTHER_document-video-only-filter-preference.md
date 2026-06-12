---
id: TASK-072
title: 'Document the Video Only display-filter preference'
investigation: INV-017
status: DONE
priority: low
blocked_by: [TASK-069, TASK-070, TASK-071]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - docs/video-only-filter.md
  - docs/index.md
---

## What

Add short project documentation describing the "Video Only" preference: what it does, that it is a per-library persistent display filter implemented via the post-fetch `updateFromBackend` splice (NOT a search criterion), and that the video test is `isFileExtensionVideo` in `common/fs.ts`.

## Why

The hide-missing-files feature has `docs/missing-files.md`; the video-only filter follows the same architecture and deserves an equivalent note so future contributors don't reimplement it as a search criterion. Captures the design rationale recorded in INV-017.

See [INV-017](../investigations/INV-017_MEDIUM_FRONTEND_video-only-filter-toggle-in-searchbar.md).

## Implementation Steps

- [x] 1. Create `docs/video-only-filter.md` covering: purpose, default (`false`), where it persists (`UiStore` persistent preferences, per-library localStorage key), the `updateFromBackend` splice location, the `watchUiPreferences` refetch reaction, count-override behavior, and the explicit decision to NOT model it as a `searchCriteriaList` entry.
- [x] 2. Add a one-line link to the new doc in `docs/index.md` (match the existing list style).
- [x] 3. Cross-reference: in `docs/missing-files.md`, add a single "See also: docs/video-only-filter.md (same post-fetch filter pattern)" line.

## Done When

- [x] `docs/video-only-filter.md` exists and accurately describes the implemented behavior and architecture.
- [x] It is linked from `docs/index.md`.
- [x] `docs/missing-files.md` references it as a sibling pattern.
