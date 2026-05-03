---
id: INV-010
title: 'Video player scroll wheel should seek by 1s; Alt+scroll should zoom; videos should fill the viewport by default'
reported_bug: 'In SlideMode, scrolling the mouse wheel over a video zooms it. Bare scroll should rewind/fast-forward by 1s per tick; Alt+scroll should be the zoom (the current bare-scroll behavior). Additionally, the video should always attempt to FILL the viewport as its default zoom (cover-mode), rather than fit-to-letterbox.'
date: 2026-05-03
last_updated: 2026-05-03
status: tasks-created
superseded_by:
tasks_spawned: [TASK-047, TASK-048]
root_cause_category: missing-edge-case
affects:
  - 'SlideMode wheel handling for videos (src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx)'
  - 'SlideMode initial-scale computation for videos (src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx getTransform, utils.tsx getAutofitScale)'
  - 'SlideMode double-tap reset target for videos (ZoomPan.doubleClick zoomOrReset branch)'
  - 'Existing modifier-key scroll convention (Ctrl+scroll resizes thumbnails in src/frontend/containers/ContentView/index.tsx)'
---

## Bug Report

### Observed Behavior

In SlideMode, when the active media is a video (extensions `webm`, `mp4`, `ogg` per `common/fs.ts:46-48`), spinning the mouse wheel over the player zooms the video in or out. There is no scroll-wheel scrub/seek; users must drag the native HTML5 `controls` scrubber to move along the timeline.

The wheel-to-zoom behavior is implemented in `ZoomPan.handleMouseWheel` (`src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx:152-167`):

```ts
handleMouseWheel = (event: React.WheelEvent) => {
  this.stopAnimation();
  const { scale } = this.state;
  const point = getRelativePosition(createVec2(event.clientX, event.clientY), this.container);
  if (event.deltaY > 0) {
    if (scale > this.props.minScale) {
      this.zoomOut(point);
      tryPreventDefault(event);
    }
  } else if (event.deltaY < 0) {
    if (scale < this.props.maxScale) {
      this.zoomInStep(point);
      tryPreventDefault(event);
    }
  }
};
```

`onWheel: this.handleMouseWheel` is passed to the render-prop child (`ZoomPan.tsx:296`) and ends up on both the `<img>` (image case) and the `<video>` (video case) in `src/frontend/containers/ContentView/SlideMode/index.tsx:391-403, 424-432`. So the same handler covers both media types — there is no video-specific branch.

### Expected Behavior

In SlideMode, when the active media is a video:

- **Bare wheel scroll (no modifier):** seek the video by exactly 1 second per scroll tick.
  - Scroll up (`deltaY < 0`, wheel rolling away from the user on Windows/Mac with default settings): seek **forward** +1s.
  - Scroll down (`deltaY > 0`): seek **backward** −1s.
  - Convention rationale: the existing zoom code uses `deltaY > 0 → zoomOut` and `deltaY < 0 → zoomIn`, i.e. wheel-up = "more / closer / further along," which matches YouTube and most video editors where wheel-up advances the timeline. Mac users with "natural scrolling" reverse this at the OS level; we honor the platform `deltaY` sign and do not try to detect natural-vs-classical.
- **Alt + wheel scroll:** perform the current zoom action (the existing `handleMouseWheel` logic, unchanged).

For images (non-video files), wheel behavior must remain **exactly as today**: bare-wheel zooms, Alt+wheel is undefined / falls back to zoom (the user did not request a change for images, so we do not introduce one).

Seek must clamp to `[0, video.duration]` and must not crash if `video.duration` is `NaN` (still loading / metadata not ready) — in that case treat the seek as a no-op.

### Reproduction Context

- Deterministic. Open any `.webm`/`.mp4`/`.ogg` in SlideMode (double-click the gallery thumbnail or activate slide mode for a selected video). Spin the mouse wheel anywhere over the player. Today: zoom changes; expected: timeline seeks by ±1s.
- The video element is a native HTML5 `<video controls autoPlay loop>` (`SlideMode/index.tsx:392-401`). The handler attaches via the React synthetic-event `onWheel` prop, which fires on the video element and bubbles.
- Independent of OS, video codec, library backend, or selected library. The handler is purely a renderer-side React event handler.

### Second Issue: Default Zoom Should Fill the Viewport (added 2026-05-03)

