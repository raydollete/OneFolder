## Context

The "Video Only" filter (INV-017, `docs/video-only-filter.md`) is implemented as a **post-fetch splice** inside `FileStore.updateFromBackend`. By the time it runs, the fetched files have already been turned into `ClientFile` objects, pushed into `fileList`, rendered into the masonry grid, and have begun loading thumbnails — the splice then removes the non-video entries. The visible result is images flashing into the grid and vanishing, plus wasted thumbnail generation for files the app immediately hides.

Crucially, `updateFromBackend` **already** contains an upstream, pre-materialization filter: right after entry it strips files carrying hidden tags from the raw `FileDTO[]` *before* `filesFromBackend` constructs any `ClientFile` (`FileStore.ts:1638-1647`). That is the exact seam and pattern this change should reuse. All browsing fetchers (`fetchAllFiles`, `fetchUntaggedFiles`, `fetchFilesByQuery`, `fetchDuplicatesFiles`) converge on `updateFromBackend`, so a gate there applies uniformly by construction.

The backend search API combines conditions with a single global `searchMatchAny` boolean (`data-storage.ts:31`, `data-storage-search.ts`), and `fetchFiles` (the All view) accepts no conditions at all. There is no operator for "extension in a set." This constrains where a *query-level* gate could live.

## Goals / Non-Goals

**Goals:**
- No excluded file is ever materialized into a `ClientFile`, rendered, or thumbnailed — eliminate the flash-then-disappear behavior and the wasted thumbnail work.
- Evolve the binary "Video Only" checkbox into a three-way dropdown: **Show All Media**, **Images Only**, **Video Only**.
- Preserve every existing invariant of the current filter: per-library persistence, display-only (not a search criterion), Missing-view bypass, composition with hide-missing-files, and an accurate Outliner total badge.
- Migrate existing libraries silently (`showVideosOnly: true` → `video`).

**Non-Goals:**
- Pushing the filter into the SQL/Dexie query layer (a new backend parameter). Deferred — see Decisions.
- Adding a Settings-panel mirror of the control (the existing filter has none; out of scope, as it was originally).
- Filtering by finer-grained media categories (RAW vs JPEG, animated vs still). The taxonomy stays binary: video vs. not-video.
- Changing the Missing-files view, search semantics, or count conventions beyond what is needed to keep them working.

## Decisions

### Decision 1: Gate the raw `FileDTO[]` in `updateFromBackend`, mirroring the hidden-tags filter

Add the media-type filter immediately after the existing hidden-tags filter (`FileStore.ts:1643`), operating on the `backendFiles` array **before** `filesFromBackend` runs. Files excluded here never become `ClientFile`s, never enter `fileList`, never render, and never trigger a thumbnail. The old post-fetch splice block (`FileStore.ts:1729-1746`) and its `numTotalFiles`/`splicedList` handling for video are deleted.

- **Why over the query layer:** A true query gate would need `WHERE extension IN (mp4,webm,ogg)` AND-combined with the user's tag criteria. The backend's single `searchMatchAny` flag cannot express `(tag OR tag) AND (ext-set)`, and `fetchFiles` takes no criteria — so it would require a new dedicated backend parameter threaded through `DataStorage`, `sqlite-backend`, `http-backend`, and the IndexedDB backend. That is a materially larger blast radius for a marginal data-transfer win. The DTO-boundary gate fully solves the user's stated problem (the flash and the thumbnail waste both happen strictly downstream of this point). The query-level optimization can be layered in later without changing observable behavior.
- **Why over CSS-hiding or keeping the splice:** Any approach that lets the `ClientFile` exist still pays the render + thumbnail cost and can flash.
- **Count semantics:** Capture the file count *after* the hidden-tags filter but *before* the media gate, and use it to override `numTotalFiles` in the All-content view — preserving today's convention that the Outliner "All Images" badge shows the full library size, not the reduced visible count. The video-specific branch of the current override (`FileStore.ts:1776`) folds into "a media filter is active."

### Decision 2: Replace `showVideosOnly: boolean` with a tri-state `mediaTypeFilter`

