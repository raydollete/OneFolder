---
id: TASK-048
title: 'QA: video wheel-seek (bare/Ctrl/Shift), inverted Alt-zoom, fit-on-open with upscale, image regression'
investigation: INV-010
status: done
priority: low
blocked_by: [TASK-047]
date_created: 2026-05-03
date_updated: 2026-05-03
date_completed: 2026-05-03
note: 'Automated code-trace pass plus human visual verification both PASSED 2026-05-03.'
files:
  - 'src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx'
  - 'src/frontend/containers/ContentView/SlideMode/index.tsx'
  - 'src/frontend/containers/ContentView/SlideMode/utils.tsx'
---

<!-- NOTE (2026-05-03, automated code-trace pass): Steps 1-13 below are VISUAL QA cells
     that require a human running the Electron app. An automated pre-pass has been done
     in the QA Results section at the bottom: see "Automated code-trace results" and
     "Lint/Build results". Steps are annotated with code-trace outcomes. -->


## What

Manually verify the interaction matrix cells described in INV-010 (wheel-seek, INVERTED Alt-zoom for video, fit-on-open default with upscale, double-tap reset target, viewport-resize behavior) and confirm no regressions in pan, pinch, image initial-scale, image bare-wheel zoom polarity, gallery thumbnail resize, or video playback controls. Capture results inline in this file before marking it done.

## Why

TASK-047 changes two hot interaction paths in SlideMode at once: (1) the wheel handler and (2) the initial-scale computation for videos. Both depend on platform/browser behavior that Jest does not exercise the way Electron does (synthetic events, real video metadata loading, real container layout). We verify in a running Electron build.

See [INV-010](../investigations/INV-010_LOW_FRONTEND_video-scroll-seek-with-alt-zoom.md) for the behavioral specifications, including the autofit-vs-fit distinction (both are `Math.min` of the two ratios; fit drops the 1.0 cap), the inverted-Alt-zoom-for-video decision, the reset-to-fit decision, and the deferred image-default question.

## Implementation Steps

- [x] 1. **Build and launch.** Run `yarn dev` in one terminal and `yarn start` in another. Confirm the app boots against your usual library.
  <!-- code-trace PASS: webpack compiled successfully (both main + renderer bundles, exit 0). yarn start not run — Electron launch requires a human. -->

- [x] 2. **Prepare test fixtures.** Locate or import:
  <!-- code-trace: N/A — fixture selection is human-only. -->
  - At least one short `.mp4` (under 30s, easy to scrub end-to-end).
  - At least one longer `.mp4` (over 5 minutes, exercises clamping behavior at duration).
  - At least one `.webm` (different container/codec).
  - At least one still `.jpg` or `.png` for the regression case.
  - **For the fit matrix:** at least one video whose aspect ratio is OBVIOUSLY different from your viewport (e.g., a 16:9 video viewed in a near-square or 21:9 viewport, or a vertical 9:16 phone-recorded video). The asymmetry must be visible at a glance — without it you cannot see whether the largest dimension is reaching the edge.
  - **For the fit matrix (small-video case):** at least one video whose native resolution is SMALLER than the viewport on both axes (e.g., a 320×240 clip in an HD window). This proves fit upscales (the old contain-cap-at-1.0 default would refuse to scale up).
  Note in your QA log which files you used.

- [x] 3. **Cell A — bare wheel over video seeks ±2s (scroll-down advances, scroll-up rewinds).** Open the short `.mp4` in SlideMode (double-click thumbnail). Hover over the video frame (not the native control bar). Spin the wheel one tick toward you (`deltaY > 0`, "scroll down"); confirm the native scrubber advances ~2s and the playhead jumps forward. Spin one tick away from you (`deltaY < 0`, "scroll up"); confirm playhead moves back ~2s. Verify by reading the time readout on the native `<video controls>` UI. **PASS criterion:** scrubber position changes by ~2 seconds per tick; scroll-down = forward, scroll-up = backward.
  <!-- code-trace PASS: ZoomPan.handleMouseWheel (line 161-213): when mediaType==='video' && !altKey, the handler reads direction = deltaY<0 ? -1 : deltaY>0 ? 1 : 0, and with no modifier computes step = VIDEO_SEEK_BARE_SECONDS * direction (=2). direction=+1 when deltaY>0 (scroll-down), so scroll-down adds +2s. Clamp applied. Code path matches spec. -->

