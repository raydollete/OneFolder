---
id: INV-023
title: 'Post-encode/normalize/clip UX, corrected: INV-021''s fix made it WORSE in production — finalization runs but the viewer is still dropped to the thumbnail index, the output never opens in SlideMode, and the "Delete original?" prompt appears 20–30 s later. Real primary cause: every background refetch (the folder watcher''s debouncedRefetch when the new output file appears) routes through a content-mode setter that UNCONDITIONALLY calls disableSlideMode(), so the viewer is torn out of SlideMode the instant the output is detected — and INV-021''s own pinViewedFileAcrossRefetch called refetch(), which disabled SlideMode itself and never re-enabled it. Fix: pin the viewer to the in-flight file by IDENTITY for the whole sub-process (immune to fileList/firstItem churn), make content setters exit SlideMode only on a genuine mode CHANGE (not a same-mode refetch), keep the Inspector pinned too, verify-then-swap source→output only once the output is confirmed openable with tags already copied, and surface ffmpeg failures as a modal that never closes the source.'
reported_bug: 'After testing INV-021 in production it is actually worse. The finalization step does occur, but then the user is dropped back into the index and the new file never opens. SEVERAL seconds later (20–30 s) the "Delete original?" prompt appears.'
date: 2026-06-13
status: pending_qa
supersedes: INV-021
tasks_spawned: [TASK-099]
root_cause_category: order-of-operations
affects:
  - 'Content-mode setters (src/frontend/stores/FileStore.ts setContentQuery/All/Untagged/Duplicates) — each UNCONDITIONALLY called disableSlideMode() while isSlideMode, on EVERY call. fetchAllFiles()/fetchFilesByQuery() call their setter on every refetch, so any background refetch in SlideMode exits SlideMode. The folder watcher fires debouncedRefetch() when the encode OUTPUT appears as a new file (LocationStore.addFile:529), so the output''s own ingestion kicks the user to the grid. THIS is the real primary cause INV-021 missed.'
  - 'INV-021 finalizeEncodedOutput Step B (pinViewedFileAcrossRefetch) — it called this.refetch(), which itself routes through a content-mode setter and disabled SlideMode, then re-anchored firstItem but NEVER re-enabled SlideMode. So the output "never opens in SlideMode": the fix''s own refetch was self-defeating.'
  - 'Three shared firstItem anchors — SlideView (src/frontend/containers/ContentView/SlideMode/index.tsx:54 firstFileInView), the SlideMode mount gate (LayoutSwitcher.tsx:193 firstFileInView), and the Inspector (containers/Inspector/index.tsx:19,27 fileList[firstItem]) all read fileList[firstItem]. updateFromBackend (FileStore.ts) rebuilds fileList WITHOUT reconciling firstItem, so a watcher refetch orphans firstItem → firstFileInView undefined → viewer unmounts AND the Inspector falls back to Placeholder (unmounting ImageTools and destroying its in-flight job + "Finalizing…" state).'
  - '20–30 s delay — copyTagsToOutputPath polled only ~3 s for the DB row, often returning before the row existed; waitForIngestedFile then waited up to 10 s for the output to appear in the FILTERED fileList; the extra pin-refetch and ExifTool writes stacked on top. The "Delete original?" prompt fires after the whole chain (runMediaJob), hence the long, out-of-sequence delay.'
  - 'ffmpeg failures — runMediaJob surfaced hard failures as a transient AppToaster, not a modal. The source happened to stay only incidentally.'
  - 'Shared by Re-encode (INV-018), Normalize Audio (INV-020), and Create Clip (INV-022) — all use runMediaJob + finalizeEncodedOutput, so the fix lands once in the shared helper + shared inspector + the UiStore pin.'
---

## Bug Report

### Observed Behavior (production test of INV-021's fix)

The user re-encodes / normalizes / clips a video open in SlideMode. After INV-021
shipped:

