---
id: TASK-047
title: 'Video SlideMode UX: wheel seeks ±2s/±10s (Ctrl)/±1 frame (Shift), Alt+wheel zooms (inverted polarity for video), default fits viewport (largest dim at edge, upscales)'
investigation: INV-010
status: DONE
priority: low
blocked_by: []
date_created: 2026-05-03
date_updated: 2026-05-03
date_completed: 2026-05-03
files:
  - 'src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx'
  - 'src/frontend/containers/ContentView/SlideMode/index.tsx'
  - 'src/frontend/containers/ContentView/SlideMode/utils.tsx'
---

## What

Three coordinated changes to the SlideMode video viewer, all in the same `ZoomPan`/`SlideMode` files:

1. **Wheel seeks the video, with modifier-dependent step size.** When the wrapped media is a video and `Alt` is NOT held, a wheel tick seeks the video (clamped to `[0, duration]`). Step size by modifier (precedence Shift > Ctrl > bare):
   - Bare wheel: ±2s per tick.
   - Ctrl+wheel: ±10s per tick.
   - Shift+wheel: ±1 frame per tick (heuristic `1/30s`); pauses the video on the first tick if it was playing.
   Direction is the same for all three: scroll-down (`deltaY > 0`) advances; scroll-up (`deltaY < 0`) rewinds. Ctrl/Shift paths also call `event.stopPropagation()` so the seek does not also bubble to the gallery's Ctrl+wheel-thumbnail-resize handler. Bare wheel keeps bubbling unchanged.
2. **Alt+wheel zooms with inverted polarity for video.** When `Alt` is held on a video, the wheel zooms with INVERTED `deltaY` polarity — scroll-down zooms IN, scroll-up zooms OUT (matching the seek polarity). On images (bare wheel) the original polarity is preserved.
3. **Videos open at fit-the-viewport scale with upscaling.** The initial zoom for a video is `Math.min(viewportW/videoW, viewportH/videoH)` with NO `Math.min(..., 1)` cap — the LARGEST dimension of the video reaches the corresponding viewport edge, the entire video is visible, the OTHER axis letterboxes, and small videos DO upscale. Image branch initial-scale is unchanged.

## Why

`ZoomPan` was originally written for still images and reused for videos by wrapping `<video>` in the same container (`SlideMode/index.tsx:376-403`). Two image-era defaults were inherited without being reconsidered for video:

- The wheel-to-zoom interaction (videos benefit far more from scrub-on-wheel than from zoom-on-wheel; zoom is moved behind `Alt`, with inverted polarity for video so it matches the seek polarity).
- The contain-with-cap-at-1.0 initial scale (videos benefit from filling the available space — small clips upscale, large clips are sized so the largest dimension reaches the edge with the whole frame visible; images stay at contain-cap-1.0 so they open at native pixel size for inspection).

This task introduces the missing media-type branches in both directions.

See [INV-010](../investigations/INV-010_LOW_FRONTEND_video-scroll-seek-with-alt-zoom.md) for the full diagnosis: rationale for `Alt` as the modifier (Ctrl is taken by gallery thumbnail resize, Shift is conventionally horizontal scroll), the `deltaY > 0 → forward / deltaY < 0 → backward` direction convention (user-chosen "document scroll" polarity), the matching INVERTED Alt-zoom polarity for video, the fit-vs-autofit distinction (both use `Math.min` of the two ratios; fit drops the 1.0 upscale cap), the decision to keep image behavior unchanged, and the open question on whether image should also default to fit (NOT in scope for this task).

## Implementation Steps

> The implementation has two parts. Part A (steps 1-7) is the wheel-seek + Alt-zoom branch.
> Part B (steps 8-12) is the fill-to-viewport default for videos.
> Part C (steps 13-15) is shared verification.
> All three parts ship in one commit because they touch the same two-and-a-half files and form one cohesive "video-mode UX" feature.

### Part A — Wheel seeks video; Alt+wheel zooms

- [x] 1. **Open `src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx`.** In `ZoomPanProps` (lines 33-47), add a new optional field:
  ```ts
  mediaType?: 'image' | 'video';
  ```

- [x] 2. **Add a video ref field on the class.** Near `containerRef` (line 58), add:
  ```ts
  videoRef = React.createRef<HTMLVideoElement>();
  ```
  *Note: took the `querySelector` alternative instead — steps 2, 3, and 5 are skipped per the investigation's explicit permission. `this.containerRef.current?.querySelector('video')` is used directly in the wheel handler.*