Introduce a string-literal union `MediaTypeFilter = 'all' | 'images' | 'video'` (default `'all'`). In `UiStore`: replace the `showVideosOnly` observable with `mediaTypeFilter`, replace `setShowVideosOnly`/`toggleShowVideosOnly` with `setMediaTypeFilter(value)`, swap the `PersistentPreferenceFields` entry, and update `getPersistentPreferences`/`recoverPersistentPreferences`.

- **Legacy migration (in `recoverPersistentPreferences`, `UiStore.ts:1121`):** read `mediaTypeFilter` first; if absent, fall back to the legacy boolean — `prefs.showVideosOnly === true ? 'video' : 'all'`. Validate the loaded string against the three known values and coerce unknowns to `'all'` (fail-safe to the least surprising state).
- **Why a string union over a numeric enum:** it serializes to localStorage legibly, matches the values the `<select>` emits directly, and reads clearly in the migration.

### Decision 3: Single classifier, expressed as a predicate over extension

Keep `isFileExtensionVideo` (`common/fs.ts:46`) as the sole authoritative video-extension list. Express the gate as: `all` → keep everything; `video` → `isFileExtensionVideo(ext)`; `images` → `!isFileExtensionVideo(ext)`. Add one small helper `mediaTypeMatches(filter, extension)` in `common/fs.ts` so both the gate and any test reference one predicate and future video-format additions propagate automatically.

### Decision 4: Native `<select>` dropdown in the Searchbar

Replace the `Checkbox` in `Searchbar.tsx:26-34` with a native `<select>` (three `<option>`s), matching the established pattern in `AdvancedSearch/Inputs.tsx`, `CalendarGallery.tsx`, and `DuplicateGallery.tsx`. `onChange` calls `uiStore.setMediaTypeFilter(value)` then `fileStore.refetch()` (same explicit-refetch pattern the checkbox used). Style it in `resources/style/app-toolbar.scss` where the current checkbox is styled. It stays a sibling of `QuickSearchList`/`CriteriaList` so it remains visible in criteria mode.

- The `watchUiPreferences` reaction (`FileStore.ts:139`) is re-keyed from `showVideosOnly` to `mediaTypeFilter`, so programmatic changes still trigger a refetch (the explicit `refetch()` in the handler makes the on-toggle path a harmless double-refetch, exactly as today).

## Risks / Trade-offs

- **[Full library still fetched from the backend]** → The DTO-boundary gate does not reduce the DB read; the whole file set is fetched, then trimmed in the renderer before materialization. Mitigation: acceptable — this matches the existing hidden-tags filter's cost profile and the user's complaint is about render/thumbnail work, which is eliminated. A query-level gate remains a clean future optimization (Decision 1).
- **[Total badge reads higher than the visible count]** → When a filter is active in All view, the Outliner badge shows the pre-filter count. Mitigation: this is the *existing, deliberate* convention (`docs/video-only-filter.md` §Count semantics) carried forward unchanged to avoid a confusing shrinking badge.
- **[Legacy preference misread]** → A malformed or unexpected persisted value could leave the filter in a wrong state. Mitigation: explicit whitelist validation coercing anything unrecognized to `'all'`; the legacy boolean is mapped explicitly.
- **[Selection references to now-hidden files]** → Files removed by the gate must not linger in `fileSelection`. Mitigation: `cleanFileSelection()` already runs in the main `updateFromBackend` transaction against the post-gate `fileList`, so hidden files are dropped from selection for free — no separate handling needed once the splice is gone.
- **[Generation/stale-fetch guard]** → The gate must sit inside the same `generation === this.fetchGeneration` transaction discipline. Mitigation: it lives at the top of `updateFromBackend`, which already returns early on a stale generation (`FileStore.ts:1627`).

## Migration Plan

1. Add `MediaTypeFilter` type + `mediaTypeMatches` helper in `common/fs.ts`.
2. `UiStore`: swap observable/setter/persistence fields; add legacy-migration read in `recoverPersistentPreferences`.
3. `FileStore`: add the gate beside the hidden-tags filter; delete the post-fetch video splice; update the `numTotalFiles` override and the `watchUiPreferences` reaction.
4. `Searchbar.tsx` + `app-toolbar.scss`: replace checkbox with the `<select>`.
5. Update `docs/video-only-filter.md` to describe the tri-state upstream gate.

