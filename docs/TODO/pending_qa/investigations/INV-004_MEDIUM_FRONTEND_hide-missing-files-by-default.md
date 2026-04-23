---
id: INV-004
title: 'Hide missing-file thumbnails by default in browsing views'
reported_bug: 'Missing-file thumbnails clutter the gallery by default. They should be hidden unless the user opts in via an out-of-the-way checkbox.'
date: 2026-04-22
status: active
superseded_by:
tasks_spawned: [TASK-021, TASK-022, TASK-023, TASK-024, TASK-025]
root_cause_category: missing-edge-case
affects:
  - FileStore browsing fetchers (All / Untagged / Query / Duplicates)
  - Masonry / Grid / List / Calendar gallery renderers
  - Outliner action bar "Missing" indicator
  - Settings (Appearance pane) and UiStore persistent preferences
  - SlideMode and Inspector (operate on fileList indices)
---

## Bug Report

### Observed Behavior

When a user browses their library (All Images, Untagged, Search results, Duplicates, Calendar, List), files whose `absolutePath` no longer resolves on disk are still rendered as gallery tiles. The tile shows a desaturated / dimmed thumbnail (`.thumbnail-broken > img { filter: saturate(0) brightness(0.25); }` in `resources/style/content.scss`) with a warning-broken-link overlay icon (`IconSet.WARNING_BROKEN_LINK`) positioned absolutely over the thumbnail. Clicking the overlay navigates the user to the dedicated "Missing Files" recovery view.

The same treatment appears in:

- **Masonry / Grid view** — `src/frontend/containers/ContentView/GalleryItem.tsx` lines 84-95 render the overlay when `file.isBroken === true && !fileStore.showsMissingContent`.
- **Calendar view** — `src/frontend/containers/ContentView/CalendarGallery.tsx` lines 548 and 561-572 render the same overlay.
- **Outliner action bar** — `src/frontend/containers/Outliner/TagsPanel/index.tsx` lines 104-112 show a pressed-state warning toolbar button with `fileStore.numMissingFiles` as its badge count, which opens the recovery view.

So the "missing" tiles are scattered through every content mode, visually mixed with valid thumbnails, even though they are non-interactive (cannot preview, cannot open externally — see `menu-items.tsx` lines 216, 245).

### Expected Behavior

1. **Default:** Missing files should be completely absent from the main browsing views (All / Untagged / Query / Duplicates / Calendar / List). A user with missing files should see only their present-on-disk photos when casually browsing.
2. **Opt-in:** A small, unobtrusive checkbox — placed somewhere out of the way — lets a user re-enable the old behavior (show broken thumbnails inline with the broken-link overlay). The user can then click the overlay to jump to the recovery view as before.
3. **Recovery view remains unchanged:** The dedicated "Missing Files" view (triggered by `fetchMissingFiles` or the Outliner warning badge) continues to show ONLY the missing files regardless of the toggle.
4. **Counter preserved:** The Outliner warning badge (`numMissingFiles`) must remain visible and accurate even when the tiles are hidden in the main gallery — that is the user's primary discovery mechanism that some files are missing.

### Reproduction Context

Deterministic. Triggers:

1. Create a location with some image files.
2. Let OneFolder index them (so each has a `FileDTO` row).
3. Delete or rename (without using the watcher-aware flow) one or more of those files on disk while OneFolder is running, OR close the app, delete files externally, then re-open.
4. Open "All Images". Missing files appear as tiles with desaturated thumbnails and the warning overlay.

Affects all image formats and file structures equally — the check is purely `fse.pathExists(absolutePath)`.

---

## Root Cause Analysis

**Category:** missing-edge-case

### Diagnosis

`FileStore.updateFromBackend` (`src/frontend/stores/FileStore.ts` lines 909-966) is the single entry point for populating `fileList` for every non-"Missing" content mode. It does three things in order:

1. Filters `backendFiles` by hidden-tag membership (lines 916-921). This is a synchronous, blocklist-style filter that operates on DTOs before any `ClientFile` is constructed.
2. Builds `ClientFile[]`, clears/pushes them into the observable `fileList`, and renders — at this point every file's `isBroken` is `undefined`.
3. **Kicks off** an async `fse.pathExists` check for each file (lines 937-939 and 957-965) that eventually flips `file.isBroken = true` for missing ones. The result updates `numMissingFiles` via `updateFileListState()` (lines 1026-1047) but **never removes the broken files from `fileList`**.

The gallery components (`GalleryItem.tsx`, `CalendarGallery.tsx`) individually branch on `file.isBroken` at render time to paint the overlay — they don't collaborate on whether a broken file should appear in the list at all. There is no product-level decision point that says "should a broken file be visible in a normal browsing view?" — the code simply assumes "yes, paint a warning overlay on top."

Why this is a missing edge case rather than a different category:

