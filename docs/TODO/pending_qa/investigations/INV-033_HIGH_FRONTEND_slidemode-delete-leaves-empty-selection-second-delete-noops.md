---
id: INV-033
title: 'Second consecutive delete in SlideMode silently does nothing: auto-advance reconciles firstItem but never re-selects the advanced-to file, so fileSelection is left empty and the next delete targets nothing'
reported_bug: 'When watching a video and deleting it, the viewer correctly auto-advances to the next video, but the user is then unable to delete THAT next video — the delete action does nothing. Navigating away from the video and back makes delete work again.'
date: 2026-06-19
status: pending-qa
superseded_by:
tasks_spawned: [TASK-123, TASK-124, TASK-125]
root_cause_category: order-of-operations
affects:
  - 'FileStore.removeFilesFromListInPlace (src/frontend/stores/FileStore.ts:716-822) — reconciles uiStore.firstItem to auto-advance SlideMode, and calls cleanFileSelection() which DROPS the deleted file from fileSelection, but never ADDS the advanced-to file back to the selection. After a SlideMode delete the selection is left empty.'
  - 'RemovalAlert.MoveFilesToTrashBin (src/frontend/components/RemovalAlert.tsx:125-258) — the trash dialog and its handleConfirm operate exclusively on uiStore.fileSelection. With an empty selection it deletes nothing (the for-loop body never runs) and fileStore.deleteFiles([]) early-returns. The dialog title also reads "delete 0 files".'
  - 'Main.tsx deleteSelection hotkey (src/frontend/containers/Main.tsx:60-64) — Delete opens openMoveFilesToTrash() which binds to fileSelection; with an empty selection the whole flow is a no-op.'
  - 'menu-items.tsx context-menu Delete (src/frontend/containers/ContentView/menu-items.tsx:231) and DuplicateGallery delete buttons — same selection-bound trash entry point, same empty-selection no-op after an auto-advance.'
  - 'SlideView selection-sync asymmetry (src/frontend/containers/ContentView/SlideMode/index.tsx:62-112) — manual navigation (incrImgIndex/decrImgIndex) and the firstSelectedFile reaction call uiStore.selectFile(..., true), keeping fileSelection in sync with the viewed file. The delete auto-advance path is the ONLY way to change the viewed file WITHOUT updating the selection. The firstSelectedFile reaction self-disposes after its first fire, so it cannot re-sync on later advances — only a remount (navigate away + back) re-establishes it.'
  - 'DeleteOriginalAfterJob.handleKeepOriginal (src/frontend/components/RemovalAlert.tsx:352-371) — already does the right thing for its own flow: after deleting it calls uiStore.selectFile(source, true). This proves the intended invariant (viewed file === selected file) that removeFilesFromListInPlace violates.'
---

## Bug Report

### Observed Behavior

The user is viewing a video in SlideMode (the full-screen one-file-at-a-time
viewer). They press Delete; the trash confirmation appears; they confirm. The
video is correctly trashed and the viewer **auto-advances to the next video**
(this half works — it is the INV-015 fix).

They then press Delete again to remove the now-shown next video. **Nothing
happens.** No confirmation dialog with the file in it, no deletion. The delete
action is silently inert.

If the user navigates away from the video (e.g. arrow-key to another file, or
press Space/Backspace to exit to the grid) and comes back, delete works again —
exactly once — and then the next consecutive delete is inert again.

### Expected Behavior

After an auto-advance following a delete, the viewer is showing a new file and
that file is the implicit target of the next Delete. Pressing Delete again must
open the trash confirmation for the newly-shown file and, on confirm, delete it
and auto-advance again. The user should be able to sit on the viewer and delete
file after file after file, each press advancing to the next — with no need to
navigate away and back to "re-arm" the delete.

### Reproduction Context

**Deterministic.** Any sort mode, any file type (videos are where the user
noticed it because they sit on the viewer deleting; images behave identically).

1. Open any file in SlideMode (double-click a thumbnail, or select + Enter/Space).
2. Press Delete (or right-click -> Delete file). Confirm the trash dialog.
   -> File is trashed; viewer auto-advances to the next file. (Correct.)
