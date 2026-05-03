---
id: TASK-047
title: 'Video SlideMode UX: wheel seeks ±1s, Alt+wheel zooms, default fills viewport'
investigation: INV-010
status: planned
priority: low
blocked_by: []
date_created: 2026-05-03
date_updated: 2026-05-03
date_completed:
files:
  - 'src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx'
  - 'src/frontend/containers/ContentView/SlideMode/index.tsx'
  - 'src/frontend/containers/ContentView/SlideMode/utils.tsx'
---

## What

Three coordinated changes to the SlideMode video viewer, all in the same `ZoomPan`/`SlideMode` files:

1. **Wheel seeks the video.** When the wrapped media is a video and `Alt` is NOT held, a wheel tick seeks the video by exactly ±1 second (clamped to `[0, duration]`).
2. **Alt+wheel zooms.** When `Alt` is held (or when the media is an image), the existing pan/zoom-on-wheel behavior is preserved unchanged.
3. **Videos open at fill-the-viewport scale (cover, not contain).** The initial zoom for a video is `Math.max(viewportW/videoW, viewportH/videoH)` — the smaller dimension reaches the viewport edge and the larger dimension overflows. Image branch initial-scale is unchanged.

## Why

`ZoomPan` was originally written for still images and reused for videos by wrapping `<video>` in the same container (`SlideMode/index.tsx:376-403`). Two image-era defaults were inherited without being reconsidered for video:

- The wheel-to-zoom interaction (videos benefit far more from scrub-on-wheel than from zoom-on-wheel; zoom is moved behind `Alt`).
- The contain-with-cap-at-1.0 initial scale (videos are presentational and benefit from immersive cover-mode framing; images stay at contain because users want to inspect the whole frame).

This task introduces the missing media-type branches in both directions.

See [INV-010](../investigations/INV-010_LOW_FRONTEND_video-scroll-seek-with-alt-zoom.md) for the full diagnosis: rationale for `Alt` as the modifier (Ctrl is taken by gallery thumbnail resize, Shift is conventionally horizontal scroll), the `deltaY > 0 → backward / deltaY < 0 → forward` direction convention, the contain-vs-cover distinction, the decision to keep image behavior unchanged, and the open question on whether image should also default to fill (NOT in scope for this task).

## Implementation Steps

> The implementation has two parts. Part A (steps 1-7) is the wheel-seek + Alt-zoom branch.
> Part B (steps 8-12) is the fill-to-viewport default for videos.
> Part C (steps 13-15) is shared verification.
> All three parts ship in one commit because they touch the same two-and-a-half files and form one cohesive "video-mode UX" feature.

### Part A — Wheel seeks video; Alt+wheel zooms

- [ ] 1. **Open `src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx`.** In `ZoomPanProps` (lines 33-47), add a new optional field:
  ```ts
  mediaType?: 'image' | 'video';
  ```

- [ ] 2. **Add a video ref field on the class.** Near `containerRef` (line 58), add:
  ```ts
  videoRef = React.createRef<HTMLVideoElement>();
  ```

- [ ] 3. **Widen the `children` render-prop type** so the call site can receive an optional ref. Change the `children` field on `ZoomPanProps` from
  ```ts
  children: (props: React.ImgHTMLAttributes<HTMLElement>) => React.ReactElement<HTMLElement>;
  ```
  to
  ```ts
  children: (
    props: React.ImgHTMLAttributes<HTMLElement> & { ref?: React.RefObject<HTMLVideoElement> },
  ) => React.ReactElement<HTMLElement>;
  ```
  *Acceptable alternative:* skip steps 2 and 3 entirely and instead use `this.containerRef.current?.querySelector('video') as HTMLVideoElement | null` inside the wheel handler in step 4. There is exactly one `<video>` per `ZoomPan`, so this is safe. Pick one approach and stick with it.