- The hidden-tag filter (lines 916-921) proves the mental model supports exclusion filtering — it just didn't get extended to missingness.
- The dedicated `fetchMissingFiles` path (lines 705-766) proves the codebase knows how to build a "only broken" `fileList`. The inverse ("only non-broken") was simply never implemented.
- `setBroken` in `File.ts` lines 245-248 already disables auto-save, indicating the concept of a "frozen" broken file was partially modeled. It is a small step to also omit such files from the default view.

The architectural hook point is clear: after the async existence-check promise-batch resolves in `updateFromBackend`, the results are known, and that is exactly the moment to apply a second filtering pass (conditioned on a new user preference) that splices broken files out of `fileList`.

### Diagnostic Questions Considered

- **Wrong mental model?** Partial — the code modeled broken files as "visible but decorated with an overlay" rather than "hidden by default, surfaced via a counter." That is a UX model, not a technical error, so not the primary category.
- **Architectural shortcoming?** No — the hook point for filtering exists (`updateFromBackend` already filters by hidden tags). Nothing architectural is missing.
- **Incorrect order of operations?** No — the existence check runs asynchronously and produces correct results; we simply never consume those results to filter the list.
- **Missing edge case?** Yes — the "hide broken files from normal browsing" case was never implemented. This is the primary category.
- **Wrong abstraction?** No — `isBroken` as an observable on `ClientFile` is the right abstraction.
- **Silent failure?** No — the system behaves exactly as coded; no exceptions are swallowed.

---

## Blast Radius

1. **`FileStore.updateFromBackend`** (`src/frontend/stores/FileStore.ts` lines 909-966) — The sole place where broken files enter `fileList` for All / Untagged / Query / Duplicates / Calendar / List modes. Must perform a post-existence-check filter pass that, when `uiStore.hideMissingFilesInBrowsing === true`, removes broken files from `fileList` and re-runs `cleanFileSelection`, `updateFileListState`, and `fileListLastModified`.

2. **`FileStore.fetchDuplicatesFiles`** (lines 790-800) — Also calls `updateFromBackend` via the same path, so it inherits the fix automatically, but the duplicate-detection logic runs downstream in `DuplicateGallery.tsx` and works against `fileList`. Needs verification that duplicate groups are still computed correctly after broken files are filtered out. Expected: yes — a file you can't access shouldn't participate in a duplicates list the user can act on.

3. **`FileStore.fetchMissingFiles`** (lines 705-766) — MUST NOT be affected by the new toggle. This path explicitly builds the recovery view and filters `fileList` down to only broken files. Guard the new filter with a check that the current content mode is not `Content.Missing`.

4. **`GalleryItem.tsx` `MasonryCell`** (`src/frontend/containers/ContentView/GalleryItem.tsx` lines 52-116) — When the toggle is OFF (default: files hidden), the `!fileStore.showsMissingContent` branch at line 84 becomes unreachable in normal browsing because broken files are no longer in `fileList`. When the toggle is ON (user opted to show them), the existing overlay code works as before. No code change required, but behavior must be verified end-to-end.

5. **`CalendarGallery.tsx`** (lines 540-572) — Same pattern as GalleryItem; automatic behavior, no code change required but must be verified. The `calendar-thumbnail-container` `thumbnail-broken` class-styling falls out naturally.

6. **`menu-items.tsx` `FileViewerMenuItems` / `ExternalAppMenuItems`** (lines 203, 216, 245) — These already disable "Open External" and "Reveal in Tags Panel" when `file.isBroken`. With broken files hidden by default, these disabled branches become rarely hit. When the toggle is ON and user right-clicks a broken file, the `MissingFileMenuItems` menu still replaces the normal one (`Commands.tsx` lines 203, 221, 238) — no change needed.

7. **`Outliner/TagsPanel/index.tsx` "Missing" toolbar button** (lines 104-112) — `fileStore.numMissingFiles` MUST still be populated even when broken files are filtered out of `fileList`. Today, `updateFileListState()` (lines 1026-1047) derives `numMissingFiles` from `fileList` directly. If we splice broken files OUT of `fileList`, the counter becomes wrong. Fix: derive the counter BEFORE the filter pass (count broken files, then splice), and store the count independent of `fileList`.

8. **`UiStore` persistent preferences** (`src/frontend/stores/UiStore.ts` lines 122-157, 979-1070, 1072-1110) — A new boolean preference `hideMissingFilesInBrowsing` (default `true`) needs to be added to the observable set, the `PersistentPreferenceFields` union, `recoverPersistentPreferences` with a safe default (true), and `getPersistentPreferences`. Library-scoped via the existing `storageKeyPrefix` mechanism.

