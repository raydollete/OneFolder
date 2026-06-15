---
id: TASK-104
title: 'Add videoMuted persisted preference to UiStore'
investigation: INV-027
status: DONE
priority: low
blocked_by: []
date_created: 2026-06-15
date_completed: 2026-06-15
files:
  - src/frontend/stores/UiStore.ts
---

## What

Add a new persisted boolean preference `videoMuted` to `UiStore`, modeled exactly on the existing `upscaleMode` / `galleryVideoPlaybackMode` persisted preferences. This is the state backing for the slide/preview video player's sticky mute setting. Default is `false` (unmuted), matching today's effective behavior.

## Why

The slide `<video>` is deliberately remounted on every file switch (`key={file.absolutePath}`), which destroys element-local `muted` state. Nothing persists the user's mute choice, so each new video starts unmuted. We lift mute into the existing persisted-preference layer so it survives remounts and relaunches.

See [INV-027](../investigations/INV-027_LOW_FRONTEND_persist-video-mute-across-slide-videos.md).

## Implementation Steps

- [x] 1. In `src/frontend/stores/UiStore.ts`, add `| 'videoMuted'` to the `PersistentPreferenceFields` union (next to `'upscaleMode'` / `'galleryVideoPlaybackMode'`, ~line 129-130).
- [x] 2. Add the observable near the other view prefs (~line 212-213, after `galleryVideoPlaybackMode`): `@observable videoMuted: boolean = false;` with a short doc comment, e.g. `/** Sticky mute state for the slide/preview video player. */`.
- [x] 3. Add an action setter alongside the other `@action.bound` setters (near `setGalleryVideoPlaybackMode`, ~line 370):
  ```ts
  @action.bound setVideoMuted(muted: boolean): void {
    this.videoMuted = muted;
  }
  ```
- [x] 4. In `recoverPersistentPreferences()` (~line 1201, in the `Boolean(...)` restore cluster), add: `this.videoMuted = Boolean(prefs.videoMuted ?? false);`.
- [x] 5. In `getPersistentPreferences()` (~line 1290, next to `galleryVideoPlaybackMode: this.galleryVideoPlaybackMode,`), add: `videoMuted: this.videoMuted,`.
- [x] 6. Do NOT modify `src/renderer.tsx` — the existing `reaction(() => uiStore.getPersistentPreferences(), …)` (lines ~159-165) auto-persists the new field, debounced 200ms, per-library.
- [x] 7. Verify TypeScript compiles: `yarn build` (or `tsc --noEmit`). The new field must be accepted in both the union and the serialized object without type errors.

## Done When

- [ ] `UiStore` exposes `@observable videoMuted: boolean` (default `false`) and `@action.bound setVideoMuted(muted: boolean)`.
- [ ] `getPersistentPreferences()` includes `videoMuted`; `recoverPersistentPreferences()` restores it with a `?? false` default.
- [ ] `videoMuted` is a member of `PersistentPreferenceFields`.
- [ ] Project type-checks/builds with no new errors. No change to `renderer.tsx`.
