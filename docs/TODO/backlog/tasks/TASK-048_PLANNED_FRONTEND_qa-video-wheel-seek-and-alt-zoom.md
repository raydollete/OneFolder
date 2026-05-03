---
id: TASK-048
title: 'QA: video wheel-seek, Alt-zoom, fill-on-open, image regression'
investigation: INV-010
status: planned
priority: low
blocked_by: [TASK-047]
date_created: 2026-05-03
date_updated: 2026-05-03
date_completed:
files:
  - 'src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx'
  - 'src/frontend/containers/ContentView/SlideMode/index.tsx'
  - 'src/frontend/containers/ContentView/SlideMode/utils.tsx'
---

## What

Manually verify the interaction matrix cells described in INV-010 (wheel-seek, Alt-zoom, fill-on-open default, double-tap reset target, viewport-resize behavior) and confirm no regressions in pan, pinch, image initial-scale, gallery thumbnail resize, or video playback controls. Capture results inline in this file before marking it done.

## Why

TASK-047 changes two hot interaction paths in SlideMode at once: (1) the wheel handler and (2) the initial-scale computation for videos. Both depend on platform/browser behavior that Jest does not exercise the way Electron does (synthetic events, real video metadata loading, real container layout). We verify in a running Electron build.

See [INV-010](../investigations/INV-010_LOW_FRONTEND_video-scroll-seek-with-alt-zoom.md) for the behavioral specifications, including the contain-vs-cover distinction, the reset-to-fill decision, and the deferred image-default question.

## Implementation Steps

- [ ] 1. **Build and launch.** Run `yarn dev` in one terminal and `yarn start` in another. Confirm the app boots against your usual library.

- [ ] 2. **Prepare test fixtures.** Locate or import:
  - At least one short `.mp4` (under 30s, easy to scrub end-to-end).
  - At least one longer `.mp4` (over 5 minutes, exercises clamping behavior at duration).
  - At least one `.webm` (different container/codec).
  - At least one still `.jpg` or `.png` for the regression case.
  - **For the fill matrix:** at least one video whose aspect ratio is OBVIOUSLY different from your viewport (e.g., a 16:9 video viewed in a near-square or 21:9 viewport, or a vertical 9:16 phone-recorded video). The asymmetry must be visible at a glance — without it you cannot see "fill vs. fit" distinguishably.
  - **For the fill matrix (small-video case):** at least one video whose native resolution is SMALLER than the viewport on both axes (e.g., a 320×240 clip in an HD window). This proves fill upscales (the old contain-cap-at-1.0 default would refuse to scale up).
  Note in your QA log which files you used.

- [ ] 3. **Cell A — bare wheel over video seeks +1s/-1s.** Open the short `.mp4` in SlideMode (double-click thumbnail). Hover over the video frame (not the native control bar). Spin the wheel one tick away from you (`deltaY < 0`); confirm the native scrubber advances ~1s and the playhead jumps forward. Spin one tick toward you (`deltaY > 0`); confirm playhead moves back ~1s. Verify by reading the time readout on the native `<video controls>` UI. **PASS criterion:** scrubber position changes by ~1 second per tick in the expected direction.

- [ ] 4. **Cell A boundary — clamp at duration.** Seek the short video to within 1s of the end (use the native scrubber). Spin the wheel forward several ticks. Confirm `currentTime` stops at `duration` and does NOT throw. Spin backward past 0 — confirm it stops at 0.