9. **`Settings/Appearance.tsx`** (or a new "Gallery" section) — A small `<Toggle>` (matching the existing thumbnail overlay toggles, e.g. `isThumbnailFilenameOverlayEnabled`) is the natural "out of the way" location. The Settings popup is exactly the "settings / advanced filter" kind of home the user asked for. Group it visually near the thumbnail-tag/filename/resolution toggles since it is a similar "what appears on/in thumbnails" decision.

10. **`Preview.tsx`, `SlideMode/index.tsx`, `Inspector/index.tsx`, `LayoutSwitcher.tsx`** — All navigate `fileList` by index (`firstItem`, next/prev). With broken files filtered out, these work correctly without change (the index space is smaller and consistent). However, `cleanFileSelection` MUST run after the filter splice so that any previously-selected broken files are dropped from `fileSelection` (already present in `FileStore` line 969-976; just needs to be called again after the splice).

11. **Watcher-driven real-time change** (`LocationStore.hideFile` line 533-544) — When Chokidar detects a file removal while OneFolder is running, `fileStore.hideFile(clientFile)` marks the file broken and triggers `debouncedRefetch`. The refetch goes through `updateFromBackend` and will now filter the file out. Intermediate state: the user briefly sees the broken tile before the refetch completes. Acceptable. Verify with a manual test.

12. **Numeric counters in Outliner** — `fileStore.numTotalFiles` (line 97 of `TagsPanel/index.tsx`) reflects the DB file count, not the visible count. When broken files are hidden, there will be a discrepancy between the "All Images" toolbar count and `fileList.length`. This is acceptable because the "Missing" badge (lines 104-112) accounts for the delta, and the user can toggle the preference to reconcile. Document this behavior in the tooltip.

---

## UX / Requirements Specification

### Purpose

Default the main browsing experience to a clean, uncluttered gallery of present-on-disk photos, while preserving the user's ability to opt in to seeing broken tiles inline for recovery or auditing purposes.

### User-Stated Design Decisions

1. **Hide missing files by default** — The user explicitly requested "missing file thumbnails shouldn't show at all when browsing." Default state of the preference MUST be "hide."

2. **Checkbox toggle** — The user requested a **checkbox** specifically (as opposed to a menu command, right-click option, or hidden setting). Use a `<Toggle>` / `<Checkbox>` widget consistent with OneFolder's existing pattern (e.g. the thumbnail overlay toggles in `Settings/Appearance.tsx`).

3. **"Out of the way" placement** — The user emphasized placement should NOT clutter the main UI. Explicit options the user considered and left open:
   - Preferences / Settings panel
   - An advanced filter menu
   - A small gear icon in the toolbar

   **Chosen:** Settings popup → Appearance tab → Thumbnail section (or a new "Gallery" section below Thumbnail). Rationale: it already houses similar "what displays on gallery tiles" toggles, users discover it via the `...` menu (`SecondaryCommands.tsx`), and it is visually completely out of the way of normal browsing. A right-click option on the content view would also satisfy "out of the way" but duplicating state across two UI surfaces adds complexity; stick with one canonical location for the toggle.

4. **Recovery flow unchanged** — The dedicated "Missing Files" view (reached by the Outliner warning badge with its `numMissingFiles` count) continues to show only broken files regardless of toggle state. This is the primary route for users who need to act on missing files.

5. **Consistency across all browsing contexts** — The fix MUST apply uniformly to Masonry, Grid, List, Calendar, and Duplicates views, plus Search/Query results. Implementing the filter at the `FileStore.updateFromBackend` layer (single source of truth for `fileList`) achieves this by construction.

### Behavioral Specifications

1. On fresh install, the preference `hideMissingFilesInBrowsing` is `true`. Users who upgrade an existing library also get `true` (via the default in `recoverPersistentPreferences` when the key is absent from stored JSON).

2. When the preference is `true` and the user is in All / Untagged / Query / Duplicates / Calendar / List views:
   - `fileList` contains only files where `isBroken === false` (not `undefined`, not `true`).
   - Gallery renders only those files; no broken-link overlay ever appears.
   - `numMissingFiles` is still counted and displayed in the Outliner warning badge.
   - Clicking the Outliner warning badge still navigates to the Missing view.

3. When the preference is `false`:
   - Behavior matches today's implementation exactly. Broken files appear inline with the desaturated thumbnail and warning overlay. Clicking the overlay opens the recovery view.

4. Toggling the preference at runtime must trigger `fileStore.refetch()` (or the equivalent re-apply of `updateFromBackend`) so the visible gallery updates immediately without a restart.

5. Existence-check timing: during `updateFromBackend`, files are pushed into `fileList` before the async `fse.pathExists` check completes. The filter pass happens AFTER the batched checks resolve. This means the user may briefly see a file that is about to be hidden (~50-500ms depending on disk IO). Acceptable — mirrors today's behavior where broken overlays pop in after tiles are rendered.

6. Selection hygiene: after the filter splice, `cleanFileSelection()` must run so `uiStore.fileSelection` drops any broken files that the user previously selected.

