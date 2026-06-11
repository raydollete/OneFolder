---
id: INV-017
title: 'Add a persistent "Video Only" filter toggle to the right of the tag search input'
reported_bug: 'To the right of the tag input element, add a checkbox labeled "Video Only" whose state persists on restart. When checked, the results are filtered to only show videos.'
date: 2026-06-11
status: active # active | tasks-created | superseded
superseded_by:
tasks_spawned: [TASK-069, TASK-070, TASK-071, TASK-072, TASK-073]
root_cause_category: missing-edge-case # feature request — no pre-existing affordance for media-type filtering
affects:
  - UiStore (persistent preferences)
  - FileStore (post-fetch filter pipeline / updateFromBackend)
  - Searchbar / QuickSearchList / CriteriaList (toolbar UI)
  - Searchbar SCSS layout
---

## Bug Report

### Observed Behavior

There is no quick affordance to restrict the gallery to only video files. A user who wants to see just videos must open Advanced Search and manually build an `extension equals mp4` (and `webm`, `ogg`) criterion, which is cumbersome, does not cover all video extensions in a single action, and is not sticky across restarts.

### Expected Behavior

A checkbox labeled **"Video Only"** sits to the right of the tag search input. When checked, the gallery results are filtered to show only video files (currently `mp4`, `webm`, `ogg`). The checkbox state persists across application restarts, scoped per library like every other UI preference.

This is a **feature request**, not a defect. The "root cause" is simply the absence of a media-type filter affordance; the analysis below focuses on the correct architecture for adding it without regressing the existing fetch/filter invariants.

### Reproduction Context

Deterministic. Applies to all content modes that show a normal gallery (All, Untagged, Query). Not applicable to the dedicated Missing-files recovery view.

---

## Root Cause Analysis

**Category:** missing-edge-case (no media-type filter affordance exists)

### Diagnosis

OneFolder already has two distinct filtering mechanisms, and the right design hinges on choosing the correct one:

1. **Backend search criteria** (`src/frontend/entities/SearchCriteria.ts`, applied in `FileStore.fetchFilesByQuery` via `backend.searchFiles`). These are powerful but: (a) they are user-visible criteria chips that the user can remove, (b) `extension` criteria only match one extension per criterion, and (c) combining a media-type filter with tag search via the existing `searchMatchAny` AND/OR flag would conflict with the user's intended tag semantics. Injecting synthetic extension criteria into `uiStore.searchCriteriaList` would pollute the visible search chips and fight the quick-search UI (which only renders the `TagSelector` when *all* criteria are tags — see `Searchbar.tsx` `isQuickSearch`).

2. **Post-fetch client-side filter** (`FileStore.updateFromBackend`, lines ~1281–1316). This is exactly how the **"hide missing files"** preference (INV-004) works: after the backend returns `newClientFiles`, the store optionally splices the list down to a visible subset, fixes up selection and counts, and triggers downstream reactions. A preference toggle drives a `reaction` in `FileStore.watchUiPreferences` that calls `refetch()`.

The "Video Only" filter is conceptually identical to "hide missing files": it is a **global, persistent, content-orthogonal display preference**, not a user-authored search term. Therefore it should follow the post-fetch client-side filter pattern, NOT the backend-criteria pattern. The canonical video test already exists: `isFileExtensionVideo(ext)` in `common/fs.ts`, which checks `mp4 | webm | ogg`. The `ClientFile.extension` field holds the lowercase extension.

The UI placement has one important subtlety: the "tag input element" (`TagSelector`) is only rendered by `QuickSearchList`. As soon as the search contains any non-tag criterion, `Searchbar` swaps to `CriteriaList` and the `TagSelector` disappears (`Searchbar.tsx` lines 14–23). If the checkbox were nested *inside* `TagSelector` (via its `extraIconButtons` slot), it would vanish whenever the user has a path/size/date criterion active. To keep "Video Only" always reachable, the checkbox must be a sibling of the list at the **`Searchbar`** level, rendered to the right of whichever list (`QuickSearchList` or `CriteriaList`) is active.

