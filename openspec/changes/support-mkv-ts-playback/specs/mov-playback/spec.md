## ADDED Requirements

### Requirement: MKV and TS files are ingested as video

The system SHALL treat files with the `mkv` and `ts` extensions as recognized video files: they SHALL be watched, ingested, listed, filtered, and opened like `mp4`/`webm`/`ogg`/`mov`, with `mkv` and `ts` added to the extension allowlist and to the single authoritative video-extension predicate. Extension matching SHALL be case-insensitive on Windows and case-preserving on Linux/macOS, consistent with the existing path-identity policy. Extension recognition is a file-discovery trigger only and SHALL NOT be a playability test.

#### Scenario: MKV file appears in the gallery

- **WHEN** a folder containing `film.mkv` is added as a library location
- **THEN** the file is ingested as a video file and shown in the gallery
- **AND** selecting "Video Only" shows it and "Images Only" hides it

#### Scenario: TS file opens on the video path

- **WHEN** the user opens an ingested `.ts` file in slide mode
- **THEN** it renders through the video element path (not the image path), showing the existing placeholder where Chromium cannot paint MPEG-TS frames

### Requirement: Container capability is a stored probe fact that gates the verdict

The system SHALL persist each probed file's container identity as the ffprobe format `format_name` in a nullable `formatName` column (added via the versioned SQLite migration mechanism, captured by the same single ffprobe spawn that stores the codec names). The playability derivation SHALL first require a probed video-stream fact (a non-null stored video codec) and return unprobed otherwise; when a video stream is present and the stored container is MPEG-TS (`mpegts`), the verdict SHALL be unplayable regardless of codec names; otherwise the existing codec table applies unchanged. The derivation SHALL read stored facts only and SHALL NOT consult the file's extension or filename.

#### Scenario: MPEG-TS video is unplayable even with playable codecs

- **WHEN** a probed file's stored container fact is `mpegts` and its stored codecs are `h264` video with `aac` audio
- **THEN** the derived verdict is unplayable
- **AND** the badge tooltip and banner name the container (`MPEG-TS`), never a codec

#### Scenario: TypeScript source file is never badged

- **WHEN** an ingested `.ts` file is TypeScript source code (ffprobe reports no video stream or errors)
- **THEN** the derived verdict is unprobed
- **AND** no "Not playable" badge or banner is shown

#### Scenario: MKV container decodes by codec table

- **WHEN** a probed file's stored container fact is `matroska,webm` with `h264` video and `aac` audio
- **THEN** the derived verdict is playable
- **AND** with `hevc` video the verdict is unplayable, badged by codec as in the mov lane
- **AND** with `vp8`/`vp9`/`av1` video (and Chromium-decodable audio) the verdict is playable —
  Chromium decodes WebM's native codecs natively (operator-observed correction 2026-10-27)

#### Scenario: Unprobed container is never badged

- **WHEN** a recognized video file has no stored container fact or codec facts yet (background pass pending or probe failed)
- **THEN** the derived verdict is unprobed and no badge or banner appears

## MODIFIED Requirements

### Requirement: Playability derives from stored codec facts

The system SHALL persist the probed codec names and the probed container (`formatName`) with the file row (nullable columns, added via the versioned SQLite migration mechanism with the codec-table version stamp) and SHALL derive playability at render time: a file is playable iff its stored container is demuxable by Chromium (not MPEG-TS), its first video stream is Chromium-decodable (H.264, VP8, VP9, or AV1), and its first audio stream is absent or Chromium-decodable (AAC, MP3, Opus, Vorbis); all other containers and codecs (including HEVC, ProRes, and PCM audio) are unplayable. The extension predicate SHALL NOT be used as a playability test. *(Correction 2026-10-27, operator-observed: the table had H.264 only, which mis-badged VP9 clips as unplayable while they played.)*

#### Scenario: HEVC MOV is unplayable

- **WHEN** a `.mov` file's stored first-video codec is `hevc`
- **THEN** the derived verdict is unplayable

#### Scenario: H.264 MOV is playable

- **WHEN** a `.mov` file's stored codecs are `h264` video with `aac` audio and its stored container is the mov family
- **THEN** the derived verdict is playable and the file plays natively in the player

#### Scenario: Codec table upgrade re-derives without re-probing

- **WHEN** the codec-table version constant is bumped in a release
- **THEN** verdicts re-derive from the stored codec names for files whose stamp predates the version without requiring a new probe to change the badge

#### Scenario: Sidecar renders from persisted facts

- **WHEN** the read-only web gallery lists a file whose codecs and container were probed by the desktop app
- **THEN** the badge state renders from the persisted codec and container columns without any probe executed by the server

### Requirement: Unplayable clips are badged in the gallery

The system SHALL display a "Not playable" lozenge over the gallery thumbnail of every file whose derived verdict is unplayable, with a tooltip naming the reason — the codec name for codec-driven verdicts, or `MPEG-TS` for the container-driven verdict, whose tooltip states the reason only (`MPEG-TS is not demuxable in this app`) — and SHALL display no lozenge for playable, unprobed, or probe-errored files. Badge presence SHALL NOT change hover-playback, selection, or the media-type filter behavior.

#### Scenario: Badge marks an HEVC clip

- **WHEN** the gallery shows a file whose derived verdict is unplayable
- **THEN** the thumbnail carries the "Not playable" lozenge whose tooltip explains the codec

#### Scenario: Badge marks an MPEG-TS clip

- **WHEN** the gallery shows a probed file whose stored container is `mpegts` with a video stream
- **THEN** the thumbnail carries the "Not playable" lozenge whose tooltip is `MPEG-TS is not demuxable in this app`

#### Scenario: No badge on unprobed files

- **WHEN** a video file has no stored verdict yet (background pass pending or probe failed)
- **THEN** its thumbnail carries no lozenge