- [x] 3. **Widen the `children` render-prop type** so the call site can receive an optional ref. Change the `children` field on `ZoomPanProps` from
  ```ts
  children: (props: React.ImgHTMLAttributes<HTMLElement>) => React.ReactElement<HTMLElement>;
  ```
  to
  ```ts
  children: (
    props: React.ImgHTMLAttributes<HTMLElement> & { ref?: React.RefObject<HTMLVideoElement> },
  ) => React.ReactElement<HTMLElement>;
  ```
  *Note: took the `querySelector` alternative — render-prop signature unchanged.*

- [x] 4. **Modify `handleMouseWheel` (lines 152-167).** Replace the body with the equivalent of:
  ```ts
  handleMouseWheel = (event: React.WheelEvent) => {
    // Wheel over a video seeks the timeline. Modifier-dependent step (precedence Shift > Ctrl > bare).
    // Alt+wheel falls through to the zoom path below.
    if (this.props.mediaType === 'video' && !event.altKey) {
      const videoEl = this.videoRef.current; // or: this.containerRef.current?.querySelector('video')
      if (videoEl && Number.isFinite(videoEl.duration)) {
        const direction = event.deltaY < 0 ? -1 : event.deltaY > 0 ? 1 : 0;
        if (direction !== 0) {
          let step: number;
          if (event.shiftKey) {
            step = VIDEO_SEEK_SHIFT_FRAME_SECONDS * direction; // 1/30
            if (!videoEl.paused) {
              videoEl.pause();
            }
          } else if (event.ctrlKey) {
            step = VIDEO_SEEK_CTRL_SECONDS * direction; // 10
          } else {
            step = VIDEO_SEEK_BARE_SECONDS * direction; // 2
          }
          videoEl.currentTime = clamp(videoEl.currentTime + step, 0, videoEl.duration);
          tryPreventDefault(event);
          if (event.shiftKey || event.ctrlKey) {
            event.stopPropagation();
          }
        }
      }
      return;
    }
    // Zoom path. For video (only reachable here under Alt+wheel) the deltaY → zoom polarity is
    // INVERTED so scroll-down zooms IN, matching the seek polarity. For image (bare wheel) the
    // original polarity is preserved.
    this.stopAnimation();
    const { scale } = this.state;
    const point = getRelativePosition(createVec2(event.clientX, event.clientY), this.container);
    const isVideo = this.props.mediaType === 'video';
    const wantZoomIn = isVideo ? event.deltaY > 0 : event.deltaY < 0;
    const wantZoomOut = isVideo ? event.deltaY < 0 : event.deltaY > 0;
    if (wantZoomOut) {
      if (scale > this.props.minScale) {
        this.zoomOut(point);
        tryPreventDefault(event);
      }
    } else if (wantZoomIn) {
      if (scale < this.props.maxScale) {
        this.zoomInStep(point);
        tryPreventDefault(event);
      }
    }
  };
  ```
  Notes:
  - `clamp` is already imported at line 8 (`import { clamp } from 'common/core'`).
  - Do **not** call `stopAnimation()` on the seek path — only the zoom path mutates the transform.
  - Do **not** call `event.stopPropagation()`. Bubbling must be preserved (see INV-010 Blast Radius §4 for why).
  - `Number.isFinite(videoEl.duration)` short-circuits the case where metadata has not loaded yet (`duration === NaN`).

- [x] 5. **Pass `ref` through the render-prop.** In `render()` (line 292-300), update the `children(...)` call to include the ref when applicable:
  ```ts
  {this.props.children({
    onPointerDown: this.handlePointerDown,
    onPointerMove: this.handlePointerMove,
    onPointerUp: this.handlePointerUp,
    onWheel: this.handleMouseWheel,
    onDragStart: tryPreventDefault,
    onContextMenu: tryPreventDefault,
    style: imageStyle(this.state, this.props.upscaleMode),
    ref: this.props.mediaType === 'video' ? this.videoRef : undefined,
  })}
  ```
  Skip this step if you took the `querySelector` alternative in step 3.