### Diagnostic Questions Considered

- **Wrong mental model?** The trap would be modeling "Video Only" as a search criterion. It is a display preference (like hide-missing-files), orthogonal to the user's search terms.
- **Architectural shortcoming?** No new hook points needed — `updateFromBackend` filter slot, `watchUiPreferences` reaction, and the `PersistentPreferenceFields` persistence pipeline already exist and are the correct seams.
- **Incorrect order of operations?** Must filter inside the existing `transaction(...)` in `updateFromBackend`, after the broken-file splice, and must preserve the INV-009 generation guard so a stale fetch never applies the filter to the wrong result set.
- **Missing edge case?** Counts. The missing-files filter overrides `numMissingFiles`/`numTotalFiles` so Outliner badges stay accurate after a splice. "Video Only" must decide its own count semantics (see Holistic Solution — we keep `numTotalFiles` reflecting the unfiltered library size, consistent with hide-missing-files, so the "All Images" badge is not silently shrunk by an orthogonal display filter).
- **Wrong abstraction?** Hard-coding the three extensions inline would duplicate logic. Reuse `isFileExtensionVideo` from `common/fs.ts` so any future video-format additions are picked up automatically.
- **Silent failure?** The `watchUiPreferences` reaction must be registered by `RootStore` after all stores exist (the file documents why — a constructor-time reaction throws on undefined `uiStore` and is silently disabled forever). The new reaction goes in the same already-correctly-wired method.

---

## Blast Radius

The same underlying change (a new persistent display-filter preference) touches every layer that the hide-missing-files preference touched. Each must be handled to avoid regressions:

1. **UiStore persistence pipeline** — A new observable `showVideosOnly` (default `false`) must be added to the `PersistentPreferenceFields` union (line ~122), declared as `@observable` (near line 195), given setter/toggle actions (near line 434), serialized in `getPersistentPreferences()` (near line 1145), and restored in `recoverPersistentPreferences()` (near line 1052) with a `Boolean(prefs.showVideosOnly ?? false)` guard. Missing any one site means the preference silently fails to persist.

2. **FileStore.updateFromBackend filter slot** (lines ~1281–1316) — The post-fetch transaction must gain a second optional splice that keeps only files where `isFileExtensionVideo(f.extension)` is true when `showVideosOnly` is set. It must compose correctly with the existing broken-file splice (both can apply), run before `updateFileListState()`, and call `cleanFileSelection()` so the selection drops non-video files that were removed.

3. **FileStore count semantics** — `updateFileListState()` derives `numTotalFiles` from `fileList.length` in All-content mode. After a video-only splice the list is smaller than the library, so the "All Images" badge would shrink. To stay consistent with the hide-missing-files override, `numTotalFiles` should be overridden to the pre-filter fetched count when `showVideosOnly` causes a splice in All-content mode.

4. **FileStore.watchUiPreferences reaction** (lines ~129–136) — A second `reaction` on `uiStore.showVideosOnly` must call `refetch()` so toggling the checkbox immediately re-applies the filter without a restart. Must remain in `watchUiPreferences` (RootStore-invoked) for the reasons documented at lines 120–128.

5. **Searchbar UI** (`src/frontend/containers/AppToolbar/Searchbar.tsx`) — The checkbox must render at the `Searchbar` level as a sibling to the active list so it survives the `QuickSearchList` ↔ `CriteriaList` swap. Toggling it calls the UiStore setter (the `watchUiPreferences` reaction then refetches; an explicit `fileStore.refetch()` may be added for immediate feedback, matching the SearchMatchButton pattern).

6. **Searchbar SCSS** (`resources/style/app-toolbar.scss`) — `.searchbar` currently wraps a single child. It must become a flex row (input grows, checkbox is a fixed-width control on the right) and the checkbox needs label styling consistent with the toolbar.

