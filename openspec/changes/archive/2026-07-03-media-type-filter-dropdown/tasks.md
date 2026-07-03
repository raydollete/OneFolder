## 1. Shared classifier

- [x] 1.1 In `common/fs.ts`, add `export type MediaTypeFilter = 'all' | 'images' | 'video'` and a helper `export function mediaTypeMatches(filter: MediaTypeFilter, extension: string): boolean` that returns `true` for `'all'`, `isFileExtensionVideo(extension)` for `'video'`, and `!isFileExtensionVideo(extension)` for `'images'`. Reuse the existing `isFileExtensionVideo` list — do not hard-code extensions. evidence: common/fs.ts:52 (type), :57-66 (mediaTypeMatches, switch over isFileExtensionVideo); unit test tests/media-type-filter.test.ts passes.

## 2. UiStore preference (tri-state + migration)

- [x] 2.1 Replace the `@observable showVideosOnly: boolean` field with `@observable mediaTypeFilter: MediaTypeFilter = 'all'`; import `MediaTypeFilter` from `common/fs`. evidence: src/frontend/stores/UiStore.ts:197 (observable, default 'all'), :5 (import).
- [x] 2.2 Replace `setShowVideosOnly`/`toggleShowVideosOnly` with `@action setMediaTypeFilter(value: MediaTypeFilter)`. evidence: src/frontend/stores/UiStore.ts:473-475 (setMediaTypeFilter); `grep setShowVideosOnly src` → none.
- [x] 2.3 In `PersistentPreferenceFields`, replace `'showVideosOnly'` with `'mediaTypeFilter'`. evidence: src/frontend/stores/UiStore.ts:151.
- [x] 2.4 In `getPersistentPreferences`, write `mediaTypeFilter: this.mediaTypeFilter` instead of `showVideosOnly`. evidence: src/frontend/stores/UiStore.ts:1245.
- [x] 2.5 In `recoverPersistentPreferences`, read `mediaTypeFilter` with a strict guard so a malformed value can never reach the gate: set it only if `prefs.mediaTypeFilter` is one of `['all','images','video']`; else if legacy `prefs.showVideosOnly === true` set `'video'`; otherwise (missing, `null`, `false`, or any unrecognized value) set `'all'`. Never leave the field `undefined`. evidence: src/frontend/stores/UiStore.ts:1151-1157 (strict whitelist → legacy boolean → 'all'); migration tests tests/ui-store-media-type-migration.test.ts (6 cases) pass.

## 3. FileStore upstream gate

- [x] 3.1 In `updateFromBackend`, immediately after the hidden-tags filter, apply the media gate to the raw `FileDTO[]` before `filesFromBackend`; capture the pre-gate count for the badge override. evidence: src/frontend/stores/FileStore.ts:1652 (preGateFetchedCount), :1653-1658 (mediaFilterActive gate — fail-safe on 'images'|'video' only — + backendFiles.filter(mediaTypeMatches)), import at :11; gate test asserts fileList==videos-only.
- [x] 3.2 Delete the post-fetch video-only splice block; the async existence-check `.then` no longer does any media handling. evidence: src/frontend/stores/FileStore.ts:1747-1750 (NOTE replacing the removed splice); `grep isFileExtensionVideo src/frontend/stores/FileStore.ts` → none.
- [x] 3.3 Update the `numTotalFiles` override so, in the All-content view, the badge uses the pre-gate fetched count whenever a media filter is active OR hide-missing removed broken files. Keep `numMissingFiles = brokenCount` intact. evidence: src/frontend/stores/FileStore.ts:1782 (numTotalFiles = preGateFetchedCount), guarded by showsAllContent && (broken || mediaFilterActive); numMissingFiles=brokenCount preserved above it; gate test asserts numTotalFiles===4 with 2 visible.
- [x] 3.4 Re-key the `watchUiPreferences` reaction from `uiStore.showVideosOnly` to `uiStore.mediaTypeFilter`. evidence: src/frontend/stores/FileStore.ts:139; tests/file-store-ui-preferences.test.ts passes (reaction wiring).
- [x] 3.5 Verify the gate lives inside the stale-generation guard and that `cleanFileSelection()` in the main transaction drops hidden-media files from selection. evidence: gate at FileStore.ts:1652 sits after the generation early-return at the top of updateFromBackend; cleanFileSelection() runs in the sync transaction against the post-gate fileList (no separate cleanup added).

## 4. Searchbar dropdown

- [x] 4.1 In `Searchbar.tsx`, replace the `Checkbox` with a native `<select>` (three `<option>`s: Show All Media=`all`, Images Only=`images`, Video Only=`video`), `value={uiStore.mediaTypeFilter}`, `onChange` → `setMediaTypeFilter(...)` then `fileStore.refetch()`. Remove the unused `Checkbox` import. evidence: src/frontend/containers/AppToolbar/Searchbar.tsx:26-38 (select + options + onChange), :54 (MediaTypeFilter import); `grep Checkbox Searchbar.tsx` → none.
- [x] 4.2 Add styling for the dropdown in `resources/style/app-toolbar.scss`. evidence: resources/style/app-toolbar.scss:31 (`.media-type-filter` rule; vars --background-color-alt/--border-color/--text-color-muted confirmed to exist).

## 5. Tests

- [x] 5.1 Unit-test `mediaTypeMatches` for all three filters against representative video and image extensions. evidence: tests/media-type-filter.test.ts:22-50 (3 cases); `yarn jest tests/media-type-filter.test.ts` passes.
- [x] 5.2 FileStore gate test: mixed `FileDTO[]` + `mediaTypeFilter==='video'` → `fileList` is videos only (no image ClientFile) and All-view `numTotalFiles` equals the pre-gate count. evidence: tests/media-type-filter.test.ts:107-160 (video/images/all cases assert fileList ids + numTotalFiles===4); passes.
- [x] 5.3 Migration test for `recoverPersistentPreferences`: legacy true→'video', missing/false→'all', unknown/null→'all', valid tri-state honoured, valid value wins over legacy. evidence: tests/ui-store-media-type-migration.test.ts (6 cases); passes.

## 6. Docs

- [x] 6.1 Update `docs/video-only-filter.md` for the tri-state `mediaTypeFilter`, the upstream `FileDTO[]` gate, the dropdown, the legacy migration, and the query-level gate as a future optimization. evidence: docs/video-only-filter.md rewritten (title "Media-Type Filter", §"Filter Implementation — the upstream gate", §"Legacy migration", §"Future optimization: query-level gate").

## 7. Verification (REQUIRES MANUAL EXECUTION — GUI)

- [x] 7.1 Confirm a clean project-source TypeScript compile with no `showVideosOnly` references remaining. evidence: `yarn tsc --noEmit` → zero errors in project source (only pre-existing node_modules dom/webworker lib-collision errors); `grep showVideosOnly src` → only the intentional legacy-migration read at UiStore.ts:1157; `yarn eslint` on all changed files → clean.
- [x] 7.2 In the running app, select "Video Only" and confirm images do NOT flash into the grid before disappearing; select "Images Only" and confirm videos are absent; select "Show All Media" and confirm both return. Capture evidence per `docs/TODO/QA-DISCIPLINE.md`. evidence: manually validated by the user (Ray) on 2026-07-03 — filtering behaves correctly with no image-flash under Video/Images Only.
- [x] 7.3 Confirm the selection persists across an app restart and is isolated per library. evidence: manually validated by the user (Ray) on 2026-07-03.
