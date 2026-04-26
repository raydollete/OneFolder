---
id: TASK-038
title: 'Add MediaReleaseCoordinator for quiescing <video> handles before file ops'
investigation: INV-008
status: planned
priority: high
blocked_by: []
date_created: 2026-04-23
date_completed:
files:
  - src/frontend/image/MediaReleaseCoordinator.ts
  - src/frontend/contexts/StoreContext.tsx
---

## What

Introduce a new renderer-side singleton, `MediaReleaseCoordinator`, that (a) tracks all live `<video>` elements currently showing files by absolute path, and (b) provides an awaitable `releasePaths(paths)` that tears down the Chromium media resource for any matching element before a destructive file operation runs. This is the missing "quiesce hook" identified in INV-008 and is the dependency for all subsequent fix tasks.

## Why

Chromium's `<video>` with a `file://` src keeps an OS file handle open without `FILE_SHARE_DELETE` on Windows. That handle blocks `shell.trashItem` and blocks the chokidar post-op rescan from scandir'ing the parent directory, producing the reported `EBUSY: resource busy or locked, scandir <filepath>` error. No existing module coordinates between destructive-op callers and the components that hold these handles. Introducing one unblocks TASK-039 (component registrations) and TASK-040 (caller integrations).

See [INV-008](../investigations/INV-008_HIGH_FRONTEND_video-file-handle-blocks-delete-with-ebusy.md).

## Implementation Steps

- [ ] 1. Create `src/frontend/image/MediaReleaseCoordinator.ts` exporting a class `MediaReleaseCoordinator` with:
  - Private `#registry: Map<string, Set<HTMLVideoElement>>` keyed by absolute path (normalize by calling `path.normalize` or simply `toLowerCase` on Windows-stripped path — pick one and apply consistently; the gallery passes absolute paths as-is, so normalize on ingress of both register and release).
  - Method `register(absolutePath: string, el: HTMLVideoElement): () => void` that adds to the set and returns an unregister closure that removes from the set and prunes empty sets.
  - Method `releasePaths(paths: Iterable<string>, options?: { timeoutMs?: number }): Promise<void>` that:
    1. Builds a set of normalized target paths.
    2. For each registered `HTMLVideoElement` whose key is in the target set:
       - Call `el.pause()`.
       - Store the current `src` on a local var for logging, then call `el.removeAttribute('src')`.
       - Call `el.load()` (the essential step — this transitions the media element to `NETWORK_EMPTY` and instructs the media pipeline to tear down).
    3. Also run a DOM fallback sweep: `document.querySelectorAll('video[src]')` and for each element decode its `src` (`decodeURIComponent` the path portion after `file://`) and apply the same release if it matches a target path. This catches orphan preload videos and pre-coordinator legacy elements.
    4. Await a microtask (`await Promise.resolve()`) AND a `requestAnimationFrame` turn to let Chromium process the src clear.
    5. Optionally (behind `options.timeoutMs`, default 200), race `Promise.all(emptiedPromises)` against a timeout — where each `emptiedPromise` resolves when the element fires an `emptied` event (which Chromium fires after the pipeline tears down). This gives a tighter guarantee on slow systems.
  - Keep the module as a plain class instance (not a MobX store) — it holds no observable state and is called imperatively.
- [ ] 2. Expose a singleton via `StoreContext`. Add a field `mediaReleaseCoordinator: MediaReleaseCoordinator` to the StoreContext provider in `src/frontend/contexts/StoreContext.tsx` (or whichever file constructs the shared services — check for existing ImageLoader instantiation and mirror it). Construct a single instance at app init.
- [ ] 3. Add a small helper `decodeVideoSrcToPath(src: string): string | undefined` inside the coordinator module that takes a `file://` URL (possibly with `?v=1` style query params and encoded characters) and returns the absolute path suitable for comparison with the registry keys. Mirror the encoding done by `common/fs.ts:encodeFilePath` so the decode is its inverse. Add a Jest test for round-trip (`encodeFilePath` → `decodeVideoSrcToPath` returns the original path).
- [ ] 4. Add JSDoc comments on the coordinator explaining: (a) the Chromium handle-release contract, (b) why pause() alone is insufficient, (c) when callers should await `releasePaths` (before any trashing, renaming, overwriting of paths that MAY be rendered in a video element).
- [ ] 5. Manually verify in devtools that `document.querySelectorAll('video[src]').forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); })` in a running session with a hover-previewed video actually releases the OS handle (use Process Explorer on Windows to confirm the handle count drops). Document the test evidence in the task's DONE comment.

## Done When

- [ ] `MediaReleaseCoordinator.ts` exists with `register` and `releasePaths` implementations matching the spec above.
- [ ] A singleton instance is reachable from React components via `useStore()` (or the equivalent hook in `StoreContext`).
- [ ] Unit test covers: encode → decode round-trip, register/unregister symmetry, releasePaths calls pause/removeAttribute/load in that order on a mocked element, releasePaths resolves after rAF even when no elements match.
- [ ] Manual devtools verification that the DOM-sweep fallback finds and releases a hover-previewed video (handle count drops in Process Explorer). Evidence pasted into the task when moving to `pending_qa`.
- [ ] Module is lint-clean and type-clean (`yarn lint`, `yarn tsc --noEmit` or build).