**Observed behavior:** When a video opens in SlideMode, the initial scale is computed by `getAutofitScale(containerDimension, imageDimension)` (`SlideMode/utils.tsx:66-74`), which returns `Math.min(containerW/imageW, containerH/imageH, 1)`. This is a classic "**contain**" / "fit" computation: the WHOLE video fits inside the viewport with letterboxing on whichever axis has spare room, AND the result is capped at `1.0` so videos smaller than the viewport are never upscaled.

The call sites are `SlideMode/index.tsx:380` (video branch) and `:413` (image branch), both of which pass `initialScale="auto"`. `ZoomPan.getTransform` (`ZoomPan.tsx:343-359`) interprets `'auto'` by calling `getAutofitScale`, then clamps to `[minScale, maxScale]`.

**Expected behavior:** When a video opens in SlideMode, the initial scale should be the "**cover**" / fill scale: `Math.max(containerW/imageW, containerH/imageH)` — the video grows until the viewport is fully covered, with the larger dimension overflowing on one axis (panable). The user said "the zoom should always attempt to fill the viewport as a default."

**Distinction:**
- `contain` (current): `min(viewportW/mediaW, viewportH/mediaH)`. Whole media visible, letterboxed.
- `cover` / fill (new default for video): `max(viewportW/mediaW, viewportH/mediaH)`. Viewport fully covered, media overflows on one axis.

**Reproduction context:** Same as above — deterministic, open any video in SlideMode. Today, a 16:9 video in a 21:9 viewport letterboxes vertically (black bars left/right). With the fill default, it should grow to cover horizontally and overflow vertically (visible content cropped top/bottom unless the user pans/zooms).

### Scope: Video-Only vs. Video + Image (decision)

The user's request was made in a turn that focused on the video-mode UX work; their literal words were "the zoom should always attempt to fill the viewport as a default." They did not specify video-only. **This investigation interprets the change as VIDEO-ONLY** for the following reasons:

1. The prior thread context was specifically about video. "Only fix what was asked" applies.
2. Changing image default behavior is a higher-impact change with a long history of muscle memory ("I open an image, I see the whole image"). The current contain-with-cap-at-1.0 default has been stable; flipping it to fill would crop visible content on every open and would surprise users.
3. Filling makes more sense for video specifically — videos are typically presentational/cinematic and benefit from immersive framing. Images in a photo manager are typically being inspected, where seeing the whole frame matters more.

**Open question for the user (flagged, not assumed):** Do you also want IMAGES to default to fill-the-viewport? If yes, this is a one-line follow-up — change the image branch's `initialScale` to use the same fill computation. If no, leave images at the current contain-cap-1.0 behavior. Default assumption while investigating: **video-only**. The implementer should not change image behavior without explicit confirmation.

---

## Root Cause Analysis

**Category:** missing-edge-case

### Diagnosis

`ZoomPan` is a generic pan/zoom container originally written for still images (its provenance is the MIT-licensed `react-responsive-pinch-zoom-pan`, see `LICENSE` in the same folder and the file header at `ZoomPan.tsx:1-4`). When video support was added, the same `ZoomPan` was reused as a wrapper around `<video>` (`SlideMode/index.tsx:376-403`) — a pragmatic choice that gave videos pan/zoom for free, but it inherited the wheel-to-zoom interaction designed for still images.

For videos, the wheel has a more useful semantic: timeline scrub. The current code never branches on media type inside `handleMouseWheel`, so videos get the still-image zoom by accident of code reuse.

This is a **missing edge case**, not a wrong abstraction: the abstraction (a pan/zoom viewport) is correct and worth keeping for both media types. What is missing is the conditional behavior that says "if the child element is a `<video>` AND no modifier is held, the wheel means seek, not zoom."

The cleanest hook point is `ZoomPan.handleMouseWheel` itself, because that is where the wheel signal arrives and where the `event.altKey`, `deltaY` sign, and the wheel target are all in scope. Handling it any higher (e.g. on the outer `#zoomable-image` div) would lose the relationship to the underlying media element; handling it any lower (e.g. attaching a separate `onWheel` directly on the `<video>`) would race with the existing `ZoomPan` wheel handler that is already on the same element via `{...props}` spread.

The implementation needs a way to know "the child being rendered is a video." The simplest signal is a new optional prop on `ZoomPan` — `mediaType?: 'image' | 'video'` — passed in by the call site that already knows (`SlideMode/index.tsx:376` already branches on `isFileExtensionVideo(file.extension)`). This keeps `ZoomPan` media-aware without making it own the seek logic by reaching into the DOM.

