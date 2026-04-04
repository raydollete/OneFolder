---
id: TASK-014
title: 'Configure electron-builder for portable distribution targets'
investigation: INV-002
status: planned
priority: medium
blocked_by: [TASK-013]
date_created: 2026-04-04
date_completed:
files:
  - 'package.json'
---

## What

Update the electron-builder configuration in `package.json` to produce portable distribution artifacts: a Windows portable EXE (already partially configured) and a Linux AppImage (already configured). Ensure native modules (`better-sqlite3`) are correctly rebuilt for each target platform. Add a `portable.txt` marker file to portable builds so they auto-detect portable mode.

## Why

The electron-builder config in `package.json` already has `win.target: ["nsis", "portable"]` and `linux.target: ["AppImage"]`, but the portable EXE has never been tested with path redirection. With TASK-013 implementing portable mode detection, the packaging must be configured to include the marker file and ensure the native SQLite module is bundled correctly.

See [INV-002](../investigations/INV-002_HIGH_BACKEND_sqlite-migration-and-portable-mode.md).

## Implementation Steps

- [ ] 1. In `package.json`, update the `build.portable` section to include the `portable.txt` marker file:

    ```json
    "portable": {
      "artifactName": "${productName}Portable.${version}.${ext}",
      "requestExecutionLevel": "user"
    }
    ```

    Add an `extraFiles` entry for portable builds that includes a `portable.txt` marker:

    ```json
    "extraFiles": [
      {
        "from": "resources/portable.txt",
        "to": "portable.txt"
      }
    ]
    ```

    Create `resources/portable.txt` with content explaining portable mode (e.g., "This file enables portable mode. All application data will be stored in the data/ directory next to the executable.").

    Note: electron-builder's `portable` target extracts to a temp directory by default. The `portable.txt` must end up next to the extracted executable. Investigate whether `extraFiles` achieves this for portable targets, or whether a post-build script is needed to inject it into the portable archive.

- [ ] 2. Handle `better-sqlite3` native module rebuild. Add or update the electron-builder config:

    ```json
    "build": {
      "nodeGypRebuild": false,
      "npmRebuild": true
    }
    ```

    Alternatively, use `electron-rebuild` in a `postinstall` script or `afterPack` hook. `better-sqlite3` is a native C++ module that must be compiled against the correct Electron version and architecture. Verify that the existing `asar: true` config works with native modules (native `.node` files must be unpacked from the asar archive).

    Add to electron-builder config:
    ```json
    "asarUnpack": [
      "node_modules/better-sqlite3/**"
    ]
    ```

- [ ] 3. For Linux AppImage: verify it already works as a portable target. AppImage is inherently portable (single file, runs from anywhere). The portable mode detection (TASK-013) checks for `portable.txt` or `data/` next to the executable. For AppImage, `process.execPath` points to the AppImage file itself, so `path.dirname(process.execPath)` gives the directory containing the AppImage. Users create `portable.txt` or `data/` next to the `.AppImage` file.

    Document this in a README or help text: "To enable portable mode on Linux, create a file named `portable.txt` next to the AppImage file."

- [ ] 4. For macOS: the `.app` bundle structure means `process.execPath` is inside `Contents/MacOS/`. Portable mode on macOS requires different detection logic (check next to the `.app` bundle, not next to the binary inside it). Update TASK-013's detection logic if macOS portable mode is desired, or explicitly skip macOS portable support.

- [ ] 5. Add a `package:portable` script to `package.json` for convenient portable-only builds:

    ```json
    "package:portable": "yarn build && electron-builder --win portable",
    "package:appimage": "yarn build && electron-builder --linux AppImage"
    ```

- [ ] 6. Test the complete build pipeline:
    - `yarn package` produces both NSIS installer and portable EXE for Windows
    - The portable EXE, when extracted, has `portable.txt` next to the executable
    - Running the portable EXE creates a `data/` directory and stores the SQLite database there
    - Linux AppImage works with a `portable.txt` placed next to it

## Done When

- [ ] `yarn package` produces a working Windows portable EXE with `portable.txt` included
- [ ] `yarn package` produces a working Linux AppImage
- [ ] `better-sqlite3` native module is correctly bundled and unpacked from asar
- [ ] Windows portable EXE auto-detects portable mode and stores data in `./data/`
- [ ] Linux AppImage works in portable mode when `portable.txt` is placed alongside it
- [ ] Build scripts are documented in `package.json`