3. Press Delete again.
   -> Nothing happens. (Bug.)
4. Arrow-key to a neighbor and back (or exit to the grid and re-open), then
   press Delete. -> Works once. Repeat from step 3.

---

## Root Cause Analysis

**Category:** order-of-operations (a required state update — re-selecting the
advanced-to file — is missing from the auto-advance code path).

### Diagnosis

The delete flow is **selection-driven**, but the auto-advance flow is
**firstItem-driven**, and the two were never reconciled on the auto-advance path.

**The delete target is `uiStore.fileSelection`, not the viewed file.**
Every delete entry point — the `deleteSelection` hotkey
(`Main.tsx:60-64` -> `uiStore.openMoveFilesToTrash()`), the context-menu Delete
(`menu-items.tsx:231`), and the dialog itself
(`RemovalAlert.MoveFilesToTrashBin`, `RemovalAlert.tsx:125-258`) — reads
`uiStore.fileSelection`. `handleConfirm` iterates `for (const file of selection)`
and calls `fileStore.deleteFiles(deleted)`. There is no concept of "delete the
file currently on screen"; the on-screen file is deleted only because, normally,
it is also the selected file.

**Auto-advance updates `firstItem` but empties `fileSelection`.**
`FileStore.removeFilesFromListInPlace` (`FileStore.ts:716-822`) is the in-place
splice helper added by INV-015/TASK-063. After splicing the deleted file out of
`fileList`, it:

1. Calls `this.cleanFileSelection()` (`FileStore.ts:768`), which removes any
   selection entry whose id is no longer in `index` — i.e. it **drops the just-
   deleted file from the selection**.
2. Reconciles `uiStore.firstItem` to the advanced-to file's new index
   (`FileStore.ts:780-821`) so SlideMode shows the next file.

It never calls `selectFile`/`fileSelection.add` for the advanced-to file. So
after a single-file SlideMode delete, `fileSelection` is **empty** while
`firstItem` points at the next file. The viewer shows a file that is not
selected.

**The next Delete therefore targets an empty selection.**
`openMoveFilesToTrash()` opens the dialog (its only guard is `mediaProcessing.
active`, `UiStore.ts:634-641` — not relevant here). The dialog's
`handleConfirm` runs over an empty `selection`, the loop body never executes,
`deleted` is `[]`, and `fileStore.deleteFiles([])` early-returns
(`FileStore.ts:826-828`). Net effect: nothing happens, with no error. (The
dialog title even reads "Are you sure you want to delete 0 files?", though the
user may dismiss it as fast as it appeared, or — depending on how empty
selection renders — perceive "nothing happened".)

**Why navigating away and back fixes it (one delete at a time).**
The selection-vs-viewed-file sync lives entirely in `SlideView`
(`SlideMode/index.tsx`):

- `incrImgIndex`/`decrImgIndex` (`:92-112`) both end with
  `uiStore.selectFile(fileStore.fileList[index], true)` — arrow navigation
  re-selects the viewed file.
- The `firstSelectedFile` reaction (`:62-80`) selects the file on entry, but it
  `reaction.dispose()`s after its first fire, so it does not re-sync on
  subsequent in-viewer changes.

So any **manual** navigation re-selects the viewed file, re-arming exactly one
delete; the auto-advance after that delete again empties the selection, and the
cycle repeats. Exiting to the grid and re-opening remounts `SlideView`, which
re-creates the `firstSelectedFile` reaction and re-selects — same one-shot
re-arm.

**The intended invariant is "viewed file === selected file," and one delete
flow already upholds it.** `DeleteOriginalAfterJob.handleKeepOriginal`
(`RemovalAlert.tsx:352-371`) deletes the output, then sets `firstItem` to the
surviving original AND calls `uiStore.selectFile(source, true)`. That is exactly
the missing step in `removeFilesFromListInPlace`'s auto-advance branch.

### Diagnostic Questions Considered

