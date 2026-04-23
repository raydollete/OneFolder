---
id: TASK-037
title: 'QA: sidebar count parity and content-mode stickiness across all five Content modes'
investigation: INV-007
status: PLANNED
priority: medium
blocked_by: [TASK-034, TASK-035, TASK-036]
date_created: 2026-04-23
date_completed:
files:
  - 'src/frontend/stores/FileStore.ts'
  - 'src/frontend/stores/UiStore.ts'
  - 'src/frontend/stores/LocationStore.ts'
  - 'src/frontend/stores/RootStore.ts'
  - 'src/frontend/containers/Outliner/TagsPanel/TagsTree.tsx'
  - 'src/frontend/containers/Outliner/TagsPanel/index.tsx'
---

## What

Cross-view QA of the INV-007 fixes. For each of the five Content modes (All, Untagged, Missing, Query, Duplicates), verify:

1. **Sidebar count parity** — the count badge next to the selector equals the gallery item count.
2. **Content-mode stickiness across `watchLocations()` completion** — on a fresh launch, clicking the selector and then waiting for `watchLocations` to finish does not flip the view.
3. **Content-mode stickiness across chokidar `add` events** — dropping a new image into a watched folder while in each mode does not flip the view.
4. **Content-mode stickiness across `uiStore.hideMissingFilesInBrowsing` toggle** — toggling the setting triggers a refetch via the FileStore reaction, and the refetch preserves the current content mode.

Produces a QA transcript in the same style as TASK-024 (DISPLAY REQUIRED for visual confirmations, PASS / FAIL / PARTIAL per sub-step, with a short note if PARTIAL).

## Why

INV-007 identified two defects in the Untagged path. The fixes in TASK-034 / TASK-035 / TASK-036 should transparently benefit the other four Content modes too, but only if the race pattern (`clearSearchCriteriaList` inside a non-query fetcher) was isolated to Untagged. This QA pass verifies that assumption and catches any symmetric bug in the other modes.

