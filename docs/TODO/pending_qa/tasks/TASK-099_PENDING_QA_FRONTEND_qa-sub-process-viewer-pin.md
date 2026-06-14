---
id: TASK-099
investigation: INV-023
title: 'QA the corrected sub-process viewer-pin UX (REQUIRES MANUAL EXECUTION ON WINDOWS)'
status: pending_qa
type: qa
component: FRONTEND
supersedes: TASK-092
---

# TASK-099 — QA the corrected sub-process viewer-pin UX

**REQUIRES MANUAL EXECUTION ON WINDOWS.** Per `docs/TODO/QA-DISCIPLINE.md`, only the
human QA executor may tick the `[x]` boxes, and this task may not move to
`completed/` until at least one step has produced concrete evidence (screenshot,
captured log line, or screen recording) pasted in or linked below.

Implementation (INV-023) is complete and passed all agent-reachable checks: typecheck,
lint, **full Jest suite (15 suites / 117 tests)**, and a production webpack build. The
automated coverage now includes:

- `tests/sub-process-viewer-pin.test.ts` — 15 store-level + integration tests (pin by
  identity, content-setter guard, verify-then-swap, dispose guard, plus 2 real
  `FileStore`+`UiStore` integration tests driving a real `refetch()` through the INV-021
  failure conditions).
- `tests/sub-process-imagetools-dom.test.tsx` — a **jsdom rendered-component test that
  dispatches a real click on the real "Re-encode (x264)" button** and asserts the
  rendered progress UI, the navigation lock, the source→output `slideFile` swap, the
  delete prompt, and the failure-modal path.

So the click→pin→swap→prompt flow and the failure→modal flow are executed and asserted
against the rendered component. What **only a human on Windows** can still confirm is the
same flow against the **real Electron `SlideMode` renderer + real ffmpeg + the real OS
folder watcher** for **all three tools** (Re-encode, Normalize Audio, Create Clip).
Per QA-DISCIPLINE.md rule 1, only the human QA executor may tick the boxes below.

## Build & launch

- [ ] `yarn dev` (webpack watch) + `yarn start` (Electron), or a packaged portable build.

## Requirement 1 — cannot navigate away (but can play/pause/seek)

For each tool, while the job is running AND during "Finalizing…":
- [ ] Arrow Left / Right do nothing (viewer stays on the current video).
- [ ] On-screen prev/next NavigationButtons do nothing.
- [ ] "Back" button, mouse back-button, Escape, Backspace do NOT leave SlideMode.
- [ ] Play / pause / seek on the video still work normally.
- [ ] The user is NEVER returned to the thumbnail index — not even for one frame
      (watch closely the moment the output file would be detected by the watcher).

## Requirement 2 — seamless source → destination swap

- [ ] The SOURCE video stays on screen continuously from click through ffmpeg and
      through "Finalizing…".
- [ ] When the output is ready, the viewer swaps to it IN PLACE (no grid trip, no
      blank/black frame, no flicker). Verify from: a tag-filtered (Query) view, the
      All view, and the Untagged view.
- [ ] The Inspector stays mounted throughout; the "Finalizing…" indicator is visible
      for the whole ffmpeg-exit → output-open gap and then clears to the output's tools.

## Requirement 3 — destination already has the source's tags

- [ ] Immediately after the swap, the output's tags in the Inspector match the
      source's (no missing tags, no second write). Confirm the tags are present on the
      file's EXIF/XMP as well (re-open / exiftool spot check).
- [ ] Zero-tag source: swap still works; no spurious tag write.

## Requirement 4 — ffmpeg failure shows a modal, keeps the source

- [ ] Force a failure (e.g. an unreadable/locked input, or a deliberately bad clip
      range) and confirm a blocking modal appears with the ffmpeg error text.
- [ ] The SOURCE video remains open in SlideMode behind the modal; dismissing the
      modal leaves the source on screen. No "Delete original?" prompt appears.
- [ ] Cancel (the Cancel button mid-encode) shows the neutral "cancelled" toast (no
      modal) and keeps the source on screen.

## Sequence / regression

- [ ] On success, the "Delete original?" prompt appears AFTER the swap (not 20–30 s
      later, not while still in the grid). Deleting still works (trash / permanent).
- [ ] No INV-019 regression: no `net::ERR_REQUEST_RANGE_NOT_SATISFIABLE`, no
      "outside a watched folder" false claim on the happy path, single EXIF write.
- [ ] Fallback (output genuinely not ingestable, e.g. outside a watched location):
      the source stays on screen, an honest toast explains it, and NO delete prompt
      fires.

## Docs

- [ ] Update `docs/reencode-x264.md` ("Post-Encode Finalization") and `docs/TOOLS.md`
      to describe the identity-pin model (`uiStore.mediaProcessingFile` / `slideFile`)
      and that background refetches no longer exit SlideMode (content setters exit only
      on a genuine mode change), replacing the INV-021 "pinViewedFileAcrossRefetch"
      description.

## Evidence

> Paste screenshots / recording links / log lines here as steps are executed.
