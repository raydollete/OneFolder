## ADDED Requirements

### Requirement: Frame rate is shown on its own row below Dimensions

The info panel SHALL display a video's frame rate on its own row labeled
`Frame Rate`, positioned directly below the `Dimensions` row. The frame rate
SHALL NOT be appended to the `Dimensions` value. The `Dimensions` value SHALL
remain `<width> x <height>`.

The frame-rate value SHALL be formatted concisely: rounded to at most two
decimal places with trailing zeros (and a trailing decimal point) removed, and
suffixed with ` fps` (e.g. `29.97 fps`, `30 fps`).

#### Scenario: Video with a frame rate shows a Frame Rate row

- **WHEN** a video file that reports a frame rate is selected
- **THEN** the info panel shows a `Dimensions` row with value `<width> x <height>`
- **AND** directly below it a `Frame Rate` row with the concise value (e.g. `29.97 fps`)

#### Scenario: Non-video files show no Frame Rate row

- **WHEN** an image (or any file the app does not treat as a video) is selected
- **THEN** no `Frame Rate` row is shown
- **AND** the `Dimensions` value contains no frame-rate text

#### Scenario: Video that reports no frame rate shows no Frame Rate row

- **WHEN** a video is selected but ExifTool returns no `VideoFrameRate` value
- **THEN** no `Frame Rate` row is shown, rather than an empty or `?` row

### Requirement: Frame-rate display is reliable across file selections

The frame rate SHALL render every time a video that reports one is selected, and
SHALL NOT become stuck blank across subsequent selections such that only an app
restart restores it. A frame-rate read that resolves for a file other than the
currently selected file SHALL NOT update the displayed value (no stale or
cross-file values).

#### Scenario: Frame rate renders on repeated video selections

- **WHEN** the user selects several videos in succession, each reporting a frame rate
- **THEN** each selection shows that video's `Frame Rate` row
- **AND** the row does not remain blank on a later selection due to an earlier read

#### Scenario: Rapid file switching never shows a stale frame rate

- **WHEN** the user switches from video A to video B before A's frame-rate read completes
- **THEN** the panel shows B's frame rate (or no row if B reports none)
- **AND** never shows A's frame rate for B

### Requirement: Frame-rate read failures are surfaced, not silently swallowed

The system SHALL log a diagnostic warning when reading the frame rate fails (as
opposed to the file simply having no frame rate), rather than silently discarding
the error. A failed read SHALL degrade gracefully in the UI (the row is hidden)
while still leaving a record that a read was attempted and failed.

#### Scenario: A failed read is logged

- **WHEN** the frame-rate read rejects (e.g. the metadata reader is unavailable)
- **THEN** a diagnostic warning is logged identifying the failure
- **AND** the info panel does not show a broken or empty `Frame Rate` row