For seeking, `ZoomPan` needs a reference to the `<video>` element. The current render-prop flow doesn't expose one because the caller only forwards spread `props`. We add a `videoRef` that `ZoomPan` exposes via the render-prop signature when `mediaType === 'video'`, and the call site passes it through to the `<video>`'s `ref`. Alternative: `ZoomPan` can `containerRef.current.querySelector('video')` at wheel time. The `querySelector` approach is uglier but avoids changing the render-prop signature — it's acceptable here because there is exactly one `<video>` per `ZoomPan`. The task picks the prop-plus-ref approach to avoid hidden DOM coupling, but the implementer may fall back to `querySelector` if it materially simplifies the patch (call this out in code review).

### Diagnostic Questions Considered

- **Wrong mental model?** Partially. The original author of the video-support patch likely did not think about scroll-wheel interaction at all — they reused `ZoomPan` because it gave them the visible part (pan/zoom canvas) for free. The mental model "wheel always zooms" was inherited from the image case without a deliberate decision.
- **Architectural shortcoming?** No. `ZoomPan` is a fine wrapper. We just need to teach it about media type.
- **Incorrect order of operations?** No.
- **Missing edge case?** Yes, primary category. The video branch was added at the level of "what element to render" but not at the level of "what wheel semantics apply."
- **Wrong abstraction?** Considered — could argue `ZoomPan` should be split into `ImageViewport` and `VideoViewport`. Rejected: 95% of the pan/zoom code is identical and worth sharing. A small `mediaType` prop is a strictly better trade than duplicating the file.
- **Silent failure?** No. The current behavior is wrong-but-deliberate, not silently failing.

### Root Cause: Fill-to-Viewport Default (second issue)

Same root-cause family — **missing edge case at the level of "what default makes sense for this media type."** When `ZoomPan` was generalized to wrap videos, the existing `'auto'` initialScale interpretation (contain-with-cap-at-1.0) was inherited unchanged. There is currently no "cover" / fill option in either `getAutofitScale` or in `ZoomPan`'s `initialScale` prop vocabulary. The fix is to introduce a fill option (either a new `initialScale: 'fill'` literal, or a new utility `getFillScale`, or both) and to opt the video branch into it.

The hook points are:

1. **`SlideMode/utils.tsx`** — add a `getFillScale` utility analogous to `getAutofitScale` but using `Math.max` instead of `Math.min`, and crucially **without** the `Math.min(..., 1)` cap (fill must upscale a small video to cover a large viewport — that is the whole point).
2. **`SlideMode/ZoomPan.tsx`** — extend the `initialScale` prop union from `number | 'auto'` to `number | 'auto' | 'fill'`, and update `getTransform` (line 343-359) to dispatch on the `'fill'` literal.
3. **`SlideMode/ZoomPan.tsx` `doubleClick` (line 209)** — the `zoomOrReset` branch currently reads `getAutofitScale` directly; this must become "the same scale `getTransform` would have produced for the current props," so it computes `'fill'` for the video case and `'auto'` for the image case. Easiest: replace the inline `getAutofitScale` call with a call to `getTransform(props).scale` (single source of truth) — see Holistic Solution.
4. **`SlideMode/index.tsx:380`** — change `initialScale="auto"` to `initialScale="fill"` on the video `ZoomPan`. Image branch unchanged.

**No race, no async fix needed.** The video render branch in `SlideMode/index.tsx:282-352` (the `usePromise` for `image`) already waits for `loadedmetadata` on a probe `<video>` element BEFORE rendering `ZoomPan` — it resolves the dimension promise only after `videoWidth`/`videoHeight` are available (line 298-307). So by the time `ZoomPan` mounts with `imageDimension={dimension}`, the dimensions are already real and the fill scale is computable immediately. No additional `loadedmetadata` listener is needed inside `ZoomPan`.

**Container resize is already handled** by `ZoomPan.componentDidUpdate` → `updateTransform` (line 314-318), which reacts to `containerDimension` prop changes and re-runs `getTransform(props)` (via `getCorrectedTransform` on imgDimensionChanged path; on container-only-changed path it preserves user-pan and just re-centers). For the fill default to recompute on resize, the existing recompute-on-image-change branch (line 258-264) is already correct because `getTransform(props)` will honor `initialScale: 'fill'` and produce the new fill scale. The container-only-changed branch (line 265-271) deliberately preserves user pan and does NOT recompute initial scale — that is **intentional and correct**: if the user has already wheel-zoomed away from the fill default, a container resize should not yank them back. **Recommendation: leave that branch alone.** This is a nuance to capture in QA.

