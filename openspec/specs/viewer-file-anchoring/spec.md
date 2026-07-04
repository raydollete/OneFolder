# viewer-file-anchoring Specification

## Purpose
TBD - created by archiving change video-viewer-index-lock. Update Purpose after archive.
## Requirements
### Requirement: Slide-mode viewer is anchored to a file by identity

The system SHALL determine the file shown in the full-screen slide-mode viewer by
a stable file identity (the file's ID) recorded when the viewer is opened, not by
a numeric position into the gallery list. While the viewer is open, the displayed
file SHALL remain the file with that identity for as long as that file is present
in the gallery list, regardless of the file's changing numeric position.

#### Scenario: Opening the viewer records the file identity

- **WHEN** the user opens a file in slide mode from the gallery
- **THEN** the viewer displays that exact file
- **AND** the viewer's anchor is set to that file's identity, not merely its list position

#### Scenario: The anchored file remains displayed as its position changes

- **WHEN** a file is open in slide mode
- **AND** the anchored file is still present in the gallery list after the list changes
- **THEN** the viewer continues to display the anchored file even if its numeric index changed

### Requirement: List re-sorting never interrupts the open viewer

The system SHALL NOT change which file the slide-mode viewer displays as a result
of the gallery list being re-sorted or re-fetched (including the default random
sort order re-permuting the list). A re-sort SHALL leave the currently viewed file
in place.

#### Scenario: Random re-sort keeps the same file open

- **WHEN** a video is open and playing in slide mode
- **AND** the gallery list is re-sorted or re-fetched (for example under random sort order) so the file now occupies a different index
- **THEN** the same video remains open in the viewer
- **AND** the viewer does not jump to a different file

### Requirement: Ingesting a new file never interrupts the open viewer

The system SHALL NOT change which file the slide-mode viewer displays as a result
of a new file being inserted into the gallery list, including files ingested when
a media-processing job (re-encode, normalize, clip) completes. The user's open
file SHALL continue to display uninterrupted while new files appear in the
underlying gallery.

#### Scenario: A completed media job does not pull the user off their video

- **WHEN** a user is viewing a video in slide mode
- **AND** a separate media-processing job completes and its output file is ingested into the gallery list
- **THEN** the user's currently viewed video remains open and continues playing
- **AND** the viewer does not switch to the newly ingested file or any other file

### Requirement: Prev/next navigation moves relative to the anchored file and re-anchors

The system SHALL treat explicit previous/next navigation (arrow keys or on-screen
buttons) as movement relative to the anchored file's current position in the
gallery list. On navigation the viewer SHALL display the adjacent file and SHALL
re-anchor to that newly displayed file's identity. Navigation SHALL be bounded by
the ends of the list.

#### Scenario: Next moves to the file after the anchored file

- **WHEN** a file is open in slide mode and the user triggers "next"
- **THEN** the viewer displays the file immediately after the anchored file in the current list order
- **AND** the viewer re-anchors to that newly displayed file

#### Scenario: Navigation is bounded at the ends of the list

- **WHEN** the anchored file is the last file in the list and the user triggers "next"
- **THEN** the viewer continues to display the last file and does not wrap or error

### Requirement: The anchored file leaving the list does not silently swap the viewer

The system SHALL NOT display a different, unrelated file in the slot the anchored
file previously occupied when the anchored file is no longer present in the gallery
list (for example it was deleted, or an active filter now excludes it). Instead the
viewer SHALL present an explicit "no file" / closed state rather than silently
surfacing whichever file now occupies the old index.

#### Scenario: Deleting the viewed file does not surface an unrelated file

- **WHEN** a file is open in slide mode
- **AND** that file is removed from the gallery list (deleted or filtered out)
- **THEN** the viewer does not silently switch to whatever file now occupies the previous index
- **AND** the viewer shows an explicit empty-or-closed state

### Requirement: Intentional retargeting of the viewer is still permitted

The system SHALL allow deliberate, user- or workflow-initiated actions to change
the viewer's anchor to a specific intended file (for example a media-queue "show
in viewer" action, or replacing the viewed file with its processed output). Such
intentional retargeting is distinct from — and not blocked by — the protection
against incidental list churn.

#### Scenario: A "show in viewer" action re-anchors deliberately

- **WHEN** the user or a workflow explicitly requests that a specific file be shown in the viewer
- **THEN** the viewer displays that file
- **AND** the viewer re-anchors to that file's identity

