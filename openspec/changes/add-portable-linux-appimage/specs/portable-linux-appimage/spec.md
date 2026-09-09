## Purpose

Defines the portable Linux x86_64 AppImage contract for OneFolder, including adjacent application data, complete native resources, safe GNOME behavior, and compatibility with the Windows portable build.

## ADDED Requirements

### Requirement: A single portable Linux application artifact

The build SHALL produce a Linux x86_64 AppImage that contains the Electron application and can be launched without installing OneFolder or obtaining root privileges. The supported portable unit SHALL be the AppImage together with its sibling `data/` directory.

#### Scenario: Build the Linux artifact

- **WHEN** the Linux portable packaging command completes successfully on a supported Linux x86_64 build host
- **THEN** exactly one versioned x86_64 `.AppImage` application artifact is produced
- **AND** the artifact is executable and launches the OneFolder desktop application without an installation step

#### Scenario: Move the portable unit

- **WHEN** the user moves the AppImage and its sibling `data/` directory together to another writable, executable directory on a supported Linux x86_64 GNOME system
- **THEN** launching the moved AppImage opens the same OneFolder application state and registered libraries

### Requirement: AppImage data is anchored beside the outer artifact

An AppImage launch SHALL automatically enter portable mode and SHALL resolve its portable root from the absolute outer AppImage path supplied by the AppImage runtime, not from the mounted payload executable or current working directory. Before any application user-data path is consumed, OneFolder SHALL route user data and application-owned temporary data to `data/` beside the outer AppImage.

#### Scenario: First AppImage launch

- **WHEN** a user launches an AppImage from a writable directory that has no sibling `data/` directory
- **THEN** OneFolder creates `data/` and its required portable subdirectories beside the outer AppImage
- **AND** all subsequently created preferences, library registry data, databases, backups, thumbnails, themes, logs, and application-owned staging files use that portable context

#### Scenario: Launch from another working directory

- **WHEN** the AppImage is invoked while the process working directory differs from the AppImage's directory
- **THEN** the portable `data/` path remains anchored to the AppImage's directory

#### Scenario: Portable root is not writable

- **WHEN** OneFolder cannot create or write the required sibling `data/` directory
- **THEN** startup fails visibly with the underlying path and filesystem error
- **AND** OneFolder does not silently fall back to a home-directory profile or transient mounted storage

### Requirement: Relaunch executes the outer AppImage

Any application-controlled relaunch from an AppImage SHALL execute the outer AppImage artifact and SHALL preserve all user-supplied launch flags.

#### Scenario: Reload the desktop application

- **WHEN** a user action or recoverable application path requests a full relaunch of the packaged AppImage
- **THEN** the new process executes the persistent outer AppImage rather than an executable inside the transient mounted payload
- **AND** the old process exits after handing off the relaunch

#### Scenario: Relaunch serve mode

- **WHEN** an AppImage process launched with `--serve --port 9000` performs an application-controlled relaunch
- **THEN** the replacement process retains `--serve --port 9000`
- **AND** it does not open the desktop GUI

### Requirement: Linux runtime resources are complete and executable

The AppImage SHALL contain Linux x86_64 native modules and runnable ExifTool, FFmpeg, and FFprobe resources at the paths consumed by the application. Required resources SHALL retain executable permissions and SHALL be accompanied by recorded version, provenance, checksum, license, and material build-feature information. Missing or incompatible required resources SHALL fail loudly and SHALL NOT select Windows executables or silently disable the affected feature.

#### Scenario: Inspect the packaged payload

- **WHEN** the AppImage payload is extracted for verification
- **THEN** its SQLite and image-processing native modules target Linux x86_64 and the packaged Electron ABI
- **AND** Linux ExifTool, FFmpeg, and FFprobe resources exist at their runtime paths with executable permissions
- **AND** Windows PE helper executables are absent from the Linux-only payload

#### Scenario: Use image metadata

- **WHEN** the user reads or writes supported metadata from the packaged AppImage on a supported host with the documented Perl runtime
- **THEN** the packaged ExifTool process performs the operation with the same metadata semantics as the Windows portable application

#### Scenario: Use a video media tool

- **WHEN** the user runs a video media job on compatible NVIDIA hardware and drivers
- **THEN** the packaged FFprobe inspects the input and the packaged FFmpeg performs the job using the existing NVENC contract
- **AND** progress, completion, cancellation, and failure remain visible through the existing media queue

#### Scenario: Required host runtime is unavailable

- **WHEN** a required helper cannot start because a documented host runtime, driver capability, or executable is unavailable
- **THEN** OneFolder reports an actionable error identifying the missing capability
- **AND** it does not report successful metadata or media processing

#### Scenario: Retry after ExifTool fails to open