---

## Blast Radius

Scope is small and contained — both issues live in the same two files.

### From the wheel-seek issue

1. **`src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx:152-167` (`handleMouseWheel`)** — Primary fix site. Needs to branch on `mediaType` and `event.altKey`.
2. **`src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx:33-47` (`ZoomPanProps`) and `:296` (render-prop spread)** — Add the `mediaType` prop and a way to access the `<video>` element for seeking (either a forwarded ref through the render-prop signature, or a `querySelector` inside the wheel handler — see Diagnosis).
3. **`src/frontend/containers/ContentView/SlideMode/index.tsx:376-403` (video render branch)** — Pass `mediaType="video"` into `ZoomPan` and wire the video ref through the render-prop, if the ref-based approach is taken. Image branch (`:411-433`) is unchanged or passes `mediaType="image"` explicitly.

### From the fill-to-viewport issue

4. **`src/frontend/containers/ContentView/SlideMode/utils.tsx:66-74` (`getAutofitScale`)** — Add a sibling `getFillScale` utility: `Math.max(containerW/imageW, containerH/imageH)`. Do NOT cap at 1.0 (fill MUST upscale a small video to cover a large viewport). Guard against zero/negative dimensions the same way `getAutofitScale` does (return `1`).
5. **`src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx:33-47` (`ZoomPanProps.initialScale`)** — Widen the union from `number | 'auto'` to `number | 'auto' | 'fill'`.
6. **`src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx:343-359` (`getTransform`)** — Dispatch on the new `'fill'` literal and call `getFillScale` instead of `getAutofitScale`. The existing `clamp(..., minScale, maxScale)` will naturally cap pathologically extreme aspect ratios at `maxScale=5`.
7. **`src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx:208-216` (`doubleClick` `zoomOrReset` branch)** — Currently calls `getAutofitScale(props.containerDimension, props.imageDimension)` inline as the "is current scale at the initial scale?" check. Change this to read the actual initial scale that `getTransform(props)` would produce (i.e., honor `props.initialScale`), so `'fill'` videos reset to fill, not to autofit. Cleanest implementation: replace the inline `getAutofitScale(...)` with `getTransform(props).scale`. **Decision:** double-tap reset target IS the new fill scale for videos — this matches user expectation that "reset" returns to the default zoom, and the default zoom is now fill.
8. **`src/frontend/containers/ContentView/SlideMode/index.tsx:380` (video ZoomPan call site)** — Change `initialScale="auto"` to `initialScale="fill"`.
9. **`src/frontend/containers/ContentView/SlideMode/index.tsx:413` (image ZoomPan call site)** — UNCHANGED. Stays at `initialScale="auto"`. (See Scope decision in the Bug Report section: image default is preserved pending explicit user confirmation.)

### Cross-cutting / unchanged

10. **`src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx:249-273` (`updateTransform`, container/image dimension change handler)** — No code change needed. The existing logic already calls `getTransform(props)` on image-dimension change (which will honor `'fill'`) and preserves user pan on container-only change (which is the right behavior — we do NOT want to yank a wheel-zoomed user back to fill on resize). This file region IS in scope to verify but should not be edited.
11. **Latent issue (NOT in scope, flag only):** `src/frontend/containers/ContentView/index.tsx:112-121` — `Content`'s outer `onWheel` handler resizes thumbnails when `Ctrl` is held. Wheel events from inside SlideMode bubble up to this handler because `tryPreventDefault` only calls `preventDefault()`, not `stopPropagation()`. This means **Ctrl+scroll while in SlideMode silently resizes the gallery thumbnails behind the slide view.** This is unrelated to the user's request but worth recording. Do NOT fix in this task — it is an existing, separate UX issue. If the QA pass surfaces it as a problem, file a follow-up investigation.

---

## UX / Requirements Specification

### Purpose

Make scroll-wheel interaction over a video in SlideMode useful for the dominant action a user wants to perform on a video (timeline scrub), while keeping the existing pan/zoom capability accessible behind the `Alt` modifier.

### User-Stated Design Decisions