- [x] 6. **Open `src/frontend/containers/ContentView/SlideMode/index.tsx`.** In the video render branch (lines 376-403), pass `mediaType="video"` to `ZoomPan` and forward the ref into `<video>`:
  ```tsx
  <ZoomPan
    /* ...existing props... */
    mediaType="video"
  >
    {({ ref, ...props }) => (
      <video
        ref={ref}
        {...props}
        src={encodeFilePath(src)}
        width={dimension[0]}
        height={dimension[1]}
        controls
        autoPlay
        loop
      />
    )}
  </ZoomPan>
  ```
  Make sure `ref={ref}` appears **before** `{...props}` so the spread cannot clobber it (and confirm by destructuring `ref` out of `props` as shown). If you took the `querySelector` alternative, omit the `ref` plumbing entirely — only the `mediaType="video"` prop is needed.

- [x] 7. **(Optional but recommended) Pass `mediaType="image"` explicitly in the image branch** (lines 411-433) for clarity, or leave it unset since `'image'` is the documented default. Either way, do not change the image render-prop body.

### Part B — Default initial scale for video is fit-the-viewport with upscaling

- [x] 8. **Open `src/frontend/containers/ContentView/SlideMode/utils.tsx`.** Add and export `getFitScale` immediately after the existing `getAutofitScale` (after line 74):
  ```ts
  // "Fit-to-viewport" scale: largest image dimension reaches the corresponding viewport
  // edge — entire image visible, letterboxed on the other axis. Unlike getAutofitScale,
  // this DOES upscale a small image past 1.0 to reach the edge.
  export const getFitScale = (
    [containerWidth, containerHeight]: Dimension,
    [imageWidth, imageHeight]: Dimension,
  ): number => {
    if (imageWidth <= 0 || imageHeight <= 0) {
      return 1;
    }
    return Math.min(containerWidth / imageWidth, containerHeight / imageHeight);
  };
  ```
  **Critical:** do NOT cap at 1 (no `Math.min(..., 1)`). Fit-with-upscale must grow a small video so its largest dimension reaches the viewport edge — that is the entire point.

- [x] 9. **Open `src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx`.** Add `getFitScale` to the existing utility import block (line 9-24):
  ```ts
  import {
    // ...existing imports...
    getAutofitScale,
    getFitScale,
    // ...existing imports...
  } from './utils';
  ```

- [x] 10. **Widen `ZoomPanProps.initialScale`** from `number | 'auto'` to `number | 'auto' | 'fit'` (in the `ZoomPanProps` interface around line 35).

- [x] 11. **Update `getTransform` (lines 343-359)** to dispatch on the new `'fit'` literal. Change the inner scale computation from:
  ```ts
  const scale = clamp(
    initialScale === 'auto' ? getAutofitScale(containerDimension, imageDimension) : initialScale,
    minScale,
    maxScale,
  );
  ```
  to:
  ```ts
  const rawScale =
    initialScale === 'auto'
      ? getAutofitScale(containerDimension, imageDimension)
      : initialScale === 'fit'
      ? getFitScale(containerDimension, imageDimension)
      : initialScale;
  const scale = clamp(rawScale, minScale, maxScale);
  ```
  The `clamp(..., minScale, maxScale)` cap is intentional — it bounds pathological aspect ratios (e.g., a 320×1 video in a 1920-wide viewport would otherwise compute a fit scale of 6).

- [x] 12. **Update `doubleClick` `zoomOrReset` branch (lines 208-216)** so double-tap-reset honors `props.initialScale === 'fit'` for videos. Replace:
  ```ts
  case 'zoomOrReset':
    const initialScale = getAutofitScale(props.containerDimension, props.imageDimension);
    // If current scale is same as initial scale, zoom in, otherwise reset to initial zoom
    if (Math.abs(this.state.scale - initialScale) < 0.01) {
      this.zoomIn(position);
    } else {
      this.startAnimation(resetTransform(props, this.setState));
    }
    break;
  ```
  with:
  ```ts
  case 'zoomOrReset': {
    // Reset target = whatever getTransform currently produces for these props,
    // so 'fit' videos reset to fit and 'auto' images reset to autofit.
    const initialScale = getTransform(props).scale;
    if (Math.abs(this.state.scale - initialScale) < 0.01) {
      this.zoomIn(position);
    } else {
      this.startAnimation(resetTransform(props, this.setState));
    }
    break;
  }
  ```
  Note the added block braces around the `case` body — required because we declare a `const` inside it.

- [x] 12a. **Open `src/frontend/containers/ContentView/SlideMode/index.tsx`.** In the **video** render branch (line 380), change:
  ```tsx
  initialScale="auto"
  ```
  to:
  ```tsx
  initialScale="fit"
  ```
  In the **image** render branch (line 413), leave `initialScale="auto"` UNCHANGED. (Per INV-010, image default is preserved pending explicit user confirmation.)

