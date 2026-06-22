---
id: INV-035
title: 'Move ffmpeg sub-process operations into a non-blocking bottom queue drawer (reverse the in-viewer pin model)'
reported_bug: "Every ffmpeg operation (rotate, re-encode, normalize-audio, create-clip, subtract-clip) runs inside the video player one at a time and takes over the UI — pinning the viewer, blocking navigation/deletion, and forcing a blocking Keep-which-version modal on completion (and a blocking error modal on failure). The user wants these operations to stop interrupting normal use: requests should go into a persistent, collapsible FIFO queue drawer at the bottom of the interface, one job running at a time and auto-draining, while the user keeps browsing/tagging/viewing. Completed operations wait in the drawer (stacking up) until the user explicitly chooses what to keep."
date: 2026-06-22
status: active
superseded_by:
tasks_spawned: [TASK-138, TASK-139, TASK-140, TASK-141, TASK-142, TASK-143, TASK-144, TASK-145]
root_cause_category: wrong-abstraction
affects:
  - 'Media-job execution location (src/frontend/components/ImageTools.tsx)'
  - 'Viewer-pin / media-processing lock (src/frontend/stores/UiStore.ts)'
  - 'Post-job finalize/anchor (src/frontend/stores/FileStore.ts)'
  - 'Blocking completion/error modals (src/frontend/components/RemovalAlert.tsx, src/frontend/containers/ContentView/index.tsx)'
  - 'New session-scoped queue store + bottom drawer UI (src/frontend/stores/, src/frontend/containers/MediaQueue/)'
  - 'Navigation/delete guards keyed on isMediaProcessing (SlideMode, Main.tsx)'
  - 'Tool documentation (docs/TOOLS.md + per-tool docs)'
---

<!--
  NOTE: This investigation formalizes an already-approved, fully-researched plan.
  The research and design were done and approved before this document was written;
  this is the holistic capture + task decomposition, not a fresh investigation.
  "Root cause" here is the architectural decision being intentionally reversed, not a
  defect diagnosed from scratch.
-->

## Bug Report

### Observed Behavior

Today every ffmpeg media operation (rotate CW/CCW, re-encode x264, normalize-audio,
create-clip, subtract-clip) runs **inside the video player**, one at a time, and
**takes over the UI**:

- `ImageTools.tsx` runs the job in local component state (`activeJob`, `jobPercent`,
  `isFinalizing`) and shows an in-inspector progress spinner.
- `UiStore.beginMediaProcessing` / `setMediaProcessingFile` / `endMediaProcessing`
  **pin the viewer** to the source, then swap it to the output; `isMediaProcessing`
  **blocks navigation and deletion** for the whole job (the INV-021 / INV-023
  "viewer-pin" invariant).
- On completion a **blocking modal** (`DeleteOriginalAfterJob`) forces a
  Keep Modified / Keep Original / Keep Both choice before the user can do anything
  else; failures pop a second blocking modal (`MediaJobErrorAlert`).

### Expected Behavior

Media operations must **stop interrupting normal use**. Instead of running in the
viewer, requests go into a **persistent, collapsible drawer at the bottom of the
interface** showing a FIFO queue (oldest on top). One process runs at a time and the
queue auto-drains, but the user can keep browsing, tagging, and viewing throughout.
Completed operations wait in the drawer — stacking up — until the user explicitly
chooses what to keep.

Spec (verbatim from the approved plan):

- A collapsible drawer spans the bottom of the content area. Rows are ordered by
  request time, **oldest on top**, all statuses in one chronological list.
- Each row has four columns: **Original filename | Operation | Status | Actions**.
  - **Filename** is clickable → opens the **original** in the viewer.
  - **Pending**: Status `Queued`; Actions `[Cancel]`.
  - **Running** (only one at a time): Status `Processing… N%`; Actions `[Cancel]`.
  - **Completed**: Status is a `View Completed` control → opens the **new** file in
    the viewer; Actions `[Keep New] [Keep Original] [Keep Both]`. Row stays until a
    Keep action is chosen (they can stack).
  - **Failed**: Status `Failed` (reveals ffmpeg error detail on click); Actions
    `[Retry] [Dismiss]`.
