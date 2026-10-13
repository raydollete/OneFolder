# Design — add-linux-appimage-build

## Approach

The work splits into four seams: build environment, packaging config, portable-mode detection, and binary/permission handling. Most application code is already platform-aware; the center of gravity is standing up a Linux build+test path.

**1. Build environment (Docker on Windows).**
Build the AppImage inside a Linux container (`electronuserland/builder`) invoked from the maintainer's Windows machine. Do a **fresh `yarn install` inside the container** so `better-sqlite3` compiles against the Linux/Electron ABI and `sharp` resolves its Linux libvips prebuild (`@img/sharp-linux-x64`). electron-builder does not cross-compile, so this in-container install is what makes native modules correct — and the Windows `node_modules` must **not** be shared into the container (a separate volume or an excluded mount), or the Linux build picks up Windows `.node` files. Set `APPIMAGE_EXTRACT_AND_RUN=1` (or run the container `--privileged`) so appimagetool assembles the image without FUSE inside the container. A `Dockerfile`/compose file plus a documented `docker run … yarn install && yarn package:appimage` flow lands in the repo; the resulting `.AppImage` is copied back to Windows. (WSL2 is a viable alternative the peers raised; Docker is the chosen path per the maintainer's decision — it is self-contained and reproducible.)

**2. Packaging config (`package.json` `build`).**
- Add `resources/ffmpeg/ffmpeg` and `resources/ffmpeg/ffprobe` to `linux.extraResources` (alongside the exiftool entries already there).
- Add `linux.desktop` fields: `Categories=Graphics;Photography;`, and `StartupWMClass` matching the app's window class so GNOME shows the real icon and groups the window.
- Add `linux.executableName`, `linux.icon` (a PNG), and an AppImage `artifactName` (the Windows target's `brave`/`brave.${ext}` identity is Windows-only and not reused).
- Extend the `logo` script (or build config) to place a `build/icon.png` (multi-size) from the existing `resources/logo/png/` set — today only `.icns`/`.ico` are copied.

**3. Portable-mode detection (`src/main.ts`).**
Add a Linux branch that derives the writable app directory from `process.env.APPIMAGE` (its `dirname` is the folder beside the `.AppImage`), because `process.execPath` on an AppImage points inside the read-only squashfs mount. The existing `PORTABLE_EXECUTABLE_DIR`/`execPath` logic stays for Windows. This must run at module scope before any `app.getPath()` consumer, matching the existing ordering. A wrong derivation here surfaces as an EROFS write failure when creating `data/` inside the read-only mount — the change must make that impossible, not merely unlikely.

**4. Binaries and executable bits.**
- Source Linux **static** `ffmpeg`/`ffprobe` built with `--enable-gpl --enable-libx264` to match the shipped Windows build's license posture (the GPL-source-offer obligation the code comments already flag applies equally).
- exiftool on Linux runs via `exiftool.pl`, which `@logion/node-exiftool` spawns **directly** (`cp.spawn(bin, …)` in `node_modules/@logion/node-exiftool/src/lib.js:164`, no `perl` prefix) relying on its `#!/usr/bin/perl -w` shebang. A Windows checkout has no execute bit on these files, and `extraResources` copying does not reliably set one. So the build (or a Linux-only first-launch `chmod +x`) must ensure `exiftool.pl`, `ffmpeg`, and `ffprobe` are executable in the packaged image. The bundled `resources/exiftool/lib` supplies `Image::ExifTool`; `/usr/bin/perl` (perl-base, always present on Ubuntu) satisfies the shebang.

**GNOME specifics.** The frameless custom titlebar already targets "windows/linux" and fits GNOME's client-side-decoration model; window controls and drag region are verified on real GNOME. `libfuse2` is a documented Ubuntu 22.04+ dependency for running AppImages. MIME associations are deliberately **not** registered — OneFolder manages folders and must not become the default image opener. `--serve` mode's invocation on Linux is `./OneFolder.AppImage --serve`; its docs/banner references to `brave.exe --serve` are updated.

**Alternatives considered.** `.deb` (native apt integration but not "portable" — rejected: conflicts with the portable-beside-the-executable model) and Flatpak (sandboxed via portals — rejected: fights the "your files, your folder" filesystem-direct philosophy). AppImage is the correct fit for a portable deliverable.

## External Review

### Peer Review Verdict

Quorum: achieved (weight 2/2, escalated to tier 1)
Certainty: 0.95
Caller Agreement: 1
Arbiter: ok
Sources:
- gemini-flash (google/gemini-3.5-flash) — ok, agreement 1
- qwen (qLLM) — ok, agreement 0.9

### Review Feedback

Consensus feedback recorded verbatim:
- Use a Linux container (or WSL2) for a clean install and native-module compile, avoiding Windows node_modules pollution — ACCEPTED: this is the core of approach step 1 (fresh in-container `yarn install`, no shared Windows `node_modules`); WSL2 noted as an accepted alternative, Docker chosen per maintainer decision.
- Add a `linux` block with AppImage target, high-res PNG icon (Linux doesn't render .ico/.icns), desktop categories, and StartupWMClass — ACCEPTED: covered by approach step 2 (PNG icon wiring, `linux.desktop` with `StartupWMClass`, categories).
- Ensure bundled binaries (ffmpeg/ffprobe/exiftool.pl) carry executable permissions (chmod +x), since Windows filesystems lose the bit — ACCEPTED: elevated to a first-class design concern in approach step 4 (build-set or first-launch `chmod +x` on Linux), applied to all three binaries, not just exiftool.
- Guard against silent EROFS write failures if the app writes inside the read-only SquashFS mount — ACCEPTED: approach step 3 keys portable detection on `process.env.APPIMAGE` specifically so `data/` never targets the read-only mount; verification asserts the writable-location scenario.
- Missing `libfuse2` on Ubuntu 22.04+ and the Perl runtime dependency for exiftool.pl in minimal environments — ACCEPTED: libfuse2 documented as a runtime dependency; Perl reliance recorded as an assumption (perl-base is always present on Ubuntu) and exercised by the exiftool QA scenario.
- Native-module ABI mismatch risk — ACCEPTED: mitigated structurally by compiling inside the target Linux/Electron ABI container rather than cross-building; the pinned Electron 41.7.2 / better-sqlite3 versions are held identical to the Windows build.