- [ ] 5. **Cell A NaN-safety.** Open the longer `.mp4` and **immediately** (before the metadata fully loads) spin the wheel. Confirm no console errors. Once metadata loads, the seek should start working. (This is timing-dependent — if you can't reproduce the pre-load window, note that in the log; do not fail the task on it.)

- [ ] 6. **Cell B — Alt + wheel over video zooms.** Same short `.mp4` open in SlideMode. Hold `Alt` and spin the wheel. Confirm the video zooms in/out exactly as today's bare-wheel behavior — image (well, video frame) gets larger/smaller around the cursor. **PASS criterion:** zoom transform changes; `currentTime` does NOT change.

- [ ] 7. **Cell C — bare wheel over image zooms (regression).** Open a still `.jpg` in SlideMode. Spin wheel without modifiers. Confirm the image zooms exactly as before this change. **PASS criterion:** zoom transform changes — no regression.

- [ ] 8. **Cell D — Ctrl + wheel in gallery resizes thumbnails (regression).** Exit SlideMode (Esc / Backspace). In the gallery, hold `Ctrl` and spin the wheel. Confirm thumbnail size changes (per `ContentView/index.tsx:112-121`). **PASS criterion:** unchanged behavior.

- [ ] 9. **Pan still works on video.** With the short `.mp4` open, `Alt`+wheel-zoom in until the video overflows the container, release `Alt`, then click-and-drag with the left mouse button. Confirm panning works. **PASS criterion:** pan still works.

- [ ] 10. **Double-tap reset still works on video.** With the video still zoomed in, double-click on the video. Confirm it resets to autofit. **PASS criterion:** double-tap reset still works.

- [ ] 11. **Native video controls still work.** Click play/pause, drag the native scrubber, toggle mute, change volume via the native UI. Confirm none of these were broken. **PASS criterion:** native controls behave as before.

### Fill-to-viewport matrix (new cells from the 2026-05-03 amendment)

- [ ] 11a. **Cell E — opening a video fills the viewport.** Open the asymmetric-aspect-ratio video (from step 2). Hover over the slide. Confirm the video VISUALLY FILLS the viewport — the smaller dimension of the video reaches the corresponding viewport edge, the larger dimension overflows beyond the viewport (cropped on screen, available via pan). **PASS criterion:** there are NO letterbox bars on either axis (modulo a 1-pixel rounding band). The viewport is 100% covered by video pixels. Compare with the pre-fix behavior in your memory or by checking out the prior commit — under the old default this same video would have shown letterbox bars on at least one axis.

- [ ] 11b. **Cell E (small video) — fill upscales below-native videos.** Open the small-resolution video (e.g., 320×240) in a large viewport. Confirm it fills the viewport at a scale > 1.0 (visibly upscaled, possibly blurry — this is correct). **PASS criterion:** the video covers the viewport rather than being a tiny island in the middle (which is what the old contain-cap-at-1.0 default would have produced). It is acceptable for the upscaled video to look soft.

- [ ] 11c. **Cell E (clamp) — pathological aspect ratios.** If you can find or create a deliberately extreme video (e.g., a 100×1080 vertical sliver), open it. Confirm: no crash, no freeze, the video is rendered at `maxScale=5` (the clamp kicks in) and overflows heavily. **PASS criterion:** it does not throw, the slide is interactive (you can wheel-zoom further if you want). Marking this "could not reproduce" is acceptable if you don't have such a fixture handy.

- [ ] 11d. **Cell F — image opening behavior is UNCHANGED.** Open a still `.jpg` in SlideMode. Confirm the initial scale is the OLD autofit-cap-at-1.0 — for an image smaller than the viewport, it appears at native size with letterboxing on both axes; for an image larger than the viewport, it is shrunk to fit with the whole frame visible. **PASS criterion:** matches behavior on the previous commit (no regression). If image now also defaults to fill, this is a BUG — the image branch was supposed to be untouched.

- [ ] 11e. **Cell G — viewport resize with NO user zoom: fill recomputes.** Open a video (back to fill default). Without touching the wheel or double-tap, resize the Electron window (drag the corner) to a different aspect ratio. Confirm the video continues to fill the new viewport — i.e., the smaller dimension of the video keeps reaching the viewport edge as that edge moves. **PASS criterion:** fill scale is recomputed on each resize tick; no letterboxing appears.

- [ ] 11f. **Cell G (preserve user zoom) — viewport resize after Alt+wheel zoom: user state preserved.** Open a video. Alt+wheel-zoom in a few ticks (away from the fill default). Now resize the window. **PASS criterion:** the user's chosen scale is preserved — the video does NOT snap back to the new fill scale. The `ZoomPan` correctly distinguishes "first paint" from "user has interacted." (This relies on the existing `updateTransform` container-only branch, which is intentionally preserved unchanged in TASK-047 step 12b.)

- [ ] 11g. **Cell G (toggle inspector/outliner) — panel-toggle resize behaves like window resize.** Open a video at fill default. Toggle the inspector panel open/closed (eye icon in the SlideMode nav). Confirm the video still fills the new (narrower or wider) content area. Now Alt+wheel-zoom away from fill; toggle the inspector again. Confirm the user scale is preserved. **PASS criterion:** matches Cells G/G2.

- [ ] 11h. **Cell H — double-tap reset on a video returns to fill (not autofit).** With a video open, Alt+wheel-zoom in or out so the current scale is clearly different from the fill default. Double-click on the video. Confirm it animates back to the FILL scale (fully covers the viewport, not letterboxed). **PASS criterion:** after the reset animation completes, the video looks identical to "first open" (fills the viewport). A regression here would manifest as the video resetting to the OLD autofit-cap-at-1.0 scale (letterboxed).

- [ ] 11i. **Cell H (image regression) — double-tap reset on an image is unchanged.** Open an image, zoom in via the wheel, double-click. Confirm it returns to the autofit scale (whole image visible, the way it always has). **PASS criterion:** matches pre-fix behavior.

- [ ] 11j. **Pan still works on a fill-defaulted video** along the overflowing axis. Open a video at fill. Identify the axis that is overflowing (use the visible cropping). Click-and-drag along that axis. Confirm the cropped region scrolls into view. **PASS criterion:** existing pan code still functions. (This is a critical regression check — if `getCorrectedTransform` interacts badly with the new larger-than-1.0 default, pan could become locked.)

- [ ] 12. **Trackpad smoke test (if available).** On a laptop trackpad with a two-finger scroll: do a slow one-finger-tick scroll over a video. Confirm it seeks one second per discrete tick. Do a fast swipe. Confirm it seeks several seconds (this is expected per INV-010 Risks §2 — note the actual behavior in the QA log; do not fail on this).

- [ ] 13. **Record results.** Append a "QA Results" section below with PASS/FAIL for each cell and any observations. If any cell fails, file a follow-up investigation rather than fixing in-place.

## Done When

- [ ] All cells tested and recorded with PASS/FAIL or an explicit "could not reproduce" note. The full set is:
  - Wheel-seek matrix: 3 (Cell A), 4 (Cell A clamp), 5 (Cell A NaN), 6 (Cell B Alt-zoom), 7 (Cell C image-zoom), 8 (Cell D Ctrl+wheel gallery), 9 (pan), 10 (double-tap on zoomed video), 11 (native controls), 12 (trackpad).
  - Fill matrix: 11a (Cell E fill), 11b (Cell E small-video upscale), 11c (Cell E clamp), 11d (Cell F image initial-scale unchanged), 11e (Cell G resize-recomputes-fill), 11f (Cell G preserve-user-zoom), 11g (Cell G panel-toggle), 11h (Cell H reset-to-fill), 11i (Cell H image reset unchanged), 11j (pan works on fill-defaulted video).
- [ ] No FAIL on REQUIRED cells: A (3, 4), B (6), C (7), D (8), pan (9), double-tap on zoomed video (10), native controls (11), E (11a), E small (11b), F (11d), G (11e, 11f), H (11h, 11i), pan on fill (11j).
- [ ] OPTIONAL / "could not reproduce" tolerated: 5 (NaN race), 11c (extreme aspect ratio without fixture), 12 (trackpad if no trackpad available), 11g (panel toggle if Cells G already covered the resize behavior).
- [ ] If any required cell fails, this task stays blocked and a follow-up investigation is filed.

## QA Results

<!-- Fill in during step 13. Format: -->
<!--
### Wheel-seek matrix
- Cell A (step 3): PASS — short.mp4, scrubber advanced ~1.0s per tick on a Logitech wheel mouse on Windows 11.
- Cell A clamp (step 4): PASS — capped at duration, no throw.
- Cell A NaN-safety (step 5): could not reproduce pre-load window; no errors observed.
- Cell B Alt-zoom (step 6): PASS — Alt+wheel zoomed instead of seeking.
- Cell C image-zoom regression (step 7): PASS — bare wheel zoomed; no regression.
- Cell D Ctrl+wheel gallery (step 8): PASS — thumbnails resized; bubbling preserved.
- Pan (step 9): PASS — drag worked after Alt+wheel zoom-in.
- Double-tap on zoomed video (step 10): PASS — animated back to fill.
- Native controls (step 11): PASS — play/pause/scrub/volume all worked.
- Trackpad (step 12): not tested (no trackpad on test machine).

### Fill matrix
- Cell E fill (step 11a): PASS — 9:16 phone video filled landscape viewport horizontally with vertical overflow; no letterbox bars.
- Cell E small-video upscale (step 11b): PASS — 320x240 clip upscaled to fill 1080p viewport (visibly soft, expected).
- Cell E clamp (step 11c): could not reproduce — no extreme-aspect-ratio fixture available.
- Cell F image unchanged (step 11d): PASS — image opened at autofit-cap-at-1.0; matches prior behavior.
- Cell G resize-recomputes-fill (step 11e): PASS — dragging window corner kept video filling at each step.
- Cell G preserve-user-zoom (step 11f): PASS — user scale preserved across resize.
- Cell G panel-toggle (step 11g): PASS — same as 11e/11f.
- Cell H reset-to-fill (step 11h): PASS — double-tap on zoomed-in video returned to fill.
- Cell H image reset unchanged (step 11i): PASS — image still resets to autofit, not fill.
- Pan on fill-defaulted video (step 11j): PASS — could pan along overflowing axis.
-->
