## Why

When viewing a video in OneFolder, there is no keyboard shortcut to start or stop
playback — the user must aim for the small native `<video>` play/pause control with
the mouse. Spacebar-to-toggle-playback is a near-universal convention (browsers,
YouTube, VLC, QuickTime, Photos) and its absence makes video review slower and
feels broken to users who expect it.

## What Changes

- Add a keyboard shortcut so that when a video is the focused/active item in the
  viewer, pressing **Spacebar** toggles the video between Play and Pause.
- Spacebar only affects playback when a video is actually shown and focused; in any
  other context (no video, a text input focused, etc.) the key retains its current
  behavior and does not hijack typing.
- The toggle reflects the true current media state (play a paused video, pause a
  playing one), rather than tracking a separate flag that can drift out of sync.

## Capabilities

### New Capabilities
- `video-playback`: Keyboard-driven control of video playback in the viewer —
  starting with Spacebar toggling Play/Pause for the focused video.

### Modified Capabilities
<!-- None: no existing spec defines video playback behavior. -->

## Impact

- **Frontend viewer**: the component that renders the single-item/slide video view
  and its `<video>` element (renderer, MobX `@observer`).
- **Keyboard handling**: integrates with the viewer's existing key handling; must
  respect focus/input-field guards so it does not interfere with typing (e.g. tag
  entry, search, rename).
- No changes to main process, IPC, DTOs, or metadata. No new dependencies.
- Platform seam unaffected (pure renderer/DOM behavior).