- Enqueuing/processing/completion never moves the user's viewer or selection or
  blocks input.

### Reproduction Context

Deterministic. Affects any video open in SlideMode where the inspector Tools section
is shown (all five media tools). This is a behavioral reversal of an existing,
intentionally-built model, not a defect — but the current behavior is what the user
is reporting as wrong.

---

## Root Cause Analysis

**Category:** wrong-abstraction (an intentional reversal of a prior architectural decision)

### Diagnosis

The media-job subsystem was built around the assumption that **a media job is a modal
sub-process of viewing a single file**. That assumption is encoded structurally:

- Execution lives in the **viewer's** inspector component (`ImageTools.tsx`), in
  React component-local state, so a job is conceptually bound to the file being
  viewed.
- `UiStore` carries a **global single-job lock** (`mediaProcessing`,
  `mediaProcessingFile`, `isMediaProcessing`) whose entire purpose is to (a) pin the
  viewer to the in-flight file and (b) freeze navigation/deletion so the viewer can
  not move out from under the job (INV-021 / INV-023 "viewer-pin" invariant).
- Completion and failure are surfaced as **blocking modals** (`DeleteOriginalAfterJob`,
  `MediaJobErrorAlert`) because the model assumes the user is waiting on this one job.

The user's requirement — keep browsing/tagging/viewing while jobs run and stack — is
fundamentally incompatible with "a job is a modal sub-process of the current view."
The right abstraction is a **session-scoped, viewer-independent job queue** with a
persistent surface (the bottom drawer). Once jobs no longer happen *in* the viewer,
the viewer-pin/lock and both blocking modals are not merely unnecessary, they are
**obsolete and actively harmful** to the new model, so they are removed. Their
*reusable mechanics* (commit/ingest via `finalizeEncodedOutput`; trash-with-recyclable-check
from `DeleteOriginalAfterJob`) are kept and shared, not the modal/lock wrapping.

This is the same generalized media-job stack validated by INV-018/020/022/030/032;
the only thing changing is **where the job runs and how its lifecycle is surfaced** —
not `FfmpegRunner`, `MediaJobService`, `MEDIA_JOB_SPECS`, or the IPC channels.

### Diagnostic Questions Considered

- **Wrong mental model?** Partially — "a job belongs to the current view" is the
  mental model being corrected.
- **Architectural shortcoming?** Yes — there is no viewer-independent place for a job
  to live or for its result to wait. The drawer + `MediaQueueStore` supplies it.
- **Incorrect order of operations?** No.
- **Missing edge case?** Only the new one introduced by removing the lock (deleting a
  file that is the source of a pending/running job — see Risks).
- **Wrong abstraction?** Yes — the primary finding. A modal-per-view sub-process is
  the wrong abstraction for "fire-and-forget, queue, decide later."
- **Silent failure?** No — failures become loud inline `Failed` rows instead of a
  blocking modal; nothing is swallowed.

---

## Blast Radius

Every area below is touched by the single root change "move media jobs out of the
viewer into a session queue and remove the viewer-pin/lock + blocking modals."

1. **`ImageTools.tsx` execution path** — the in-inspector `runMediaJob` /
   `handleCancel` / progress subscription / `activeJob` / `jobPercent` /
   `isFinalizing` and the entire in-inspector progress UI block
   (`ImageTools.tsx:67-185, 224-283`) are replaced by `mediaQueueStore.enqueue(file,
   jobType, clip)` calls that return immediately. Buttons, the Mark Start/End +
   Create/Subtract Clip fields, and `captureCurrentTime` stay.

