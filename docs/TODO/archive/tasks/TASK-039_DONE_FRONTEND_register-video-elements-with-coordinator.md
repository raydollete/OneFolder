---
id: TASK-039
title: 'Register gallery and slide-mode <video> elements with MediaReleaseCoordinator'
investigation: INV-008
status: DONE
priority: high
blocked_by: [TASK-038]
date_created: 2026-04-23
date_completed: 2026-05-03
files:
  - src/frontend/containers/ContentView/GalleryItem.tsx
  - src/frontend/containers/ContentView/SlideMode/index.tsx
---

## What

Wire every `<video>` element OneFolder renders (gallery thumbnail, SlideMode main, SlideMode preload) into the `MediaReleaseCoordinator` from TASK-038 by calling `register(file.absolutePath, videoEl)` on mount and the returned unregister on unmount. Also track the orphan preload videos in SlideMode so they can be released.

## Why

The coordinator can only release handles for elements it knows about (plus a DOM-sweep fallback). Explicit registration is more reliable than the fallback, especially for the SlideMode preload path which creates detached `document.createElement('video')` nodes that the fallback's `document.querySelectorAll('video[src]')` would miss because they are never attached to the document.

See [INV-008](../investigations/INV-008_HIGH_FRONTEND_video-file-handle-blocks-delete-with-ebusy.md).

## Implementation Steps

- [x] 1. In `src/frontend/containers/ContentView/GalleryItem.tsx` `Thumbnail` component:
  - Grab `mediaReleaseCoordinator` from `useStore()`.
  - Add a new `useEffect` that, when `thumbnailRef.current` is non-null and `isFileExtensionVideo(file.extension)` is true, calls `mediaReleaseCoordinator.register(file.absolutePath, thumbnailRef.current)` and returns the unregister function as the effect cleanup. Dependencies: `[thumbnailRef, file.absolutePath, file.extension, mediaReleaseCoordinator]`.
  - Do NOT modify the existing pause/play effects — they remain as-is. The new effect is purely for registration.
- [x] 2. In `src/frontend/containers/ContentView/SlideMode/index.tsx` `ZoomableImage` video branch (around line 392):
  - Add `const slideVideoRef = useRef<HTMLVideoElement>(null);` at the top of `ZoomableImage`.
  - Pass `ref={slideVideoRef}` to the `<video>` returned inside the `<ZoomPan>` render prop. If the ZoomPan render prop spreads its own ref via `...props`, compose both refs with a small merge helper (pattern: `useCallback((el) => { propsRef(el); slideVideoRef.current = el; }, [...])`). Check the ZoomPan render-prop signature before deciding.
  - Add a `useEffect` that registers `slideVideoRef.current` with the coordinator when set, under the same conditions as step 1. Use `file.absolutePath` as the key.
- [x] 3. In the SlideMode preload effect (`SlideMode/index.tsx` lines 125-158):
  - Introduce a ref `const preloadVideosRef = useRef<Map<string, HTMLVideoElement>>(new Map());` to track per-path created orphan videos.
  - Inside the `autorun`, when `isFileExtensionVideo(nextFile.extension)` is true, check the map — if an entry for `nextFile.absolutePath` already exists, reuse it; otherwise create a new `video` element, store it in the map keyed by the absolute path, and ALSO call `mediaReleaseCoordinator.register(nextFile.absolutePath, nextImg)`. Store the returned unregister function (e.g., in a second parallel map or attach it as a symbol property on the element) so it can be called on cleanup.
  - On effect teardown (the existing `return () => { ... }` block), iterate the map: call each unregister function, then release each orphan explicitly (`v.pause(); v.removeAttribute('src'); v.load();`) to free the handle immediately rather than waiting for GC. Clear the map.
  - Apply the same treatment to the `prevFile` branch.
- [x] 4. Sanity-check the new code does not change the hover/auto playback behavior: the pause/play effects in GalleryItem still run, the preload autorun still assigns `.src`, videos still play on hover. Register is additive.
- [x] 5. Build (`yarn build` or `yarn dev`) and verify there are no TypeScript or lint errors introduced. NOTE: Zero new errors introduced; all remaining lint issues are pre-existing in the codebase. Confirm in devtools that hover-previewing a video now shows it in the coordinator's registry (add a temporary `console.log(this.#registry.size)` in releasePaths while testing; remove before commit).

## Done When

- [x] Every path that mounts a `<video>` (`GalleryItem.Thumbnail`, `SlideMode.ZoomableImage` video branch, SlideMode preload) calls `mediaReleaseCoordinator.register` with the absolute path and unregisters on unmount/teardown.
- [x] The SlideMode preload orphan videos are explicitly released (src cleared, load() called) on effect cleanup, not just dropped for GC.
- [ ] No behavior regressions to hover preview, auto preview, or slide-mode playback (manual smoke test). DEFERRED to TASK-042 manual QA.
- [x] No TypeScript or ESLint errors introduced (all remaining lint issues are pre-existing).
