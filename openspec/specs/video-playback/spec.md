# video-playback

## Purpose

Defines control and presentation of video playback in the slide-mode viewer. Covers
Spacebar toggling Play/Pause and mouse-wheel seeking of the focused video — both driven
by the "focused video" model rather than the element under the cursor — while preserving
each input's default behavior in every other context (images, gallery, text entry). Also
covers the appearance of the native scrub controls (no gradient scrim behind them).

## Requirements

### Requirement: Spacebar toggles playback of the focused video

The system SHALL toggle the playback state of the currently viewed video when the
user presses the Spacebar while a video is the focused/active item in the viewer.
A paused video SHALL begin playing and a playing video SHALL pause. The toggle
SHALL be driven by the video element's actual current playback state so that the
displayed state never drifts from a separately tracked flag.

#### Scenario: Paused video starts playing

- **WHEN** a video is the focused item in the viewer and is currently paused
- **AND** the user presses the Spacebar
- **THEN** the video begins playing

#### Scenario: Playing video pauses

- **WHEN** a video is the focused item in the viewer and is currently playing
- **AND** the user presses the Spacebar
- **THEN** the video pauses at the current frame

#### Scenario: Spacebar does the default action when no video is focused

- **WHEN** no video is the focused item in the viewer (e.g. an image is shown, or
  the gallery/list has focus)
- **AND** the user presses the Spacebar
- **THEN** playback is not affected and the Spacebar retains its existing behavior

### Requirement: Spacebar playback control does not hijack text entry

The system SHALL NOT toggle video playback when the Spacebar is pressed while a
text-entry surface has focus, so that typing a space in fields such as tag entry,
search, or file rename inserts a space normally.

#### Scenario: Spacebar in a focused text input inserts a space

- **WHEN** a text input, textarea, or other editable field has focus (for example
  the tag editor, search bar, or rename field)
- **AND** the user presses the Spacebar
- **THEN** a space character is entered into the field
- **AND** video playback is not toggled

#### Scenario: Default page scroll is not triggered by the playback shortcut

- **WHEN** the Spacebar toggles video playback for the focused video
- **THEN** the browser's default Spacebar scroll behavior is prevented for that key
  press

### Requirement: Wheel-seek is active whenever the video is the focused viewer item

The system SHALL seek the currently viewed video in response to the mouse wheel
whenever that video is the focused/active item in the viewer, independent of
whether the pointer is positioned over the video element. This mirrors the
"focused video" model already used by the Spacebar play/pause control: the seek
responds to the focused video, not to the element under the cursor.

The wheel-seek step sizes and modifier semantics SHALL be preserved:
- a bare wheel tick seeks ±2 seconds,
- Ctrl+wheel seeks ±10 seconds,
- Shift+wheel steps ±1 frame and pauses the video first (frame-stepping only
  makes sense on a paused video),
- Alt+wheel SHALL continue to control zoom rather than seek.

Wheel-seek SHALL NOT trigger the gallery's Ctrl+wheel thumbnail-resize behavior
while a video is the focused viewer item.

#### Scenario: Wheel over the inspector seeks the focused video

- **WHEN** a video is the focused item in the viewer
- **AND** the user scrolls the wheel while the pointer is outside the video
  element (for example over the inspector panel or the letterbox margin)
- **THEN** the video's playback position moves by the step for the active
  modifier (±2s bare, ±10s Ctrl, ±1 frame Shift)

#### Scenario: Wheel over the video still seeks

- **WHEN** a video is the focused item in the viewer
- **AND** the user scrolls the wheel while the pointer is over the video
- **THEN** the video seeks exactly as it did before this change

#### Scenario: Alt+wheel still zooms

- **WHEN** a video is the focused item in the viewer
- **AND** the user scrolls the wheel while holding Alt
- **THEN** the viewer zooms and the playback position is not changed

#### Scenario: Ctrl+wheel does not resize gallery thumbnails during video viewing

- **WHEN** a video is the focused item in the viewer
- **AND** the user scrolls the wheel while holding Ctrl
- **THEN** the video seeks by ±10 seconds
- **AND** the gallery's thumbnail size is not changed

#### Scenario: Wheel-seek is inactive when no video is focused

- **WHEN** no video is the focused item in the viewer (an image is shown, or the
  gallery/list has focus)
- **AND** the user scrolls the wheel
- **THEN** the wheel retains its existing non-seek behavior (zoom, gallery
  scroll, or thumbnail resize as applicable)

### Requirement: No gradient scrim is drawn behind the scrub controls

The system SHALL NOT render a gradient/scrim shadow behind the video scrub
controls in slide mode. The scrub controls SHALL sit over the unmodified video
frame without an added darkening overlay at the bottom of the viewport.

#### Scenario: Controls appear without a gradient shadow

- **WHEN** a video is shown in slide mode with its scrub controls visible
- **THEN** no gradient/scrim shadow is drawn behind the controls
- **AND** the scrub controls remain visible and usable
