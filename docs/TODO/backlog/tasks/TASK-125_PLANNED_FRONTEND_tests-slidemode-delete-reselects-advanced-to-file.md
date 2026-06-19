---
id: TASK-125
title: 'Regression test: SlideMode delete auto-advance re-selects the advanced-to file (selection tracks the viewer)'
investigation: INV-033
status: planned
priority: high
blocked_by: [TASK-123]
date_created: 2026-06-19
date_completed:
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

- [ ] 1. Create `tests/file-store-slidemode-delete-reselect.test.ts`. Model it on
      `tests/file-store-firstitem-scroll-during-fetch.test.ts`: `configure({
      enforceActions: 'never' })`, mock `fs-extra` and `../src/frontend/components/
      Toaster`, and build a mock RootStore whose `uiStore` exposes a writable
      `firstItem`, a real observable `fileSelection` (a `Set<ClientFile>` or the
      observable-set equivalent the store uses), `isSlideMode`, `disableSlideMode`,
      and `selectFile(file, clear)` implemented to mirror the real one (clear then
      add then set `firstItem` to `getIndex(file.id)`).
- [ ] 2. Seed `fileStore.fileList` with a small ordered list (e.g. A..E), run
      `updateFileListState()` so `index` is built, set `uiStore.isSlideMode = true`.
- [ ] 3. Test case "forward advance": set `firstItem` to C's index, seed
      `fileSelection = {C}`, call `removeFilesFromListInPlace([C])`. Assert
      `firstItem` points at D and `fileSelection` contains exactly D (size 1).
- [ ] 4. Test case "tail (backward) advance": `firstItem` -> E (last),
      `fileSelection = {E}`, delete E. Assert `firstItem` -> new tail D and
      `fileSelection` is exactly {D}.
- [ ] 5. Test case "empty list": single-element list [A], on A, `fileSelection =
      {A}`, delete A. Assert `fileList.length === 0`, `disableSlideMode` was
      called, and `fileSelection` is empty.
- [ ] 6. Test case "non-SlideMode delete": `isSlideMode = false`, delete the
      viewed file. Assert `fileSelection` ends EMPTY (grid behavior unchanged)
      and `firstItem` is clamped in range.
- [ ] 7. Test case "viewed file survives a bulk delete of neighbors": delete
      files other than the viewed one while in SlideMode; assert the viewed file
      remains the sole selection at its new index.
- [ ] 8. Run `yarn test` and confirm all new cases pass.
- [ ] 9. Prove the test is meaningful: temporarily revert TASK-123's selection
      write in `removeFilesFromListInPlace`, confirm the forward/tail/bulk cases
      FAIL (selection empty), then restore the fix and confirm they pass. Note
      this in the task as evidence.

## Done When

- [ ] `tests/file-store-slidemode-delete-reselect.test.ts` exists and all cases
      pass under `yarn test`.
- [ ] The forward, tail, and bulk-survivor cases demonstrably fail when the
      TASK-123 selection write is neutralized (proving the test guards the fix).
- [ ] The empty-list and non-SlideMode cases pass, documenting the gated behavior.
