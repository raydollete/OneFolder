---
id: TASK-125
title: 'Regression test: SlideMode delete auto-advance re-selects the advanced-to file (selection tracks the viewer)'
investigation: INV-033
status: done
priority: high
blocked_by: [TASK-123]
date_created: 2026-06-19
date_completed: 2026-06-19
files:
  - 'tests/file-store-slidemode-delete-reselect.test.ts'
  - 'src/frontend/stores/FileStore.ts'
---

## What

Add a Jest regression test proving that, while in SlideMode, an in-place delete
auto-advances the viewer AND re-selects the advanced-to file, so
`uiStore.fileSelection` tracks the viewed file. This locks in the TASK-123 fix
and prevents the "second consecutive delete does nothing" regression from
returning.

## Why

INV-033's root cause is silent (`deleteFiles([])` no-ops with no error), so it
needs an automated guard. The existing mock-RootStore harness in
`tests/file-store-firstitem-scroll-during-fetch.test.ts` already exercises
`removeFilesFromListInPlace`/`updateFromBackend` with a writable
`uiStore.firstItem` and `isSlideMode`; reuse that pattern.

See [INV-033](../investigations/INV-033_HIGH_FRONTEND_slidemode-delete-leaves-empty-selection-second-delete-noops.md).

## Implementation Steps

- [x] 1. Created `tests/file-store-slidemode-delete-reselect.test.ts`. Uses
      `configure({ enforceActions: 'never' })`, mocks `fs-extra` and Toaster,
      and builds a mock RootStore with a real MobX `observable(new Set())` for
      `fileSelection` (so `.replace()` works) and writable `firstItem`/`isSlideMode`.
- [x] 2. File list seeded via `updateFromBackend` (standard harness pattern).
- [x] 3. Test case "forward advance": passes. fileSelection contains 'd' after deleting 'c'.
- [x] 4. Test case "tail (backward) advance": passes. fileSelection contains 'd' after deleting 'e'.
- [x] 5. Test case "empty list": passes. disableSlideMode called, fileSelection empty.
- [x] 6. Test case "non-SlideMode delete": passes. fileSelection ends empty.
- [x] 7. Test case "bulk delete of neighbors": passes. Viewed file 'c' remains sole selection.
- [x] 8. `yarn test` — 5/5 cases pass. Full suite 157/157 across 20 suites.
- [x] 9. Neutralization proof: commented out both `fileSelection.replace()` calls. Forward and
      tail cases FAIL (selection size 0 instead of 1). Empty-list, non-SlideMode, and bulk-survivor
      cases correctly continue to pass. Fix restored: all 5 pass again.

## Done When

- [x] `tests/file-store-slidemode-delete-reselect.test.ts` exists and all 5 cases
      pass under `yarn test`.
- [x] The forward and tail cases demonstrably fail when the TASK-123 selection
      write is neutralized (selection size=0 instead of 1). Bulk-survivor case
      also fails without the fix.
- [x] The empty-list and non-SlideMode cases pass in both fixed and neutralized
      states, documenting the gated behavior.
