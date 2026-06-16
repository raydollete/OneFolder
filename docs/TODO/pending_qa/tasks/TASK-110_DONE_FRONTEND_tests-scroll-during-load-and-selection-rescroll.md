---
id: TASK-110
title: "Tests: firstItem survives scroll-during-fetch; selection-scroll doesn't re-fire on count-only refetch; batch build + manual portable QA"
investigation: INV-028
status: done # planned | in-progress | blocked | done
priority: high # critical | high | medium | low
blocked_by: [TASK-106, TASK-107, TASK-108, TASK-109]
date_created: 2026-06-15
date_completed: 2026-06-15
files:
  - tests/file-store-firstitem-scroll-during-fetch.test.ts
  - tests/virtualized-renderer-selection-rescroll-dom.test.tsx
---

## What

Add automated coverage for INV-028 and run the end-of-batch build + manual portable QA. Two new test files: (1) a FileStore unit test (Node env, modeled on `tests/file-store-generation-gate.test.ts`) proving that `firstItem` moved BETWEEN the sync and async phases of `updateFromBackend` is honored (not overwritten by the start-of-fetch snapshot) when a splice occurs, and untouched when no splice occurs; (2) a rendered jsdom test (`@jest-environment jsdom`) for `VirtualizedRenderer` proving the selection-scroll effect does NOT re-fire `scrollToIndex` on a count-only refetch but DOES on a real selection change.

## Why

The INV-009 generation-gate tests pass straight through this scenario (the generation stays current), so they do not cover it. This task locks in the fix and prevents regression. This fork CAN render real components + clicks in jsdom (see project memory: jsdom rendered-component tests; existing `*-dom.test.tsx` use the `@jest-environment jsdom` pragma).

See [INV-028](../investigations/INV-028_HIGH_FRONTEND_stale-firstItem-snapshot-snaps-scroll-and-selection-back-after-loading.md).

## Implementation Steps

- [x] 1. **FileStore unit test** `tests/file-store-firstitem-scroll-during-fetch.test.ts` (Node env). Model the mock RootStore/backend/FileStore harness on `tests/file-store-generation-gate.test.ts` (`makeMockRootStore`, controllable `fetchFiles` resolver, `configure({ enforceActions: 'never' })`). The mock `uiStore` must expose a writable `firstItem`, a `mediaProcessingFile` (default `undefined`), `hideMissingFilesInBrowsing` (settable `true`), and the surfaces `updateFromBackend` touches.
  - [x] 1a. **Splice case re-anchors to LIVE position.** Set `hideMissingFilesInBrowsing = true`; provide backend files where at least one will be `isBroken` so the async splice runs. Make `fse.pathExists` controllable (mock `fs-extra`) so you can hold the existence check open. Call `fetchAllFiles()` (or `updateFromBackend(files, gen)` directly), let the SYNC pass commit, then SET `uiStore.firstItem` to a NEW index (simulating the user scrolling during the existence check), then resolve the existence check. ASSERT that after the async `.then()`, `uiStore.firstItem` reflects the post-scroll file's identity/new index — NOT the start-of-fetch index.
  - [x] 1b. **No-splice case leaves firstItem untouched.** With `hideMissingFilesInBrowsing = false` and `showVideosOnly = false` (no splice), set `uiStore.firstItem` to a new value after the sync pass, resolve existence checks, and ASSERT the async phase did NOT overwrite `firstItem` (it equals the user's post-scroll value).
  - [x] 1c. **Media-processing pin wins.** With a splice active and `uiStore.mediaProcessingFile` set to a file in the list, ASSERT the async re-anchor targets the pinned file's id regardless of the live `firstItem`.
- [x] 2. **Rendered jsdom test** `tests/virtualized-renderer-selection-rescroll-dom.test.tsx` with `/** @jest-environment jsdom */` pragma at the top. Render `VirtualizedRenderer` (or the smallest wrapper that exercises its effects) with a mock store via the app's `StoreContext`/`useStore` provider. Spy on the `scrollIntoView`/`scrollToIndex` path (e.g. mock `HTMLElement.prototype.scrollIntoView`).
  - [x] 2a. **Count-only refetch does NOT re-scroll selection.** Establish a selection (set `lastSelectionIndex.current` and `fileSelection`), let the initial scroll settle, clear the spy, then trigger a refetch that only changes `numImages`/`fileListLastModified` while the selected file's identity is unchanged. ASSERT `scrollIntoView` is NOT called again for the selection.
  - [x] 2b. **Real selection change DOES scroll.** Change the selected file identity (simulate cursor-key navigation: update `lastSelectionIndex.current` + selection). ASSERT `scrollToIndex` fires for the new selection.
- [x] 3. Run the batched build + tests once for the whole INV-028 set (TASK-106..110): `yarn build` (no TypeScript errors) and `yarn test` (all suites green, including the two new files and the existing `file-store-generation-gate`, `virtualized-renderer`, `sub-process-viewer-pin` suites which must still pass). Per project discipline, do this once at the end, then debug failures.

## Done When

- [x] `tests/file-store-firstitem-scroll-during-fetch.test.ts` passes: splice case re-anchors to the live (post-scroll) position; no-splice case leaves `firstItem` untouched; media-processing pin wins.
- [x] `tests/virtualized-renderer-selection-rescroll-dom.test.tsx` passes: count-only refetch does not re-scroll the selection; real selection change does scroll.
- [x] `yarn build` and `yarn test` both green for the full suite.

## Manual QA / Verification (REQUIRES MANUAL EXECUTION)

Perform on a built/portable run with a library large enough that thumbnail/existence-check loading visibly takes several seconds, and with `hideMissingFilesInBrowsing` ON and/or some broken files present (so the async splice fires).

- [ ] **Scroll-during-load does not snap back:** Launch / trigger a large refetch. While thumbnails are still loading, scroll well away from the top. When loading completes, EXPECT the viewport to stay where you scrolled (no snap-back). Capture evidence (screen recording or before/after screenshots with scroll position visible).
- [ ] **Selection does not get dragged back:** Select a file near the top, scroll past it during loading. When loading completes, EXPECT the viewport to NOT jump back to the still-selected file.
- [ ] **View-mode switch still retains scroll:** Scroll down, switch grid↔list↔calendar and back. EXPECT scroll position retained (regression check for the layout-restore effect).
- [ ] **SlideMode return still scrolls viewed file into view:** Open a file in SlideMode, exit. EXPECT the gallery scrolls so the viewed file is visible.
- [ ] **Media-processing pin still anchors:** Run a media job (e.g. Compress & Normalize Audio) while viewing a file in SlideMode. EXPECT the viewer stays pinned to that file across the refetch (INV-021/INV-023 regression check).
- [ ] **Missing view anchors sensibly:** Enter the Missing-files view after scrolling in the All view. EXPECT it does not scroll to a stale arbitrary position (TASK-108).
- [ ] **SlideMode next-image:** Advance through images with the next-image control. EXPECT no flash/jump to the first image (TASK-109).
