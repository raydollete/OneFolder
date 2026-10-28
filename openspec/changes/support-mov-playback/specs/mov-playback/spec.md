## Purpose

Defines support for `.MOV` (Apple QuickTime container) media files: ingestion as recognized video, codec triage that determines whether Chromium can play a clip, the gallery and player surfaces that disclose unplayable clips, and the single action that converts an unplayable clip into a playable sibling via the existing re-encode media job.

## ADDED Requirements

### Requirement: MOV files are ingested as video

The system SHALL treat files with the `mov` extension as recognized video files: they SHALL be watched, ingested, listed, filtered, and opened like `mp4`/`webm`/`ogg`, with `mov` added to the extension allowlist and to the single authoritative video-extension predicate. Extension matching SHALL be case-insensitive on Windows and case-preserving on Linux/macOS, consistent with the existing path-identity policy.

#### Scenario: MOV file appears in the gallery

- **WHEN** a folder containing `clip.MOV` is added as a library location
- **THEN** the file is ingested as a video file and shown in the gallery
- **AND** selecting "Video Only" shows it and "Images Only" hides it

#### Scenario: MOV opens in the player as a video

- **WHEN** the user opens an ingested `.mov` file in slide mode
- **THEN** it renders through the video element path (play/pause, wheel-seek, scrub controls) rather than the image path

### Requirement: Codec triage is a background four-state probe

The system SHALL determine each recognized video file's first video and audio codec by probing with the bundled ffprobe on a low-priority background pass after location load — never synchronously on the location-load path — and SHALL only (re-)probe when the cache key (path, size, modification time) changed or the stored codec stamp does not match the current codec-table version. The probe result SHALL be four-state: `codec`, `no-video`, `error`, `unprobed`. A probe run that is `error` or `unprobed` SHALL be logged and SHALL NOT be presented to the user as unplayable.

#### Scenario: Fresh verdict is not re-probed

- **WHEN** a location is re-loaded and a video's path, size, and modification time are unchanged with a version-current stored verdict
- **THEN** no ffprobe subprocess is spawned for that file

#### Scenario: Externally edited file is re-probed

- **WHEN** a video file's modification time or size changed since the stored verdict
- **THEN** the file is re-probed on the background pass and the stored codecs are updated

#### Scenario: Probe failure never becomes a verdict

- **WHEN** ffprobe is missing, times out, or exits non-zero for a file
- **THEN** the file shows no "Not playable" indication
- **AND** the failure is logged

### Requirement: Playability derives from stored codec facts

The system SHALL persist the probed codec names with the file row (nullable columns, added via the versioned SQLite migration mechanism with the codec-table version stamp) and SHALL derive playability at render time: a file is playable iff its first video stream is Chromium-decodable (H.264, VP8, VP9, or AV1) and its first audio stream is absent or Chromium-decodable (AAC, MP3, Opus, Vorbis); all other codecs (including HEVC, ProRes, and PCM audio) are unplayable. The extension predicate SHALL NOT be used as a playability test. *(Correction 2026-10-27, operator-observed: the table had H.264 only, mis-badging VP9 clips as unplayable while they played.)*

#### Scenario: HEVC MOV is unplayable

- **WHEN** a `.mov` file's stored first-video codec is `hevc`
- **THEN** the derived verdict is unplayable

#### Scenario: H.264 MOV is playable

- **WHEN** a `.mov` file's stored codecs are `h264` video with `aac` audio
- **THEN** the derived verdict is playable and the file plays natively in the player

#### Scenario: Codec table upgrade re-derives without re-probing

- **WHEN** the codec-table version constant is bumped in a release
- **THEN** verdicts re-derive from the stored codec names for files whose stamp predates the version without requiring a new probe to change the badge

#### Scenario: Sidecar renders from persisted codecs

- **WHEN** the read-only web gallery lists a file whose codecs were probed by the desktop app
- **THEN** the badge state renders from the persisted codec columns without any probe executed by the server

### Requirement: Unplayable clips are badged in the gallery

The system SHALL display a "Not playable" lozenge over the gallery thumbnail of every file whose derived verdict is unplayable, with a tooltip naming the codec, and SHALL display no lozenge for playable, unprobed, or probe-errored files. Badge presence SHALL NOT change hover-playback, selection, or the media-type filter behavior.

#### Scenario: Badge marks an HEVC clip

- **WHEN** the gallery shows a file whose derived verdict is unplayable
- **THEN** the thumbnail carries the "Not playable" lozenge whose tooltip explains the codec

#### Scenario: No badge on unprobed files

- **WHEN** a video file has no stored verdict yet (background pass pending or probe failed)
- **THEN** its thumbnail carries no lozenge

### Requirement: Unplayable clips disclose the reason and point at the existing re-encode tool

In the desktop build, when an unplayable file is opened in slide mode the system SHALL show an inline banner naming the reason (the probed codec, or `MPEG-TS` for the container-driven verdict) and SHALL direct the user to the inspector Tools section's existing "Re-encode (x264)" tool as the remedy. The system SHALL NOT offer a separate "Create playable copy" button on the banner or in the Tools panel (owner decision 2026-10-27: one tool, one label). Re-encoding via that existing tool SHALL enqueue the existing re-encode media job (NVENC H.264 into an auto-incremented `.mp4` sibling), inheriting its progress reporting, cancellation, tag copy, auto-open of the output, and Keep/Delete-original prompt unchanged. The system SHALL NOT modify or delete the original file, SHALL NOT auto-convert at ingest, and in the read-only web build SHALL show the reason with no write affordance.

#### Scenario: Re-encode converts an unplayable HEVC clip

- **WHEN** the user activates "Re-encode (x264)" on an unplayable `.mov` clip
- **THEN** a re-encode job appears in the media-queue drawer, its progress streams, and on completion the auto-incremented `.mp4` sibling opens with the source's tags

#### Scenario: Original is preserved

- **WHEN** the conversion completes
- **THEN** the original `.mov` file is unchanged on disk and the existing Keep/Delete-original prompt decides its fate

#### Scenario: Web build offers no conversion

- **WHEN** an unplayable file is opened in the read-only web gallery
- **THEN** the banner states the clip is not playable in this browser and no write affordance is rendered

#### Scenario: Unavailable encoder fails loudly

- **WHEN** the conversion job runs on a machine without NVENC
- **THEN** the job surfaces a Failed row in the media-queue drawer, exactly as the existing re-encode tool does, with no silent software fallback
