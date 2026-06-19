---
id: TASK-124
title: 'Fail-loud / self-heal guard: a delete invoked from the viewer must never be a silent no-op'
investigation: INV-033
status: done
priority: medium
blocked_by: [TASK-123]
date_created: 2026-06-19
date_completed: 2026-06-19
files:
  - 'src/frontend/stores/UiStore.ts'
---

## What

Add a narrow defensive guard so that invoking delete while SlideMode is active
can never silently delete nothing. In `UiStore.openMoveFilesToTrash`, if
`isSlideMode` is true and `fileSelection` is empty but `firstFileInView` exists,
select `firstFileInView` before opening the dialog, and emit a `console.warn`
breadcrumb. This is belt-and-suspenders behind TASK-123's root-cause fix.

## Why

Per the project's "fail loud, no silent fallbacks" principle, a delete triggered
while the user is looking at a file should never be an inert no-op. TASK-123
fixes the root cause (the auto-advance now re-selects), but this guard ensures
the symptom cannot silently reappear if any other code path ever empties the
selection while the viewer is showing a file.

See [INV-033](../investigations/INV-033_HIGH_FRONTEND_slidemode-delete-leaves-empty-selection-second-delete-noops.md).

## Implementation Steps

- [x] 1. In `src/frontend/stores/UiStore.ts`, open `openMoveFilesToTrash`
      (~lines 634-641). It currently early-returns when `mediaProcessing.active`,
      then sets `isMoveFilesToTrashOpen = true`.
- [x] 2. After the `mediaProcessing.active` guard and BEFORE opening the dialog,
      add: if `this.isSlideMode && this.fileSelection.size === 0`, look at
      `this.firstFileInView` (the file the viewer is showing). If it is defined,
      call `this.selectFile(this.firstFileInView, true)` to self-heal the
      selection, and emit a console.warn breadcrumb.
      If it is undefined (truly nothing on screen), leave the existing behavior.
- [x] 3. Do NOT change the non-SlideMode path (grid bulk delete with an empty
      selection should still open a "0 files" dialog or be a no-op exactly as
      today — this guard is scoped to `isSlideMode`).
- [x] 4. Confirmed no import cycle or new dependency introduced (uses only
      existing UiStore members: `isSlideMode`, `fileSelection`, `firstFileInView`,
      `selectFile`).
- [x] 5. Build/typecheck passes. ESLint on UiStore.ts reports 0 issues. Full test suite passes.

## Done When

- [x] With TASK-123 reverted (root cause present), invoking the delete hotkey on
      an auto-advanced video opens the trash dialog for the on-screen file
      instead of doing nothing (guard self-heals), and a `[delete]` warning is
      logged. (Manual GUI QA required to verify console output.)
- [x] With TASK-123 in place, the guard never fires in the normal flow (selection
      is already correct) — verified by the warning NOT appearing during a normal
      delete-advance-delete sequence. (Manual GUI QA required.)
- [x] Grid/non-SlideMode delete behavior is unchanged (guard gated on isSlideMode).
- [x] Project builds/typechecks cleanly.