### Explicit Rejections

- **Do not** add the toggle as a prominent toolbar button in the main action bar — user explicitly rejected cluttering the main UI.
- **Do not** remove the broken-overlay rendering code in `GalleryItem.tsx` / `CalendarGallery.tsx` — when the user opts in (toggle = false), the old behavior must still work.
- **Do not** expose two separate preferences (e.g. "hide in Masonry" vs "hide in List"). One unified preference applies to all browsing contexts.
- **Do not** alter `fetchMissingFiles` — it must continue to show ONLY missing files when explicitly requested.
- **Do not** change `numTotalFiles` (DB-backed total) based on the preference — the total file count is a library-level fact, not a view-level fact.

---

## Holistic Solution

### Approach

1. **Add a library-scoped persistent preference** `hideMissingFilesInBrowsing` to `UiStore`:
   - New observable, default `true`.
   - Add to `PersistentPreferenceFields`, `recoverPersistentPreferences` (with `?? true` fallback), and `getPersistentPreferences`.
   - Add `@action.bound setHideMissingFilesInBrowsing(value: boolean)` and a `@action.bound toggleHideMissingFilesInBrowsing()` helper.

2. **Apply post-existence-check filtering** in `FileStore.updateFromBackend`:
   - Compute `numMissingFiles` BEFORE filtering (so the Outliner badge stays accurate).
   - If the preference is on AND the current content mode is not `Content.Missing`, splice broken files out of `fileList` after the existence-check promise batch resolves.
   - Call `cleanFileSelection()` and bump `fileListLastModified` after the splice.
   - Inside a MobX `transaction` to avoid reaction storms on large libraries (the existing code already uses this pattern — follow it).

3. **Guard the dedicated "Missing" path.** In the new filter branch, explicitly check `!this.showsMissingContent` to ensure `fetchMissingFiles` is never affected.

4. **Add the UI toggle** in `Settings/Appearance.tsx`:
   - Place a `<Toggle>` under the existing Thumbnail section (or create a new "Gallery" section below it).
   - Label: "Show missing files in gallery" (inverted semantic of the preference, so the default `true` for "hide" maps to the checkbox being `unchecked` for "show"). Use `checked={!uiStore.hideMissingFilesInBrowsing}` and a setter that toggles.
   - Add a small helper-text line explaining that the Missing Files recovery view is always available via the warning badge in the Outliner.

5. **Trigger a refetch on toggle.** When the preference changes, call `fileStore.refetch()` so the visible gallery re-applies the filter.

6. **Preserve `numMissingFiles` counting.** Refactor `updateFileListState()` so it counts from the pre-filter list, or compute `numMissingFiles` in the new filter branch explicitly and write to the store property directly.

7. **Documentation update.** Add a short paragraph to `docs/index.md` (or create `docs/missing-files.md`) describing the new preference and how the recovery view interacts with it.

### Expected Outcomes

- Fresh install: user sees clean galleries, no broken tiles. Missing-file badge appears in Outliner if applicable.
- Upgrade: same as fresh install (preference defaults to hide).
- Recovery: clicking the Outliner warning badge continues to show the full list of missing files for triage.
- Opt-in: user finds the Settings → Appearance → Show missing files toggle, enables it, and the old inline broken-tile behavior returns across all gallery modes.
- No performance regression: one additional observable check per existence-check batch; negligible cost.

### Risks and Tradeoffs

- **Visible count discrepancy:** `numTotalFiles` (DB count) vs. `fileList.length` (visible count) will differ when broken files exist. Mitigated by the existing Outliner warning badge making the delta discoverable. Document in the toggle's help text.
- **Brief flash of broken tiles:** Because existence checks run after initial render, there is a ~50-500ms window where broken tiles may appear before being spliced out. Mirrors today's behavior (overlays also pop in late). Acceptable tradeoff vs. blocking the entire gallery on existence checks.
- **Duplicate detection:** `DuplicateGallery` operates on `fileList`. With broken files removed, a missing-but-duplicate file is no longer shown as part of a duplicate group. This is arguably correct behavior (you can't act on a file you can't reach), but verify in QA.
- **SlideMode index stability:** `uiStore.firstItem` is an index into `fileList`. When the preference is toggled during slide mode, the index may point to a different file or become out-of-bounds. Acceptable — `setFirstItem` (line 326 of UiStore.ts) already clamps, and users toggling during slide mode is a rare path.
- **Watcher race:** If Chokidar reports a removal for a currently-visible file, `hideFile` → `debouncedRefetch` path will now remove it from view entirely within ~200ms. Better UX than today's "sit there with a broken overlay forever."

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: a new `docs/missing-files.md` describing the preference and user-visible behavior will be created as part of TASK-025. `docs/index.md` gets a pointer to it.
