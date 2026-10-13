## Purpose

Defines the identity and launch contract of the Windows portable build: one self-contained, versioned executable that keeps all state in a sibling `data/` directory.

## ADDED Requirements

### Requirement: Windows portable artifact identity

The Windows build SHALL produce exactly one distributable artifact, a portable executable named `OneFolder-<version>-x64.exe`, where `<version>` is the application version from `package.json`. The executable that the portable wrapper extracts and launches SHALL be named `OneFolder.exe`. The Windows build SHALL NOT produce an installer, and no Windows artifact or inner executable SHALL be named after another vendor's product.

#### Scenario: Packaging the Windows portable build

- **WHEN** the Windows portable build is packaged at version 1.1.2
- **THEN** `dist/OneFolder-1.1.2-x64.exe` is produced
- **AND** no installer (`*Setup*.exe`) and no `brave.exe` is produced

#### Scenario: Inner executable name

- **WHEN** the portable artifact is launched and extracts its payload
- **THEN** the launched inner process is `OneFolder.exe`

### Requirement: Portable state follows the artifact, not its name

The Windows portable executable SHALL keep its state in a `data/` directory beside the artifact, whatever the artifact's file name. Renaming or replacing the artifact SHALL NOT change which `data/` directory it uses.

#### Scenario: Replacing an older build in an existing portable directory

- **WHEN** a portable directory contains `data/` and a previous build, and the previous build is replaced by `OneFolder-<version>-x64.exe`
- **THEN** the new build opens the same libraries, preferences, and thumbnails from the existing `data/`

### Requirement: Serve flag on the Windows portable artifact

The Windows portable artifact SHALL start the read-only web sidecar instead of the desktop GUI when launched with `--serve`, and SHALL accept `--port <n>`, exactly as the desktop executable's serve mode defines.

#### Scenario: Launching serve mode by the new name

- **WHEN** `OneFolder-<version>-x64.exe --serve --port 9000` is run from a portable directory
- **THEN** no application window opens and the web sidecar listens on port 9000 using that directory's `data/`
