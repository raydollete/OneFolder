---
id: TASK-046
title: 'QA: stale-fetch filter stickiness across all five Content modes + INV-009 repro matrix'
investigation: INV-009
status: done
priority: high
blocked_by: [TASK-043, TASK-044]
date_created: 2026-04-24
date_completed: 2026-04-26
files:
  - src/frontend/stores/FileStore.ts
  - src/frontend/stores/UiStore.ts
  - src/frontend/stores/LocationStore.ts
  - src/frontend/stores/RootStore.ts
  - src/frontend/containers/Outliner/TagsPanel/TagsTree.tsx
  - src/frontend/containers/Outliner/TagsPanel/index.tsx
  - src/renderer.tsx
---

## What

Replacement for TASK-037. Cross-view QA of the INV-009 fix. Verify filter stickiness across BOTH the initial-scan race (new in INV-009) AND the user-click and chokidar races (from INV-007's TASK-037 coverage). Produce a QA transcript in TASK-024 style (DISPLAY REQUIRED for visual confirmations, PASS/FAIL/PARTIAL per row).

TASK-037 (IN-PROGRESS) should be closed without advancing — its step list assumed INV-007 was complete. Its work is subsumed by this task.

## Why

INV-009 identified that the post-TASK-034 fix left a systemic stale-apply race that affects ALL five Content modes, not just Untagged. The QA pass for TASK-037 was insufficient because (a) it focused on content-mode stickiness and missed the fileList clobber symptom, (b) it may have been run on a test library too small to trigger the initial-scan race. This QA extends coverage with:

- A reproduction-matrix pass covering the five INV-009 repro rows.
- An observability pass confirming `droppedApplyCount` (from TASK-044) behaves correctly.
- A library-size precondition ensuring the initial-scan race can fire.

See [INV-009](../investigations/INV-009_HIGH_FRONTEND_stale-fetch-clobbers-user-filter-via-updateFromBackend.md) §Reproduction Matrix and §Holistic Solution TASK-046.

## Implementation Steps

- [ ] 1. **Pre-flight — library setup.** Ensure the test library satisfies:
  - At least 3000 files, OR an artificial delay (see step 2) to force the race.
  - At least 50 missing files on disk.
  - At least 20 untagged non-missing files.
  - At least one tag applied to 30-50% of non-missing files.
  - At least one duplicate pair.
  - Verify initial `fetchAllFiles` takes >= 3 seconds from launch to `updateFromBackend` completion. Use DevTools Performance tab or add a `console.time('initial-fetch')` / `console.timeEnd` around `RootStore.main`'s `fileStoreInit()` call (temporary, remove before commit).

- [ ] 2. **(Optional but recommended) Dev-only delay injection.** If the test library is smaller than the reporter's, add a temporary artificial delay to make the race deterministic:
  ```ts
  if (IS_DEV && process.env.INV009_INJECT_DELAY_MS) {
    await new Promise(r => setTimeout(r, Number(process.env.INV009_INJECT_DELAY_MS)));
  }
  ```
  Place inside `fetchAllFiles` right after `setContentAll()` and before the backend call. Set `INV009_INJECT_DELAY_MS=5000` to force a 5-second initial fetch. Remove this code before finalizing QA.

- [ ] 3. **Repro Row 1 — Untagged race.** DISPLAY REQUIRED.
  1. Launch `yarn start`. Open DevTools console.
  2. Within 1s of Outliner appearing, click Untagged selector at the bottom of Tags panel.
  3. Gallery populates with untagged files. Note `fileStore.fileList.length`.
  4. Wait 15-30s for initial scan to complete. Watch "Looking for new images" toast disappear.
  5. **Expected:** gallery stays on untagged. `fileStore.fileList.length` unchanged. `content === Content.Untagged`.
  6. **Expected console:** 1-2 `[INV-009] dropped stale apply` debug lines with `phase: 'sync'` and/or `'async'`.
  7. **PASS** if gallery stays and counts match. **FAIL** if gallery reverts to All-mode data.
  8. Record result.

- [ ] 4. **Repro Row 2 — Tag selection race.** DISPLAY REQUIRED.
  1. Relaunch app. Within 1s, click a tag in the Tags tree that has files attached.
  2. Gallery populates with tag's files. Criteria chip appears in Searchbar.
  3. Wait 15-30s.
  4. **Expected:** gallery stays on tag's files. Criteria chip remains. `content === Content.Query`.
  5. Record result.

- [ ] 5. **Repro Row 3 — Multi-tag race.** DISPLAY REQUIRED.
  1. Relaunch. Within 1s, click tag A.
  2. Within another 1-2s, ctrl+click tag B.
  3. Gallery populates with A+B match.
  4. Wait 15-30s.
  5. **Expected:** gallery stays on A+B. Both chips remain.
  6. Record result.

- [ ] 6. **Repro Row 4 — Missing race.** DISPLAY REQUIRED.
  1. Relaunch. Within 1s, click the Missing warning badge (top of TagsPanel).
  2. Gallery populates with missing files.
  3. Wait 15-30s.
  4. **Expected:** gallery stays on missing. `content === Content.Missing`. Missing badge visually pressed.
  5. Record result.

- [ ] 7. **Repro Row 5 — Persisted-criteria launch race.** DISPLAY REQUIRED.
  1. Active search with at least one criterion. Quit app (criteria persist to preferences).
  2. Relaunch. Before the persisted search resolves (within 1s of Outliner), click Untagged.
  3. Gallery populates with untagged files.
  4. Wait 15-30s for persisted `fetchFilesByQuery` to resolve in background.
  5. **Expected:** gallery stays on untagged. `content === Content.Untagged`. No persisted chips.
  6. Record result.

- [ ] 8. **Repro Row 6 — Control (user waits).** DISPLAY REQUIRED.
  1. Relaunch. Wait 30s for scan to complete (toast disappears).
  2. Then click Untagged.
  3. **Expected:** gallery populates and stays. No `[INV-009]` drops (because no stale fetch is in flight).
  4. `window.__inv009.droppedCount === 0`.
  5. Record result.

- [ ] 9. **Repro Row 7 — Chokidar add while filtered.** DISPLAY REQUIRED.
  1. From Row 6's state (Untagged active, scan complete). Drop an untagged image file into a watched folder via OS file explorer.
  2. Wait 1-2s for chokidar `add` → `debouncedRefetch` → `_fetchUntaggedFilesForced` → update.
  3. **Expected:** gallery refreshes, new file appears (if untagged), Untagged mode stays.
  4. No `[INV-009]` drops (legitimate refetch, no staleness).
  5. Record result.

- [ ] 10. **INV-007 regression check.** DISPLAY REQUIRED.
  1. During steps 3-9, watch for `[INV-007 regression]` console warnings.
  2. **Expected:** ZERO such warnings. If any fire, investigate — the INV-009 fix should not reintroduce INV-007's content-mode self-clobber.
  3. Record result.

- [ ] 11. **`numUntaggedFiles` / `numTotalFiles` parity (INV-007 TASK-035 carry-forward).** DISPLAY REQUIRED.
  1. On each mode (All, Untagged, Query, Missing): check the sidebar badge count matches `fileStore.fileList.length` (or the All badge matches `fileStore.numTotalFiles`).
  2. **Expected:** counts match within the rules established by INV-007/TASK-035.
  3. Record result. If any mode's count is wrong, note whether it's a INV-009 regression or a pre-existing INV-007 issue.

- [ ] 12. **Existence-check `.then()` second-pass drop.** DISPLAY REQUIRED.
  1. Inject a longer delay (INV009_INJECT_DELAY_MS=8000) or use a big library.
  2. Relaunch. Within 1s click Untagged.
  3. Watch DevTools console.
  4. **Expected:** both `phase: 'sync'` AND `phase: 'async'` drop messages are emitted (the initial fetchAllFiles hits both guard sites).
  5. If only `sync` fires, the async guard is not correctly installed — FAIL TASK-043.
  6. Record result.

- [ ] 13. **Preview-window smoke test.** DISPLAY REQUIRED.
  1. In the main window, select 2-3 files. Open the preview window (hotkey or menu).
  2. Verify preview renders correctly with those 2-3 files.
  3. Switch selection in main window; reopen preview.
  4. **Expected:** preview shows the new selection, no visual glitch. If INV-009 preview-window generation plumbing (TASK-043 step 6) is missing, there could be a stale-apply issue here too — validate.
  5. Record result.

- [ ] 14. **Summary table.** Append a "QA Results" section to this task file listing each step's PASS/FAIL/PARTIAL with notes.

- [ ] 15. **If all PASS:** move INV-009 and TASK-043/044/045/046 to `pending_qa/`. Also close TASK-037 as superseded by TASK-046 and move to `pending_qa/`.

- [ ] 16. **If any FAIL:** file a follow-up INV (if a distinct defect) or reopen the specific task. Do not advance until addressed. Include the DevTools console output and screenshot in the task file.

- [ ] 17. Commit QA results with a message like "QA INV-009: stale-fetch stickiness cross-mode".

## Done When

- [ ] QA transcript in task body covers all 7 reproduction rows, the two regression checks (INV-007, count parity), the async second-pass check, and the preview-window check.
- [ ] All applicable steps PASS or documented-PARTIAL. No undocumented FAIL.
- [ ] Dev-build `[INV-007 regression]` fired zero times during the QA pass.
- [ ] Dev-build `[INV-009]` drops fired only during the initial-scan-race reproduction rows (1-5), never during the control (6) or the chokidar refetch (7).
- [ ] `window.__inv009.droppedCount` is exposed and readable during QA.
- [ ] If PASS: INV-009 and TASK-043/044/045/046 advanced to `pending_qa/`; TASK-037 marked superseded and moved.
- [ ] If FAIL: follow-up INV or task filed with full diagnostic detail.
