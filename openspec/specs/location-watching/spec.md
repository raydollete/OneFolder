# location-watching Specification

## Purpose

Defines how OneFolder derives location display names and surfaces file-watcher activity and errors to the user. It ensures location labels are always human-meaningful, distinguishes noisy initial-scan errors from actionable watch-time errors, keeps worker-to-renderer error payloads structured and typed, presents slow initial scans as calm progress notes, and prevents empty-path location rows from being persisted or loaded.

## Requirements

### Requirement: Location display name never resolves to an empty string

A location's display name (`ClientLocation.name`) SHALL always be a non-empty, human-meaningful string, so that every consumer — startup toasts, the Locations sidebar, creation/recovery dialog titles, and console logs — renders a real label rather than empty quotes. The name SHALL be derived by a fallback chain that requires no platform-specific branching: the path's basename when non-empty, otherwise the full path, otherwise a literal `(unnamed)`.

#### Scenario: Sub-directory location shows its folder name

- **WHEN** a location's path is a normal sub-directory such as `D:\Photos\Family`
- **THEN** its display name is `Family` (the basename)

#### Scenario: Drive-root location shows its path

- **WHEN** a location's path is a filesystem root whose basename is empty (`D:\`, a UNC root, or POSIX `/`)
- **THEN** its display name is the path itself (e.g. `D:\`), never an empty string

#### Scenario: Empty-path location shows a literal placeholder

- **WHEN** a location's path is itself the empty string
- **THEN** its display name is `(unnamed)`

### Requirement: Initial-scan errors are suppressed; watch-time errors are actionable

Permission and traversal errors emitted by the file watcher during a location's initial scan SHALL NOT produce a user-facing toast, because scanning a drive root reliably hits system-protected directories that are noise rather than actionable failures. Errors emitted after the location is ready (live watching) SHALL produce a toast that names the location and includes the underlying error detail. The `ClientLocation.isReady` flag SHALL be set `true` once the initial scan resolves, so it correctly distinguishes the two phases and its wording ("initializing" vs "watching") is accurate.

#### Scenario: Drive-root permission error during initial scan is not toasted

- **WHEN** the watcher emits an `error` event while the location is still performing its initial scan (`isReady === false`)
- **THEN** the error is logged to the console and no toast is shown

#### Scenario: Watch-time error after ready is toasted with detail

- **WHEN** the watcher emits an `error` event after the location is ready (`isReady === true`), for example the drive is disconnected mid-session
- **THEN** a toast is shown that includes the location's (non-empty) display name and the error's `code` and/or `path`

#### Scenario: Concurrent location errors do not overwrite each other

- **WHEN** two different locations each surface a watch-time error
- **THEN** each toast uses a per-location key so both remain visible instead of one replacing the other

### Requirement: Worker-to-renderer error payload is structured and typed

The folder-watcher worker SHALL serialize a chokidar `Error` into a plain, structured payload `{ message: string; code?: string; path?: string }` before posting it to the renderer, and the renderer's message-handler type union SHALL declare the `error` case with that shape. This closes the mismatch where an `Error` object is posted into a slot typed as `string` and its `code`/`path` fields are lost.

#### Scenario: Error is delivered with code and path intact

- **WHEN** the worker's chokidar watcher fires an `error` carrying `code` and `path`
- **THEN** the renderer receives `{ message, code, path }` and can render those fields, rather than an opaque value

### Requirement: Slow initial scans show a calm progress note, not an alarming warning

When a single location's initialization exceeds a threshold, the app SHALL show a calm, accurate progress note rather than an alarm implying something is broken, and SHALL NOT offer a "Retry?" action that reloads the renderer (which would restart the same scan and strictly worsen the user's wait). The threshold SHALL be at least 60 seconds so that slow-but-progressing scans of real-world libraries do not trigger it. Each location SHALL use its own progress-note toast key.

#### Scenario: Fast location shows no progress note

- **WHEN** a location's initial scan completes within the threshold
- **THEN** no slow-scan progress note is shown

#### Scenario: Slow location shows a calm progress note with no Retry button

- **WHEN** a location's initial scan exceeds the threshold (≥ 60 s)
- **THEN** a toast appears reading `Scanning location "<name>"… this can take a while for large folders.` with no `Retry?` / reload action, and it dismisses automatically when the scan completes

#### Scenario: Multiple slow locations each show their own note

- **WHEN** more than one location exceeds the threshold
- **THEN** each shows its own progress note (per-location key), rather than a later one overwriting an earlier one

### Requirement: Empty-path location rows are rejected and filtered

The system SHALL refuse to persist a location whose path is empty or whitespace-only, and SHALL defensively skip empty-path rows when loading or migrating locations, so a corrupt or hand-edited row cannot create a permanent unnamed ghost entry. Guards SHALL exist at the renderer create path, the data-layer create path, the initial load, and the two migration/conversion tools.

#### Scenario: Creating a location with an empty path is rejected

- **WHEN** `LocationStore.create()` or the data-layer `createLocation` is called with an empty or whitespace-only path
- **THEN** it throws and no location row is written

#### Scenario: Empty-path rows are skipped on load

- **WHEN** the location store loads persisted rows and one has an empty path
- **THEN** that row is filtered out with a console warning and the remaining locations load normally

#### Scenario: Migration and backup conversion skip empty-path rows

- **WHEN** the IndexedDB→SQLite migration or the offline dexie-backup converter encounters a location row with an empty path
- **THEN** the row is skipped, a warning noting how many were skipped is logged, and no empty-path row is written to the new store
