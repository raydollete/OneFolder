---
id: INV-021
title: 'Jarring post-encode UX: the source video tears out of SlideMode back to the thumbnail grid the moment ffmpeg exits, then several seconds of blank, feedback-less finalization pass before the new video abruptly opens. Keep the source on-screen (and the media-processing UI up) through finalization, swap seamlessly to the output, and never blind-drop the viewer via refetch/clearSearchCriteriaList.'
reported_bug: 'After a re-encode (or Normalize Audio) completes, the source video closes and the user is returned to the thumbnail index. Several seconds pass with no indication anything is happening, then the new video suddenly pops up. Jarring and unexpected. The source should stay open until the output is ready and then swap seamlessly, OR there should be clear "finalizing…" feedback during the gap.'
date: 2026-06-11
status: pending_qa
superseded_by:
tasks_spawned: [TASK-089, TASK-090, TASK-091, TASK-092]
root_cause_category: order-of-operations
affects:
  - 'Post-encode finalization (src/frontend/stores/FileStore.ts finalizeEncodedOutput:1422-1497) — Step B refetch() (:1435) wholesale-replaces fileList via updateFromBackend(); Step E clearSearchCriteriaList() (:1463) flips content mode to All. Both tear the source out of SlideMode and run with ZERO user-facing feedback for the whole ~2 s awaitWriteFinish + ~3 s DB poll + refetch + waitForIngestedFile window.'
  - 'SlideMode mount gate (src/frontend/containers/ContentView/LayoutSwitcher.tsx:193) — SlideMode is mounted only while `delayedSlideMode && uiStore.firstFileInView`. firstFileInView (UiStore.ts:1275-1278) is fileList[firstItem]; when refetch() replaces fileList and firstItem is left stale, firstFileInView can momentarily return undefined and SlideMode unmounts — the "return to thumbnail grid" the user sees.'
  - 'updateFromBackend (src/frontend/stores/FileStore.ts:1523-1647) — wholesale clear()/push() of fileList (:1572-1573) followed by cleanFileSelection() (:1575) but NO reconciliation of uiStore.firstItem to track the currently-viewed file. removeFilesFromListInPlace (:703-809) DOES reconcile firstItem; the fetch path does not. This is the structural asymmetry that drops the viewer on any refetch while in SlideMode.'
  - 'Content-mode setters (src/frontend/stores/FileStore.ts setContentAll:629-634 / setContentUntagged:636-641 / setContentQuery:622-627 / setContentDuplicates:643-648) — each unconditionally calls disableSlideMode(). The fallback path (clearSearchCriteriaList -> viewAllContent -> fetchAllFiles -> setContentAll) therefore GUARANTEES the viewer tears down even when tags were copied successfully.'
  - 'ImageTools.tsx runMediaJob (src/frontend/components/ImageTools.tsx:39-108) — tears down the progress spinner the instant startMediaJob resolves (setActiveJob(null) is in finally, but the spinner is replaced by finalizeEncodedOutput awaiting silently). No "finalizing…" state spans the ffmpeg-exit -> output-open gap; the lock UI disappears while finalization is still running.'
  - 'Media-processing lock teardown ordering (ImageTools.tsx:99-105 finally) — endMediaProcessing() + setActiveJob(null) run AFTER finalizeEncodedOutput resolves, which is correct for the lock, but the inspector spinner is the only on-screen feedback and it shows encode percent only — there is no finalization phase, so the visible UI is "done" while work continues.'
  - 'INV-020 Normalize Audio (src/frontend/components/ImageTools.tsx, finalizeEncodedOutput) — reuses the exact same finalize helper and runMediaJob orchestration, so it inherits the identical jarring teardown. The fix MUST live in the shared helper + shared inspector UI so both tools benefit.'
---

## Bug Report

### Observed Behavior

The user is viewing a tagged video in **SlideMode** (the Re-encode / Normalize
Audio tools live in the inspector, which is only visible in SlideMode). They
click **Re-encode (x264)**. ffmpeg runs with a progress spinner. When ffmpeg
exits:

1. The source video **closes** — SlideMode tears down and the user is dumped
   back to the thumbnail grid.
