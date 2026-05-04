---
id: TASK-058
title: 'Use callback refs for video registration in GalleryItem and SlideMode + add dev-only releasePaths logging'
investigation: INV-014
status: planned
priority: critical
blocked_by: []
date_created: 2026-05-04
date_completed:
files:
  - src/frontend/containers/ContentView/GalleryItem.tsx
  - src/frontend/containers/ContentView/SlideMode/index.tsx
  - src/frontend/image/MediaReleaseCoordinator.ts
---

## What

Replace the broken `useRef + useEffect` registration pattern in `GalleryItem.Thumbnail`
and `SlideMode.ZoomableImage` (the SlideMode main video) with a callback-ref pattern that
fires `mediaReleaseCoordinator.register(...)` synchronously when React attaches the
`<video>` element to the DOM and unregisters when React detaches it. Also add dev-only
`console.debug` logging inside `MediaReleaseCoordinator.releasePaths` that reports how
many elements were released via the registry vs. via the DOM-fallback sweep, so the
runtime wiring becomes visible in QA.

## Why

INV-014 Root Cause #1: the existing `useEffect` whose deps are `[thumbnailRef, file.absolutePath, file.extension, mediaReleaseCoordinator]` runs once at mount when `thumbnailRef.current` is still `null` (because `<video>` is rendered conditionally on `imageSource.tag === 'ready'`). None of the deps change when the promise resolves, so the effect never re-runs and the `<video>` element is never registered. SlideMode's `slideVideoRef` has the identical defect. The DOM-fallback sweep that was meant to compensate is also broken (TASK-059 covers that). The callback-ref pattern fires immediately when React attaches/detaches the element, regardless of upstream async state, and is robust against the conditional-rendering pattern.

The dev logging is the runtime evidence the original fix shipped without — it converts a silent failure into an observable one.

See [INV-014](../investigations/INV-014_HIGH_FRONTEND_video-delete-ebusy-recurs-fix-incomplete.md).

## Implementation Steps

- [ ] 1. In `src/frontend/containers/ContentView/GalleryItem.tsx` `Thumbnail` component:
  - Remove the existing registration `useEffect` (lines ~189-199) — the one with deps `[thumbnailRef, file.absolutePath, file.extension, mediaReleaseCoordinator]`.
  - Keep `const thumbnailRef = useRef<HTMLVideoElement>(null);` since the existing pause/play `useEffect`s read `thumbnailRef.current`.
  - Add a ref to track the unregister callback: `const unregisterRef = useRef<(() => void) | null>(null);`.
  - Add a memoized callback ref:
    ```ts
    const setThumbnailRef = useCallback((el: HTMLVideoElement | null) => {
      // Tear down previous registration (if any)
      if (unregisterRef.current) {
        unregisterRef.current();
        unregisterRef.current = null;
      }
      thumbnailRef.current = el;
      if (el && isFileExtensionVideo(file.extension)) {
        unregisterRef.current = mediaReleaseCoordinator.register(file.absolutePath, el);
      }
    }, [file.absolutePath, file.extension, mediaReleaseCoordinator]);
    ```
  - Change the `<video ref={thumbnailRef} ...>` JSX (line ~259) to `<video ref={setThumbnailRef} ...>`.
  - Add a final `useEffect` cleanup so unregistering also happens when the component unmounts without React calling the callback ref with `null`:
    ```ts
    useEffect(() => () => { unregisterRef.current?.(); unregisterRef.current = null; }, []);
    ```

- [ ] 2. In `src/frontend/containers/ContentView/SlideMode/index.tsx` `ZoomableImage` (around line 388-394):
  - Apply the same pattern: remove the registration `useEffect`, keep `slideVideoRef` as a `useRef`, add `unregisterRef`, add `setSlideVideoRef` callback ref.
  - Change the inline `<video {...props} ref={slideVideoRef} ...>` (line ~437) to use a composed ref so both `props.ref` from ZoomPan AND `setSlideVideoRef` receive the element. Pattern:
    ```ts
    const composedRef = useCallback((el: HTMLVideoElement | null) => {
      setSlideVideoRef(el);
      // ZoomPan provides its own ref via props.ref or props.someRefKey — inspect ZoomPan's render-prop signature and forward correctly.
      const innerRef = (props as any).ref;
      if (typeof innerRef === 'function') innerRef(el);
      else if (innerRef && 'current' in innerRef) innerRef.current = el;
    }, [setSlideVideoRef]);
    ```
  - Verify by reading ZoomPan that `...props` does include a ref handle — if not, no compose is needed; just pass `setSlideVideoRef`.
  - Add the same unmount-cleanup `useEffect`.

- [ ] 3. In `src/frontend/image/MediaReleaseCoordinator.ts` `releasePaths`:
  - Import `IS_DEV` from `common/process` (or use `process.env.NODE_ENV !== 'production'` if cleaner).
  - At entry, count `targetKeys.size` and capture it.
  - When iterating the registry, count how many keys matched (call this `registryHits`).
  - When iterating the DOM fallback, count how many elements matched (call this `domHits`).
  - After the `Promise.all(waitForEmptied)` resolves, log (only when `IS_DEV` is true):
    ```ts
    if (IS_DEV) {
      // eslint-disable-next-line no-console
      console.debug(
        '[MediaReleaseCoordinator] releasePaths',
        { targets: targetKeys.size, registryHits, domHits, releasedElements: releasedElements.length },
      );
    }
    ```
  - This output is the gating evidence for TASK-061's QA matrix.

- [ ] 4. Build (`yarn build` or `yarn dev`) and verify no TypeScript / lint errors. Run `yarn test` and verify the existing `tests/media-release-coordinator.test.ts` still passes (it should — the coordinator API is unchanged).

- [ ] 5. Manual smoke test in dev: open OneFolder, hover a video thumbnail, open devtools, then run `window.__rootStore?.mediaReleaseCoordinator?.releasePaths(['<paste absolute path>'])` (or trigger a delete). Confirm the dev log line shows `registryHits >= 1`. (If no easy `__rootStore` accessor exists, temporarily expose it on `window` for the test and remove before commit.)

## Done When

- [ ] `GalleryItem.Thumbnail` `<video>` elements are registered with the coordinator immediately when React attaches them, regardless of whether `imageSource` was pending or ready at component mount.
- [ ] `SlideMode.ZoomableImage` main `<video>` element is registered the same way.
- [ ] Both registrations correctly unregister when (a) React detaches the element, OR (b) the component unmounts.
- [ ] In dev builds, `releasePaths` logs a structured object showing `registryHits` and `domHits` for every call.
- [ ] `yarn build` and `yarn test` both pass with no new errors.
- [ ] Smoke-test evidence (devtools log line) captured showing `registryHits >= 1` when delete is triggered on a hovered video.