2. **`UiStore` media-processing lock/pin** — `mediaProcessing`,
   `mediaProcessingFile`, `isMediaProcessing`, `beginMediaProcessing`,
   `setMediaProcessingFile`, `endMediaProcessing`, `showMediaJobError` /
   `closeMediaJobError` / `mediaJobError`, and the `deleteOriginalAfterJob*` state +
   open/close actions (`UiStore.ts:229-271, 674-742`) all exist only to serve the
   in-viewer model and are removed. `slideFile` simplifies to `firstFileInView`
   (drop the `mediaProcessingFile ??` pin, `UiStore.ts:1381-1383`).

3. **Navigation / delete guards keyed on `isMediaProcessing`** — `SlideMode/index.tsx`
   nav guards (~95-96, 121), the `Main.tsx` delete-shortcut comment (60-64), and
   `UiStore.openMoveFilesToTrash`'s media-processing guard all reference the lock and
   must be removed when the lock is removed.

4. **`FileStore` finalize/anchor coupling** — `finalizeEncodedOutput` and
   `resolveOutputClientFile` currently **anchor the viewer** (`uiStore.firstItem = …`
   + `selectFile`, `FileStore.ts:1459-1460, 1485-1486`). The queue must commit the
   output WITHOUT moving the viewer, so finalize needs a `{ focusViewer }` option
   (default `false`) threaded into `resolveOutputClientFile`. `fileList` injection
   stays unconditional.

5. **Blocking modals + their render sites** — `DeleteOriginalAfterJob` and
   `MediaJobErrorAlert` (in `RemovalAlert.tsx`) and their render sites in
   `ContentView/index.tsx:16-18, 146-147` are deleted. The reusable trash logic
   (release handles → `checkRecyclable` → `trashFile`/`deleteFilePermanently` →
   `fileStore.deleteFiles`, `RemovalAlert.tsx:281-333`) is extracted to a shared
   helper/hook for the queue's Keep actions. `MoveFilesToTrashBin` stays.

6. **New session-scoped queue store** — `MediaQueueStore` owns the queue, serializes
   execution (one `startMediaJob` in flight — the same serialization the
   `isMediaProcessing` gate provided before, now owned by the store), drives the
   drawer, and exposes enqueue/cancel/retry/keep actions + viewer-focus helpers.
   Wired into `RootStore` after `uiStore`.

7. **New bottom drawer UI** — `MediaQueue/index.tsx` (+ `.scss`), an `observer`
   mounted in `Main.tsx` after `<ContentView />` (`Main.tsx:76`), reusing
   `Collapse.tsx`, `IconSet`, `.loading-spinner`, and `AppToaster`.

8. **Documentation** — `docs/TOOLS.md` and the per-tool docs (`reencode-x264.md`,
   `rotate-video.md`, `normalize-audio.md`, `create-clip.md`, `subtract-clip.md`)
   describe the in-viewer pin/lock + blocking Keep modal flow and must be rewritten to
   the queue/drawer flow.

---

## UX / Requirements Specification

### Purpose

Make ffmpeg media operations non-blocking: a persistent bottom queue drawer that
auto-drains one job at a time while the user keeps browsing/tagging/viewing, with
completed outputs waiting in the drawer until the user explicitly chooses what to keep.

### User-Stated Design Decisions (confirmed product decisions)

1. **Commit on completion** — when ffmpeg finishes, immediately tag + commit the new
   file into the watched folder (reuse `finalizeEncodedOutput`). "View Completed"
   opens the real library file; "Keep Original" trashes the committed output; "Keep
   Both" leaves it. *(Rationale: the output is a real file the user may want to view
   before deciding; deferring the commit would mean the "View Completed" control had
   nothing real to open.)*
2. **Inline `Failed` rows** — a failed job becomes a row with a `Failed` status (error
   detail on demand) and `Retry` / `Dismiss` actions. No blocking modal. *(Rationale:
   a failure must not interrupt the user; the detail is available on click.)*