2. **Several seconds pass with no indication anything is happening** (no
   spinner, no toast, no progress). The inspector tool UI is gone.
3. The **new video suddenly pops up** in SlideMode, abruptly.

The user describes the flow as "jarring and unexpected."

### Expected Behavior

The user stated two acceptable resolutions:

- **(a) Seamless swap** — the source stays open in SlideMode until the new
  output is ready, then the viewer swaps to the output in place. No trip back to
  the grid.
- **(b) Honest feedback during the gap** — if there must be a finalization
  window, show clear feedback ("Finalizing…" progress/spinner) for its full
  duration, so nothing happens silently.

(a) is preferred; (b) is the floor. The two are combinable: keep the source on
screen AND show a "finalizing…" indicator, then swap.

### Reproduction Context

Deterministic. Reproduces every successful re-encode/normalize from SlideMode.
The "return to grid" is most violent from a **tag-filtered (Query) view** (the
INV-019 repro state), but also occurs from All/Untagged because the refetch
replaces `fileList` and never reconciles `firstItem`. The blank gap is
structural and view-independent: ~2 s `awaitWriteFinish` + up to ~3 s DB poll +
`refetch()` + `waitForIngestedFile()` all run with no UI between the spinner
teardown and the output opening.

---

## Root Cause Analysis

**Category:** order-of-operations (with a wrong-abstraction substrate carried
over from INV-019 and a missing-feedback-state secondary defect)

### Diagnosis

There are **two independent defects** producing the single "jarring" experience.
Both were verified in code (file:line below), not assumed.

#### Defect 1 — The source is torn out of SlideMode by finalization side-effects (the "returns to the thumbnail index" symptom)

In SlideMode, the on-screen file is `uiStore.firstFileInView`:

```
firstFileInView = firstItem < fileList.length ? fileList[firstItem] : undefined
```
(`src/frontend/stores/UiStore.ts:1275-1278`)

SlideMode is mounted ONLY while `delayedSlideMode && uiStore.firstFileInView`
(`LayoutSwitcher.tsx:193`). So the viewer unmounts the instant EITHER
`isSlideMode` goes false OR `firstFileInView` returns `undefined`.

`finalizeEncodedOutput` (`FileStore.ts:1422-1497`) breaks both invariants:

- **Step B, `this.refetch()` (`:1435`)** dispatches to the active fetcher. For a
  tag-filtered view that is `fetchFilesByQuery()` -> `updateFromBackend()`, which
  **wholesale-replaces** the list:
  `this.fileList.clear(); this.fileList.push(...newClientFiles)`
  (`FileStore.ts:1572-1573`), then `cleanFileSelection()` (`:1575`).
  Critically, **`updateFromBackend` never reconciles `uiStore.firstItem`** to
  follow the file the user was viewing. Contrast `removeFilesFromListInPlace`
  (`:703-809`), which snapshots `oldFirstItemId` and re-points `firstItem` to the
  survivor's new index (`:792-807`). The fetch path has no such logic. After the
  replace, `firstItem` (the source's OLD index) points at a different file or out
  of range -> `firstFileInView` can be `undefined` -> **SlideMode unmounts**.
  Even when it is in range, it now shows the WRONG file. The tagless re-encode
  output also does not match a tag filter, so in the filtered view the source's
  position and the list contents shift underneath `firstItem`.

- **Step E, the fallback (`:1463`)** makes teardown *guaranteed*:
  `clearSearchCriteriaList()` -> `viewAllContent()` -> `fetchAllFiles()` ->
  `setContentAll()`, and `setContentAll()` **unconditionally calls
  `disableSlideMode()`** (`FileStore.ts:629-634`). Every content-mode setter does
  this (`:622-648`). So the moment finalization falls through to the fallback —
  which it does whenever the happy-path `waitForIngestedFile` is slow — the
  viewer is explicitly closed.

The root order-of-operations error: **finalization mutates the very state that
keeps the viewer mounted (`fileList` identity/order + `firstItem` + `content`
mode + `isSlideMode`) BEFORE the replacement file is ready to be shown, and
without preserving the viewer's anchor.** The viewer therefore collapses to the
grid, then re-opens once `selectFile(newFile, true) + enableSlideMode()` runs
(`:1449-1450`). The visible "close, wait, pop" is exactly this collapse-and-
reopen.

#### Defect 2 — The finalization window has no user-facing feedback (the "several seconds of nothing" symptom)

The only on-screen feedback during a media job is the inspector spinner in
`ImageTools.tsx` (`:136-147`), driven by local `activeJob`/`jobPercent` state.
That spinner reflects **ffmpeg progress only**. The flow:

1. `startMediaJob` resolves at ffmpeg exit (`ImageTools.tsx:66`).
2. The progress subscription is torn down (`:69-70`).
3. `finalizeEncodedOutput(file, outputPath)` is `await`ed (`:76`) — this is the
   ~2 s `awaitWriteFinish` (`folderWatcher.worker.ts:49`) + up to ~3 s DB poll
   (`copyTagsToOutputPath` MAX_POLLS=15 × 200 ms, `FileStore.ts:1338-1361`) +
   `refetch()` + `waitForIngestedFile()` (up to 10 s) window.
4. `activeJob`/spinner is reset in the `finally` (`:99-104`) — but that only
   fires AFTER finalize resolves. In practice the spinner stays at "100%"/last
   value but `firstFileInView` has unmounted SlideMode (Defect 1), taking the
   whole inspector with it. So the spinner disappears WITH the viewer, leaving a
   bare thumbnail grid and no indication that finalization is in flight.

There is **no "finalizing…" phase** in the state machine. `activeJob` is a
binary encode/idle flag; nothing represents "ffmpeg done, ingesting + tagging +
opening." The lock (`isMediaProcessing`) is still held through finalize (good —
it blocks nav), but it renders no global UI of its own, so the user sees nothing.