1. **Bare wheel = seek ±1s per tick.** Each wheel tick produces exactly one second of seek. We do not scale by `deltaY` magnitude — high-resolution trackpad scrolls would otherwise either fly through the timeline or feel laggy. One tick, one second, regardless of `|deltaY|`. Detect a "tick" as any wheel event with `deltaY !== 0`; on trackpads this debounces nicely because the user explicitly intends a discrete step.
2. **Alt + wheel = zoom (current behavior).** `Alt` was chosen over `Ctrl` because `Ctrl+scroll` is already taken by the gallery's thumbnail-size resize, and `Shift+scroll` is conventionally horizontal scroll on most platforms. `Alt` is not currently used by any wheel handler in the codebase (verified via grep — the only modifier-aware wheel handler is `Content.handleWheel` checking `ctrlState`).
3. **Direction matches the existing zoom code's `deltaY` interpretation.** `deltaY > 0` → backward (mirrors the existing `deltaY > 0 → zoomOut` polarity, i.e. "scrolling down dials something down"). `deltaY < 0` → forward. We do not platform-detect natural scrolling; we trust the OS-reported `deltaY` sign.
4. **Image behavior is untouched.** Bare-wheel still zooms images. Alt+wheel on images falls through to the existing zoom path (it does not need to differ from bare-wheel for images, but it must not crash or error).
5. **Investigate-only deliverable.** Do not implement. Produce one investigation and the task(s) needed to implement it.

### Behavioral Specifications

- When `mediaType === 'video'` and `!event.altKey`:
  - If `videoEl` is null or `Number.isFinite(videoEl.duration) === false`, no-op (do not throw).
  - Else: `videoEl.currentTime = clamp(videoEl.currentTime + (event.deltaY < 0 ? +1 : -1), 0, videoEl.duration)`.
  - Call `tryPreventDefault(event)` so the browser does not also scroll the page.
  - Do **not** call `stopPropagation` — preserve the existing bubbling behavior to keep Ctrl+scroll thumbnail resize working in non-slide modes (and to leave the latent issue described in Blast Radius §4 in its current state, neither better nor worse).
- When `mediaType === 'video'` and `event.altKey`: run the existing zoom logic unchanged.
- When `mediaType === 'image'` (or undefined, default): run the existing zoom logic unchanged (Alt is ignored — same as today).
- The seek must not interact with `ZoomPan`'s pan/animation state. In particular, `this.stopAnimation()` should NOT be called for the seek path — it is a video-time mutation, not a transform mutation. (If we kept calling `stopAnimation` for both paths it would be harmless today but conceptually wrong.)

### Explicit Rejections

- Do NOT add platform detection for "natural scrolling." OS already inverts `deltaY` for that.
- Do NOT scale seek-amount by `|deltaY|` magnitude. One tick, one second.
- Do NOT alter behavior for images.
- Do NOT add a settings toggle to disable this. The user did not ask for one and SlideMode interactions are not user-configurable today.
- Do NOT fix the latent Ctrl+scroll-while-in-slidemode issue (Blast Radius §11) in this work. It is out of scope.
- Do NOT replace the native `<video controls>` scrubber. The wheel seek is additive.
- Do NOT change pan/double-tap/pinch behavior.

### Fill-to-Viewport: User-Stated Design Decisions (added 2026-05-03)

