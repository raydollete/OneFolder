## ADDED Requirements

### Requirement: Inspector metadata always reflects the selected file

The inspector SHALL only display metadata belonging to the currently selected
file. When the user switches files while an asynchronous metadata read for a
previous file is still in flight, the late/out-of-order resolution of that read
SHALL NOT update the inspector's displayed values (no stale or cross-file
metadata).

#### Scenario: Fast file switch does not show the previous file's metadata

- **WHEN** the user selects file A and then selects file B before A's metadata read completes
- **THEN** the inspector shows B's metadata (or empty fields while B loads)
- **AND** A's metadata is never shown while B is selected, even if A's read resolves after B's

### Requirement: Inspector saves never write another file's metadata

The inspector SHALL NOT write a previously selected file's metadata into the
currently selected file. Form fields seeded from an asynchronous read SHALL be
seeded only from a read that belongs to the currently selected file, so that a
save always writes the values that belong to the file being saved.

#### Scenario: Saving after a fast switch writes only the current file's values

- **WHEN** file A's metadata read resolves after the user has switched to file B
- **AND** the user edits and saves the inspector form for file B
- **THEN** only B's (edited) values are written to file B
- **AND** none of A's values are written into file B

### Requirement: Inspector read failures are logged, not silently swallowed

The inspector SHALL log a diagnostic message when an asynchronous metadata read
fails, rather than discarding the error with an empty or value-clearing catch. A
failed read SHALL leave the affected field empty/unchanged in the UI while still
producing a record that a read was attempted and failed.

#### Scenario: A failed metadata read is logged

- **WHEN** an inspector metadata read rejects (for example the metadata reader is unavailable)
- **THEN** a diagnostic message is logged identifying the failing read
- **AND** the failure is not collapsed into an indistinguishable silent blank

#### Scenario: A failed background thumbnail move is logged

- **WHEN** moving a file's thumbnail after a file move/rename fails
- **THEN** the failure is logged rather than swallowed by an empty catch