### Diagnostic Questions Considered

- **Wrong mental model?** Yes (substrate, inherited from INV-019): the finalize
  helper treats "refetch + select" as a cheap, instantaneous swap, but in
  SlideMode a refetch is a viewer-destroying event because `fileList`/`firstItem`
  are the viewer's mount anchor and the fetch path does not preserve them.
- **Architectural shortcoming?** Yes: there is no "keep the viewer pinned to a
  specific file across a refetch" primitive. `removeFilesFromListInPlace` has
  bespoke firstItem-reconciliation; the fetch path has none; and there is no
  finalization-phase UI state.
- **Incorrect order of operations? — PRIMARY.** Finalization tears down the
  viewer (refetch replaces fileList; fallback flips content mode -> disableSlide)
  BEFORE the output is ready, instead of keeping the source pinned and swapping
  only when the output is in hand.
- **Missing edge case? / missing state — SECONDARY.** No "finalizing" UI state
  spans the ffmpeg-exit -> output-open gap, so the structural delay is invisible.
- **Wrong abstraction?** `firstFileInView`/`firstItem`/`isSlideMode` are an
  index-into-a-mutable-list anchor; any list churn during finalize invalidates
  it. The fix pins by file identity, not by index, across the swap.
- **Silent failure?** Partial: the gap is silent by construction (no toast, no
  spinner), which the user correctly read as "nothing is happening."

### Why this was not caught by INV-019

INV-019 was scoped to **correctness** (tags copied at the DB level before
showing; no partial-file ingestion; honest messaging) and was verified from the
data/correctness angle. It deliberately re-sequenced to "refetch then select"
and explicitly accepted the fallback that flips to All-content. The UX cost of
that re-sequencing in SlideMode — viewer teardown + a feedback-less gap — was out
of INV-019's scope and is the subject of this investigation. **This fix must not
regress INV-019's correctness guarantees** (see Explicit Rejections).

---

## Blast Radius

1. **`FileStore.finalizeEncodedOutput` (`:1422-1497`)** — the orchestration that
   both tools share. It must be reworked to keep the source pinned in SlideMode
   and swap seamlessly, and to surface a finalization phase. This is the single
   place to fix so both Re-encode and Normalize Audio benefit (INV-020 reuses it
   verbatim).

2. **`updateFromBackend` firstItem non-reconciliation (`:1523-1647`)** — the
   structural reason any refetch drops the viewer. Either finalize must avoid a
   viewer-killing refetch, or the swap must re-anchor `firstItem` to the output
   by identity immediately after the list settles (within a single MobX
   transaction so `firstFileInView` never transiently returns `undefined`).