6. **Default initial zoom for video = fill (cover) the viewport.** When a video opens in SlideMode, the initial scale is `Math.max(containerW/videoW, containerH/videoH)` — the smaller dimension of the video reaches the corresponding viewport dimension and the larger dimension overflows. This is the opposite polarity from the existing autofit `Math.min(...)` and from the `Math.min(..., 1)` cap (which is dropped for fill — a small video MUST upscale to cover the viewport).
7. **"As a default" — user can still wheel-zoom from there.** The fill scale is the starting point on open, not a lock. Alt+wheel zoom-in / zoom-out from the fill scale works exactly as today's zoom (relative scaling: `scale * 1.1` / `scale / 1.1` per tick). The `minScale` and `maxScale` constraints (`minScale = Math.min(0.1, contain-scale)`, `maxScale = 5`) are unchanged — the user can zoom out to see the whole video (below fill, into letterbox territory) and zoom in up to 5x.
8. **Recompute fill on viewport resize, but NOT on user pan/zoom.** When the browser/Electron window resizes (or the inspector/outliner panel toggles), the video should recompute its fill scale and re-center — UNLESS the user has already manually zoomed away from the default. The existing `ZoomPan.componentDidUpdate` → `updateTransform` logic already does the right thing here (see Blast Radius §10 / Root Cause §"Fill" subsection): on `imageDimension` change it re-runs `getTransform(props)` (which will honor `'fill'`), and on container-only change it preserves user pan/scale by design. Confirm in QA, do not modify.
9. **Reset gesture (double-tap with `doubleTapBehavior="zoomOrReset"`) resets to the new default — i.e., to fill for videos and to autofit for images.** This is a natural consequence of treating "the initial scale" as the canonical reset target. The `doubleClick` handler at `ZoomPan.tsx:208-216` must be updated to read the true initial scale via `getTransform(props).scale` instead of the hard-coded `getAutofitScale(...)` it currently uses.
10. **Aspect-ratio edge cases:** an extreme aspect-ratio mismatch (e.g., a 1×1080 video in a 1920×800 viewport) would compute a fill scale of `1920/1` = 1920, which exceeds `maxScale=5`. The existing `clamp(..., minScale, maxScale)` in `getTransform` will cap the result at 5. This is acceptable — such a video is pathological and the user can zoom further if desired. Do NOT bump `maxScale` to accommodate this; the cap is also a safety bound for `imageStyle`'s `pixelated` rendering threshold (line 491).
11. **Open question (flagged for user confirmation, not assumed):** Should images also default to fill instead of contain-cap-1.0? Default assumption: NO, video-only. Implementer must NOT change image behavior without confirmation.
12. **No new settings toggle.** Same rationale as decision §4 — SlideMode interactions are not user-configurable. Fill is the default for video, full stop.

### Fill-to-Viewport: Behavioral Specifications

- New utility `getFillScale([containerW, containerH], [imageW, imageH])` in `SlideMode/utils.tsx`:
  - If `imageW <= 0 || imageH <= 0`: return `1` (matches `getAutofitScale` zero-guard).
  - Else: return `Math.max(containerW / imageW, containerH / imageH)`.
  - **No `Math.min(..., 1)` cap** — fill must upscale.
- New `initialScale` literal `'fill'` accepted by `ZoomPanProps`. `getTransform` dispatches:
  - `initialScale === 'auto'` → `getAutofitScale(...)` (existing).
  - `initialScale === 'fill'` → `getFillScale(...)` (new).
  - `typeof initialScale === 'number'` → use literally (existing).
  - All three paths still pass through `clamp(..., minScale, maxScale)` (existing).
- Video render branch in `SlideMode/index.tsx:376-403` passes `initialScale="fill"`.
- Image render branch in `SlideMode/index.tsx:411-433` continues to pass `initialScale="auto"`.
- `doubleClick` `zoomOrReset` branch reads the initial scale via `getTransform(props).scale` (or via a small private `getInitialScale(props)` helper if cleaner) so it resets to whatever the initial computation produced for the current `mediaType`.

### Fill-to-Viewport: Explicit Rejections

- Do NOT change the IMAGE default (pending user confirmation; see decision §11).
- Do NOT change `maxScale=5`. The clamp is intentional.
- Do NOT add a `loadedmetadata` listener inside `ZoomPan` — the dimension prop is already correct by mount time (the outer `usePromise` handles metadata loading; see Root Cause §"Fill" subsection).
- Do NOT recompute fill on container-only resize when the user has already wheel-zoomed (the existing `updateTransform` container-only branch correctly preserves user state).
- Do NOT add an `object-fit: cover` CSS rule to the `<video>` element. Fill MUST be implemented via the transform/scale system so that pan, wheel-zoom, and double-tap-reset interact with it correctly. CSS `object-fit` would bypass `ZoomPan` entirely and break those interactions.

---

## Holistic Solution

### Approach

**Single implementation task (TASK-047, FRONTEND)** — both the wheel-seek/Alt-zoom branch AND the fill-to-viewport default land together because they both touch `ZoomPan.tsx` + `SlideMode/index.tsx` and they form one cohesive "video-mode UX" change. Splitting them would force the QA pass to re-set up a video twice for very little win.

#### Part A — wheel-seek and Alt-zoom (original plan, unchanged)

