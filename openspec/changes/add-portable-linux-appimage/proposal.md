# Ship a portable Linux AppImage for GNOME

Tier: 3 — cross-cutting platform correction spanning packaging, process bootstrap, helper lifecycle, destructive deletion, and shared filesystem identity semantics; it preserves the data model and renderer architecture but cannot be made reliable as a packaging-only edit.
Type: bug

## Root Cause

wrong-mental-model: the declared Linux target was treated as maintained cross-platform support while later portable, helper, deletion, and path-identity work continued to model Windows; most directly, prior packaging work assumed `process.execPath` names the outer AppImage even though AppImage exposes the outer file through `APPIMAGE` and Electron runs from the mounted payload (`src/main.ts:102`, `src/main.ts:1266`; `docs/TODO/pending_qa/tasks/TASK-014_DONE_ELECTRON_portable-packaging-config.md:68`).

## Blast Radius

1. `package.json:16` and `package.json:46` — the AppImage command and target exist, but Linux resources omit the `ffmpeg` and `ffprobe` executables required by the media-job path and do not explicitly define GNOME launcher identity/icon inputs.
2. `src/main.ts:102` — portable context detection must resolve the directory containing the outer AppImage before the first `app.getPath()` call and preserve the existing Windows behavior.
3. `src/main.ts:1266` — forced relaunch must execute the outer AppImage rather than the transient mounted Electron executable while forwarding all user flags, including `--serve`.
4. `src/main.ts:820` — the `$Recycle.Bin` capability probe is Windows-specific; on Linux it classifies `/` as non-recyclable and diverts deletion toward the permanent-delete warning/path instead of Freedesktop Trash through Electron.
5. `common/fs.ts:143` and `common/ExifIO.ts:52` — packaged helper lookup already selects POSIX names, but the actual Linux helper files and executable contract must match those paths; `common/ExifIO.ts:165` must also clear and share failed/in-flight initialization rather than leaving later calls polling forever.
6. `resources/exiftool/exiftool.pl:1` and `resources/ffmpeg/ffmpeg.exe:1` — ExifTool is a non-executable Perl script in git and the repository contains only Windows FFmpeg binaries; Linux x64 runnable resources and their licensing/provenance are required. The Linux package declaration also spells the tracked `.ExifTool_config` as `.Exiftool_config` at `package.json:54`, which fails on case-sensitive filesystems.
7. `src/frontend/image/MediaReleaseCoordinator.ts:41`, `src/frontend/stores/LocationStore.ts:533`, and `src/frontend/stores/FileStore.ts:1620` — media release, watcher suppression/ingest, and wait-for-ingest keys lowercase all paths; Linux path identity must remain case-sensitive so `Clip.mp4` and `clip.mp4` do not alias while Windows comparisons stay case-insensitive.
8. `src/frontend/containers/WindowTitlebar.tsx:10` and `resources/style/window-titlebar.scss:1` — the existing frameless Windows/Linux titlebar is retained, but its controls, drag region, focus, maximize/restore, and GNOME Wayland behavior require packaged UI verification.
9. `README.md:90`, `docs/multi-library.md:51`, and `docs/TOOLS.md:33` — build, portable-data, helper-binary, launch, GNOME integration, host-runtime, NVENC, and case-sensitive filesystem requirements must describe the Linux artifact accurately rather than repeating Windows-only instructions.
10. `tests/media-job.test.ts:54` — helper-path and platform behavior tests must stop silently skipping Linux media verification when the promised bundled binaries are absent; new focused tests are also required for AppImage path/relaunch resolution, ExifTool retry, POSIX case-distinct paths, and non-Windows trash classification.
11. Grepped `APPIMAGE|APPDIR|PORTABLE_EXECUTABLE|process.platform|$Recycle.Bin|toLowerCase|ffmpeg|exiftool|WindowSystemButtons` across `src/`, `common/`, `tests/`, `resources/`, `docs/`, and `package.json`; the sites above are the in-scope Linux-portability surface. `src/server/path-resolver.ts:85` already preserves POSIX case sensitivity and needs no change; `common/fs.ts:18` mishandles literal `?` in legal Linux filenames but shares an ambiguous query-suffix API, so changing it would alter other file-URL consumers and is explicitly deferred pending a separate contract decision.

## Stated Requirements

- Verbatim owner request: “The current codebase was designed for an electron app to be built for Windows. How can we create a similar portable build for Linux/Gnome?”
- The Linux deliverable is a GNOME-friendly AppImage analogous to the current Windows portable executable: one movable application artifact with its writable `data/` directory beside it.
- Cross-OS migration of Windows drive-letter library paths into Linux mount paths is not included; that would be a separate data-migration change.

## Why

The repository advertises a Linux AppImage, but the present artifact cannot satisfy the Windows portable contract: it resolves data and relaunch paths inside a temporary AppImage mount, omits Linux media executables, may fail to start ExifTool, and applies a Windows-only Recycle Bin probe on Linux. The target should be made genuinely usable and then exercised through the packaged application on GNOME.

## What Changes

- Make AppImage launches automatically use the outer AppImage directory as the portable root, storing all application state under the adjacent `data/` directory while leaving Windows portable behavior unchanged.
- Relaunch the outer AppImage and preserve launch flags for both GUI and `--serve` modes.
- Package executable Linux x64 ExifTool, FFmpeg, and FFprobe resources with explicit runtime/licensing documentation and fail-loud validation when promised helpers are absent.
- Correct exact-case resource declarations and make ExifTool initialization retryable after a helper-start failure.
- Use Electron/Freedesktop trash behavior on Linux instead of probing for Windows `$Recycle.Bin` directories.
- Preserve case-sensitive Linux path identity throughout media release, watcher suppression/ingest, and ingest-wait comparisons while retaining Windows case-insensitive behavior.
- Give the AppImage explicit application identity and icons suitable for GNOME launchers and document optional desktop integration without making installation a prerequisite.
- Add focused automated coverage plus a packaged GNOME Wayland acceptance pass covering persistence, relaunch, metadata, media tools, trash, titlebar/window behavior, and serve mode.

## Capabilities

### New Capabilities

- `portable-linux-appimage`: Linux AppImage packaging, adjacent portable data, outer-artifact relaunch, bundled native/helper resources, safe Linux trash behavior, GNOME identity/integration, and packaged acceptance behavior.

### Modified Capabilities

- None.

## Impact

- **Process bootstrap:** `src/main.ts` gains an AppImage-aware distribution context used consistently by portable detection and relaunch.
- **Packaging/resources:** `package.json` and `resources/` gain Linux-specific executable assets, metadata, modes, and license/provenance records; Linux builds must run on Linux x64 with Electron-native dependencies rebuilt for that target.
- **Platform behavior:** Linux deletion capability checks stop consulting the Windows Recycle Bin layout; helper initialization becomes retryable; media/watcher path equality becomes platform-aware through the established frontend platform seam.
- **Documentation/tests:** README and tool/library documentation are corrected, focused unit tests cover pure platform decisions, and final verification drives the real packaged AppImage under GNOME Wayland and inspects its contents.
- **Compatibility:** Windows portable and unpackaged development behavior must remain observably unchanged. No database schema, API, frontend component hierarchy, or headless security contract changes.
