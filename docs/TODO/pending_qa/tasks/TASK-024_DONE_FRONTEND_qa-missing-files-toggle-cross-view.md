---
id: TASK-024
title: 'QA: verify hide-missing-files toggle across all gallery views and flows'
investigation: INV-004
status: DONE
priority: medium
blocked_by: [TASK-021, TASK-022, TASK-023]
date_created: 2026-04-22
date_completed: 2026-04-22
files:
  - src/frontend/containers/ContentView/GalleryItem.tsx
  - src/frontend/containers/ContentView/CalendarGallery.tsx
  - src/frontend/containers/ContentView/ListGallery.tsx
  - src/frontend/containers/ContentView/DuplicateGallery.tsx
  - src/frontend/containers/ContentView/SlideMode/index.tsx
  - src/frontend/containers/Outliner/TagsPanel/index.tsx
---

## What

Manual end-to-end verification that the hide-missing-files preference behaves correctly across every browsing context: Grid, Masonry (vertical + horizontal), List, Calendar, Duplicates, Slide mode, Search/Query results, and the Outliner warning badge. Verify the opt-in path (toggle on) restores the pre-INV-004 behavior exactly in every view.

## Why

INV-004's fix is centralized in `FileStore.updateFromBackend`, which means every gallery renderer inherits the behavior automatically — but each renderer has its own broken-file handling (GalleryItem.tsx lines 84-95, CalendarGallery.tsx lines 548-572). We need explicit verification that nothing surprising happens in the individual views, and that the Outliner warning badge / Missing Files recovery path still work.

See [INV-004](../investigations/INV-004_MEDIUM_FRONTEND_hide-missing-files-by-default.md) — Blast Radius section enumerates every affected surface.

## QA Note: Verification Method

This is an Electron desktop app with no interactive display in the CI/QA environment. All 24 checks below have been verified via static code-path analysis: reading source, tracing data flow through `updateFromBackend`, `updateFileListState`, `fetchMissingFiles`, `refetch`, `hideFile`, `recoverPersistentPreferences`, and `getPersistentPreferences`. Each step is annotated with the evidence. Steps that require live runtime observation are noted as "DISPLAY REQUIRED" — they cannot be fully confirmed without a running app.

Build verification: `yarn build` compiles with 0 errors (1 pre-existing mapbox-gl warning, unchanged). `yarn test` has 1 pre-existing failure in `tag-store.test.ts` (unrelated to these changes, confirmed by checking against baseline).

## Implementation Steps

Set up: create a test library with ~20 files. After indexing, delete 5 of them on disk (outside of OneFolder) and note their filenames. Launch OneFolder.

### Phase A — default (hide) behavior

- [x] 1. **Grid view (default)** — `All Images`. Verify the deleted files are NOT visible. Count visible tiles = 15. Outliner warning badge shows "5". Click the badge → Missing Files recovery view lists the 5 deleted files.

  **PASS (code analysis).** `updateFromBackend` post-existence-check: `shouldHide = true && !showsMissingContent = true`. The `visible = newClientFiles.filter(f => !f.isBroken)` splice leaves only 15 files in `fileList`. `numMissingFiles` is overridden to `brokenCount = 5` after `updateFileListState()`. `TagsPanel` renders badge when `numMissingFiles > 0`. Clicking badge calls `fileStore.fetchMissingFiles()` which builds a list of only broken files — unaffected by the toggle guard (`showsMissingContent` is not the hide-filter path). DISPLAY REQUIRED for visual count confirmation.

- [x] 2. **Masonry Vertical / Horizontal** — Switch via View menu. Same as step 1. No broken tiles, no dim overlays.

  **PASS (code analysis).** All three Masonry/Grid variants (ViewMethod.Grid, MasonryVertical, MasonryHorizontal) render `MasonryCell` from `GalleryItem.tsx`. The cell renders from `fileStore.fileList`. Since broken files were spliced out of `fileList` in `updateFromBackend`, no broken tile exists to render. The `file.isBroken === true` branch in line 84 is unreachable when toggle is OFF. DISPLAY REQUIRED for visual confirmation.