TASK-024 (INV-004's QA pass) caught BUG-1: a symmetric `numTotalFiles` bug that shipped to pending_qa despite the primary fix working. An explicit cross-view QA pass is cheap and has positive track record.

See [INV-007](../investigations/INV-007_HIGH_FRONTEND_untagged-selector-count-mismatch-and-filter-clobber.md) §Holistic Solution item 4.

Blocked by TASK-034, TASK-035, TASK-036 because the QA pass is validating their combined effect.

## Implementation Steps

- [ ] 1. **Pre-flight setup.** Use a test library with:
  - At least 500 files total
  - At least 50 missing files on disk (to exercise the hide-missing splice path)
  - At least 20 untagged files among the non-missing set
  - At least one tag applied to ~40% of non-missing files (to exercise Query mode)
  - At least one duplicate pair or trio (to exercise Duplicates mode)
  - Verify via DevTools: `rootStore.fileStore.numTotalFiles`, `numUntaggedFiles`, `numMissingFiles` after app startup settles.

- [ ] 2. **All mode sidebar parity.** DISPLAY REQUIRED.

  1. Launch app. Let gallery settle. Content should be `Content.All`.
  2. Note `numTotalFiles` in the "All Images" toolbar badge (TagsPanel/index.tsx line 97).
  3. Scroll through the gallery. Count (approximately) the rendered tiles — or use DevTools to `rootStore.fileStore.fileList.length`.
  4. **Expected:** `numTotalFiles` = raw DB total (e.g. 500). `fileList.length` = visible count (e.g. 450, because 50 missing files were spliced).
  5. **PASS / FAIL:** PASS if `numTotalFiles` shows the DB total AND `fileList.length` matches the visible tile count.
  6. Record result.

- [ ] 3. **All mode stickiness — `watchLocations` completion.** DISPLAY REQUIRED.

  1. With app freshly launched, immediately observe whether the "Looking for new images" toast appears (indicates `watchLocations` is running).
  2. Watch toolbar All badge for ~10 seconds. Content mode should stay at `Content.All`.
  3. **Expected:** no mode flip. `fileStore.showsAllContent === true` throughout.
  4. Record result.

- [ ] 4. **Untagged mode sidebar parity.** DISPLAY REQUIRED.

  1. Click the Untagged selector at the bottom of the Tags panel.
  2. Note the number in parentheses — `Untagged (N)`.
  3. After gallery settles, count tiles or check `fileStore.fileList.length`.
  4. **Expected:** `N` equals `fileList.length` equals visible tile count.
  5. **This is the core INV-007 regression test.** Record result. If PASS, INV-007's user-visible symptom #1 is resolved.

- [ ] 5. **Untagged mode stickiness — `watchLocations` completion.** DISPLAY REQUIRED.

  1. Kill and relaunch the app. Immediately (within 1s of the Outliner appearing) click Untagged.
  2. Wait for the "Looking for new images" toast to disappear (`watchLocations` complete).
  3. **Expected:** content stays in Untagged mode. `fileStore.showsUntaggedContent === true`. Untagged selector stays pressed.
  4. **This is the core INV-007 regression test for the clobber.** Record result.

- [ ] 6. **Untagged mode stickiness — chokidar `add`.** DISPLAY REQUIRED.

  1. With Untagged mode active, drop an image (no tags) into a watched location via OS file explorer.
  2. **Expected:** within ~1-2 seconds, the gallery refreshes. Untagged mode stays. New file appears if it was untagged.
  3. Record result.

- [ ] 7. **Untagged mode stickiness — hide-missing toggle.** DISPLAY REQUIRED.

  1. With Untagged mode active, open Settings → Appearance. Toggle "Hide missing images from browsing views" OFF.
  2. FileStore constructor's `reaction` on `hideMissingFilesInBrowsing` fires → `refetch()` → `fetchUntaggedFiles(true)`.
  3. **Expected:** gallery refreshes; Untagged mode preserved; count updates to the raw DB untagged number (now including missing files).
  4. Toggle back ON. Verify mode preserved and count returns to the visible count.
  5. Record result.

- [ ] 8. **Missing mode sidebar parity.** DISPLAY REQUIRED.

  1. Only possible if `numMissingFiles > 0`. Click the Missing warning badge in the TagsPanel toolbar (Tagspanel/index.tsx line 104-112).
  2. Note `numMissingFiles` badge value and gallery tile count.
  3. **Expected:** they match.
  4. Record result.

- [ ] 9. **Missing mode stickiness — `watchLocations` completion.** DISPLAY REQUIRED.

  1. Relaunch. Click Missing badge immediately.
  2. Wait for `watchLocations` to complete.
  3. **Expected:** mode stays. `fileStore.showsMissingContent === true`.
  4. Record result. (Expected to PASS because `fetchMissingFiles` uses `searchCriteriaList.clear()` directly, bypassing the clobber.)

- [ ] 10. **Query mode sidebar parity.** DISPLAY REQUIRED.

  1. Click a tag in the Tags panel that has files attached (`nodeData.fileCount > 0`).
  2. Note the tag's fileCount in its tooltip (TagsTree.tsx line 398: `tooltip={`${nodeData.path.join(' › ')} (${nodeData.fileCount})`}`).
  3. Gallery populates with Query mode.
  4. Count gallery tiles.
  5. **Expected:** tooltip count equals gallery tile count (approximately — `fileCount` is on the tag, post-filter count depends on hide-missing).
  6. **PARTIAL acceptable** if there is a known off-by-X due to missing-file interplay with `fileCount` that is out of scope for this investigation. Note the delta and continue.
  7. Record result.

- [ ] 11. **Query mode stickiness — `watchLocations` completion.** DISPLAY REQUIRED.

  1. Relaunch. Immediately click a tag.
  2. Wait for `watchLocations`.
  3. **Expected:** mode stays. `fileStore.showsQueryContent === true`.
  4. Record result.

- [ ] 12. **Query mode stickiness — chokidar `add`.** DISPLAY REQUIRED.

  1. With a tag selected, drop an image with that tag in its metadata into the watched folder. If the location is configured to import metadata at load (`importMetadataAtLocationLoading`), the tag will be applied automatically.
  2. **Expected:** gallery refreshes, Query mode preserved, new file appears if it has the tag.
  3. Record result.

- [ ] 13. **Duplicates mode sidebar parity.** DISPLAY REQUIRED (if a Duplicates-mode entry point is exposed in the current UI; if not, skip with N/A).

  1. If accessible: trigger Duplicates mode.
  2. Note any count displayed for duplicates.
  3. Expected parity vs. gallery count.
  4. Record result or N/A.

- [ ] 14. **Duplicates mode stickiness.** DISPLAY REQUIRED (if applicable).

  1. Same as steps 3/5/9/11 for the other modes.
  2. Record result or N/A.

- [ ] 15. **Dev-build regression assertion absence.** DISPLAY REQUIRED.

  1. During steps 2-14, keep the DevTools console open.
  2. **Expected:** no `[INV-007 regression]` warnings fired by the TASK-036 assertion in any step.
  3. If any fired, note which step triggered it and investigate — it indicates a remaining clobber path.
  4. Record result.

- [ ] 16. **Summary table.** Write a PASS / FAIL / PARTIAL / N/A row for each of steps 2-15 in the TASK's body (append a "QA Results" section). For each FAIL or PARTIAL, note the root cause and whether it blocks moving INV-007 forward.

- [ ] 17. **If all PASS:** move INV-007 and TASK-034/035/036/037 to `pending_qa/` as a batch.

- [ ] 18. **If any FAIL:** file a follow-up INV (if root-cause belongs to a separate defect) or reopen the relevant task with the failing step documented. Do not advance until addressed.

- [ ] 19. Commit the QA results update with a message like "QA INV-007: sidebar counts and content-mode stickiness cross-view".

## Done When

- [ ] QA transcript in the task body covers all five Content modes across sidebar-parity, `watchLocations` stickiness, chokidar-add stickiness, and hide-missing-toggle stickiness.
- [ ] All applicable steps are PASS or documented-PARTIAL. No undocumented FAIL.
- [ ] Dev-build `[INV-007 regression]` assertion fired zero times during the QA pass.
- [ ] If all PASS: investigation and related tasks advanced to `pending_qa/`.
- [ ] If any FAIL: follow-up investigation or task filed.