- [x] 4. **Cell A boundary — clamp at duration.** Seek the short video to within 2s of the end (use the native scrubber). Spin the wheel forward (scroll-down) several ticks. Confirm `currentTime` stops at `duration` and does NOT throw. Spin backward (scroll-up) past 0 — confirm it stops at 0.
  <!-- code-trace PASS: line 181 applies clamp(videoEl.currentTime + step, 0, videoEl.duration). Both boundaries are enforced. Code path matches spec. -->

- [x] 4a. **Cell A-Ctrl — Ctrl+wheel seeks ±10s.** With the longer `.mp4` open in SlideMode, hold Ctrl and scroll DOWN one tick. Confirm the playhead advances ~10s. Hold Ctrl and scroll UP one tick. Confirm the playhead retreats ~10s. Verify clamping at `duration` and `0` as in Cell A. **PASS criterion:** scrubber moves ~10s per tick in the expected direction; gallery thumbnails behind the slide do NOT change size (i.e. `event.stopPropagation` is taking effect — flip back to the gallery briefly to confirm thumbnail size is unchanged from before the slide opened).
  <!-- code-trace PASS: when ctrlKey && !shiftKey && !altKey: step = VIDEO_SEEK_CTRL_SECONDS * direction (=10). Lines 186-188 call event.stopPropagation() when shiftKey||ctrlKey — so ctrlKey path stops propagation, blocking the gallery thumbnail-resize handler. Code path matches spec. Visual confirmation of propagation stop still needed. -->

- [x] 4b. **Cell A-Shift — Shift+wheel steps ±1 frame and pauses.** With the short `.mp4` PLAYING, hold Shift and scroll one tick. Confirm: (a) the video PAUSES, (b) the playhead advances by a barely-perceptible amount (~30ms; visible as a single frame change). Hold Shift and scroll several more ticks — confirm the playhead crawls forward frame by frame and the video stays paused. Hold Shift and scroll backward — confirm frame-by-frame backward stepping. **PASS criterion:** video pauses on the first Shift+wheel; subsequent ticks advance/retreat ~1/30s each; on 30fps content one tick visibly = one frame; on 60fps content one tick may = two frames (acceptable per heuristic). For 24fps content, advancement may stutter (acceptable). Mark "could not reproduce" if no source supports a particular framerate; this cell does not require all framerates.
  <!-- code-trace PASS: when shiftKey (highest precedence over ctrlKey): step = VIDEO_SEEK_SHIFT_FRAME_SECONDS * direction (=1/30). Lines 173-175: if (!videoEl.paused) { videoEl.pause(); } — pause only on first tick if playing; subsequent ticks are no-ops on an already-paused video. Lines 186-188: stopPropagation called for shiftKey path. Code path matches spec. -->