- **Wrong mental model?** Partly. INV-015/TASK-063 modeled auto-advance purely
  as a `firstItem` reconciliation (which is what drives the *visible* viewer)
  and treated selection cleanup as "remove dead entries" (`cleanFileSelection`)
  rather than "track the viewed file." It missed that the delete command is
  selection-driven, so leaving the selection empty silently disarms the next
  delete.

- **Architectural shortcoming?** Secondary. The deeper smell is that "the file
  the viewer is showing" and "the file(s) the delete command acts on" are two
  separate pieces of state (`firstItem` vs `fileSelection`) kept in sync only by
  scattered `selectFile(..., true)` calls in the SlideView component, with no
  single store-level guarantee. The store mutates `firstItem` directly in
  several places (`removeFilesFromListInPlace`, `reconcileFirstItemTo`,
  `pinViewedFileAcrossRefetch`) and only sometimes updates the selection to
  match.

- **Incorrect order of operations?** **Yes — primary.** The auto-advance branch
  does step "reconcile firstItem" but omits the required co-step "select the
  advanced-to file," which the manual-nav and keep-original paths both perform.

- **Missing edge case?** It is not an edge case — every SlideMode single-file
  delete hits it. It only *looks* edge-casey because the first delete (with a
  freshly-armed selection) works, masking the disarm until the second press.

- **Wrong abstraction?** Mild — see "architectural shortcoming."

- **Silent failure?** **Yes.** `deleteFiles([])` returns with no log, no toast,
  no modal. Consistent with the "fail loud, no silent fallbacks" memory: a
  delete invoked while the viewer is showing a file should never be a silent
  no-op. (Addressed defensively in the solution.)

---

## Blast Radius

1. **`FileStore.removeFilesFromListInPlace` auto-advance branch
   (`FileStore.ts:780-821`).** Root cause. Reconciles `firstItem` without
   re-selecting the advanced-to file. Every `deleteFiles` caller inherits the
   empty-selection-after-SlideMode-delete behavior.

2. **`RemovalAlert.MoveFilesToTrashBin` / hotkey / context-menu delete
   (`RemovalAlert.tsx:125-258`, `Main.tsx:60-64`, `menu-items.tsx:231`).**
   All selection-driven. After an auto-advance the selection is empty, so the
   next invocation deletes nothing. This is the user-visible failure.

3. **`RemovalAlert.FileRemoval` (missing-file cleanup) and
   `DuplicateGallery` delete buttons.** Same selection-driven trash flow; same
   empty-selection no-op if invoked right after a `deleteFiles` that emptied the
   selection while in SlideMode. Lower frequency but identical root cause.

4. **SlideView selection-sync asymmetry
   (`SlideMode/index.tsx:62-112`).** The only places that keep
   `fileSelection` in step with `firstItem` are the arrow-nav handlers and the
   one-shot `firstSelectedFile` reaction. The fix belongs in the store
   (the auto-advance writer) so all callers — including the Preview window and
   any future advance trigger — are covered, rather than patching the
   component.

5. **Bulk delete from SlideMode (multi-selection including the viewed file).**
   After the bulk delete the auto-advance lands on a survivor that is also not
   selected -> same disarm for the next delete. The fix (re-select the advanced-
   to file when in SlideMode) covers this case too.

6. **Preview window (`src/frontend/Preview.tsx`).** Renders the same SlideMode
   and drives `firstItem`. If delete is wired there, it has the same disarm.
   Store-level fix covers it transparently.

7. **Defensive: any code that mutates `firstItem` to move the viewer while in
   SlideMode without re-selecting** (`reconcileFirstItemTo`,
   `pinViewedFileAcrossRefetch`). These are out of scope for the reported bug
   (they re-anchor to the SAME identity the user was already on, so the
   selection — if it was correct — stays correct), but they share the latent
   "viewed != selected" smell. Flagged for awareness; not changed here to avoid
   regressing the media-job pin invariant (INV-021/INV-023).

---

## UX / Requirements Specification

### Purpose