7. **Settings (optional parity)** — Other display preferences (hide-missing, tag overlay) also expose a Settings toggle. Out of scope for the core request (the user asked specifically for a searchbar checkbox), but noted so a future task can add a Settings mirror if desired. Not implemented here to avoid scope creep.

---

## UX / Requirements Specification

### Purpose

Give the user a one-click, persistent way to restrict the gallery to video files, directly in the search toolbar.

### User-Stated Design Decisions

1. **Placement: to the right of the tag input element** — The control lives in the search toolbar, immediately right of the tag search input. (Implemented at the `Searchbar` level so it remains visible even when the search is in `CriteriaList` mode and the tag input is not rendered.)
2. **Control type: a checkbox** — Use the `Checkbox` widget (`widgets/checkbox.tsx`), labeled exactly **"Video Only"**.
3. **Behavior: when checked, results are filtered to only show videos** — Only files passing `isFileExtensionVideo(extension)` (`mp4`, `webm`, `ogg`) are shown.
4. **Persistence: state persists on restart** — Stored in the per-library persistent preferences (localStorage), default unchecked (`false`).

### Behavioral Specifications

- Default state on a fresh library: **unchecked** (show everything).
- Toggling updates the gallery immediately (no restart), via the `watchUiPreferences` refetch reaction.
- Composes with active tag/criteria search: video-only narrows whatever the current search already returned (logical AND at the display layer).
- Does not appear as a removable search chip and does not alter `searchCriteriaList`.
- Outliner "All Images" count continues to reflect the true library size, not the filtered count.

### Explicit Rejections

- Do **not** implement this by injecting synthetic `extension` criteria into `uiStore.searchCriteriaList` (would pollute search chips, break quick-search detection, and can't express "any video extension" in one criterion).
- Do **not** nest the checkbox inside `TagSelector.extraIconButtons` (it would disappear in `CriteriaList` mode).
- Do **not** hard-code the video extension list inline; reuse `isFileExtensionVideo` from `common/fs.ts`.

---

## Holistic Solution

### Approach

Mirror the INV-004 hide-missing-files architecture exactly, for a new `showVideosOnly` preference:

1. **UiStore** — Add `showVideosOnly` observable (default `false`), its setter/toggle, and wire it through all five persistence sites so it saves/restores per library.
2. **FileStore** — Add a `showVideosOnly` reaction in `watchUiPreferences` that refetches; add a video-only splice in the `updateFromBackend` transaction (after the broken-file splice, reusing `isFileExtensionVideo`), with the same selection-cleanup and `numTotalFiles` count override so badges stay correct.
3. **Searchbar** — Render a `Checkbox` labeled "Video Only" at the `Searchbar` level, to the right of the active list, bound to `uiStore.showVideosOnly` / its setter, with an explicit `fileStore.refetch()` on change for immediate feedback.
4. **SCSS** — Make `.searchbar` a flex row so the list grows and the checkbox sits on the right; style the label.

### Expected Outcomes

- A "Video Only" checkbox is visible right of the tag input in both quick-search and criteria modes.
- Checking it instantly filters the gallery to videos; unchecking restores the full result set.
- The state survives restart and is isolated per library.
- Tag/criteria search still works and composes with the filter; Outliner counts remain accurate.

### Risks and Tradeoffs

- **Count semantics**: We intentionally keep `numTotalFiles` at the unfiltered size when video-only causes an All-content splice, matching hide-missing-files. Tradeoff: the badge can read higher than the visible gallery count. This is the established convention in this codebase and avoids a confusing shrinking "All Images" badge.
- **Two composing splices**: When both hide-missing and video-only are active, the order is broken-file splice then video splice (or a single combined filter predicate). The implementation must rebuild derived state once, after both, to avoid double work and keep `cleanFileSelection` correct.
- **Generation guard**: The new filter lives inside the existing INV-009 generation-guarded transaction; no new race is introduced as long as it is added inside that block and not before the guard.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: `docs/missing-files.md` should gain a sibling note, or a short `docs/video-only-filter.md` should be added documenting the new preference and that it follows the post-fetch filter pattern (covered by TASK-072).