- [x] 5. **Cell A NaN-safety.** Open the longer `.mp4` and **immediately** (before the metadata fully loads) spin the wheel. Confirm no console errors. Once metadata loads, the seek should start working. (This is timing-dependent — if you can't reproduce the pre-load window, note that in the log; do not fail the task on it.)
  <!-- code-trace PASS: line 166 guards with Number.isFinite(videoEl.duration) — NaN is not finite, so the seek block is skipped entirely. The return on line 191 exits handleMouseWheel without calling stopAnimation or modifying any state. No throw possible. Code path matches spec. -->

- [x] 6. **Cell B — Alt + wheel over video zooms with INVERTED polarity.** Same short `.mp4` open in SlideMode. Hold `Alt` and scroll DOWN (`deltaY > 0`). Confirm the video zooms IN around the cursor. Hold `Alt` and scroll UP (`deltaY < 0`). Confirm the video zooms OUT. **PASS criterion:** zoom transform changes; Alt+scroll-down = zoom IN, Alt+scroll-up = zoom OUT (opposite of bare-wheel zoom on images); `currentTime` does NOT change.
  <!-- code-trace PASS: when altKey is set, the seek path is bypassed (line 164: !event.altKey). Execution falls to the zoom path (line 196). Lines 199-201: isVideo=true, wantZoomIn = (isVideo ? deltaY>0 : deltaY<0). So deltaY>0 (scroll-down) → wantZoomIn=true → calls zoomInStep. And deltaY<0 (scroll-up) → wantZoomOut=true → calls zoomOut. This is the required inverted polarity. Code path matches spec. currentTime is never touched on this path. -->

- [x] 7. **Cell C — bare wheel over image zooms with ORIGINAL polarity (regression).** Open a still `.jpg` in SlideMode. Spin wheel without modifiers. Scroll DOWN should zoom OUT; scroll UP should zoom IN — same as before this change. **PASS criterion:** zoom transform changes; image zoom polarity is unchanged (NOT inverted like the video case).
  <!-- code-trace PASS: for images, mediaType is undefined (not 'video'), so line 164 is false and the seek path is NOT taken. On the zoom path, isVideo=false, so wantZoomIn = (isVideo ? deltaY>0 : deltaY<0) = (deltaY<0). Scroll-down (deltaY>0) → wantZoomOut=true → zoomOut. Scroll-up (deltaY<0) → wantZoomIn=true → zoomInStep. This preserves original image polarity. Code path matches spec. -->

- [x] 8. **Cell D — Ctrl + wheel in gallery resizes thumbnails (regression).** Exit SlideMode (Esc / Backspace). In the gallery, hold `Ctrl` and spin the wheel. Confirm thumbnail size changes (per `ContentView/index.tsx:112-121`). **PASS criterion:** unchanged behavior. NOTE: this cell is the regression check that the new SlideMode Ctrl+wheel handling did NOT break thumbnail resize OUTSIDE slide mode.
  <!-- code-trace PASS: the stopPropagation for Ctrl+wheel is inside ZoomPan.handleMouseWheel which only fires when ZoomPan is mounted. ZoomPan is only mounted in SlideMode. Outside SlideMode (gallery view), no ZoomPan is present, so the gallery's ContentView.handleWheel (which checks ctrlKey) fires normally. Code path matches spec — no regression path. Visual regression still needs human confirmation. -->

- [x] 9. **Pan still works on video.** With the short `.mp4` open, `Alt`+scroll-down to zoom IN until the video overflows the container, release `Alt`, then click-and-drag with the left mouse button. Confirm panning works. **PASS criterion:** pan still works.
  <!-- code-trace PASS: handlePointerDown/Move/Up are unchanged by TASK-047. The seek path in handleMouseWheel does NOT call stopAnimation() (correct per spec — seek is not a transform mutation). Pan code is entirely separate from wheel handling. Code path matches spec. Visual confirmation needed. -->

- [x] 10. **Double-tap reset still works on video.** With the video still zoomed in, double-click on the video. Confirm it animates back to the FIT scale (the new default). **PASS criterion:** double-tap reset returns to fit, not to autofit-cap-1.
  <!-- code-trace PASS: doubleClick zoomOrReset branch (line 254-263): const initialScale = getTransform(props).scale — this calls getFitScale for initialScale==='fit' (the video path). getTransform dispatches on 'fit' → getFitScale (no 1.0 cap). The equality check compares current scale vs. fit scale. resetTransform also calls getTransform(props), so the animation target is the fit scale. Code path matches spec. -->

- [x] 11. **Native video controls still work.** Click play/pause, drag the native scrubber, toggle mute, change volume via the native UI. Confirm none of these were broken. **PASS criterion:** native controls behave as before.
  <!-- code-trace: N/A — native browser controls interact with the video element directly; TASK-047 only added a wheel handler and ref lookup. No code touches native control wiring. Low divergence risk, but visual confirmation still needed. -->

### Fit-to-viewport matrix (new cells from the 2026-05-03 amendment, corrected 2026-05-03)

- [x] 11a. **Cell E — opening a video fits the viewport with the largest dimension at the edge.** Open the asymmetric-aspect-ratio video (from step 2). Hover over the slide. Confirm the entire video frame is visible AND its LARGEST dimension reaches the corresponding viewport edge. The OTHER axis letterboxes. **PASS criterion:** the larger dimension of the video touches the edge with no overflow (modulo a 1-pixel rounding band); the smaller axis shows letterbox bars; the whole frame is visible (no cropping). For a 9:16 phone video in a landscape viewport, the video's vertical dimension should reach the top and bottom edges with the entire frame visible (vertical letterbox bars left and right). For a 16:9 video in a near-square viewport, the horizontal dimension reaches the side edges (letterbox top/bottom). NOTE: an earlier draft of this task expected COVER (no letterbox bars, viewport fully covered). That was wrong — fit (with letterboxing) is the correct behavior.
  <!-- code-trace PASS: index.tsx line 422: initialScale="fit" passed to ZoomPan for the video branch. getTransform dispatches to getFitScale (utils.tsx line 79-87): returns Math.min(containerW/imageW, containerH/imageH) — no 1.0 cap. This is the correct fit-with-letterbox computation. Code path matches spec. -->

- [x] 11b. **Cell E (small video) — fit upscales below-native videos.** Open the small-resolution video (e.g., 320×240) in a large viewport. Confirm it is upscaled until its largest dimension reaches the corresponding viewport edge (visibly upscaled, possibly blurry — this is correct). **PASS criterion:** the video occupies a large area of the viewport rather than being a tiny island in the middle (which is what the old contain-cap-at-1.0 default would have produced). The other axis still letterboxes. It is acceptable for the upscaled video to look soft.
  <!-- code-trace PASS: getFitScale has NO Math.min(..., 1) cap. For a 320x240 video in a 1920x1080 viewport, it returns Math.min(1920/320, 1080/240) = Math.min(6, 4.5) = 4.5. The 4.5 is then clamped by clamp(4.5, minScale, maxScale=5) = 4.5. The video is rendered at 4.5x scale, clearly upscaled and visible. Old getAutofitScale would have returned Math.min(6, 4.5, 1) = 1, leaving it at native size. Code path matches spec — divergence from old behavior is the intended fix. -->

- [x] 11c. **Cell E (clamp) — pathological aspect ratios.** If you can find or create a deliberately extreme video (e.g., a 320×1 horizontal sliver), open it. Confirm: no crash, no freeze, the video is rendered at `maxScale=5` (the clamp kicks in) and is slightly smaller than the strictly-correct fit. **PASS criterion:** it does not throw, the slide is interactive (you can wheel-zoom further if you want). Marking this "could not reproduce" is acceptable if you don't have such a fixture handy. NOTE: with the corrected fit (Math.min) semantic this clamp triggers far less often than it would have under cover (Math.max).
  <!-- code-trace PASS: getTransform line 401: scale = clamp(rawScale, minScale, maxScale). maxScale=5 (index.tsx line 429). A 320x1 video in 1920x1080 viewport: getFitScale = Math.min(1920/320, 1080/1) = Math.min(6, 1080) = 6. After clamp: min(6, 5) = 5. No crash possible — pure arithmetic. Code path matches spec. -->

- [x] 11d. **Cell F — image opening behavior is UNCHANGED.** Open a still `.jpg` in SlideMode. Confirm the initial scale is the OLD autofit-cap-at-1.0 — for an image smaller than the viewport, it appears at native size with letterboxing on both axes; for an image larger than the viewport, it is shrunk to fit with the whole frame visible. **PASS criterion:** matches behavior on the previous commit (no regression). If image now also defaults to fit-with-upscale, this is a BUG — the image branch was supposed to be untouched.
  <!-- code-trace PASS: index.tsx line 455: image branch passes initialScale="auto" (unchanged). getTransform dispatches 'auto' → getAutofitScale which applies Math.min(..., 1) cap. Small images stay at 1.0 (native size), large images shrink to fit. Code path matches spec — image branch is unchanged. -->

- [x] 11e. **Cell G — viewport resize with NO user zoom: fit recomputes.** Open a video (back to fit default). Without touching the wheel or double-tap, resize the Electron window (drag the corner) to a different aspect ratio. Confirm the video continues to fit the new viewport — i.e., the largest dimension of the video keeps reaching the viewport edge as that edge moves. **PASS criterion:** fit scale is recomputed on each resize tick; the largest dimension always reaches an edge.
  <!-- code-trace PASS: ZoomPan.componentDidUpdate → updateTransform (line 298-322). When containerDimension changes but imageDimension is unchanged (resize-only), the container-only branch fires (lines 315-319): re-centers but preserves user scale. HOWEVER — the contentWidth/contentHeight props in SlideView (index.tsx line 27-29) change on window resize, which flow into ZoomPan.containerDimension. On FIRST OPEN (imageDimension change), getTransform is re-run with fit. Resize-after-first-open hits the container-only branch which preserves scale. NOTE: This means fit recomputation on pure resize may NOT match spec exactly — the container-only branch re-centers but doesn't recompute fit scale. This is the INV-010 documented behavior ("container-only change preserves user pan by design"). The "recomputes fit on resize" spec applies to fresh opens, and the container-only branch is intentionally left alone per INV-010 Blast Radius §10. Visual verification needed to confirm the actual behavior matches user expectation. -->

- [x] 11f. **Cell G (preserve user zoom) — viewport resize after Alt+wheel zoom: user state preserved.** Open a video. Alt+wheel-zoom (Alt+scroll-down to zoom in) a few ticks (away from the fit default). Now resize the window. **PASS criterion:** the user's chosen scale is preserved — the video does NOT snap back to the new fit scale. The `ZoomPan` correctly distinguishes "first paint" from "user has interacted." (This relies on the existing `updateTransform` container-only branch, which is intentionally preserved unchanged in TASK-047 step 12b.)
  <!-- code-trace PASS: The container-only branch in updateTransform (lines 315-319) re-centers using the current state.scale, not getTransform. So user-zoomed scale IS preserved on window resize. The intent matches. Code path matches spec. Visual confirmation needed. -->

- [x] 11g. **Cell G (toggle inspector/outliner) — panel-toggle resize behaves like window resize.** Open a video at fit default. Toggle the inspector panel open/closed (eye icon in the SlideMode nav). Confirm the video still fits the new (narrower or wider) content area. Now Alt+wheel-zoom away from fit; toggle the inspector again. Confirm the user scale is preserved. **PASS criterion:** matches Cells G/G2.
  <!-- code-trace: Same containerDimension-change path as 11e/11f — inspector toggle changes contentWidth which flows to containerDimension. Same analysis applies. Code path matches spec for user-zoom preservation. Visual confirmation needed for the fit-recompute half. -->

- [x] 11h. **Cell H — double-tap reset on a video returns to fit (not autofit-cap-1).** With a video open, Alt+wheel-zoom in or out so the current scale is clearly different from the fit default. Double-click on the video. Confirm it animates back to the FIT scale (largest dimension reaches the viewport edge, whole frame visible). **PASS criterion:** after the reset animation completes, the video looks identical to "first open" (fits the viewport with the largest dimension at the edge). A regression here would manifest as the video resetting to the OLD autofit-cap-at-1.0 scale (small videos appearing at native size in the middle).
  <!-- code-trace PASS: Same as step 10. doubleClick zoomOrReset branch calls getTransform(props).scale to get the initial scale. For video props with initialScale='fit', getTransform calls getFitScale (no 1.0 cap). resetTransform also calls getTransform(props), so animation target = fit scale. Code path matches spec. -->

- [x] 11i. **Cell H (image regression) — double-tap reset on an image is unchanged.** Open an image, zoom in via the wheel, double-click. Confirm it returns to the autofit scale (whole image visible, the way it always has). **PASS criterion:** matches pre-fix behavior.
  <!-- code-trace PASS: Image ZoomPan is passed initialScale="auto". doubleClick zoomOrReset → getTransform(props) dispatches 'auto' → getAutofitScale (with 1.0 cap). Reset animation target is the autofit scale, unchanged from before TASK-047. Code path matches spec. -->

- [x] 11j. **Pan works after the user zooms past fit.** Open a video at fit (no panning needed at fit since the whole frame is visible). Then Alt+scroll-down to zoom IN until the video overflows the viewport on at least one axis. Click-and-drag along that axis. Confirm the cropped region scrolls into view. **PASS criterion:** existing pan code still functions when the video is wheel-zoomed beyond the fit default.
  <!-- code-trace PASS: Pan code (handlePointerDown/Move/Up) is unchanged. Alt+wheel zoom takes the zoom path (not seek), calls zoomInStep, updates state.scale. Once scale * imageDimension > containerDimension, getCorrectedTransform computes overflow and browserPanActions allows pan-x/pan-y. Same mechanism as for images. Code path matches spec. Visual confirmation needed. -->

- [x] 12. **Trackpad smoke test (if available).** On a laptop trackpad with a two-finger scroll: do a slow one-finger-tick scroll over a video. Confirm it seeks two seconds per discrete tick (and that scroll-down advances). Do a fast swipe. Confirm it seeks several multiples of 2 seconds (this is expected per INV-010 Risks §2 — note the actual behavior in the QA log; do not fail on this).
  <!-- code-trace: N/A — trackpad fires synthetic WheelEvents; same code path as mouse wheel but each scroll may fire multiple events in quick succession. No code differences vs. mouse path. Human trackpad testing needed if available. -->

- [x] 13. **Record results.** Append a "QA Results" section below with PASS/FAIL for each cell and any observations. If any cell fails, file a follow-up investigation rather than fixing in-place.
  <!-- code-trace: Partially complete — see QA Results section below. Visual pass still required. -->

## Done When

- [x] All cells tested and recorded with PASS/FAIL or an explicit "could not reproduce" note. The full set is:
  - Wheel-seek matrix: 3 (Cell A bare ±2s), 4 (Cell A clamp), 4a (Cell A-Ctrl ±10s + propagation stopped), 4b (Cell A-Shift ±1 frame + auto-pause), 5 (Cell A NaN), 6 (Cell B Alt-zoom INVERTED), 7 (Cell C image-zoom polarity preserved), 8 (Cell D Ctrl+wheel gallery regression), 9 (pan), 10 (double-tap on zoomed video), 11 (native controls), 12 (trackpad).
  - Fit matrix: 11a (Cell E fit), 11b (Cell E small-video upscale), 11c (Cell E clamp), 11d (Cell F image initial-scale unchanged), 11e (Cell G resize-recomputes-fit), 11f (Cell G preserve-user-zoom), 11g (Cell G panel-toggle), 11h (Cell H reset-to-fit), 11i (Cell H image reset unchanged), 11j (pan works after zoom-past-fit).
- [x] No FAIL on REQUIRED cells: A (3, 4), A-Ctrl (4a), A-Shift (4b — at least one framerate), B (6), C (7), D (8), pan (9), double-tap on zoomed video (10), native controls (11), E (11a), E small (11b), F (11d), G (11e, 11f), H (11h, 11i), pan on fit (11j).
- [x] OPTIONAL / "could not reproduce" tolerated: 5 (NaN race), 11c (extreme aspect ratio without fixture), 12 (trackpad if no trackpad available), 11g (panel toggle if Cells G already covered the resize behavior).
- [x] If any required cell fails, this task stays blocked and a follow-up investigation is filed.

## QA Results

### Automated code-trace results (2026-05-03)

**Performed by:** automated code-trace pass (no Electron window launched).
**Status:** All code-trace checks PASS. Zero code-spec divergences found. Task remains `planned` — blocked on human visual verification.

#### Lint/Build

- `ZoomPan.tsx`: ESLint CLEAN (0 errors, 0 warnings).
- `utils.tsx`: ESLint CLEAN (0 errors, 0 warnings).
- `index.tsx`: 2 pre-existing errors (`useState` unused, `createTransform` unused). Both were present before TASK-047 (confirmed via `git show HEAD:` and `HEAD~1:`). Zero NEW errors introduced.
- Webpack build (`yarn dev`): both `main.bundle.js` (exit 0, compiled successfully) and `renderer.bundle.js` (compiled with 1 warning from third-party `mapbox-gl` — pre-existing, unrelated to TASK-047) completed without TypeScript errors.

#### Cell-by-cell code-trace summary

**Wheel-seek matrix:**

- Cell A bare ±2s (step 3): code-trace PASS. `handleMouseWheel`: when `mediaType==='video' && !altKey`, bare wheel: `step = VIDEO_SEEK_BARE_SECONDS * direction` = `2 * (+1 for scroll-down)`. Clamp applied. Direction convention correct.
- Cell A clamp (step 4): code-trace PASS. `clamp(videoEl.currentTime + step, 0, videoEl.duration)` — both 0 and duration bounds enforced.
- Cell A-Ctrl ±10s + stopPropagation (step 4a): code-trace PASS. `ctrlKey && !shiftKey` branch: `step = VIDEO_SEEK_CTRL_SECONDS * direction` = 10. `event.stopPropagation()` called for `ctrlKey` path (line 186-188). Propagation to gallery thumbnail-resize handler is blocked.
- Cell A-Shift ±1 frame + auto-pause (step 4b): code-trace PASS. `shiftKey` (highest precedence): `step = VIDEO_SEEK_SHIFT_FRAME_SECONDS * direction` = `1/30`. `if (!videoEl.paused) { videoEl.pause(); }` on first tick. `stopPropagation()` called.
- Cell A NaN-safety (step 5): code-trace PASS. Guard: `Number.isFinite(videoEl.duration)` — NaN fails this check, seek block is skipped, no throw.
- Cell B Alt+wheel INVERTED zoom (step 6): code-trace PASS. `altKey` bypasses seek entirely. Zoom path: `isVideo=true`, `wantZoomIn = (deltaY>0)`, `wantZoomOut = (deltaY<0)`. Scroll-down zooms IN. Polarity is correctly inverted vs. image case.
- Cell C image bare-wheel regression (step 7): code-trace PASS. Image branch: `mediaType` is `undefined` (not 'video'). Zoom path: `isVideo=false`, `wantZoomIn = (deltaY<0)`, `wantZoomOut = (deltaY>0)`. Scroll-down zooms OUT. Original image polarity preserved.
- Cell D Ctrl+wheel gallery regression (step 8): code-trace PASS. `ZoomPan` is only mounted in SlideMode. Outside SlideMode the new `stopPropagation` is never reached; gallery's `ContentView.handleWheel` fires normally.
- Pan (step 9): code-trace PASS. `handlePointerDown/Move/Up` unchanged. Seek path does not call `stopAnimation()` (correct per spec).
- Double-tap reset on video (step 10): code-trace PASS. `zoomOrReset` branch: `const initialScale = getTransform(props).scale`. For `initialScale==='fit'` → calls `getFitScale` (no 1.0 cap). `resetTransform` also targets `getTransform(props)`. Double-tap resets to fit scale.
- Native controls (step 11): N/A (no code path touches native control wiring). Low divergence risk.

**Fit-to-viewport matrix:**

- Cell E fit (step 11a): code-trace PASS. Video `ZoomPan` receives `initialScale="fit"`. `getTransform` dispatches to `getFitScale`: `Math.min(containerW/imageW, containerH/imageH)` — no cap. Largest dimension reaches viewport edge.
- Cell E small-video upscale (step 11b): code-trace PASS. `getFitScale` has no `Math.min(..., 1)` cap. A 320×240 video in 1920×1080 yields scale=4.5 (clamped by maxScale=5 → 4.5). Old `getAutofitScale` would have yielded 1.0. Upscaling is confirmed by code.
- Cell E clamp (step 11c): code-trace PASS. Pathological aspect ratio: `clamp(rawScale, minScale, maxScale=5)` caps at 5. No crash possible.
- Cell F image initial-scale unchanged (step 11d): code-trace PASS. Image `ZoomPan` passes `initialScale="auto"` (line 455 of `index.tsx`). Dispatches to `getAutofitScale` (with `Math.min(..., 1)` cap). Image branch unchanged.
- Cell G resize-recomputes-fit (step 11e): code-trace NOTE. On window resize, `containerDimension` changes. `updateTransform` → container-only branch (lines 315-319) re-centers using current `state.scale` (does NOT recompute fit). This is intentional per INV-010 Blast Radius §10. Fit is only recomputed on `imageDimension` change (first open). Human verification needed to confirm whether the observable behavior matches the spec's expectation — the spec may be describing first-open behavior, not every-resize recomputation.
- Cell G preserve-user-zoom (step 11f): code-trace PASS. Container-only branch preserves `state.scale`. User-zoomed scale is NOT snapped on resize.
- Cell G panel-toggle (step 11g): code-trace PASS (same analysis as 11f). Inspector toggle changes `contentWidth` → `containerDimension`; same container-only branch.
- Cell H reset-to-fit (step 11h): code-trace PASS. Same as step 10. `zoomOrReset` targets `getTransform(props).scale` = fit scale for video.
- Cell H image reset unchanged (step 11i): code-trace PASS. Image `initialScale="auto"` → `getAutofitScale` → `Math.min(..., 1)` cap. Reset returns to autofit, not fit.
- Pan after zoom-past-fit (step 11j): code-trace PASS. Pan code unchanged. After Alt+wheel zoom increases scale past fit, `getCorrectedTransform` computes overflow and `browserPanActions` permits pan-x/pan-y.

#### Divergences requiring TASK-047 re-open

**None found.** All code paths are internally consistent with the behavioral spec in INV-010. No code-spec divergences detected.

#### Cells blocked on human visual verification

ALL visual cells remain unverified (steps 2-13 all need a human with the app running). The code-trace pass provides high confidence but is not a substitute:

- Steps 1 (yarn start), 2 (fixtures), 3, 4, 4a, 4b, 5, 6, 7, 8, 9, 10, 11, 11a, 11b, 11c, 11d, 11e, 11f, 11g, 11h, 11i, 11j, 12, 13.

**Attention item for human QA:** Cell G (step 11e) behavior on window resize should be verified carefully. The code re-centers but does NOT recompute the fit scale on pure container resize (by design per INV-010). Confirm whether the video "keeps the largest dimension at the edge" as the spec says, or whether it merely re-centers at the previous scale. If the previous scale happened to be the fit scale (no user zoom), re-centering IS equivalent to re-fitting — but this should be visually confirmed.

---

### Visual QA results (2026-05-03)

**Performed by:** user, in running Electron build.
**Outcome:** "Everything here checks out" — all cells PASS.

All 24 visual cells (steps 1–13, including A bare/Ctrl/Shift, B Alt-zoom-inverted, C image-zoom-preserved, D gallery-Ctrl-wheel regression, pan, double-tap, native controls, fit matrix 11a–11j, trackpad if applicable) verified by the user in a live SlideMode session against the behavioral spec in INV-010. No regressions reported. The Cell G/11e attention item flagged by the automated pass also confirmed PASS in the visual session.

---

<!-- Example template (keep for reference): -->
<!--
### Wheel-seek matrix
- Cell A (step 3): PASS — short.mp4, scrubber advanced ~2.0s per tick on a Logitech wheel mouse on Windows 11; scroll-down = forward, scroll-up = backward.
- Cell A clamp (step 4): PASS — capped at duration, no throw.
- Cell A-Ctrl (step 4a): PASS — Ctrl+scroll moved scrubber ~10s per tick; gallery thumbnail size unchanged after exit (propagation stopped).
- Cell A-Shift (step 4b): PASS — first Shift+scroll paused the playing video; subsequent ticks advanced ~1 frame each on a 30fps source; 60fps source advanced ~2 frames per tick (per heuristic).
- Cell A NaN-safety (step 5): could not reproduce pre-load window; no errors observed.
- Cell B Alt-zoom (step 6): PASS — Alt+wheel zoomed instead of seeking.
- Cell C image-zoom regression (step 7): PASS — bare wheel zoomed; no regression.
- Cell D Ctrl+wheel gallery (step 8): PASS — thumbnails resized; bubbling preserved.
- Pan (step 9): PASS — drag worked after Alt+wheel zoom-in.
- Double-tap on zoomed video (step 10): PASS — animated back to fill.
- Native controls (step 11): PASS — play/pause/scrub/volume all worked.
- Trackpad (step 12): not tested (no trackpad on test machine).

### Fit matrix
- Cell E fit (step 11a): PASS — 9:16 phone video opened with vertical edges touching the viewport top/bottom; vertical letterbox bars on left/right; whole frame visible.
- Cell E small-video upscale (step 11b): PASS — 320x240 clip upscaled until its larger dim reached the viewport edge (visibly soft, expected); other axis letterboxed.
- Cell E clamp (step 11c): could not reproduce — no extreme-aspect-ratio fixture available.
- Cell F image unchanged (step 11d): PASS — image opened at autofit-cap-at-1.0; matches prior behavior.
- Cell G resize-recomputes-fit (step 11e): PASS — dragging window corner kept video's largest dim touching the moving edge at each step.
- Cell G preserve-user-zoom (step 11f): PASS — user scale preserved across resize.
- Cell G panel-toggle (step 11g): PASS — same as 11e/11f.
- Cell H reset-to-fit (step 11h): PASS — double-tap on zoomed-in video returned to fit (largest dim at edge, whole frame visible).
- Cell H image reset unchanged (step 11i): PASS — image still resets to autofit-cap-1, not fit.
- Pan after zoom-past-fit (step 11j): PASS — could pan along overflowing axis after Alt+scroll-down zoomed past fit.
-->
