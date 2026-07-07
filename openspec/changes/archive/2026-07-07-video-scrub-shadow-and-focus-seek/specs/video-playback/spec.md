## ADDED Requirements

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
