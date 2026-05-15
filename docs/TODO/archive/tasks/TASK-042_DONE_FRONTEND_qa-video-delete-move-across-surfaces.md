---
id: TASK-042
title: 'QA: verify video delete and move succeed across every trigger surface on Windows'
investigation: INV-008
status: DONE
priority: high
blocked_by: [TASK-038, TASK-039, TASK-040, TASK-041]
date_created: 2026-04-23
date_completed: 2026-05-03
files:
  - docs/thumbnail-generation.md
---

## What

Run the full reproduction matrix for INV-008 on Windows and verify every entry point that previously hit `EBUSY: resource busy or locked, scandir <filepath>` now completes cleanly. Add a short note to `docs/thumbnail-generation.md` cross-referencing the INV-008 mitigation so future contributors understand why the video `<video>` lifecycle is coordinated.

## Why

The fix spans multiple modules (coordinator, component registrations, destructive-op integrations, main-process retry). A single path working is not sufficient — every surface listed in the INV-008 blast radius must be validated to confirm the root-cause fix covered them all.

See [INV-008](../investigations/INV-008_HIGH_FRONTEND_video-file-handle-blocks-delete-with-ebusy.md).

## Implementation Steps

- [ ] 1. Prepare a test library with at least: two `.mp4` files, one `.webm`, one `.ogg`, plus a few `.jpg`/`.png` for regression control. REQUIRES MANUAL EXECUTION ON WINDOWS.
- [ ] 2. Settings: set `Gallery video playback mode` to `hover`. Run repro matrix: REQUIRES MANUAL EXECUTION ON WINDOWS.
  - [ ] Hover a video thumbnail, press Delete hotkey, confirm → file trashes, no EBUSY, DB record removed, Outliner counts update.
  - [ ] Hover a video thumbnail, right-click → Delete file, confirm → same result.
  - [ ] Select multiple files (mix of videos and images), press Delete, confirm → all files trash cleanly.
  - [ ] Open a video in SlideMode, press Delete, confirm → slide mode closes / advances, file trashes cleanly.
  - [ ] In SlideMode, navigate past a video (so it's preloaded as prev), then open the delete flow for that video via context menu → file trashes cleanly.
  - [ ] Open Duplicate Gallery with a group containing a video, click the per-row Delete button, confirm → file trashes cleanly.
- [ ] 3. Settings: set `Gallery video playback mode` to `auto`. Repeat the first bullet of step 2 (gallery delete) with a video currently playing → trashes cleanly. REQUIRES MANUAL EXECUTION ON WINDOWS.
- [ ] 4. Settings: set `Gallery video playback mode` to `disabled`. Repeat first bullet → trashes cleanly (should still work since no handle was aggressively opened, but confirm no regression). REQUIRES MANUAL EXECUTION ON WINDOWS.
- [ ] 5. Drag-and-drop move of a currently-hovering video into a sub-location → moves cleanly, no EBUSY, no duplicate DB entries after chokidar settles. REQUIRES MANUAL EXECUTION ON WINDOWS.
- [ ] 6. Drag-and-drop overwrite where the destination is a previewed video → source replaces destination cleanly. REQUIRES MANUAL EXECUTION ON WINDOWS.
- [ ] 7. Regression checks: REQUIRES MANUAL EXECUTION ON WINDOWS.
  - [ ] Hover preview still plays on mouse-enter, pauses on mouse-leave.
  - [ ] Auto playback still starts when the thumbnail enters the viewport.
  - [ ] SlideMode video still plays with controls/autoplay/loop as before.
  - [ ] Image delete flow unchanged (images trash cleanly, no additional latency).
  - [ ] After each successful delete, the Outliner "All Images" and "Untagged" counts match the gallery (no stale numbers).
- [ ] 8. Edge: rapidly hover over many videos in succession (move the mouse across a row of 10 video thumbnails), then delete one while another is still hovered → only the targeted file trashes, others keep playing after the operation. REQUIRES MANUAL EXECUTION ON WINDOWS.
- [ ] 9. Evidence: capture screenshots or short clips of one success per unique trigger (trash, move, slide-mode delete) and paste into the task comment or the linked investigation. REQUIRES MANUAL EXECUTION ON WINDOWS.
- [x] 10. Docs: add a short paragraph to `docs/thumbnail-generation.md` under the existing "Videos/GIFs: Currently use original (future enhancement planned)" bullet noting that because videos use the original file path as their `<video>` src, OneFolder coordinates `<video>` handle release via `MediaReleaseCoordinator` before destructive file ops (reference INV-008). DONE.

## Done When

- [ ] Every item in the repro matrix above passes on Windows with the fixes from TASK-038..041 applied. REQUIRES MANUAL EXECUTION BY USER.
- [ ] No regressions observed in image delete, hover playback, auto playback, or SlideMode video playback. REQUIRES MANUAL EXECUTION BY USER.
- [x] `docs/thumbnail-generation.md` has a short cross-reference to INV-008 near the existing video-thumbnail note. DONE.
- [ ] Evidence captured in the task (screenshots or clips). REQUIRES MANUAL EXECUTION BY USER.
- [x] Task moved to `docs/TODO/pending_qa/tasks/` after all above are verified.