1. Finalization **does** run (tags get copied; "Finalizing…" shows).
2. The user is **still dropped back to the thumbnail index** — SlideMode tears down.
3. The new output file **never opens** in SlideMode.
4. **20–30 seconds later**, the "Delete original?" prompt appears.

This is **worse** than the original INV-021 bug, which at least eventually popped
the output open.

### Controlling Requirements (user `/goal` + clarifications)

When performing a sub-process function (re-encode, normalize audio, create clip):

1. **The user cannot navigate away from the current video** — they can still
   play / pause / seek, but cannot move to another file or leave the viewer. Not
   even for one frame may they be "kicked back to the index."
2. **The viewer switches seamlessly from the source to the destination video** —
   verify-then-swap: the source stays on screen until the output is confirmed
   openable, then the viewer swaps in place.
3. **The destination already carries all of the source's tags** before it is shown.
4. **Any failed conversion (per ffmpeg error output) shows as a modal and does NOT
   close the source video.**

---

## Root Cause Analysis

**Category:** order-of-operations (a background side-effect mutates the viewer's
mount state; the INV-021 fix guarded the wrong refetch).

All four symptoms trace to the SlideMode viewer, its mount gate, and the Inspector
**all being anchored to `fileList[uiStore.firstItem]`**, combined with two
background mutations that fire when the encode output appears:

### Primary cause — background refetch disables SlideMode

`fetchAllFiles()` calls `setContentAll()` and `fetchFilesByQuery()` calls
`setContentQuery()` on **every** invocation, and each content-mode setter
**unconditionally** ran `disableSlideMode()` while `isSlideMode`:

```
setContentAll() { this.content = Content.All; if (isSlideMode) disableSlideMode(); }
```

The folder watcher fires `fileStore.debouncedRefetch()` whenever a **new file**
appears in a watched folder (`LocationStore.addFile:529`). The re-encode output
**is** a new file (and the Step-A EXIF write re-touches it), so the output's own
ingestion triggers `refetch()` → content setter → **`disableSlideMode()`** →
`isSlideMode` false → the viewer unmounts → **"dropped back to the index."**

INV-021's `finalizeEncodedOutput` Step B called `pinViewedFileAcrossRefetch(source)`,
which calls `this.refetch()` — so the **fix's own refetch disabled SlideMode**, and
it never re-enabled it. That is why the output **never opens in SlideMode**: by the
time Step D selected the output, `isSlideMode` was already false.

### Secondary cause — firstItem orphaning tears down the viewer + Inspector

`updateFromBackend` rebuilds `fileList` (`clear()/push()`) but **never reconciles
`firstItem`** (unlike `removeFilesFromListInPlace`). So even independent of the
content-setter bug, a watcher refetch leaves `firstItem` pointing out of range →
`firstFileInView` returns `undefined` →

- the SlideMode mount gate unmounts the viewer (`LayoutSwitcher.tsx:193`), and
- the **Inspector** (`Inspector/index.tsx:19,27`) falls back to its `Placeholder`,
  **unmounting `ImageTools`** and destroying its in-flight `activeJob` /
  `isFinalizing` / progress-subscription state (the "Finalizing…" spinner vanishes).

### The 20–30 s delay

`copyTagsToOutputPath` polled only ~3 s for the output's DB row (created by the
watcher after its ~2 s `awaitWriteFinish` + worker round-trip), so it often gave up
or barely caught it; `waitForIngestedFile` then waited up to 10 s for the output to
appear in the **filtered** `fileList`; the extra pin-refetch and ExifTool writes
stacked on. The "Delete original?" prompt fires only after the whole chain returns,
so it lands 20–30 s late and out of sequence with the (missing) swap.

### Why INV-021 missed it

INV-021 correctly identified the `firstItem`/`fileList` anchor problem but built its
fix on `refetch()` + `pinViewedFileAcrossRefetch`, not realizing **`refetch()` itself
disables SlideMode** via the content setters. Its "atomic firstItem swap" ran while
`isSlideMode` was already false, so the viewer stayed in the grid. The added refetch
+ waits also lengthened the silent window, making the experience worse.

