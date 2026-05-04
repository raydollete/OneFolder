---
id: TASK-060
title: 'Tear down SlideMode dimension-probe orphan <video> after metadata read'
investigation: INV-014
status: planned
priority: high
blocked_by: []
date_created: 2026-05-04
date_completed:
files:
  - src/frontend/containers/ContentView/SlideMode/index.tsx
---

## What

Modify the `usePromise` body in `SlideMode/index.tsx` (around lines 325-348) that creates
an orphan `document.createElement('video')` purely to read intrinsic video dimensions,
so that:
1. The orphan element is registered with `mediaReleaseCoordinator` immediately on
   creation, keyed by `src` (the absolute path), so it is released by any concurrent
   delete-flow `releasePaths` call.
2. After `onloadedmetadata` resolves OR `onerror` fires (whichever comes first), the
   orphan is explicitly torn down (`pause(); removeAttribute('src'); load();`) and
   unregistered.

## Why

INV-014 Root Cause #3: this orphan element was missed entirely by INV-008's blast-radius
scan. Even though INV-008 covered the SlideMode preload orphans (lines 132-189), the
dimension-probe orphan at lines 325-348 is a separate code path that creates a `<video>`
element, sets `.src = encodeFilePath(src)`, and reads its dimensions via
`onloadedmetadata`. The element holds an OS file handle for at least the duration of
metadata loading, and the JS reference is captured by the Promise executor closure —
meaning it persists past `resolve` until V8 GC finalizes the wrapper. On Windows, this
can race with a fast user-triggered delete and produce EBUSY even after TASK-058 and
TASK-059 are complete.

The element is never attached to `document`, so the DOM-fallback sweep cannot find it.
The only reliable mechanism is explicit registration + explicit teardown.

See [INV-014](../investigations/INV-014_HIGH_FRONTEND_video-delete-ebusy-recurs-fix-incomplete.md).

## Implementation Steps

- [ ] 1. Locate the `usePromise` body in `src/frontend/containers/ContentView/SlideMode/index.tsx`
      that resolves the video dimensions. Currently at approximately:
  ```ts
  const image = usePromise(
    source, absolutePath, thumbnailSrc, imgWidth, imgHeight, file.extension,
    async (source, absolutePath, thumbnailSrc, imgWidth, imgHeight, fileExtension) => {
      ...
      let img;
      if (isFileExtensionVideo(fileExtension)) {
        img = document.createElement('video');
        img.onloadedmetadata = ...
        img.onerror = ...
        img.preload = 'metadata';
      } else {
        img = new Image();
        ...
      }
      img.src = encodeFilePath(src);
      ...
  ```

- [ ] 2. The `usePromise` body cannot easily access `mediaReleaseCoordinator` (it's a
      pure async function passed to `usePromise`, and `usePromise` does not give us a
      way to inject store dependencies). Two options:
  - **Option A (preferred — minimal refactor):** capture `mediaReleaseCoordinator` from
    the enclosing `ZoomableImage` scope in a stable ref, and read it from inside the
    `usePromise` body via that ref. Pattern:
    ```ts
    const coordinatorRef = useRef(mediaReleaseCoordinator);
    coordinatorRef.current = mediaReleaseCoordinator;
    // Then in usePromise body, read coordinatorRef.current
    ```
    This works because `ZoomableImage` already destructures `mediaReleaseCoordinator`
    from `useStore()` (line 304).
  - **Option B (cleaner, larger):** lift the dimension-probe out of `usePromise` into
    a dedicated `useEffect` that has direct access to the store. Pass the resolved
    dimensions through a `useState` instead. Slightly more code but eliminates the
    capture-via-ref hack.
  - Pick Option A unless the team prefers Option B; document the choice in a code
    comment referencing INV-014.

- [ ] 3. Inside the video branch of the `usePromise` body, after creating
      `img = document.createElement('video')` and before assigning `.src`:
  ```ts
  const unregisterProbe = coordinatorRef.current.register(src, img);
  ```
      (Use `src`, the absolute path, as the registry key — this is the same value
      `encodeFilePath` will be called with for the `.src` attribute.)

- [ ] 4. In both `onloadedmetadata` and `onerror` handlers, BEFORE calling `resolve(...)`,
      add explicit teardown:
  ```ts
  img.onloadedmetadata = function (this: any) {
    const videoWidth = this.videoWidth || imgWidth || 1920;
    const videoHeight = this.videoHeight || imgHeight || 1080;
    // Release before resolving so any awaiter that immediately triggers a delete
    // sees a clean handle.
    try { img.pause(); } catch {}
    img.removeAttribute('src');
    img.load();
    unregisterProbe();
    resolve({ src, dimension: createDimension(videoWidth, videoHeight) });
  };
  img.onerror = (error) => {
    console.warn('Video metadata loading failed, using stored dimensions:', error);
    try { img.pause(); } catch {}
    img.removeAttribute('src');
    img.load();
    unregisterProbe();
    resolve({ src, dimension: createDimension(imgWidth || 1920, imgHeight || 1080) });
  };
  ```
      Wrap `pause()` in a try/catch because some Chromium versions throw if the
      element never started playing (it's a defensive belt — `pause` on a metadata-only
      element is usually a no-op).

- [ ] 5. Sanity check: confirm the dimensions are still correctly read by
      `onloadedmetadata`. The `videoWidth`/`videoHeight` properties are sampled BEFORE
      teardown, so they remain valid in the `resolve` payload. If for any reason the
      teardown sequence interferes with reading width/height, sample them into local
      vars first, then tear down, then resolve with the sampled values.

- [ ] 6. (Optional, recommended) Add a comment in the file referencing INV-014 and
      explaining why the registration + teardown is required:
  ```ts
  // The probe element holds a Chromium media-pipeline handle on the file for as long as
  // it lives in the JS heap. Without explicit teardown, V8 GC alone may not release the
  // handle in time for a fast delete-after-open scenario on Windows. Register with the
  // coordinator so a concurrent delete picks it up; tear down explicitly after metadata
  // read so the steady-state case does not depend on GC. (INV-014 Root Cause #3)
  ```

- [ ] 7. Build (`yarn build` or `yarn dev`) and verify no TypeScript / lint errors. The
      existing `usePromise` typing should be unaffected because the closure body's
      shape and return type don't change.

## Done When

- [ ] The dimension-probe `<video>` is registered with the coordinator on creation.
- [ ] The element is explicitly torn down (`pause/removeAttribute/load`) and unregistered
      after both `onloadedmetadata` and `onerror`.
- [ ] Resolved dimensions still match what was read from `videoWidth`/`videoHeight`
      (no regression to dimension accuracy).
- [ ] `yarn build` passes; existing tests pass.
- [ ] Comment in the source code explains why this teardown is required and references
      INV-014.
