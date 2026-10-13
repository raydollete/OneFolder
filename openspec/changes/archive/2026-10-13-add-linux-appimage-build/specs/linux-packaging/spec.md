## ADDED Requirements

### Requirement: Portable data directory on the AppImage layout
The application SHALL detect portable mode on Linux from the AppImage runtime environment and place its writable `data/` directory beside the `.AppImage` file, never inside the read-only mount.

#### Scenario: Launched as an AppImage
- **WHEN** the app starts with `process.env.APPIMAGE` set to `/home/user/Apps/OneFolder.AppImage`
- **THEN** portable mode is active
- **AND** the writable data directory is created at `/home/user/Apps/data/` (sibling of the `.AppImage`), not under the read-only squashfs mount that `process.execPath` points into
- **AND** `userData` and `temp` are remapped into that `data/` directory before any `app.getPath()` consumer runs

#### Scenario: data directory is writable on first launch
- **WHEN** the AppImage is run for the first time from a writable location
- **THEN** `data/`, `data/backups`, `data/thumbnails`, and `data/themes` are created successfully
- **AND** no attempt is made to write inside the read-only AppImage mount

### Requirement: Bundled media tooling resolves and runs on Linux
The Linux build SHALL bundle Linux `ffmpeg` and `ffprobe` binaries as `extraResources` so the media subsystem can encode, clip, and probe media without a system-installed ffmpeg.

#### Scenario: ffmpeg path resolves to the bundled Linux binary
- **WHEN** the media subsystem requests the ffmpeg or ffprobe path on Linux
- **THEN** it resolves to `resources/ffmpeg/ffmpeg` / `resources/ffmpeg/ffprobe` (no `.exe` suffix)
- **AND** that file exists in the packaged AppImage and is executable

#### Scenario: A real media job completes on Linux
- **WHEN** a video re-encode job is run against a bundled test clip on Ubuntu/GNOME
- **THEN** the job spawns the bundled ffmpeg, streams progress, and produces a valid output file
- **AND** cancellation kills the child via SIGKILL (not taskkill)

### Requirement: Metadata tooling runs via Perl on Linux
The Linux build SHALL run exiftool through its bundled Perl runnable (`exiftool.pl`), which is spawned directly by the node-exiftool library and therefore SHALL be executable and resolve its `#!/usr/bin/perl` shebang.

#### Scenario: exiftool spawns successfully on Linux
- **WHEN** the app opens a library and initializes the exiftool process on Ubuntu
- **THEN** `resources/exiftool/exiftool.pl` is spawned directly (the library does not prepend `perl`)
- **AND** the runnable carries the execute bit and the `#!/usr/bin/perl -w` shebang resolves against the system Perl
- **AND** reading and writing EXIF/XMP metadata on a real image succeeds

### Requirement: GNOME desktop integration
The Linux build SHALL integrate with the GNOME shell: a `.desktop` entry with a `StartupWMClass` matching the app's window class, an appropriate application category, and a themed PNG icon.

#### Scenario: App is a recognized GNOME citizen
- **WHEN** the AppImage window is open on GNOME
- **THEN** the shell shows the app's own icon in the dock (not a generic placeholder)
- **AND** the running window groups under the app's `.desktop` entry (StartupWMClass matches)
- **AND** the frameless custom titlebar's window controls and drag region function under client-side decorations

### Requirement: Reproducible Linux build
The repository SHALL provide a documented, repeatable Docker-based path to build the Linux AppImage from the maintainer's Windows machine, producing correct Linux native modules.

#### Scenario: AppImage builds via Docker
- **WHEN** the maintainer runs the documented Docker build (`yarn install` then `yarn package:appimage` inside the Linux container, with `APPIMAGE_EXTRACT_AND_RUN=1`)
- **THEN** `better-sqlite3` compiles for the Linux/Electron ABI and `sharp` resolves its Linux libvips inside the container
- **AND** a single `.AppImage` artifact is produced under `dist/`
- **AND** the Windows `node_modules` is not shared into the container (a fresh Linux dependency tree is used)