1. In `src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx`:
   - Add an optional `mediaType?: 'image' | 'video'` prop to `ZoomPanProps` (default `'image'`).
   - Add a private `videoRef = React.createRef<HTMLVideoElement>()` field on the class. Expose it through the render-prop child signature as a fourth field — only set when `mediaType === 'video'` — so the call site can attach it to the `<video>`. Concretely: extend the render-prop call to `this.props.children({ onPointerDown, onPointerMove, onPointerUp, onWheel, onDragStart, onContextMenu, style, ref: this.props.mediaType === 'video' ? this.videoRef : undefined })` and update the `children` type to `(props: React.ImgHTMLAttributes<HTMLElement> & { ref?: React.RefObject<HTMLVideoElement> }) => React.ReactElement<HTMLElement>`. Acceptable alternative if cleaner: `this.containerRef.current?.querySelector('video')` inside the wheel handler.
   - Modify `handleMouseWheel`:
     - If `this.props.mediaType === 'video' && !event.altKey`: read `videoEl = this.videoRef.current` (or `querySelector`), bail if `videoEl == null` or `!Number.isFinite(videoEl.duration)`, otherwise apply the ±1s clamped seek and `tryPreventDefault(event)`. Do NOT call `stopAnimation()` on this path.
     - Otherwise: existing zoom logic, unchanged.
2. In `src/frontend/containers/ContentView/SlideMode/index.tsx`:
   - In the video render branch (lines 376-403), pass `mediaType="video"` to `ZoomPan` and forward the ref from the render-prop into `<video ref={...} {...props}>`. (`{...props}` spread happens after `ref=` so the spread will not clobber the ref unless `props.ref` is set; if both end up set, set `ref` last.)
   - In the image render branch (lines 411-433), either omit `mediaType` (defaulting to `'image'`) or pass `mediaType="image"` explicitly for clarity. No ref change needed.
3. Verify the React TypeScript types compile under strict mode. `React.WheelEvent` already has `altKey: boolean` so no extra typing is needed for the modifier check.

#### Part B — fill-to-viewport default (new)

4. In `src/frontend/containers/ContentView/SlideMode/utils.tsx`:
   - Add and export `getFillScale`:
     ```ts
     export const getFillScale = (
       [containerWidth, containerHeight]: Dimension,
       [imageWidth, imageHeight]: Dimension,
     ): number => {
       if (imageWidth <= 0 || imageHeight <= 0) {
         return 1;
       }
       return Math.max(containerWidth / imageWidth, containerHeight / imageHeight);
     };
     ```
     Note: NO `Math.min(..., 1)` cap, unlike `getAutofitScale`. Fill must upscale a small video.
5. In `src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx`:
   - Import `getFillScale` from `./utils`.
   - Widen `ZoomPanProps.initialScale` from `number | 'auto'` to `number | 'auto' | 'fill'`.
   - Update `getTransform` (line 343-359) to dispatch on the new literal:
     ```ts
     const rawScale =
       initialScale === 'auto'
         ? getAutofitScale(containerDimension, imageDimension)
         : initialScale === 'fill'
         ? getFillScale(containerDimension, imageDimension)
         : initialScale;
     const scale = clamp(rawScale, minScale, maxScale);
     ```
   - Update `doubleClick` `zoomOrReset` branch (line 208-216): replace the inline `getAutofitScale(props.containerDimension, props.imageDimension)` with `getTransform(props).scale` so the "is current scale at the initial scale?" check honors `props.initialScale === 'fill'` for video. This makes double-tap-reset return to the fill default for videos and to the autofit default for images.
6. In `src/frontend/containers/ContentView/SlideMode/index.tsx`:
   - In the video render branch (line 380), change `initialScale="auto"` to `initialScale="fill"`.
   - In the image render branch (line 413), leave `initialScale="auto"` UNCHANGED.
7. **Do NOT** add a `loadedmetadata` listener inside `ZoomPan` — the dimension prop is already correct by mount time (the outer `usePromise` in `SlideMode/index.tsx:282-352` handles video metadata loading via a probe `<video>` with `preload="metadata"`).
8. **Do NOT** modify `updateTransform` (line 249-273). Its existing behavior (re-run `getTransform` on image-dimension change; preserve user pan on container-only change) is correct for the fill case as well.

#### QA

**QA task (TASK-048, FRONTEND):** Manual QA covering the scenarios in both Behavioral Specifications sections, plus regression checks for image zoom, image initial-scale (must still be autofit-cap-at-1.0), video pan, video pinch, video double-tap (must reset to fill, not to autofit), Ctrl+scroll thumbnail resize in non-slide modes, Alt+wheel zoom on videos, and viewport resize behavior (fill recomputes vs. preserves user pan). Documented in TASK-048.