- [x] 12b. **Do NOT modify `ZoomPan.componentDidUpdate` / `updateTransform` (lines 249-273, 314-318).** The existing logic — re-run `getTransform(props)` on image-dimension change, preserve user pan on container-only change — is already correct for the fit case. Verify this in QA, do not edit.

- [x] 12c. **Do NOT add a `loadedmetadata` listener inside `ZoomPan`.** The `usePromise` in `SlideMode/index.tsx:282-352` already waits for `loadedmetadata` on a probe `<video preload="metadata">` and resolves the dimension promise only after `videoWidth`/`videoHeight` are real. By the time `ZoomPan` mounts with `imageDimension={dimension}`, dimensions are correct.

### Part C — Verification

- [x] 13. **Run `yarn lint`** to confirm the TypeScript types compile under strict mode (`initialScale: 'fit'` literal must be accepted; the new render-prop `ref` field must type-check).
  *Result: lint reported errors only in pre-existing files unrelated to this task. The three SlideMode files produced zero new errors. Pre-existing errors in `index.tsx` (`useState` and `createTransform` unused) were present before this task.*

- [x] 14. **Run `yarn build`** to catch any production-only type or bundling issues.
  *Result: build reported 2 pre-existing errors in `src/main.ts` (TS18048 `'message' is possibly 'undefined'`) — unrelated to SlideMode. The renderer bundle compiled successfully with no errors from any modified file.*

- [ ] 15. **Manually verify the matrix cells** (covered in detail by TASK-048):
  - bare wheel over video → seeks ±2s (scroll-down advances, scroll-up rewinds); native scrubber tracks
  - Ctrl+wheel over video → seeks ±10s; gallery thumbnail-resize behind the slide does NOT also fire
  - Shift+wheel over video → seeks ±1 frame (~1/30s); video is paused on the first tick if it was playing
  - Alt+wheel over video → zooms with INVERTED polarity (Alt+scroll-down zooms IN, Alt+scroll-up zooms OUT)
  - bare wheel over image → zooms (today's behavior, polarity unchanged: scroll-down zooms OUT, scroll-up zooms IN)
  - Ctrl+wheel in non-slide gallery → still resizes thumbnails (regression check)
  - **opening a video → fits the viewport (largest dim reaches edge, whole frame visible, small videos upscale)**
  - **opening an image → unchanged (autofit-cap-at-1.0)**
  - **resize browser window with video open and no user-zoom yet → fit recomputes**
  - **resize browser window after Alt+wheel-zooming → user scale preserved**
  - **double-tap reset on video → returns to fit scale (not autofit-cap-1)**
  - **panning still works on a video that has been wheel-zoomed past fit** (overflow on at least one axis)

## Done When

- [ ] `mediaType` prop exists on `ZoomPan` and is plumbed from the video call site.
- [ ] `handleMouseWheel` short-circuits to a modifier-dependent seek when `mediaType === 'video' && !event.altKey`, with NaN-duration safety and `[0, duration]` clamping. Step = `±1/30s` (Shift) / `±10s` (Ctrl) / `±2s` (bare); direction sign is `deltaY > 0 → +` / `deltaY < 0 → -`. Modifier precedence Shift > Ctrl > bare. Shift path pauses the video if playing. Ctrl/Shift paths call `event.stopPropagation()`; bare keeps bubbling.
- [ ] `Alt`+wheel on a video zooms with INVERTED `deltaY` polarity (`deltaY > 0` → zoom IN, `deltaY < 0` → zoom OUT).
- [ ] Image-side wheel behavior is byte-for-byte unchanged (bare wheel zoom polarity preserved).
- [ ] `getFitScale` is exported from `SlideMode/utils.tsx` and computes `Math.min(...)` without a 1.0 cap.
- [ ] `ZoomPanProps.initialScale` accepts `'fit'`; `getTransform` dispatches it to `getFitScale`.
- [ ] Video `ZoomPan` is invoked with `initialScale="fit"`; image `ZoomPan` continues to use `"auto"`.
- [ ] `doubleClick` `zoomOrReset` branch reads `getTransform(props).scale` (so video reset goes to fit, image reset goes to autofit).
- [ ] `yarn lint` and `yarn build` both pass.
- [ ] All matrix cells in step 15 pass manual verification.