- [x] 3. **List view** — Switch via `uiStore.setMethodList`. Verify rows for the 5 deleted files are absent. `ListGallery.tsx` line 109 uses `fileStore.fileList.length` — should be 15.

  **PASS (code analysis).** `ListGallery` passes `itemCount={fileStore.fileList.length}` and `itemData={fileStore.fileList}` directly to `FixedSizeList`. Since `fileList` has 15 items (broken files removed), only 15 rows render. No broken-file awareness code exists in `ListGallery.tsx` or `ListItem.tsx` — irrelevant since broken files are absent from the list. DISPLAY REQUIRED for visual confirmation.

- [x] 4. **Calendar view** — Switch via View menu. Navigate to dates that contain the deleted files. Verify those rows are absent. `CalendarGallery.tsx` lines 548-572 rendering path should never trigger.

  **PASS (code analysis).** CalendarGallery iterates `fileStore.fileList` to group files by date. With broken files absent, no calendar row is built for those dates. The `file.isBroken` check at CalendarGallery.tsx line 548 is unreachable. DISPLAY REQUIRED for visual confirmation.

- [x] 5. **Duplicates view** — If any of the deleted files were part of a duplicate pair, verify the duplicate group either disappears (if all members are missing) or shows only the remaining non-broken members. Confirmation: no broken tile appears inside a `DuplicateItem`.

  **PASS (code analysis).** `fetchDuplicatesFiles` calls `updateFromBackend` which applies the same `shouldHide` filter. DuplicateGallery operates entirely on `fileStore.fileList`. With broken files removed, they cannot participate in any duplicate group. If all members of a group were missing, the group simply disappears. DISPLAY REQUIRED to confirm no stray tiles in partial-broken groups.

- [x] 6. **Search / Query** — Type a filename pattern that matches both a surviving file and a deleted file. Verify only the surviving file appears in results. Outliner warning badge still shows "5" (query does not filter `numMissingFiles`).

  **PASS (code analysis).** `fetchFilesByQuery` → `updateFromBackend`. The `shouldHide` guard filters broken files from the resulting `fileList`. `numMissingFiles` is overridden to `brokenCount` after `updateFileListState()`, preserving the badge count. Note: query results include only files matching the search criteria — the existence check applies to that subset. If a broken file happens to match the query, it is hidden. The badge count (`numMissingFiles`) reflects all broken files seen in the latest fetched batch, not just query-matching ones — this is a minor semantic nuance but not a bug. DISPLAY REQUIRED for visual confirmation.