3. **Auto-expand on first job** — drawer auto-opens when the first job is enqueued;
   user can collapse it; collapsed state shows a summary bar with counts. *(Rationale:
   the user should see that work started without losing the ability to dismiss the
   surface.)*
4. **In-memory queue (session only)** — on quit, pending/running jobs are cancelled
   (existing `MediaJobService.killAll` on `before-quit`); completed-undecided outputs
   were already committed, so they simply remain on disk. No persistence/resume.
   *(Rationale: committed outputs are real files that survive on disk; only the
   undecided "which to keep" state is lost, which is acceptable.)*

### Behavioral Specifications

- Rows ordered by request time, oldest on top, all statuses in one chronological list.
- Columns: **Original filename | Operation | Status | Actions**.
  - Filename clickable → opens the **original** in the viewer.
  - Pending: Status `Queued`; Actions `[Cancel]`.
  - Running (one at a time): Status `Processing… N%`; Actions `[Cancel]`.
  - Completed: Status `View Completed` → opens the **new** file; Actions
    `[Keep New] [Keep Original] [Keep Both]`; row persists until a Keep action.
  - Failed: Status `Failed` (click reveals ffmpeg error detail); Actions
    `[Retry] [Dismiss]`.
- Enqueue/process/complete never move the viewer/selection or block input.
- Keep semantics: `Keep New` → trash `source`; `Keep Original` → trash `output` (and
  if the viewer is currently on the output, focus the source); `Keep Both` → just
  remove the row. Each removes its row when done.
- Cancel: pending → splice the row (no ffmpeg starts); running → `cancelMediaJob` (the
  in-flight `runItem` rejects with `MEDIA_JOB_CANCELLED` and removes the row).
- Retry: re-enqueue same `source/jobType/clip`; remove the failed row.

### Explicit Rejections

- Do **not** keep the in-viewer pin/lock — it is obsolete under the queue model and is
  removed (intentional reversal of INV-021 / INV-023).
- Do **not** keep the blocking `DeleteOriginalAfterJob` or `MediaJobErrorAlert` modals
  — completion and failure are inline drawer rows.
- Do **not** persist/resume the queue across sessions.
- Do **not** change the main-process media stack (`MediaJobService`, `FfmpegRunner`,
  `MEDIA_JOB_SPECS`) or the IPC channels — reuse them unchanged.
- Do **not** duplicate the trash flow — extract and share the exact recyclable-check
  flow from `DeleteOriginalAfterJob`.
- Do **not** rewrite `finalizeEncodedOutput`'s ingest/commit — only decouple the
  viewer anchoring behind a `focusViewer` flag.

---

## Holistic Solution

### Approach

A new **renderer-side `MediaQueueStore`** owns the queue, serializes execution (one
`startMediaJob` in flight at a time — no main-process change), and drives a persistent
**bottom drawer** (`MediaQueue/index.tsx`). The trigger buttons in `ImageTools.tsx`
change from "run a job in the viewer" to "**enqueue** a job and return immediately."
The viewer-pin/lock and both blocking modals are removed; their reusable parts
(commit/ingest, keep/trash) are extracted and shared.

Ordered implementation:

1. **TASK-138** — Extract a shared `mediaJobLabel(jobType)` helper
   (`src/frontend/data/mediaJobLabels.ts`) from the label map inlined in
   `ImageTools.tsx`, and extract the reusable trash helper/hook from
   `DeleteOriginalAfterJob` (`RemovalAlert.tsx:281-333`). Pure refactor; no behavior
   change yet (both old and new call sites use the extracted code).
2. **TASK-139** — `FileStore.finalizeEncodedOutput` / `resolveOutputClientFile`: add
   `{ focusViewer?: boolean }` (default `false`); only set `firstItem`/`selectFile`
   when `true`; keep `fileList` injection unconditional.