Let the user delete file after file directly from the viewer: each Delete
removes the on-screen file and advances to the next, with no need to navigate
away and back to re-arm the delete. The file shown in SlideMode must always be
the file the next delete acts on.

### User-Stated Design Decisions

1. **"Deleting the auto-advanced video must work without navigating away."** —
   The viewer must stay armed for repeated deletes. Verified feasible: the fix
   is to re-select the advanced-to file in the same `@action` that reconciles
   `firstItem`, mirroring the existing `incrImgIndex`/`decrImgIndex` and
   `DeleteOriginalAfterJob.handleKeepOriginal` behavior.

2. **Auto-advance behavior from INV-015 is preserved.** — Splice in place, no
   refetch, no reshuffle; advance forward (or to the new tail), close SlideMode
   only when the list becomes empty. The fix only ADDS a selection update; it
   does not change which file is advanced to.

### Behavioral Specifications

- **Single-file delete in SlideMode (the reported scenario):**
  Before: `firstItem` -> C (on screen), `fileSelection = {C}`.
  Delete C. After: `firstItem` -> D (the advanced-to file), and
  **`fileSelection = {D}`**. SlideMode shows D; pressing Delete again opens the
  trash dialog for D and deletes it. Repeats indefinitely.

- **Tail delete in SlideMode:**
  Before: `firstItem` -> E (last), `fileSelection = {E}`. Delete E. After:
  `firstItem` -> D (new tail), `fileSelection = {D}`. Delete re-armed on D.

- **Delete that empties the list:**
  Before: `fileList = [A]`, on A, `fileSelection = {A}`. Delete A. After:
  `fileList = []`, SlideMode disabled (existing INV-015 behavior),
  `fileSelection = {}` (nothing to select). The grid shows empty; this is
  correct and there is no "next delete" to arm.

- **Bulk delete in SlideMode (selection includes the viewed file):**
  After the splice, auto-advance lands on a survivor per the existing
  forward/backward scan; that survivor becomes the sole selection so the next
  delete is armed on it.

- **Delete from the grid while NOT in SlideMode:**
  No viewer is showing a single file, so there is no "advance-to" file to
  select. Behavior unchanged: selection becomes empty after delete (the grid is
  not armed for an implicit single-file delete; the user re-selects). The
  re-selection is gated on `uiStore.isSlideMode` so the grid is unaffected.

### Explicit Rejections

- **Do not change the delete command to target the viewed file instead of the
  selection.** That is a larger redesign and would alter grid/bulk semantics.
  The minimal, correct fix is to keep "delete acts on selection" and ensure the
  selection tracks the viewed file while in SlideMode.

- **Do not re-introduce a refetch on delete.** INV-015 removed it deliberately;
  the fix stays within `removeFilesFromListInPlace`'s in-place splice.

- **Do not patch only the SlideView component (e.g. add another reaction).**
  The fix belongs in the store so the Preview window and all `deleteFiles`
  callers are covered, and so the auto-advance and its selection update happen
  atomically in one `@action` (no intermediate empty-selection frame).

- **Do not touch the media-processing pin path
  (`pinViewedFileAcrossRefetch`/`reconcileFirstItemTo`).** Out of scope; changing
  them risks regressing INV-021/INV-023.

---

## Holistic Solution

### Approach

One focused store change plus a small defensive guard and a regression test.

1. **Re-select the advanced-to file in `removeFilesFromListInPlace`
   (TASK-123).** In the two auto-advance branches that set `uiStore.firstItem`
   to a surviving file's new index (the "viewed file was deleted" branch,
   `FileStore.ts:780-813`, and — for completeness — the "viewed file survived"
   branch, `:814-821`), additionally update `uiStore.fileSelection` so the file
   now at `firstItem` is the sole selected file **when `uiStore.isSlideMode` is
   true**. Use the existing idiomatic call `uiStore.selectFile(targetFile,
   true)` (which clears then adds and also sets `firstItem` — confirm it sets
   `firstItem` to the same index we computed, so behavior is unchanged) OR
   directly `fileSelection.replace([targetFile])` to avoid any double-write to
   `firstItem`. Keep it inside the same `@action` so the splice + firstItem +
   selection commit atomically (no empty-selection frame visible to a reaction).
   Gate on `isSlideMode` so grid-only deletes keep their current
   empty-selection behavior. Leave the empty-list branch
   (`FileStore.ts:771-779`) as-is (nothing to select; SlideMode is disabled).