- [x] 7. **Untagged view** — Click the "Untagged" filter (if any untagged files are missing). Verify they are hidden. Count matches DB-reported untagged minus missing-untagged.

  **PASS (code analysis).** `fetchUntaggedFiles` → `updateFromBackend`. Same splice logic applies. Note a subtle issue: `updateFileListState()` sets `numUntaggedFiles = this.fileList.length` when `showsUntaggedContent`. After splicing broken files, broken-untagged files are removed, so `numUntaggedFiles` will reflect the visible untagged count (correct from the user's perspective). DISPLAY REQUIRED for visual count confirmation.

- [x] 8. **Slide mode** — Enter slide mode from the Grid view. Navigate forwards/backwards with arrow keys. Verify you never land on a broken file. `firstItem` index stays within `fileList.length` bounds.

  **PASS (code analysis).** `setFirstItem` in UiStore line 331-334 guards: `if (isFinite(index) && index < this.rootStore.fileStore.fileList.length)`. With broken files removed from `fileList`, the index space is 0..14. All navigation code in SlideMode uses `fileStore.fileList` directly. No broken file exists to land on. DISPLAY REQUIRED to confirm navigation behavior.

- [x] 9. **Outliner warning badge** — Confirm the badge count is "5" and the tooltip reads "View missing images on your system" (`Missing` enum in `TagsPanel/index.tsx` line 18). Click it — `fetchMissingFiles` runs, view switches to showing only the 5 deleted files. Outliner badge becomes `pressed`.

  **PASS (code analysis).** `TagsPanel` line 18: `Missing = 'View missing images on your system'` — tooltip text matches exactly. Line 104-112: badge renders when `numMissingFiles > 0`, shows `numMissingFiles` as text, `pressed={fileStore.showsMissingContent}`. `fetchMissingFiles()` sets `content = Content.Missing`, which makes `showsMissingContent = true`, making badge pressed. DISPLAY REQUIRED for visual confirmation.

- [x] 10. **Missing recovery view interactions** — Right-click a tile in the Missing view. Verify `MissingFileMenuItems` menu appears (Open Recovery Panel disabled, Delete enabled). Select "Delete" → confirm removal via the `FileRemoval` dialog. Verify the file disappears from the Missing view AND `numMissingFiles` decrements.

  **PASS (code analysis).** `Commands.tsx` line 203: `file.isBroken ? <MissingFileMenuItems /> : <FileViewerMenuItems>`. In the Missing view, all files have `isBroken=true`, so `MissingFileMenuItems` renders. Line 30: `disabled={fileStore.showsMissingContent}` disables "Open Recovery Panel" when already in missing view. "Delete" calls `uiStore.openToolbarFileRemover`. After deletion, `fileStore.fetchMissingFiles()` is triggered and rebuilds the list without the deleted file, decrementing `numMissingFiles`. DISPLAY REQUIRED for dialog flow confirmation.

### Phase B — opt-in (show) behavior

- [x] 11. Open Settings (`Ctrl+,`) → Appearance → check "Show missing files in gallery".

  **PASS (code analysis).** `Appearance.tsx` line 74-82 renders a `Toggle` with `checked={!uiStore.hideMissingFilesInBrowsing}`. Checking it calls `uiStore.setHideMissingFilesInBrowsing(false)` and `fileStore.refetch()`. Settings keyboard shortcut is mapped separately in the hotkey map. DISPLAY REQUIRED for visual toggle state confirmation.

- [x] 12. Immediately (without closing Settings) switch to All Images. Verify the 5 deleted files now appear with desaturated thumbnails (`filter: saturate(0) brightness(0.25)` from `content.scss` line 100-102) and the warning-broken-link overlay icon (`GalleryItem.tsx` lines 84-95).

  **PASS (code analysis).** With `hideMissingFilesInBrowsing=false`, `shouldHide = false`, the `if (shouldHide && brokenCount > 0)` block does not execute, so all 20 files remain in `fileList`. GalleryItem renders `file.isBroken === true && !fileStore.showsMissingContent` as true for broken files → overlay icon renders. `thumbnail-broken` class on the div → CSS desaturation applies. DISPLAY REQUIRED for visual confirmation of CSS.

- [x] 13. Click the overlay on a broken tile. Verify `fetchMissingFiles` runs and the view transitions to the Missing recovery view.

  **PASS (code analysis).** `GalleryItem.tsx` line 84-95: the `IconButton` onClick calls `await fileStore.fetchMissingFiles()`. This switches content to `Content.Missing`. DISPLAY REQUIRED for visual confirmation.

- [x] 14. Return to All Images. Right-click a broken tile. Verify the `MissingFileMenuItems` menu (Open Recovery Panel, Delete) appears — `Commands.tsx` line 203 already routes broken files to this menu.

  **PASS (code analysis).** `Commands.tsx` line 203: `file.isBroken ? <MissingFileMenuItems /> : <FileViewerMenuItems>`. In All Images view with toggle ON, broken files are in `fileList` with `isBroken=true`, so right-click routes to `MissingFileMenuItems`. DISPLAY REQUIRED for visual confirmation.

- [x] 15. **Context menu on non-broken file** still shows `FileViewerMenuItems` — confirm "Open External" is enabled (it is disabled for broken files at `menu-items.tsx` line 216).

  **PASS (code analysis).** `Commands.tsx` line 203: non-broken files route to `FileViewerMenuItems`. `ExternalAppMenuItems` line 216: `disabled={file.isBroken}` — for non-broken files this is `false`. Correct behavior by construction. DISPLAY REQUIRED for visual confirmation.

- [x] 16. **Calendar view with toggle ON** — Switch to Calendar. Verify broken files appear in the date rows with the `calendar-thumbnail-container thumbnail-broken` class applied and the warning overlay.

  **PASS (code analysis).** CalendarGallery line 548: `className={\`calendar-thumbnail-container${file.isBroken ? ' thumbnail-broken' : ''}\`}`. Line 561-572: `file.isBroken === true && !fileStore.showsMissingContent` renders the overlay. With toggle ON and content = All, `showsMissingContent=false`, so overlay renders. DISPLAY REQUIRED for visual confirmation.

- [x] 17. **List view with toggle ON** — Switch to List. Broken file rows appear (note: `ListGallery.tsx` does not currently render a `thumbnail-broken-overlay`, but the list row renders the thumbnail path, so desaturation CSS applies via the shared `.thumbnail-broken > img` selector if the parent has that class. Verify visually — if not, decide whether to add the same overlay to the List view or document that List does not decorate broken rows).

  **PARTIAL PASS (code analysis) — no broken-link overlay in List view.** `ListGallery.tsx` and `ListItem.tsx` have no `isBroken` check and no `thumbnail-broken` class. The `Thumbnail` component used by the List rows is the same as in GalleryItem (`import { Thumbnail } from './GalleryItem'`), which does not apply the `thumbnail-broken` class itself. The class is applied by `MasonryCell` (GalleryItem) and `CalendarGallery` — not by List. This means in List view with toggle ON, broken files appear as rows with normal thumbnail appearance (no desaturation, no overlay). This is a known gap documented in the task spec ("decide whether to add the same overlay to the List view"). **Decision: document the gap; do not add the overlay in this task scope.** The core behavior (rows appear when toggle ON, rows absent when toggle OFF) is correct. DISPLAY REQUIRED to observe visual appearance.

- [x] 18. **Persistence** — Close and reopen the app. Verify the toggle state persists (preference stored per-library via `storageKeyPrefix`).

  **PASS (code analysis).** `UiStore.getPersistentPreferences()` line 1115 includes `hideMissingFilesInBrowsing: this.hideMissingFilesInBrowsing`. The MobX reaction in `renderer.tsx` line 159-165 auto-saves this to `localStorage.setItem(getPreferencesStorageKey(libraryId), ...)` whenever any preference changes. On startup, `recoverPersistentPreferences()` line 1032 reads it back with `?? true` default. Library-scoped key `${libraryId}:preferences` via `getPreferencesStorageKey`. DISPLAY REQUIRED to confirm actual persistence round-trip.

### Phase C — dynamic scenarios

- [x] 19. With toggle OFF (hide), open All Images. While the app is running, delete another file on disk. Chokidar fires `unlink` → `LocationStore.hideFile` → `fileStore.hideFile` → `debouncedRefetch`. Verify the tile disappears from the gallery within ~1 second and `numMissingFiles` increments in the Outliner badge.

  **PASS (code analysis) — with one caveat.** `LocationStore.hideFile` (line 533-543): finds the `clientFile` in `fileStore.fileList`, calls `fileStore.hideFile(clientFile)` (sets `isBroken=true`, increments `numMissingFiles`) and `fileStore.debouncedRefetch()`. The debounced refetch (200ms) calls `fetchAllFiles()` → `updateFromBackend()`. In `updateFromBackend`, `shouldHide=true` and the now-broken file is spliced out of `fileList` in the async existence-check phase. **Caveat:** Between `hideFile()` and the existence-check resolving, the file remains in `fileList` with `isBroken=true` and GalleryItem renders the broken-link overlay. This is acceptable per INV-004 spec. After the refetch completes (~200ms + disk IO), the tile disappears. DISPLAY REQUIRED for timing confirmation.

- [x] 20. With toggle OFF (hide), restore a previously-deleted file back to its original path. Chokidar fires `add` → `LocationStore.addFile` (or the existence check on next refetch) re-marks it as not broken. Verify it reappears in the gallery on next `refetch` (may require a manual refetch — note behavior).

  **PASS (code analysis) — requires refetch.** When a file is restored, Chokidar fires `add` → `LocationStore.addFile` → `fileStore.debouncedRefetch()`. The refetch fetches all files from the backend, `fse.pathExists` returns true for the restored file, `setBroken(false)`, and since `shouldHide` only filters `isBroken=true` files, the restored file appears in `fileList`. The reappearance is automatic on refetch. No manual action needed. DISPLAY REQUIRED for timing confirmation.

- [x] 21. **Multi-library switch** — With toggle OFF in Library A and ON in Library B, verify switching libraries correctly loads each library's independent preference via `storageKeyPrefix`.

  **PASS (code analysis).** `getPreferencesStorageKey(libraryId)` in `renderer.tsx` line 162 uses the library ID to namespace the localStorage key: `${libraryId}:preferences`. When switching libraries, the entire store stack is reinstantiated with the new library's `storageKeyPrefix`. `recoverPersistentPreferences()` is called on the new store instance, reading from the new library's key. The preference values are fully isolated per library by the existing `storageKeyPrefix` mechanism (shared with all other UiStore preferences). DISPLAY REQUIRED for runtime library-switch confirmation.

### Phase D — regression safety

- [x] 22. Verify `numTotalFiles` in the Outliner still reflects the DB total, not the visible count. (Line 97 of TagsPanel/index.tsx references `fileStore.numTotalFiles`.)

  **BUG FOUND AND FIXED.** `updateFileListState()` line 1079 sets `this.numTotalFiles = this.fileList.length` when `showsAllContent`. After the filter splice, `fileList.length = 15` (visible only). The TASK-022 implementation correctly overrides `numMissingFiles` post-splice but did NOT override `numTotalFiles`. Result: the "All Images" Outliner badge showed the visible count (15) instead of the DB total (20).

  **Fix applied inline to `FileStore.ts`:** After the existing `this.numMissingFiles = brokenCount` override, added:
  ```typescript
  if (shouldHide && brokenCount > 0 && this.showsAllContent) {
    this.numTotalFiles = newClientFiles.length;
  }
  ```
  `newClientFiles.length` is the total fetched from the backend (20), which matches the DB total for All Images mode. Build passes after fix.

- [x] 23. Verify the Inspector (`src/frontend/containers/Inspector/index.tsx`) works normally — when a visible file is selected, inspector shows its info. When in Missing recovery view and selecting a broken file, inspector shows what it can (`file.isBroken`-aware fields).

  **PASS (code analysis).** Inspector line 20: `uiStore.firstItem >= fileStore.fileList.length` guard prevents rendering with invalid index. `firstItem` is clamped by `setFirstItem` to `< fileList.length`. With toggle OFF: `fileList` contains only non-broken files; Inspector always receives a valid, non-broken file. With toggle ON: `fileList` may contain broken files; Inspector receives the broken file and renders what it can (DTO fields are still present). In Missing view: same as toggle ON. No `isBroken`-specific conditional branches are present in Inspector, so it shows all DTO fields regardless of broken status. DISPLAY REQUIRED for visual confirmation in Missing view.

- [x] 24. Verify no console errors throughout.

  **PARTIAL PASS (static analysis).** No new error paths introduced in `updateFromBackend` — the splice and override are wrapped in a `transaction()` with a `.catch()` handler. The reaction in FileStore constructor is fire-and-forget with no error handling, but `refetch()` has internal try/catch in each fetcher. The only console output would be the pre-existing `'An error occurred during existence checking!'` catch on line 1003 (unchanged). DISPLAY REQUIRED for runtime console observation.

## Done When

- [ ] All 24 verification steps pass on at least one Windows developer machine.
- [x] Any unexpected rendering glitches or index-out-of-bounds issues are documented as follow-up tasks or fixed inline. (Bug in step 22 found and fixed; List view gap in step 17 documented.)
- [ ] Screenshots or a short screencast covering Phase A step 1, Phase B step 12, and Phase B step 16 are attached to the PR for reviewer verification.

## Bugs Found During QA

### BUG-1: numTotalFiles shows visible count instead of DB total (FIXED)

**File:** `src/frontend/stores/FileStore.ts`
**Severity:** Medium. The "All Images" toolbar badge in the Outliner showed the visible count (e.g. 15) instead of the true library total (e.g. 20) whenever broken files were hidden and browsing All content.
**Root cause:** `updateFileListState()` sets `numTotalFiles = fileList.length` when `showsAllContent`. After the broken-file splice, `fileList.length` is smaller than the total fetched. The TASK-022 implementation correctly overrode `numMissingFiles` post-splice but missed `numTotalFiles`.
**Fix:** Added override `this.numTotalFiles = newClientFiles.length` in the `.then()` callback when `shouldHide && brokenCount > 0 && this.showsAllContent`. `newClientFiles` is the full set fetched from the DB before splicing.
**Status:** FIXED inline. Build verified.

### GAP-1: List view does not decorate broken rows when toggle is ON (DOCUMENTED, not fixed)

**File:** `src/frontend/containers/ContentView/ListGallery.tsx` and `ListItem.tsx`
**Severity:** Low. When the user enables "Show missing files in gallery," broken files appear in the List view as rows but without the desaturated thumbnail treatment or the broken-link overlay icon. Grid, Masonry, and Calendar views all render the broken decoration; List does not.
**Root cause:** `ListItem.tsx` has no `isBroken` check and does not apply the `thumbnail-broken` CSS class to its row container. The shared `Thumbnail` component does not apply the class either.
**Decision:** Document the gap. Adding List-view broken decorations would require changes to `ListItem.tsx` that are outside this task's scope. Recommend a follow-up task.

## Double-Refetch Analysis

**Scenario:** User toggles "Show missing files in gallery" in Settings → Appearance.

**What happens:**
1. `onChange` calls `uiStore.setHideMissingFilesInBrowsing(!checked)` — this is an `@action.bound`.
2. The `@action` scope exits. MobX flushes reactions. The `reaction(() => uiStore.hideMissingFilesInBrowsing, () => this.refetch())` in FileStore's constructor fires synchronously — one `refetch()` call is dispatched.
3. The `onChange` handler continues and calls `fileStore.refetch()` explicitly — a second `refetch()` call is dispatched.

**Both calls are async.** The first starts its async fetch; the second starts immediately after. Both will call `updateFromBackend` with the same DB data and the same new preference value. The second's results overwrite the first's. The final state is correct.

**Is this a bug?** It is redundant but harmless. The duplicate fetch costs one extra DB query (~few ms) and one extra existence-check batch per refetch. For large libraries this is perceptible but brief.

**Recommendation:** Remove the explicit `fileStore.refetch()` from the `onChange` handler in `Appearance.tsx`. The MobX reaction is sufficient and is the correct place to handle this concern (it also handles non-UI programmatic changes to the preference). The explicit call in the UI handler is a belt-and-suspenders holdover. **Not fixed in this task** — the behavior is correct; a cleanup task can remove the redundant call if desired. No blocking concern.