3. **TASK-140** — New `MediaQueueStore` + `RootStore` wiring (instantiate after
   `uiStore`, `RootStore.ts:59`). Implements `QueueItem`, observables, computeds,
   `enqueue` / `processNext` / `runItem` / `cancel` / `retry` / keep actions /
   `focusFileInViewer`.
4. **TASK-141** — New `MediaQueue/index.tsx` (+ `.scss`) drawer, mounted in `Main.tsx`
   after `<ContentView />`.
5. **TASK-142** — `ImageTools.tsx`: replace the in-inspector run/cancel/progress code
   with `mediaQueueStore.enqueue(...)`; keep all buttons/fields/`captureCurrentTime`;
   remove `disabled={uiStore.isMediaProcessing}` (keep clip-validity disabling).
6. **TASK-143** — Remove the pin/lock from `UiStore` + delete both blocking modals +
   their render sites and every `isMediaProcessing` guard.
7. **TASK-144** — jsdom component/store tests for the queue + drawer.
8. **TASK-145** — Docs: rewrite `docs/TOOLS.md` + per-tool docs to the queue/drawer
   flow and the removal of the in-viewer pin.

### Expected Outcomes

- Triggering any media tool enqueues a job and returns immediately; the drawer
  auto-opens on the first job, oldest on top, one `Processing… N%` at a time.
- The user can browse/tag/view freely while jobs run; completed rows stack with
  `View Completed` + three Keep actions; failed jobs show inline `Failed` + detail +
  `Retry`/`Dismiss`.
- No viewer pin, no navigation/deletion freeze, no blocking completion/error modals.
- `yarn lint`, `yarn test`, `yarn build` pass.

### Risks and Tradeoffs

- **New edge case from removing the lock:** the user may delete a file that is the
  source of a pending/running job. Pending → that job fails loudly (a `Failed` row).
  Running → ffmpeg holds a read handle; deletion may fail and surface the normal
  trash-error toast. Acceptable for v1; an optional guard can be added later.
- **Quit semantics:** pending/running jobs are cancelled on quit (existing
  `MediaJobService.killAll`); completed-undecided outputs were already committed and
  remain on disk with no record of the pending decision. Accepted (decision 4).
- **Reversal of INV-021 / INV-023:** the viewer-pin invariant is intentionally
  retired. Anything that *read* `isMediaProcessing` for correctness must be confirmed
  to be only the pin/nav/delete guards (TASK-143 enumerates every call site).

### User-requirement verification

- "persistent, collapsible drawer at the bottom … FIFO, oldest on top" → TASK-140
  (order) + TASK-141 (drawer). ✓
- "one process at a time, auto-drains" → `processNext` single-running guard, TASK-140. ✓
- "keep browsing/tagging/viewing throughout" → enqueue returns immediately + pin/lock
  removed, TASK-142 + TASK-143. ✓
- "four columns; filename opens original; Completed → View Completed + 3 Keep
  actions; Failed inline + Retry/Dismiss" → TASK-141 + TASK-140. ✓
- "commit on completion (reuse finalizeEncodedOutput)" → TASK-139 (focusViewer:false)
  + TASK-140 `runItem`. ✓
- "auto-expand on first job, collapsible summary bar" → TASK-140 (`isDrawerOpen=true`
  on enqueue) + TASK-141. ✓
- "in-memory only, cancel on quit" → no persistence; existing `killAll`. ✓
- "remove the in-viewer pin and both blocking modals" → TASK-143. ✓

---

## Documentation Updates

- [ ] Updated: `docs/TOOLS.md` (queue/drawer flow; removal of in-viewer pin/lock + Keep modal)
- [ ] Updated: `docs/reencode-x264.md`, `docs/rotate-video.md`, `docs/normalize-audio.md`,
      `docs/create-clip.md`, `docs/subtract-clip.md` (queue/drawer flow)
