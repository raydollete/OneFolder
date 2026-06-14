---
id: TASK-092
title: 'QA the seamless post-encode UX for both Re-encode and Normalize Audio: source never returns to the thumbnail grid, a "Finalizing…" indicator covers the gap, the viewer swaps to the output in place, and no INV-019 correctness regression. REQUIRES MANUAL EXECUTION ON WINDOWS.'
investigation: INV-021
status: pending_qa
priority: high
blocked_by: [TASK-089, TASK-090, TASK-091]
date_created: 2026-06-11
date_completed:
files:
  - 'docs/reencode-x264.md'
---

## What

Manually verify, with captured evidence, that the post-encode transition is
seamless for BOTH the Re-encode (x264) and Normalize Audio tools, across the full
view matrix, and that no INV-019 correctness guarantee regressed. Update
`docs/reencode-x264.md` to document the in-place swap and the "Finalizing…"
phase.

## Why

INV-021 fixes a user-facing flow (viewer teardown + feedback-less gap). Per
docs/TODO/QA-DISCIPLINE.md, behavioral fixes that require the live app must be
verified by a human with concrete evidence before the investigation can advance.
INV-014 shipped three defects because a QA task was ticked without evidence; this
task must not repeat that.

See [INV-021](../investigations/INV-021_HIGH_FRONTEND_post-encode-slidemode-teardown-and-finalization-gap.md).

## Implementation Steps

> All checkbox steps below are **REQUIRES MANUAL EXECUTION ON WINDOWS**. Only the
> human QA executor may tick them, after performing the step and capturing
> evidence (screenshot, screen-recording clip, or copied log line) pasted into or
> linked from this file. See docs/TODO/QA-DISCIPLINE.md.

- [ ] 1. Build/run the app (`yarn dev` + `yarn start`, or the portable build per
      project memory "test the portable build").
- [ ] 2. **Tag-filtered view, Re-encode (primary repro):** apply a tag filter,
      open a tagged video in SlideMode, run Re-encode (x264). Capture a clip.
      Verify: (a) the source stays on screen at ffmpeg exit — NO return to the
      thumbnail grid; (b) a "Finalizing…" indicator is visible for the whole gap;
      (c) the viewer swaps to the output in place; (d) no transient grid flash /
      `firstFileInView` undefined flicker.
- [ ] 3. **Tag-filtered view, Normalize Audio:** repeat step 2 with Normalize
      Audio on a tagged video. Same four checks. Confirm the shared helper gives
      identical behavior.
- [ ] 4. **All-content view** and **Untagged view:** repeat for both tools;
      confirm no grid round-trip and a seamless swap in each.
- [ ] 5. **Zero-tag source:** re-encode a tagless video; confirm seamless swap,
      no EXIF write attempted, no error.
- [ ] 6. **Name collision:** re-encode a source whose sibling output name already
      exists; confirm the auto-incremented output opens seamlessly.
- [ ] 7. **Genuinely-not-visible fallback:** force the output to not match the
      active filter (where applicable); confirm the viewer is NOT left blank —
      either the output is pinned and shown, or the SOURCE stays on screen with
      the honest INV-019 toast (never "outside a watched folder" as sole cause).
- [ ] 8. **INV-019 non-regression:** for each successful run, confirm the output
      carries the source's tags (DB + EXIF/XMP via an external EXIF viewer),
      exactly one EXIF write occurred (no double-write), and DevTools shows NO
      `net::ERR_REQUEST_RANGE_NOT_SATISFIABLE`.
- [ ] 9. **Delete-original prompt:** confirm the "Delete original?" modal appears
      AFTER the swap in every successful case, and that Keep/Delete both behave.
- [x] 10. Update `docs/reencode-x264.md` "Post-Encode Finalization" section to
      describe the in-place SlideMode swap and the "Finalizing…" inspector phase,
      replacing the current "refetch then select" description. **DONE (non-manual
      doc step, completed alongside TASK-089/090/091 implementation):** the
      "Post-Encode Finalization (Ingestion, Tag Copy, and Seamless Swap)" section
      now documents the pin-aware refetch (step 2), the in-place swap (step 4),
      the SlideMode-safe fallback (step 5), and a new "Finalizing… Inspector
      Phase" subsection. The Error Handling Summary row and the top-level flow
      bullet were updated to match.

## Done When

- [ ] Steps 2–9 each have pasted/linked evidence (clip, screenshot, or log line)
      confirming the seamless swap, the "Finalizing…" indicator, and no INV-019
      regression, for BOTH tools.
- [ ] `docs/reencode-x264.md` reflects the new finalization behavior.
- [ ] No grid round-trip, no silent gap, and no viewer-blank fallback observed in
      any matrix cell.