- [ ] 4. **Modify `handleMouseWheel` (lines 152-167).** Replace the body with the equivalent of:
  ```ts
  handleMouseWheel = (event: React.WheelEvent) => {
    // Bare wheel over a video seeks the timeline ±1s; Alt+wheel falls through to the zoom path below.
    if (this.props.mediaType === 'video' && !event.altKey) {
      const videoEl = this.videoRef.current; // or: this.containerRef.current?.querySelector('video')
      if (videoEl && Number.isFinite(videoEl.duration)) {
        const delta = event.deltaY < 0 ? 1 : event.deltaY > 0 ? -1 : 0;
        if (delta !== 0) {
          videoEl.currentTime = clamp(videoEl.currentTime + delta, 0, videoEl.duration);
          tryPreventDefault(event);
        }
      }
      return;
    }
    // Existing zoom logic — unchanged from current implementation.
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
  Notes:
  - `clamp` is already imported at line 8 (`import { clamp } from 'common/core'`).
  - Do **not** call `stopAnimation()` on the seek path — only the zoom path mutates the transform.
  - Do **not** call `event.stopPropagation()`. Bubbling must be preserved (see INV-010 Blast Radius §4 for why).
  - `Number.isFinite(videoEl.duration)` short-circuits the case where metadata has not loaded yet (`duration === NaN`).

- [ ] 5. **Pass `ref` through the render-prop.** In `render()` (line 292-300), update the `children(...)` call to include the ref when applicable:
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

- [ ] 6. **Open `src/frontend/containers/ContentView/SlideMode/index.tsx`.** In the video render branch (lines 376-403), pass `mediaType="video"` to `ZoomPan` and forward the ref into `<video>`:
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

- [ ] 7. **(Optional but recommended) Pass `mediaType="image"` explicitly in the image branch** (lines 411-433) for clarity, or leave it unset since `'image'` is the documented default. Either way, do not change the image render-prop body.

### Part B — Default initial scale for video is fill-the-viewport (cover)

- [ ] 8. **Open `src/frontend/containers/ContentView/SlideMode/utils.tsx`.** Add and export `getFillScale` immediately after the existing `getAutofitScale` (after line 74):
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
  **Critical:** do NOT cap at 1 (no `Math.min(..., 1)`). Fill must upscale a small video to cover a large viewport — that is the entire point.

- [ ] 9. **Open `src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx`.** Add `getFillScale` to the existing utility import block (line 9-24):
  ```ts
  import {
    // ...existing imports...
    getAutofitScale,
    getFillScale,
    // ...existing imports...
  } from './utils';
  ```

- [ ] 10. **Widen `ZoomPanProps.initialScale`** from `number | 'auto'` to `number | 'auto' | 'fill'` (in the `ZoomPanProps` interface around line 35).

- [ ] 11. **Update `getTransform` (lines 343-359)** to dispatch on the new `'fill'` literal. Change the inner scale computation from:
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
      : initialScale === 'fill'
      ? getFillScale(containerDimension, imageDimension)
      : initialScale;
  const scale = clamp(rawScale, minScale, maxScale);
  ```
  The `clamp(..., minScale, maxScale)` cap is intentional — it bounds pathological aspect ratios (e.g., a 1×1080 video would otherwise compute a fill scale of 1080).

- [ ] 12. **Update `doubleClick` `zoomOrReset` branch (lines 208-216)** so double-tap-reset honors `props.initialScale === 'fill'` for videos. Replace:
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
    // so 'fill' videos reset to fill and 'auto' images reset to autofit.
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

- [ ] 12a. **Open `src/frontend/containers/ContentView/SlideMode/index.tsx`.** In the **video** render branch (line 380), change:
  ```tsx
  initialScale="auto"
  ```
  to:
  ```tsx
  initialScale="fill"
  ```
  In the **image** render branch (line 413), leave `initialScale="auto"` UNCHANGED. (Per INV-010, image default is preserved pending explicit user confirmation.)

- [ ] 12b. **Do NOT modify `ZoomPan.componentDidUpdate` / `updateTransform` (lines 249-273, 314-318).** The existing logic — re-run `getTransform(props)` on image-dimension change, preserve user pan on container-only change — is already correct for the fill case. Verify this in QA, do not edit.

- [ ] 12c. **Do NOT add a `loadedmetadata` listener inside `ZoomPan`.** The `usePromise` in `SlideMode/index.tsx:282-352` already waits for `loadedmetadata` on a probe `<video preload="metadata">` and resolves the dimension promise only after `videoWidth`/`videoHeight` are real. By the time `ZoomPan` mounts with `imageDimension={dimension}`, dimensions are correct.

### Part C — Verification

- [ ] 13. **Run `yarn lint`** to confirm the TypeScript types compile under strict mode (`initialScale: 'fill'` literal must be accepted; the new render-prop `ref` field must type-check).

- [ ] 14. **Run `yarn build`** to catch any production-only type or bundling issues.

- [ ] 15. **Manually verify the matrix cells** (covered in detail by TASK-048):
  - bare wheel over video → seeks ±1s; native scrubber tracks
  - Alt+wheel over video → zooms (today's behavior)
  - bare wheel over image → zooms (today's behavior)
  - Ctrl+wheel in non-slide gallery → still resizes thumbnails (regression check)
  - **opening a video → fills the viewport (smaller dim reaches edge, larger dim overflows)**
  - **opening an image → unchanged (autofit-cap-at-1.0)**
  - **resize browser window with video open and no user-zoom yet → fill recomputes**
  - **resize browser window after Alt+wheel-zooming → user scale preserved**
  - **double-tap reset on video → returns to fill scale (not autofit)**
  - **panning still works on a fill-defaulted video** along the overflowing axis

## Done When

- [ ] `mediaType` prop exists on `ZoomPan` and is plumbed from the video call site.
- [ ] `handleMouseWheel` short-circuits to a ±1s seek when `mediaType === 'video' && !event.altKey`, with NaN-duration safety and `[0, duration]` clamping.
- [ ] `Alt`+wheel on a video produces the existing zoom behavior.
- [ ] Image-side wheel behavior is byte-for-byte unchanged.
- [ ] `getFillScale` is exported from `SlideMode/utils.tsx` and computes `Math.max(...)` without a 1.0 cap.
- [ ] `ZoomPanProps.initialScale` accepts `'fill'`; `getTransform` dispatches it to `getFillScale`.
- [ ] Video `ZoomPan` is invoked with `initialScale="fill"`; image `ZoomPan` continues to use `"auto"`.
- [ ] `doubleClick` `zoomOrReset` branch reads `getTransform(props).scale` (so video reset goes to fill, image reset goes to autofit).
- [ ] `yarn lint` and `yarn build` both pass.
- [ ] All matrix cells in step 15 pass manual verification.