No schema/DTO/IPC change, so no data migration or rollback tooling is needed. Rollback is a pure code revert; a persisted `mediaTypeFilter` string is simply ignored by the old boolean reader (it falls back to `false` / all-media), so downgrade is non-destructive.

## External Review

An adversarial design review was run through Gemini (gemini-3.5-flash). Dispositions, each checked against the actual code:

- **Total badge on sub-views (Untagged / Query / Duplicates) — already safe, made explicit.** Gemini worried the pre-filter count would inflate the badge on scoped views. The `numTotalFiles` override is guarded by `this.showsAllContent` (`FileStore.ts:1776`), so scoped views already fall through to `updateFileListState()`'s post-gate `fileList.length`. Task 3.3 keeps the override strictly inside the All-content branch. No change; verify preserved.
- **Missing-files view refetch — no leak; refetch is content-aware.** Gemini feared toggling the filter in Missing view would eject the user via a blind `refetch()`. `refetch()` dispatches on content mode (`FileStore.ts:884-902`): Missing → `fetchMissingFiles()` (never calls `updateFromBackend`, so the gate never runs), Duplicates → `fetchDuplicatesFiles()`. The Missing view stays unfiltered; the only cost is one redundant missing re-fetch on toggle, which is harmless and matches today's `showVideosOnly` reaction. The `!this.showsMissingContent` clause on the gate is therefore defensive/redundant but kept for parity.
- **Duplicates view semantics — behavior unchanged from today.** Duplicate grouping in the component reads `fileList`, which the current post-fetch splice already filters before grouping; moving the gate upstream produces the identical filtered `fileList`, so grouping sees the same set. This is a display-filter carry-forward, not a regression. Flagged as a product decision in Open Questions.
- **Migration robustness — hardened.** Adopt Gemini's strict guard: `mediaTypeFilter` is set only if the stored value is one of the three literals; a legacy `showVideosOnly === true` maps to `'video'`; everything else (missing, malformed, `null`, `false`) coerces to `'all'`. Prevents an `undefined` filter reaching `mediaTypeMatches`. Reflected in Task 2.5.
- **Double-refetch on toggle — intentional parity, not a loop.** The `onChange` calls the setter then `refetch()`, and the `watchUiPreferences` reaction also fires `refetch()`. This does not loop: `refetch()` does not write `mediaTypeFilter`. It is the exact established pattern of `SearchMatchButton`/the old checkbox (documented as "harmless double-refetch"). Kept for consistency; a follow-up could drop the manual call and rely on the reaction alone.
- **Stale-generation on fast toggles — already covered.** Each fetcher calls `nextFetchGeneration()` after the content flip and before the `await` (INV-009), and `updateFromBackend` early-returns on a stale generation. No change.
- **Main-thread cost of `.filter()` on large sets — accepted.** The gate reuses the same `Array.filter` shape as the existing hidden-tags filter on the same array; it strictly *reduces* the number of `ClientFile`s constructed downstream, so it is a net win, not a new bottleneck. A query-level gate (Decision 1) is the real optimization if profiling ever demands it.

## Open Questions

- **"Images Only" definition:** treated as the complement of video (`!isFileExtensionVideo`), which correctly hides videos and shows everything else the library holds. If the library ever ingests non-image, non-video assets, they would count as "images"; this matches the binary video-vs-not taxonomy and is acceptable unless product wants a stricter image whitelist later.
- **Filter in the Duplicates view:** the media filter applies there today (via the post-fetch splice) and continues to after this change. If product decides the Duplicates view should ignore the media filter, add `!this.showsDuplicatesContent` to the gate condition — a one-line change, deliberately not made now to preserve current behavior.
- **Dropdown vs. segmented control:** a native `<select>` is chosen for pattern-consistency and zero new widget code; if a segmented button group is preferred visually, it can swap in without touching the store/gate.