### Expected Outcomes

- Wheel over a video in SlideMode seeks ±1s per tick; the `<video>`'s native scrubber visibly tracks the new `currentTime`.
- `Alt`+wheel over a video in SlideMode zooms — identical to today's bare-wheel zoom on a video.
- Wheel over an image in SlideMode zooms — identical to today.
- Ctrl+wheel in non-slide gallery modes still resizes thumbnails — unchanged.
- No console errors when wheel-seeking a video whose `duration` is still loading (`NaN`).
- **Opening a video in SlideMode shows it filling the viewport** — the smaller dimension reaches the corresponding viewport edge; the larger dimension overflows and may be panned.
- **Opening an image in SlideMode is unchanged** — autofit-with-cap-at-1.0, letterboxed.
- **Double-tapping a video resets to fill scale** (the new default), not to autofit.
- **Double-tapping an image still resets to autofit** (the image-side default is unchanged).
- **Resizing the window with a video open** (no user zoom yet) recomputes fill so the video continues to cover. **Resizing after the user has wheel-zoomed** preserves the user's scale and just re-centers (existing behavior; not regressed).
- **Pan still works on a fill-defaulted video.** Because the video overflows on one axis under the fill default, panning along that axis is meaningful and works through the existing pointer/pan code.

### Risks and Tradeoffs

- **Render-prop signature change.** Adding `ref` to the render-prop's argument widens the child type. The two existing call sites (image, video in `SlideMode/index.tsx`) cover all usage; there are no other consumers of `ZoomPan`. Risk is contained to the same file. If the implementer prefers, the alternative `containerRef.current.querySelector('video')` approach inside `handleMouseWheel` avoids the signature change at the cost of a one-liner DOM lookup per wheel event (cheap; the wheel rate is human-bounded).
- **Trackpad high-rate scrolling.** Because we do not coalesce multiple wheel events, an aggressive trackpad swipe could fire several `onWheel` events in close succession and seek the video several seconds. This is acceptable — it matches the user's intent ("I scrolled hard"). If feedback shows it feels wrong, a future task can debounce. Do not preempt.
- **Modifier choice (Alt).** On macOS, `Alt` is the `Option` key. Both Electron and Chromium surface it as `event.altKey` consistently, so behavior is identical across platforms.
- **Deferred latent issue.** Ctrl+scroll while a slide is open silently resizes background gallery thumbnails (Blast Radius §11). We are leaving this as-is. If the QA pass in TASK-048 surfaces it as confusing, a follow-up investigation should propose adding `event.stopPropagation()` to the SlideMode wheel handler when SlideMode is active.
- **Fill-default is opinionated.** Some users may prefer the old letterboxed contain default (e.g., to see the full video frame on first open). We are not adding a settings toggle (per decision §12). If user feedback pushes back, a future task can add a `Settings → SlideMode → "Fit videos to viewport on open"` boolean. Do not preempt.
- **Pathological aspect ratios.** A 1×1080 video computes a fill scale of 1080, which clamps to `maxScale=5`. The video is then visually clipped to a 5x scale, which still overflows but does not literally fill. This is acceptable — such files are extremely rare and the user can wheel-zoom further if they care. Do NOT bump `maxScale`.
- **`zoomOrReset` semantics shift slightly for videos.** Today, double-tap on a video at the autofit-default scale would zoom IN (the equality check was satisfied). After this change, double-tap on a video at the fill-default scale will also zoom IN — but the "fill-default scale" is generally LARGER than the old autofit scale (cover ≥ contain), so the zoom-in animation will go from "covering" to "covering more" (further zoomed in past fill). This is the correct interpretation of `zoomOrReset` and matches what users expect. Verify in QA.
- **Image branch left untouched is intentional and reversible.** If the user later asks for fill-on-image too, it is a one-line change to flip `initialScale="auto"` to `initialScale="fill"` on `SlideMode/index.tsx:413`. The fill machinery is already in place after this task lands.

---

## Documentation Updates

- [x] No updates needed — SlideMode wheel behavior is not currently documented in `docs/`.
- [x] No updates needed — SlideMode initial-scale behavior is not currently documented in `docs/`. If the user later requests a user-facing changelog/release note for the fill-on-open change, that would be a small addition to `docs/CHANGELOG.md` (does not exist today; out of scope).
