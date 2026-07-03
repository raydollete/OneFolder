# media-type-filter

## Purpose

Defines the gallery's per-library media-type display filter: a control that restricts the
gallery to a chosen media type (all media, images only, or video only), applied as an upstream
gate before files are materialized into the view so excluded files never render or generate
thumbnails. Covers the control itself, the gating guarantee, persistence and legacy migration,
and how the filter composes with existing view rules.

## Requirements

### Requirement: Media-type filter control

The Search toolbar SHALL provide a dropdown control offering exactly three mutually exclusive options — **Show All Media**, **Images Only**, and **Video Only** — that selects which media types appear in the gallery. The control SHALL replace the previous "Video Only" checkbox. The default selection SHALL be **Show All Media**.

#### Scenario: Default state shows all media
- **WHEN** a library is opened with no previously saved media-type preference
- **THEN** the dropdown SHALL display "Show All Media" and the gallery SHALL include both image and video files

#### Scenario: Selecting Video Only
- **WHEN** the user selects "Video Only" from the dropdown
- **THEN** the gallery SHALL show only files whose extension is a recognized video format and SHALL hide all other files

#### Scenario: Selecting Images Only
- **WHEN** the user selects "Images Only" from the dropdown
- **THEN** the gallery SHALL show only files whose extension is not a recognized video format and SHALL hide all video files

#### Scenario: Control remains visible in criteria search mode
- **WHEN** the search is in advanced criteria mode (the tag quick-search input is not rendered)
- **THEN** the media-type dropdown SHALL still be visible and usable

### Requirement: Upstream gating before materialization

The media-type filter SHALL be applied as an upstream gate on the fetched file set, before any hidden file is materialized into a `ClientFile`, pushed into the gallery `fileList`, rendered, or has a thumbnail generated. Files excluded by the active filter SHALL never appear transiently in the gallery.

#### Scenario: Hidden files never flash into view
- **WHEN** the user has "Video Only" (or "Images Only") active and a fetch resolves a mixed set of image and video files
- **THEN** the excluded files SHALL NOT be rendered into the gallery at any point, not even briefly before being removed

#### Scenario: No thumbnail work for excluded files
- **WHEN** a fetch resolves files excluded by the active media-type filter
- **THEN** no thumbnail generation SHALL be triggered for those excluded files

#### Scenario: Filter re-applies when changed
- **WHEN** the user changes the media-type selection
- **THEN** the gallery SHALL re-fetch and re-gate so that the visible set matches the new selection without requiring a manual refresh

### Requirement: Persistence and legacy migration

The media-type selection SHALL be a per-library display preference persisted across application restarts. A library that previously persisted the legacy `showVideosOnly: true` boolean SHALL be treated as having "Video Only" selected on first load after upgrade; any other legacy value SHALL map to "Show All Media".

#### Scenario: Selection survives restart
- **WHEN** the user selects "Images Only" and later restarts the application with the same library
- **THEN** the dropdown SHALL restore to "Images Only" and the gallery SHALL be filtered accordingly

#### Scenario: Per-library isolation
- **WHEN** two libraries have different media-type selections
- **THEN** switching between them SHALL restore each library's own saved selection independently

#### Scenario: Legacy Video Only upgrades cleanly
- **WHEN** a library that stored the old `showVideosOnly: true` preference is opened after this change
- **THEN** the media-type filter SHALL initialize to "Video Only" without user intervention

#### Scenario: Malformed persisted value fails safe
- **WHEN** the persisted media-type value is missing, `null`, or not one of the three known values
- **THEN** the media-type filter SHALL initialize to "Show All Media" rather than hiding all files

### Requirement: Interaction with existing view rules

The media-type filter SHALL remain a display-only preference and SHALL NOT be represented as a search criterion: it SHALL NOT add a removable search chip and SHALL NOT alter the AND/OR (`searchMatchAny`) semantics of the search. It SHALL NOT be applied in the Missing-files view, which is always unfiltered. When combined with the hide-missing-files filter, a file SHALL be shown only if it satisfies both filters. The Outliner total badge SHALL continue to reflect the pre-filter fetched count so it does not shrink when a media-type filter is active.

#### Scenario: Not shown as a search chip
- **WHEN** any media-type option other than "Show All Media" is active
- **THEN** no corresponding removable criterion chip SHALL appear in the search bar and the search AND/OR toggle behavior SHALL be unchanged

#### Scenario: Missing-files view ignores the filter
- **WHEN** the user opens the Missing-files view while "Video Only" or "Images Only" is selected
- **THEN** the Missing-files view SHALL display all missing files regardless of media type

#### Scenario: Composes with hide-missing-files
- **WHEN** both "Video Only" and hide-missing-files are active
- **THEN** the gallery SHALL show only files that are both video and not broken

#### Scenario: Total badge stays accurate
- **WHEN** a media-type filter hides part of the library in the All-content view
- **THEN** the Outliner total badge SHALL report the full pre-filter fetched count rather than the reduced visible count
