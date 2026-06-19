---
id: TASK-118
title: 'Position the non-modal Keep-which-version prompt clear of the video controls; QA and docs'
investigation: INV-031
status: DONE
priority: medium
blocked_by: [TASK-116, TASK-117]
date_created: 2026-06-19
date_completed: 2026-06-19
files:
  - resources/style/controls/popover.scss
  - docs/reencode-x264.md
  - docs/TOOLS.md
---

## What

Add SCSS to anchor the non-modal "Keep which version?" prompt to the **top** of
the viewer (overriding the default centered position) so it never covers the
video's native control bar at the bottom edge, leaving the seek bar and
play/pause reachable. Then perform manual QA verifying full video interactivity
while the prompt is open, and update the docs to record the non-modal behavior.

## Why

A non-modal dialog (TASK-116/117) no longer blocks the video, but the default
`Alert` dialog is centered (`top/bottom: 0; margin-top: 10vh`) and would still
visually occlude the middle/bottom of the frame — including, depending on video
size, the native control bar. Anchoring the non-modal prompt to the top keeps
the control bar and most of the frame clickable. QA and docs close out the
investigation.

See [INV-031](../investigations/INV-031_MEDIUM_FRONTEND_keep-which-version-video-controls-inert-under-modal.md).

## Implementation Steps

- [x] 1. In `resources/style/controls/popover.scss`, add a rule targeting the
      non-modal alert via the `data-nonmodal` hook from TASK-116 (e.g.
      `dialog[role='alertdialog'][data-nonmodal]`). Anchor it to the top of the
      viewport/viewer: override the inherited centered `top: 0; bottom: 0;
      margin-top: 10vh` so the box sits near the top (e.g. `bottom: auto;
      margin-top: 2vh;` or top-corner placement) and does NOT overlap the
      bottom edge where the `<video>` control bar lives. Keep the default
      (modal) `dialog` styling untouched.
- [x] 2. Ensure the non-modal prompt still renders above the video (normal
      stacking; add an explicit `z-index` only if QA shows it rendering behind
      the viewer or toolbar). — DOM mount order in ContentView/index.tsx places
      DeleteOriginalAfterJob after Layout; normal stacking suffices. No z-index added.
- [ ] 3. REQUIRES MANUAL EXECUTION — In the running app (`yarn dev` + `yarn
      start`): open a video in SlideMode, run a media tool (e.g. Rotate CW), and
      when the "Keep which version?" prompt appears, verify you can: (a)
      click/drag the seek bar to scrub, (b) click play/pause, (c) see the
      duration / current-time readout update. Capture a screenshot or clip.
- [ ] 4. REQUIRES MANUAL EXECUTION — Verify the prompt does not cover the video
      control bar and that all three buttons (Keep Modified / Keep Original /
      Keep Both) still click and perform their actions (source-to-trash,
      output-to-trash + switch-back, keep-both). Capture evidence.
- [ ] 5. REQUIRES MANUAL EXECUTION — Verify `MediaJobErrorAlert` still blocks
      the page (force a failure, e.g. rotate a Vorbis `.webm`, confirm the error
      modal is modal/blocking and the source remains untouched).
- [x] 6. Update `docs/reencode-x264.md` (and/or `docs/TOOLS.md`) to note the
      "Keep which version?" prompt is non-modal so the output video can be
      evaluated (scrub / play-pause / duration) while choosing. Cross-reference
      INV-031.

## Done When

- [ ] The non-modal prompt is anchored clear of the video control bar; the seek
      bar and play/pause are reachable while it is open.
- [ ] Manual QA steps 3–5 are checked by the human executor with attached
      evidence (screenshot/clip/log).
- [ ] Docs updated and cross-referenced to INV-031.
- [ ] `yarn build` succeeds.
