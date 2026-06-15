---
id: TASK-105
title: 'Bind videoMuted to the slide/preview video player (capture + apply)'
investigation: INV-027
status: DONE
priority: low
blocked_by: [TASK-104]
date_created: 2026-06-15
date_completed: 2026-06-15
files:
  - src/frontend/containers/ContentView/SlideMode/index.tsx
---

## What

Wire the new `uiStore.videoMuted` preference to the slide-mode `<video>` element so the mute toggle is both captured (on user change) and applied (on every remount). Capture via the native `volumechange` event; apply imperatively in the existing `setSlideVideoRef` callback ref AND declaratively via the `muted` prop as a backup. The Preview Quick-View window inherits this automatically (it renders the same component).

## Why

The slide `<video>` is deliberately remounted per file (`key={file.absolutePath}`), so element-local mute state is wiped each switch. Binding it to the persisted `videoMuted` observable makes mute sticky across switches and relaunches without removing the intentional remount.

See [INV-027](../investigations/INV-027_LOW_FRONTEND_persist-video-mute-across-slide-videos.md).

## Implementation Steps

- [x] 1. Confirm `SlideView` is `observer`-wrapped (it is, `src/frontend/containers/ContentView/SlideMode/index.tsx` line ~52) and `uiStore` is in scope (line ~53), so reading `uiStore.videoMuted` is reactive.
- [x] 2. In `setSlideVideoRef` (~lines 472-489), inside the existing `if (el && isFileExtensionVideo(file.extension)) { … }` block (after the `register` / `attachVideoFreezeRecovery` calls), add:
  ```ts
  el.muted = uiStore.videoMuted;
  ```
  This initializes the freshly-remounted element to the persisted state before autoplay. (React's `muted` JSX prop is not reliably reflected to the DOM; this imperative assignment is the robust path.)
- [x] 3. On the slide `<video>` element (~lines 541-558, the one with `key={file.absolutePath}` / `ref={setSlideVideoRef}` / `controls` / `autoPlay` / `loop`), add two attributes:
  - `muted={uiStore.videoMuted}` (declarative backup)
  - `onVolumeChange={(e) => uiStore.setVideoMuted(e.currentTarget.muted)}` (captures the user's native mute toggle)
- [x] 4. Do NOT touch the gallery `<video>` in `GalleryItem.tsx` (line ~278, hard-muted hover preview) and do NOT touch the off-DOM preload/probe `<video>` elements in this file (lines ~168, ~186, ~366). They stay as-is.
- [x] 5. Keep `key={file.absolutePath}` intact — the fix must coexist with the remount, not remove it.
- [x] 6. Build: `yarn build` and confirm no TypeScript errors (depends on TASK-104 having added `videoMuted` + `setVideoMuted`).

## Done When

- [ ] The slide `<video>` has `muted={uiStore.videoMuted}` and `onVolumeChange={(e) => uiStore.setVideoMuted(e.currentTarget.muted)}`.
- [ ] `setSlideVideoRef` sets `el.muted = uiStore.videoMuted` for video files.
- [ ] Gallery hover thumbnails and off-DOM preload/probe videos are unchanged.
- [ ] `key={file.absolutePath}` remains.
- [ ] Project builds with no new type errors.

## Manual QA / Verification (REQUIRES MANUAL EXECUTION)

Perform in a built/portable run (per project testing discipline) with at least two video files in a location.

- [ ] **Mute persists forward across switch:** Open video A in slide mode, mute via native controls, switch to video B. EXPECT: B is muted on load. Capture evidence (screenshot of B's muted control / log line).
- [ ] **Unmute persists across switch:** Unmute B, switch to another video. EXPECT: next video loads unmuted.
- [ ] **Persists across relaunch:** Leave state muted, fully quit and relaunch the app, reopen a video in slide mode. EXPECT: video loads muted (restored from per-library localStorage). Then repeat with unmuted state.
- [ ] **Preview Quick-View window matches:** Select a video, press space (Open In Preview Window). EXPECT: the preview window's video honors the same persisted mute state; toggling there persists on next launch.
- [ ] **Gallery hover previews stay silent:** Hover gallery video thumbnails (with gallery video playback enabled). EXPECT: no audio regardless of the slide `videoMuted` value.
- [ ] **Remount-freshness intact:** Run a media job (e.g. Compress & Normalize Audio) and confirm the slide player still loads the fresh output (the `key` remount behavior is unbroken).