- **WHEN** one or more callers observe an ExifTool initialization failure and a later caller retries after the missing executable, permission, or interpreter condition is corrected
- **THEN** concurrent callers share one initialization attempt
- **AND** the failed attempt leaves no permanent opening state or polling timer
- **AND** the later call can start ExifTool successfully

### Requirement: Linux deletion uses desktop trash semantics

On Linux, OneFolder SHALL use Electron's native trash operation without consulting the Windows `$Recycle.Bin` directory convention. Permanent deletion SHALL remain an explicit, warned path and SHALL NOT be selected merely because a Linux filesystem root lacks `$Recycle.Bin`.

#### Scenario: Trash a file on a normal GNOME filesystem

- **WHEN** the user chooses a trash action for a file on a Linux filesystem supported by the desktop trash implementation
- **THEN** OneFolder sends the file to the desktop trash
- **AND** it does not present the permanent-deletion warning solely because `$Recycle.Bin` is absent

#### Scenario: Desktop trash rejects a location

- **WHEN** the native trash operation cannot trash a file from its filesystem or mount
- **THEN** the established failure path reports the error
- **AND** permanent deletion occurs only after the user explicitly accepts its unrecoverable consequence

### Requirement: The AppImage integrates predictably with GNOME

The AppImage SHALL carry the OneFolder display name, stable desktop/window identity, Graphics category, and application icons needed for GNOME launcher and window association. Running the AppImage SHALL NOT require desktop integration; optional user-level integration SHALL be documented separately.

#### Scenario: Launch in GNOME Wayland

- **WHEN** the packaged AppImage launches in a supported GNOME Wayland session
- **THEN** GNOME associates the running window with OneFolder's application identity and icon
- **AND** the main window, custom titlebar drag region, minimize, maximize/restore, close, dialogs, drag-and-drop, and task switching remain usable

#### Scenario: Run without installing a desktop entry

- **WHEN** a user marks the downloaded AppImage executable and launches it directly
- **THEN** the full application runs without requiring a `.desktop` file in the user's application directory

#### Scenario: Compositor controls window placement

- **WHEN** GNOME Wayland declines an application's programmatic positioning or focus request
- **THEN** OneFolder remains usable under compositor-selected placement
- **AND** the shipped default does not globally force XWayland solely to override compositor policy

### Requirement: Linux file identity remains case-sensitive

OneFolder SHALL preserve case-sensitive path identity on Linux throughout media-handle release, watcher suppression, deterministic media ingest, and wait-for-ingest matching. Windows SHALL retain separator-insensitive and case-insensitive path equality.

#### Scenario: Process case-distinct Linux files

- **WHEN** a Linux library contains two files whose absolute paths differ only by letter case
- **THEN** release, suppression, ingest, and ingest-wait operations treat them as distinct files
- **AND** an operation targeting one file does not suppress, release, ingest, or resolve the other

#### Scenario: Compare Windows separator and case variants

- **WHEN** Windows main-process and renderer paths differ only by slash direction or letter case
- **THEN** the existing media and ingest workflows continue to recognize them as the same file

### Requirement: Headless mode shares the Linux portable context

The AppImage SHALL expose the existing `--serve [--port <n>]` mode using the same adjacent portable data, active library, database, thumbnail cache, SPA, and ExifTool resources as its desktop mode.

#### Scenario: Start serve mode from the AppImage

- **WHEN** the user launches the AppImage with `--serve`
- **THEN** no application or preview window is created
- **AND** the server uses the active library and log location under the sibling `data/` directory
- **AND** the existing authentication and network-exposure contract remains unchanged

### Requirement: Existing Windows portable behavior is preserved

Adding the Linux AppImage SHALL NOT change the Windows portable artifact name, executable name, portable-root precedence, adjacent `data/` layout, packaged helper resources, launch-flag forwarding, or desktop and serve-mode behavior.

#### Scenario: Build and launch Windows portable after the change

- **WHEN** the Windows portable packaging and production smoke tests run after Linux support is added
- **THEN** `brave.exe` is produced and uses the same adjacent `data/` context and Windows helper executables as before
- **AND** GUI launch, forced relaunch, trash capability detection, and `--serve` retain their existing Windows behavior

### Requirement: Release claims require packaged GNOME verification

The Linux portable capability SHALL NOT be declared working or complete until the actual packaged AppImage has been inspected and exercised end to end in a real supported GNOME Wayland session.

#### Scenario: Verify a release candidate

- **WHEN** a Linux AppImage release candidate is prepared
- **THEN** verification covers first launch, persistence across close/reopen, moving the portable unit, full relaunch, library creation, metadata read/write, thumbnails, native modules, trash, a compatible media job, window/titlebar interactions, dialogs, drag-and-drop, and `--serve`
- **AND** visual evidence from the real packaged UI is inspected and recorded