---

## Holistic Solution (implemented)

The robust fix **decouples the viewer from `firstItem` for the whole sub-process**
and stops background refetches from toggling the user's view mode.

1. **Identity pin on UiStore.** `mediaProcessingFile: ClientFile | null` plus a
   `slideFile` computed (`mediaProcessingFile ?? firstFileInView`). `beginMediaProcessing(file)`
   pins the source; `setMediaProcessingFile(output)` performs the seamless swap;
   `endMediaProcessing()` reconciles `firstItem` to the pinned file (injecting it via
   `FileStore.ensureFileInListAt` if the active filter excludes it) and unpins — all
   in one MobX action, so the handoff never blanks the viewer. The SlideMode mount
   gate, `SlideView`, and the Inspector now all read `slideFile`, so no `fileList` /
   `firstItem` churn can tear the viewer or the Inspector down during a job.
   *(Requirements 1 & 2; the Inspector pin keeps the "Finalizing…" spinner alive.)*

2. **Content setters exit SlideMode only on a genuine mode CHANGE.** Each setter now
   guards `disableSlideMode()` with `changed = this.content !== <mode>`. A same-mode
   background refetch — every watcher `debouncedRefetch()` — no longer disables
   SlideMode. This also fixes the general latent bug where any new file detected while
   browsing in SlideMode kicked the user out. *(Primary cause.)*