2. **Defensive loud-fail / guard on the delete entry (TASK-124).** Per
   "fail loud, no silent fallbacks": when a delete is invoked while SlideMode is
   active but `fileSelection` is empty, this is a logic error, not a normal
   state. Add a narrow safeguard so a delete from the viewer can never be a
   silent no-op — either (a) in `openMoveFilesToTrash`, if `isSlideMode` and
   `fileSelection.size === 0` but `firstFileInView` exists, select
   `firstFileInView` before opening (self-heals any future regression), and/or
   (b) emit a `console.warn('[delete] empty selection while viewing <file>')`
   breadcrumb. This is belt-and-suspenders behind the TASK-123 fix; it ensures
   the symptom cannot silently recur even if another path empties the selection.

3. **Regression test (TASK-125).** Using the existing mock-RootStore harness
   (`tests/file-store-firstitem-scroll-during-fetch.test.ts` pattern), assert
   that after `removeFilesFromListInPlace([viewedFile])` with
   `uiStore.isSlideMode === true`: `firstItem` points at the expected advanced-to
   file AND `uiStore.fileSelection` contains exactly that file. Add cases for
   forward-advance, tail (backward) advance, empty-list (selection empty +
   SlideMode disabled), and a non-SlideMode delete (selection ends empty,
   firstItem clamped). Prove the test fails with the TASK-123 change reverted.

### Expected Outcomes

- Reported scenario fixed: repeated Delete in the viewer deletes the on-screen
  file and advances, indefinitely, with no navigate-away-and-back needed.
- Selection invariant restored: while in SlideMode, the viewed file is always
  the selected file, matching arrow-nav and `firstSelectedFile`-reaction
  behavior.
- Bulk-in-SlideMode and tail deletes are also re-armed correctly.
- Grid/non-SlideMode delete behavior is unchanged.
- A delete from the viewer can never be a silent no-op again (defensive guard).

### Risks and Tradeoffs

- **Double-write to `firstItem`.** `uiStore.selectFile(file, true)` internally
  calls `setFirstItem(getIndex(file.id))`. Since we already computed the same
  index, this is a redundant but harmless write. To be safe, prefer
  `fileSelection.replace([targetFile])` after the existing `firstItem`
  assignment, OR call `selectFile` and DROP the manual `firstItem` write in that
  branch (single source of truth). Pick one and note it in the task to avoid two
  writers fighting.

- **Reaction ordering.** Doing splice + firstItem + selection in one `@action`
  means MobX flushes reactions once at action end; there is no intermediate
  frame where `firstItem` and `fileSelection` disagree. This avoids any
  SlideView reaction observing an inconsistent state.

- **Grid behavior.** Gating the re-select on `isSlideMode` keeps the grid's
  "delete clears selection" behavior intact. If a future requirement wants the
  grid to also keep a cursor after delete, that is a separate decision.

- **Interaction with the media-job pin.** `removeFilesFromListInPlace` is not on
  the media-job finalize path (that uses `pinViewedFileAcrossRefetch`), and the
  delete dialog is already blocked while `mediaProcessing.active`
  (`openMoveFilesToTrash`). So the new selection write cannot fire mid-encode.
  No interaction with the INV-021/INV-023 pin.

---

## Game Documentation Updates

- [x] Updated: TASK-125 (or TASK-123) adds a one-line note to the FileStore
      mutation-model doc (the `docs/file-store-mutation-model.md` / personal-fork
      notes established by INV-015/TASK-065) stating the invariant: "while in
      SlideMode, an in-place splice that auto-advances the viewer must also
      re-select the advanced-to file, because the delete command is
      selection-driven." Cross-reference INV-015 and INV-033.
