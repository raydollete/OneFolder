## ADDED Requirements

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