3. **Verify-then-swap finalize.** `copyTagsToOutputPath` now polls up to ~10 s and
   returns the **tagged `FileDTO`**, so the destination reliably carries the source's
   tags before it is shown (requirement 3). `finalizeEncodedOutput` returns the
   resolved output `ClientFile` (preferring the instance already in `fileList`, else
   built from the tagged DTO and injected at the source's position). The caller swaps
   the pin to it only on success; on a null return it keeps the source and does NOT
   prompt to delete the original. The self-defeating `pinViewedFileAcrossRefetch(source)`
   Step B is gone. *(Requirements 2 & 3.)*

4. **Navigation lockdown.** `disableSlideMode()` is a no-op while a job is active
   (covers the Back button, mouse back-button popstate, and Escape/Backspace), and the
   in-viewer `decrImgIndex`/`incrImgIndex` no-op during processing (covers the
   on-screen NavigationButtons). Arrow keys were already blocked. Play/pause/seek are
   untouched (they act on the `<video>` element, not on navigation). *(Requirement 1.)*

5. **Failure modal.** Hard ffmpeg failures (`ffmpeg exited with code N` + stderr tail
   from `ReEncodeManager`) now open a blocking `MediaJobErrorAlert` (type `danger`)
   that shows the error and explicitly states the original is unchanged and still open.
   The source stays pinned behind it; cancels remain a neutral toast. *(Requirement 4.)*

6. **Dispose guard.** `updateFromBackend` never disposes `uiStore.mediaProcessingFile`,
   so a watcher refetch can't strip the observers off the file currently on screen.

### Files changed

- `src/frontend/stores/UiStore.ts` — `mediaProcessingFile`, `mediaJobError`,
  `slideFile`, `beginMediaProcessing(file)`, `setMediaProcessingFile`,
  `endMediaProcessing` reconcile+unpin, `showMediaJobError`/`closeMediaJobError`,
  `disableSlideMode` job guard.
- `src/frontend/stores/FileStore.ts` — content-setter `changed` guards;
  `copyTagsToOutputPath` returns `FileDTO | null` (10 s poll); `finalizeEncodedOutput`
  returns `ClientFile | null` (verify-then-swap, source-pin step removed);
  `ensureFileInListAt`; dispose guard in `updateFromBackend`.
- `src/frontend/containers/ContentView/LayoutSwitcher.tsx` — mount gate uses `slideFile`.
- `src/frontend/containers/ContentView/SlideMode/index.tsx` — `SlideView` renders
  `slideFile`; nav no-ops during processing.
- `src/frontend/containers/Inspector/index.tsx` — body file uses `slideFile`.
- `src/frontend/components/ImageTools.tsx` — `beginMediaProcessing(file)`; pin swap on
  success; delete prompt only when output verified; failure → modal.
- `src/frontend/components/RemovalAlert.tsx` — `MediaJobErrorAlert`.
- `src/frontend/containers/ContentView/index.tsx` — render `<MediaJobErrorAlert />`.

### Agent-reachable QA performed

- **New tests — `tests/sub-process-viewer-pin.test.ts` (15 tests, all pass)**, including
  **2 integration tests that wire the REAL FileStore + REAL UiStore into one rootStore and
  drive a REAL `refetch()` mid-job** — reproducing the exact INV-021 failure conditions
  (`firstItem` orphaned to a different file, and `firstItem` left out of range so the raw
  `firstFileInView` returns `undefined`) and proving that `isSlideMode` stays true and
  `slideFile` still returns the pinned ClientFile (never the grid, never `undefined`), then
  swaps source→output and hands back to `firstItem` cleanly. Since the renderer
  (LayoutSwitcher mount gate + SlideView + Inspector) is a thin MobX `observer` over exactly
  `slideFile` and `isSlideMode`/`delayedSlideMode`, proving those two values hold through the
  real refetch churn proves the rendered viewer stays mounted on the correct file. The other
  13 tests directly exercise the store-level mechanism behind each requirement:
  - Req 1 (no navigate-away): content-mode setters `disableSlideMode()` only on a real
    mode CHANGE, not a same-mode background refetch; `UiStore.disableSlideMode()` is a
    no-op while a job is active and works again after it ends.
  - Req 2 (seamless swap): `slideFile` returns the pin during a job (else
    `firstFileInView`); `setMediaProcessingFile` swaps source→output by identity;
    `endMediaProcessing` reconciles `firstItem` to the pinned file (injecting via
    `ensureFileInListAt`) and unpins with no blank frame; `finalizeEncodedOutput`
    returns the output ClientFile and never calls `disableSlideMode`; the
    `updateFromBackend` dispose guard never disposes the pinned file (with a control
    case proving non-pinned files still dispose).
  - Req 3 (tags first): `copyTagsToOutputPath` finds the row, sets the source's tag ids
    on the DTO, persists (`saveFiles`), writes the tag hierarchy to EXIF once, and
    returns the tagged DTO; returns null when the row never appears.
  - Req 4 (failure modal): `showMediaJobError`/`closeMediaJobError` drive the modal
    state.
- **Rendered-component GUI test — `tests/sub-process-imagetools-dom.test.tsx` (jsdom, 2
  tests, all pass):** renders the REAL `<ImageTools>` inspector component into a DOM,
  wired to a REAL `UiStore` + `FileStore`, and **dispatches a real click on the real
  "Re-encode (x264)" button** (ffmpeg IPC mocked). It asserts the rendered DOM and the
  observable state the renderer binds to: idle button present → after click the progress
  / "Finalizing…" UI renders, the action button disappears, `isMediaProcessing` is held
  and `disableSlideMode()` is a no-op (req 1), the viewer still shows the source → after
  ffmpeg completes `slideFile` is the OUTPUT, `isSlideMode` never went false, the lock is
  released, the pin is handed back, and the delete-original prompt opens for the source
  (req 2). A second case drives an ffmpeg rejection and asserts the failure-modal state is
  set, the source is kept, and no delete prompt fires (req 4). This executes the literal
  user action and checks the rendered result; only real-ffmpeg + the real Electron
  `SlideMode`/video element + the real OS watcher are out of its reach.
- Full Jest suite: **15 suites / 117 tests pass** (includes the prior
  `file-store-generation-gate`, `file-store-ui-preferences`, `re-encode-manager`,
  `media-release-coordinator`).
- `tsc --noEmit`: clean for all project files (only the inherent dom+webworker
  node_modules lib conflicts from this repo's `tsconfig`).
- ESLint on all touched source files: no new findings (the 6 pre-existing items are in
  code this change did not touch).
- `webpack --config webpack.prod.js`: compiles successfully (only the pre-existing
  mapbox-gl "critical dependency" warning).

The store-level logic is now unit-proven. What remains is the GUI-integration pass on
Windows (does the rendered viewer actually stay put and swap, with real ffmpeg + the
real folder watcher) — the manual gate, TASK-099.

---

## Follow-up fix — production QA round 2 (firstItem orphaning on a TRAILING refetch)

**Reported after the first INV-023 fix shipped:** intermittently, after ffmpeg
finishes, the viewer does NOT show the new video — it jumps to an *unrelated* video
(the new one nowhere to be found), and the "Delete original?" prompt appears while
that unrelated video is playing.

**Root cause this investigation's first pass missed:** `updateFromBackend` (the fetch
path) never reconciled `uiStore.firstItem` — only the delete path
(`removeFilesFromListInPlace:769-813`) did. The INV-023 identity pin masked this only
*during* the job; `endMediaProcessing` releases the pin, and the folder watcher then
fires a **trailing** `debouncedRefetch()` (the post-encode EXIF-write `change` event,
~2 s later, AFTER the pin is gone). That refetch rebuilds `fileList` and leaves
`firstItem` at a now-stale index → `firstFileInView` (and thus `slideFile`, unpinned)
resolves to whatever unrelated file now occupies that index. The content-setter guard
fixed the *teardown*; the *firstItem orphaning* was never fixed.

**Why the first round's tests didn't catch it:** the integration tests fired a refetch
only *during* the pinned window; none fired a refetch *after* `endMediaProcessing`.
That blind spot is now closed.

**Fix:** `FileStore.updateFromBackend` now captures the viewer's anchor file id
(`mediaProcessingFile?.id ?? fileList[firstItem]?.id`) BEFORE replacing `fileList`, and
calls a new `reconcileFirstItemTo(anchorId)` after each rebuild (the synchronous pass
and the async broken/video-only re-filter pass) to re-point `firstItem` to that file by
identity (clamping into range if it is gone). This mirrors the delete path and makes the
viewer survive ANY refetch, at any time — so the pin's release timing no longer matters.

**Verification:** new regression test `tests/sub-process-viewer-pin.test.ts` › "does NOT
jump to an unrelated video on a trailing refetch AFTER the job ends" runs the full job
to completion (pin released), then fires a trailing refetch that reorders the list so an
unrelated file takes the output's old index, and asserts `slideFile` is still the output.
It was confirmed to FAIL with the fix neutralized and PASS with it. Full suite: 15
suites / 118 tests pass; tsc clean; production webpack build green.

---

## Explicit Rejections (carried from INV-019/INV-021)

- Do NOT reduce/remove `awaitWriteFinish` to shorten the gap — it guards against
  partial-file ingestion. Mask the gap with the pinned source + "Finalizing…".
- Do NOT revert INV-019's tags-first order — Step A stays first; tags are copied at
  the DB level (and EXIF once) before the output is shown.
- Do NOT route the SlideMode swap through `clearSearchCriteriaList()` / content-mode
  changes — those (still) exit SlideMode on a real mode change.
- Do NOT leave the finalization window feedback-less — "Finalizing…" stays visible
  (now reliably, because the Inspector is pinned).
- Do NOT fork per-tool — the fix is in the shared `runMediaJob` +
  `finalizeEncodedOutput` + the UiStore pin; Re-encode, Normalize Audio, and Create
  Clip inherit it.

## Game Documentation Updates

- [x] `docs/reencode-x264.md` "Post-Encode Finalization" and `docs/TOOLS.md` should be
      updated to describe the identity-pin model and the content-setter change
      (the fetch path no longer needs `pinViewedFileAcrossRefetch`; the viewer is
      pinned by `uiStore.mediaProcessingFile`, and background refetches no longer exit
      SlideMode). Folded into TASK-099.