3. **Content-mode setters' unconditional `disableSlideMode()` (`:622-648`)** —
   the fallback path's guaranteed teardown. The finalize fallback must not route
   through `clearSearchCriteriaList()` while in SlideMode without first securing
   the output as the pinned file, or must re-enable slide mode + pin in the same
   transaction.

4. **`ImageTools.tsx runMediaJob` (`:39-108`) + inspector Tools UI
   (`:131-172`)** — needs a finalization-phase state ("Finalizing…") that keeps
   feedback on screen between ffmpeg exit and output open, for BOTH tools. The
   spinner/label is already tool-aware (`progressLabel`, `:119-126`); extend the
   state machine, do not fork per tool.

5. **SlideMode mount gate (`LayoutSwitcher.tsx:193`) / `firstFileInView`
   (`UiStore.ts:1275-1278`)** — the gate that unmounts the viewer when the anchor
   goes stale. Understanding it is required to design the seamless swap (the swap
   must never let `firstFileInView` return `undefined` mid-transition, or use a
   transaction so React never observes the intermediate state).

6. **INV-020 Normalize Audio** — inherits the identical defect; benefits for free
   from the shared-helper + shared-inspector-UI fix. No separate work needed if
   the fix stays in the shared helper and `runMediaJob`.

7. **Timing contributors (secondary, optional):** the ~2 s `awaitWriteFinish`
   (`folderWatcher.worker.ts:49`) is the largest single contributor to the gap.
   It is an INV-019 correctness fix (prevents partial-file ingestion) and MUST
   NOT be naively reduced. The gap can instead be *masked* (keep the source on
   screen + show "Finalizing…") and *overlapped* (begin the DB poll immediately
   at ffmpeg exit — it already does — and let the stabilization run under the
   "finalizing" UI). No timing regression to INV-019 is required to fix the UX.

---

## UX / Requirements Specification

### Purpose

Make the post-encode transition feel deliberate and seamless: the user's source
video stays on screen through finalization, a clear "Finalizing…" indicator
covers the unavoidable stabilization/ingest window, and when the output is ready
the viewer swaps to it in place — never a trip back to the thumbnail grid, never
a silent gap.

### User-Stated Design Decisions

1. **The source must NOT close to the thumbnail index at ffmpeg exit.** —
   The "close, wait, pop" round-trip is the core complaint. Keep the source
   pinned in SlideMode until the output is ready, then swap in place.
2. **Either seamless swap (preferred) or clear finalization feedback (floor).** —
   The user explicitly offered (a) keep source open until output ready then
   seamless swap, OR (b) immediate clear feedback (progress/toast/spinner
   "finalizing…") during the gap. Implement both where possible: pin the source
   AND show a "Finalizing…" state, then swap.
3. **Keep the media-processing UI up through finalization, not just through
   ffmpeg.** — The inspector lock/progress UI should remain visible (in a
   finalization mode) from ffmpeg-exit until the output opens, rather than
   tearing down at ffmpeg-exit.
4. **The fix lives in the shared helper so Normalize Audio benefits too.** —
   INV-020 reuses `finalizeEncodedOutput` and `runMediaJob`; do not fork.

### Behavioral Specifications

**Corrected happy path (source `vacation.mp4` open in SlideMode, tag filter
`Travel` active):**

1. ffmpeg finishes; `startMediaJob` resolves with `outputPath`. The inspector
   transitions the spinner from "Re-encoding… 100%" to a **"Finalizing…"**
   indeterminate state (no percent). The source video REMAINS on screen in
   SlideMode (`isSlideMode` stays true; `firstItem` still points at the source).
2. `finalizeEncodedOutput` runs Step A (`copyTagsToOutputPath`) exactly as today
   (DB-level tag copy, bounded poll, single EXIF/XMP write) — unchanged for
   correctness.
