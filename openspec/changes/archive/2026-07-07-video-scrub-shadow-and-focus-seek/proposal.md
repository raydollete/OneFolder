**Effort tier:** Tier 2 — a bounded behavior change (wheel-seek re-scoped from the hovered element to the focused viewer) plus a one-line style removal; touches the slide-mode video viewer only, no cross-cutting surface.

**Type:** feature

## Why

Two rough edges on the slide-mode video viewer:

1. A gradient/scrim shadow sits behind the native scrub controls, darkening the bottom of the frame. It is visual noise the user does not want.
2. Wheel-seek (scroll wheel and its modifier variants) only fires while the cursor physically hovers the video, because it is a React `onWheel` bound to the `ZoomPan` element. The user expects seek to respond whenever the video is the focused viewer item — the same "focused video" model the Spacebar play/pause already uses — regardless of where the pointer sits (e.g. over the inspector, the nav chrome, or empty letterbox margin).

## What Changes

- Remove the gradient/scrim shadow rendered behind the video scrub controls in slide mode, so the controls sit over the unmodified frame.
- Make wheel-seek effective whenever a video is the focused item in the viewer, independent of pointer position over the video element. Bare wheel = ±2s, Ctrl+wheel = ±10s, Shift+wheel = ±1 frame (paused), Alt+wheel continues to zoom — all preserved exactly as today; only the *reachability* of the handler changes.
- Preserve the existing guards: seek must not bubble into the gallery's Ctrl+wheel thumbnail-resize handler, and Alt+wheel must still reach the zoom path.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `video-playback`: broaden from keyboard-only control to include wheel-seek of the focused video, adding a requirement that wheel-seek is active whenever the video is the focused viewer item regardless of pointer position, and a requirement that no gradient scrim is drawn behind the scrub controls.

## Blast Radius

1. `src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx:161,345` — `handleMouseWheel` and its `onWheel` binding currently scope seek to pointer-over-element; the focused-video wheel path moves out to a viewer-scoped listener, leaving only the zoom path here.
2. `src/frontend/containers/ContentView/SlideMode/index.tsx:139,568` — hosts the native `controls` on the `<video>` and the existing viewer-scoped global `keydown` listener the new focus-scoped wheel listener is modeled on.
3. `resources/style/content.scss:339,457` — slide-mode video styling; the scrub-control gradient scrim (`::-webkit-media-controls-*`) rule is added here, scoped to the slide-mode video.
4. `src/frontend/containers/ContentView/index.tsx:112,137` — gallery `handleWheel` Ctrl+wheel thumbnail-resize handler; the seek path must keep NOT triggering it (read-only invariant — deliberately not modified).
5. grepped `::-webkit-media-controls` across `resources/style` — no pre-existing app CSS targets the control panel, so the scrim is Chromium's default and no other rule conflicts.
