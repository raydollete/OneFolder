# Add portable Ubuntu/GNOME AppImage build target

Tier: 2 — new build target plus a bounded set of platform-seam touch points (portable detection, packaging config, binaries, icon); not a one-file triviality (Tier 1), not systemic/architectural (Tier 3).
Type: feature

## Stated Requirements

Captured verbatim from the user's request and follow-up decisions:
- "what would be necessary to create a Ubuntu/GNOME executable for the portable app?"
- Build host decision: **Docker on Windows** — "Use electronuserland/builder container to build from your current Windows machine. No separate hardware, reproducible."
- Scope decision: **Full GNOME integration** — "Above plus .desktop entry, MIME associations, icon theming, FUSE handling — a citizen users install and keep." (Conflict noted and resolved in design: MIME associations are deliberately excluded so OneFolder does not hijack the default image opener; the rest of the GNOME-citizen scope stands.)

## Why

The fork ships Windows-portable-only today, but the codebase already carries latent Linux seams (platform-aware ffmpeg/exiftool resolution, SIGKILL-vs-taskkill, a frameless "windows/linux" titlebar, and a `linux: { AppImage }` electron-builder stanza). No Linux artifact is producible because the tree ships only Windows binaries, the portable-mode detection understands only the Windows portable target, and there is no Linux build path. This change makes a portable Ubuntu/GNOME AppImage a first-class, GNOME-integrated deliverable, built reproducibly via Docker on the maintainer's Windows machine.

## What

- Bundle Linux `ffmpeg`/`ffprobe` (static, GPL+libx264 to match the shipped Windows build's license posture) and add them to `linux.extraResources`.
- Teach portable-mode detection the AppImage layout (`$APPIMAGE` names the writable folder beside the `.AppImage`; `process.execPath` is inside a read-only mount).
- Wire a Linux PNG icon and full GNOME desktop integration (`.desktop` entry with a correct `StartupWMClass`, categories, icon theming).
- Add a Docker-based Linux build path (fresh in-container `yarn install` compiles `better-sqlite3` for Linux and resolves `sharp`'s Linux libvips), documented and repeatable.
- Verify the exiftool-via-Perl path, native modules, thumbnails, and a real media job on genuine Ubuntu/GNOME hardware (all manual-QA gated).

## Root Cause

Not applicable — this is a feature (new build target), not a correction of existing behavior.

## Blast Radius

1. `package.json:46` — `build.linux` currently targets AppImage but its `extraResources` (lines 51–55) bundle only the exiftool Perl runnable, omitting `ffmpeg`/`ffprobe`; also needs `desktop` fields, `executableName`, `icon`, and an `artifactName`.
2. `package.json:57` — `build.win` (`executableName: "brave"`, `.exe` extraResources) and `build.portable` (`package.json:80`, `artifactName: "brave.${ext}"`) are Windows-only identity/config that the Linux target must define independently.
3. `package.json:17` — the `logo` script copies only `.icns`/`.ico` into `build/`; no `build/icon.png` is produced for the Linux target (source PNGs exist under `resources/logo/png/`).
4. `src/main.ts:102` — portable-mode detection derives `_portableAppDir` from `PORTABLE_EXECUTABLE_DIR` (Windows-portable-target env) or `path.dirname(process.execPath)`; on an AppImage `process.execPath` is inside the read-only squashfs mount, so `data/` creation (`src/main.ts:112-118`) would target a non-writable path. Must key off `process.env.APPIMAGE`.
5. `resources/ffmpeg/ffmpeg.exe` — the ffmpeg resources dir holds only Windows `.exe`; grepped/listed `resources/ffmpeg/` for bare `ffmpeg`/`ffprobe` — none present. Linux binaries must be sourced and added.
6. `common/fs.ts:157` — `getFfmpegPath`/`getFfprobePath` (and `common/fs.ts:167`) already resolve `win?'ffmpeg.exe':'ffmpeg'`; no code change, but the resolved Linux path only works once (5) lands. Cited to record it as verified-already-correct, not overlooked.
7. `common/ExifIO.ts:52` — `exiftoolRunnable = IS_WIN ? 'exiftool.exe' : 'exiftool.pl'` already selects the Perl runnable on Linux, and `resources/exiftool/` bundles `exiftool.pl` + `lib`; the open risk is HOW `@logion/node-exiftool` invokes it (direct exec needing shebang+`+x`, vs `perl exiftool.pl`) and the implicit Perl runtime dependency. Requires empirical verification, not a code change assumed in advance.
8. `src/main.ts:205` — the frameless custom titlebar already claims "windows/linux"; GNOME uses client-side decorations, so this is expected to fit, but window controls/drag must be verified on GNOME.
9. `src/serve-mode.ts:2` — `--serve` mode and its docs reference `brave.exe --serve`; on Linux the invocation is `./OneFolder.AppImage --serve`. Serve detection is arg-based (cross-platform); docs/banner reference and Linux serve verification are in scope.
10. New: a `Dockerfile` / compose + documented build flow (`docker run … yarn install && yarn package:appimage`, `APPIMAGE_EXTRACT_AND_RUN=1`) — no such Linux build infra exists in the repo (grepped `Dockerfile`, `docker` in repo root — none).

<!-- lessons.md consulted: openspec/lessons.md does not yet exist (no prior challenging-scenario captures); nothing to cite. -->