3. The output is brought into `fileList` and SELECTED WITHOUT tearing the viewer
   down: instead of a bare `refetch()` that replaces the list and orphans
   `firstItem`, the swap must, in a single MobX `transaction`:
   - ensure the output ClientFile is present in `fileList` (refetch is fine, but
     the firstItem re-anchor must happen in the SAME transaction as the list
     replacement so React/`firstFileInView` never observes an intermediate
     `undefined`), AND
   - set `uiStore.firstItem` to the output's new index and `selectFile(output,
     true)`, keeping `isSlideMode` true throughout.
   Result: SlideMode never unmounts; the displayed file changes from source to
   output in place.
4. The "Finalizing…" state clears; the inspector returns to its idle Tools view
   for the now-open output.
5. `openDeleteOriginalPrompt(source)` prompts to delete the original (unchanged).

**Fallback when the output is genuinely not visible after the bounded waits:**
Today's Step E flips to All-content via `clearSearchCriteriaList()` (which
disables slide mode). The corrected fallback must, while in SlideMode, secure the
output as the pinned file FIRST (resolve its ClientFile by path from the backend
even if outside the active filter, insert/pin it, keep slide mode) — or, if it
truly cannot be shown, keep the SOURCE on screen and surface the honest toast
(INV-019 wording, never "outside a watched folder" as sole cause) rather than
dumping to an empty/All grid. The viewer must never be left blank.

**Finalization feedback:** From the instant `startMediaJob` resolves until the
output opens (or the honest-toast fallback fires), the inspector shows a
"Finalizing…" indicator (re-using the existing `reencode-progress` spinner
markup, label parameterized like `progressLabel` so Normalize Audio reads
"Finalizing…" too). The media-processing lock stays held the whole time.

### Explicit Rejections

- **Do NOT reduce or remove `awaitWriteFinish` to "fix" the gap.** It is an
  INV-019 correctness guard against partial-file ingestion / range errors. Mask
  the gap with UI, don't shorten the stabilization.
- **Do NOT revert INV-019's order (tags copied at DB level BEFORE showing).**
  Step A stays first and unchanged.
- **Do NOT swap by index across a list churn.** `firstItem` is an index into a
  mutable list; pin by file identity and re-derive the index inside the same
  transaction as any list mutation, so `firstFileInView` is never transiently
  `undefined`.
- **Do NOT route the SlideMode swap through `clearSearchCriteriaList()` /
  content-mode setters** without first pinning the output, because those call
  `disableSlideMode()` unconditionally and will tear the viewer down.
- **Do NOT leave the finalization window feedback-less.** A "Finalizing…" state
  is mandatory even if the seamless swap is implemented.
- **Do NOT fork per-tool.** The fix is in `finalizeEncodedOutput` and
  `runMediaJob`; Normalize Audio must inherit it unchanged.

---

## Holistic Solution

### Approach

Three implementation tasks plus one QA task. The behavioral tasks land in the
shared helper and shared inspector UI so both Re-encode (INV-018) and Normalize
Audio (INV-020) benefit. The QA task is `REQUIRES MANUAL EXECUTION ON WINDOWS`
per docs/TODO/QA-DISCIPLINE.md.

1. **TASK-089 — Seamless in-place SlideMode swap in `finalizeEncodedOutput`.**
   Rework Steps B–E so that, while `isSlideMode` is true, the source stays
   pinned and the output is swapped in place. Concretely: after Step A
   (unchanged), bring the output into `fileList` and re-anchor `uiStore.firstItem`
   to the output's index + `selectFile(output, true)` inside a single MobX
   `transaction`, keeping `isSlideMode` true, so `firstFileInView` never returns
   `undefined` and SlideMode never unmounts. Replace the
   `clearSearchCriteriaList()` fallback with a SlideMode-safe path that resolves
   the output ClientFile by absolute path (independent of the active filter),
   pins it, and only as a last resort keeps the SOURCE on screen + shows the
   honest INV-019 toast. Preserves all INV-019 correctness (tags first, single
   EXIF write, honest messaging). Touches `src/frontend/stores/FileStore.ts`.

2. **TASK-090 — `firstItem` re-anchor primitive on the fetch path (or a pinned-
   file refetch helper).** Give the renderer a reusable way to refetch/replace
   `fileList` while keeping the viewer pinned to a specific file by identity:
   either teach `updateFromBackend` to reconcile `firstItem` toward a caller-
   supplied "pin file id" (mirroring `removeFilesFromListInPlace:792-807`), or add
   a small `FileStore.pinViewedFileAcrossRefetch(file)` helper that TASK-089 uses.
   This removes the structural asymmetry (delete path reconciles firstItem; fetch
   path does not) and prevents ANY future refetch-while-in-SlideMode from blind-
   dropping the viewer. Touches `src/frontend/stores/FileStore.ts`.

3. **TASK-091 — "Finalizing…" inspector phase in `runMediaJob` / ImageTools UI.**
   Add a finalization phase to the media-job state machine so feedback spans the
   ffmpeg-exit -> output-open gap. Introduce a `finalizing` flag (or extend
   `activeJob` with a phase) set right after `startMediaJob` resolves and cleared
   after `finalizeEncodedOutput` returns; render the existing `reencode-progress`
   spinner with a "Finalizing…" label (parameterized per tool, mirroring
   `progressLabel:119-126`) during that phase. Keep the media-processing lock held
   throughout. Because the source now stays in SlideMode (TASK-089), the inspector
   — and thus this indicator — remains mounted and visible. Touches
   `src/frontend/components/ImageTools.tsx` (and SCSS only if a new modifier is
   needed).

4. **TASK-092 — QA the seamless post-encode UX (REQUIRES MANUAL EXECUTION ON
   WINDOWS).** Verify, with captured evidence, the full matrix for BOTH tools
   (Re-encode and Normalize Audio): from a tag-filtered view, from All, from
   Untagged, zero-tag source, name collision, and the genuinely-not-visible
   fallback. Confirm: (1) the source never returns to the thumbnail grid; (2) a
   "Finalizing…" indicator is visible for the whole gap; (3) the viewer swaps to
   the output in place; (4) no INV-019 regression (tags present on the output;
   single EXIF write; no "outside a watched folder" false claim; no
   `net::ERR_REQUEST_RANGE_NOT_SATISFIABLE`); (5) the delete-original prompt still
   appears after the swap. Touches docs + manual verification.

### Expected Outcomes

- Re-encoding/normalizing from SlideMode keeps the source on screen, shows a
  "Finalizing…" indicator through the stabilization/ingest gap, and swaps to the
  output in place — no trip back to the grid, no silent window.
- The structural fetch-path/firstItem asymmetry is closed, so no future
  refetch-in-SlideMode blind-drops the viewer.
- INV-019 correctness is fully preserved; INV-020 Normalize Audio inherits the
  improved UX with no tool-specific code.

### Risks and Tradeoffs

- **Transaction discipline.** The seamless swap depends on mutating `fileList`,
  `firstItem`, `fileSelection`, and `isSlideMode` inside ONE MobX `transaction`
  so React never observes an intermediate `firstFileInView === undefined`. If any
  mutation escapes the transaction, the viewer can flicker/unmount. The QA task
  must specifically watch for a flicker.
- **Pinning a file outside the active filter.** The SlideMode-safe fallback may
  need to show an output that does not match the current query. Pinning it into
  `fileList` for display can transiently violate the "fileList == query result"
  invariant; keep the pin scoped to the swap and let the next user-driven refetch
  reconcile (mirrors how `removeFilesFromListInPlace` tolerates in-place edits).
- **`awaitWriteFinish` latency remains.** The gap is masked, not eliminated; on
  slow drives the "Finalizing…" state can run several seconds. That is the
  correct, honest behavior (INV-019 requires the stabilization). Do not shorten
  it to make the indicator briefer.
- **Lock-held duration.** The media-processing lock now visibly spans
  finalization; that is intended (it already did, silently). Ensure the
  `finally` in `runMediaJob` still releases it on every path (success, failure,
  cancel, and the new finalizing-error path).

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: TASK-091/092 update `docs/reencode-x264.md` "Post-Encode
      Finalization" section to document the in-place SlideMode swap and the
      "Finalizing…" inspector phase (replacing the current "refetch then select"
      description), and note that the source is never returned to the grid.
      TASK-090 adds a `docs/TOOLS.md` note that the fetch path (updateFromBackend)
      does not reconcile firstItem and that any refetch-while-in-SlideMode must
      pin the viewed file by identity.
