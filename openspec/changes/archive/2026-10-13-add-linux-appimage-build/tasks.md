# Tasks

Retired 2026-10-13 by the owner: superseded by `add-portable-linux-appimage`, which implemented the Linux AppImage target. No task here was implemented; every task is OBSOLETE and this change's `linux-packaging` spec delta is intentionally not synced.

Binding constraints (restated from CLAUDE.md, this repo): this is a **portable-only fork** — do not reintroduce installed-mode branches; the Linux target is portable (AppImage) exactly as Windows is. Frontend code must import platform capabilities from `src/frontend/platform`, never Node `fs`/`electron`/`path` directly (not expected to change here, but honor it if touched). Media/metadata tooling is **fail-loud, no silent fallbacks** — a missing/​non-executable binary must throw a loud error, never degrade silently. Bundled ffmpeg carries `--enable-gpl --enable-libx264`; the GPL source-offer/license-notice obligation applies to the Linux binaries too. Manual GUI/hardware verification is gated: tasks marked **REQUIRES MANUAL EXECUTION** need concrete evidence from real Ubuntu/GNOME hardware before ticking.

## Code & configuration

- [ ] OBSOLETE Add a Linux portable-mode detection branch in `src/main.ts`. On Linux, derive the writable app directory from `process.env.APPIMAGE` (its `path.dirname` is the folder beside the `.AppImage`); keep the existing `PORTABLE_EXECUTABLE_DIR` / `path.dirname(process.execPath)` logic for Windows. The `execPath` of an AppImage is inside a read-only squashfs mount, so it must NOT be used to place `data/`. The branch must run at module scope before any `app.getPath()` consumer (same ordering as the existing block at `src/main.ts:102`).
      Verify: `yarn lint` and `npx tsc --noEmit` pass; unit-test or a jsdom/node assertion that with `process.env.APPIMAGE=/tmp/x/OneFolder.AppImage` (and execPath pointed elsewhere) the resolved portable dir is `/tmp/x`. Done-when: on Linux the data dir resolves beside the `.AppImage`, never inside the mount, and Windows detection is unchanged.

- [ ] OBSOLETE Vendor Linux `ffmpeg` and `ffprobe` static binaries into `resources/ffmpeg/` (bare names, no extension — matching `getFfmpegPath`/`getFfprobePath` in `common/fs.ts:157`), built with `--enable-gpl --enable-libx264` to match the Windows build's license posture. Record their provenance/version and the GPL source-offer note in `resources/exiftool/readme.md`'s sibling or a new `resources/ffmpeg/README`.
      Verify: `resources/ffmpeg/ffmpeg -version` and `resources/ffmpeg/ffprobe -version` run on Linux and report libx264 in the config. Done-when: both bare Linux binaries exist in the tree with a recorded license note.

- [ ] OBSOLETE Extend `package.json` `build.linux`: add `resources/ffmpeg/ffmpeg` and `resources/ffmpeg/ffprobe` to `extraResources` (currently only exiftool entries, `package.json:51`); add `executableName`, `icon` (PNG), an AppImage `artifactName`, and `desktop` fields including `Categories=Graphics;Photography;` and a `StartupWMClass` matching the app's window class. Do NOT reuse the Windows `brave` identity (`package.json:57`, `package.json:80`). Do NOT register MIME/image associations.
      Verify: `npx electron-builder --linux AppImage --dir` (inside the Linux container) emits the `.desktop` with the expected `StartupWMClass` and categories, and the unpacked `resources/` contains the Linux ffmpeg/ffprobe. Done-when: config produces a desktop-integrated unpacked build with the media binaries present.

- [ ] OBSOLETE Wire a `build/icon.png` (multi-size, e.g. 512×512) from the existing `resources/logo/png/` set into the `logo` script (`package.json:17`) or the build config, since the Linux target cannot use `.ico`/`.icns`.
      Verify: after `yarn logo` (or the build step), `build/icon.png` exists at the required resolution; electron-builder consumes it without an icon warning. Done-when: the AppImage and `.desktop` carry the app's own PNG icon.

- [ ] OBSOLETE Ensure `resources/exiftool/exiftool.pl`, `resources/ffmpeg/ffmpeg`, and `resources/ffmpeg/ffprobe` are executable in the packaged Linux AppImage. `@logion/node-exiftool` spawns the runnable directly (`node_modules/@logion/node-exiftool/src/lib.js:164` — `cp.spawn(bin, …)`, no `perl` prefix), relying on the `#!/usr/bin/perl -w` shebang, and a Windows checkout carries no execute bit. Implement via an electron-builder `afterPack`/`extraResources` permission step or a Linux-only first-launch `chmod +x` guard; if applied at runtime it must fail loud if the chmod fails.
      Verify: in the unpacked/mounted AppImage on Linux, `stat -c '%A' resources/exiftool/exiftool.pl` shows the execute bit; spawning exiftool from the app succeeds. Done-when: all three binaries are executable in the shipped image and exiftool spawns without a permission error.

- [ ] OBSOLETE Update `--serve` mode docs/banner references from `brave.exe --serve` to the Linux invocation `./OneFolder.AppImage --serve` where they appear (`src/serve-mode.ts:2` header comment, and `CLAUDE.md`/`docs/` mentions). Serve detection is arg-based and already cross-platform; this is documentation only.
      Verify: `grep -rn "brave.exe --serve"` returns only intentionally Windows-scoped references. Done-when: Linux serve invocation is documented.

- [ ] OBSOLETE Add the Docker build path: a `Dockerfile` (or compose) based on `electronuserland/builder`, plus a short `docs/` section documenting the flow — fresh in-container `yarn install` (so `better-sqlite3` compiles for the Linux/Electron ABI and `sharp` resolves Linux libvips), `yarn package:appimage`, with `APPIMAGE_EXTRACT_AND_RUN=1` set and the Windows `node_modules` explicitly NOT shared into the container. Document the `libfuse2` runtime dependency (Ubuntu 22.04+) and the deliberate MIME-skip decision.
      Verify: running the documented `docker run … yarn install && yarn package:appimage` on the maintainer's Windows machine produces a single `dist/*.AppImage`. Done-when: a reproducible Docker build produces the AppImage and the docs state the libfuse2/MIME decisions. **REQUIRES MANUAL EXECUTION** (Docker build on the maintainer's machine).

## Manual QA on Ubuntu/GNOME — REQUIRES MANUAL EXECUTION

- [ ] OBSOLETE Launch & portable data dir: run the `.AppImage` from a writable folder on Ubuntu/GNOME; confirm the app window opens and `data/` (with `backups/`, `thumbnails/`, `themes/`) is created **beside the `.AppImage`**, not inside the mount. Confirm no EROFS error.
      Verify: `ls` beside the `.AppImage` shows the populated `data/`; app log shows portable mode active. Done-when: portable data lives beside the executable and the app runs. **REQUIRES MANUAL EXECUTION**.

- [ ] OBSOLETE Metadata (exiftool via Perl): open a library, read EXIF/XMP from a real image, then write a tag change back and confirm it persists on disk.
      Verify: exiftool process starts (app log), a round-trip read→write→read shows the changed tag. Done-when: metadata read and write both succeed on Linux. **REQUIRES MANUAL EXECUTION**.

- [ ] OBSOLETE Native modules & thumbnails: confirm the SQLite-backed library loads (better-sqlite3) and thumbnails generate (sharp) for a folder of mixed images including a HEIC/RAW sample.
      Verify: library opens without a native-module load error; thumbnails render in the grid. Done-when: better-sqlite3 and sharp both function in the AppImage. **REQUIRES MANUAL EXECUTION**.

- [ ] OBSOLETE Real media job: run a video re-encode/clip against a bundled test clip; confirm progress streams, a valid output file is produced, and cancellation kills the ffmpeg child (SIGKILL path).
      Verify: output plays back; cancelling mid-encode stops the job and leaves no orphan ffmpeg process. Done-when: an end-to-end ffmpeg job and its cancellation both work on Linux. **REQUIRES MANUAL EXECUTION**.

- [ ] OBSOLETE GNOME integration: confirm the dock shows the app's own icon (not a generic placeholder), the window groups under the `.desktop` entry (StartupWMClass correct), and the frameless custom titlebar's min/max/close controls and drag region work under client-side decorations.
      Verify: GNOME dock shows the real icon and single grouped window; titlebar controls operate. Done-when: the app presents as a proper GNOME citizen. **REQUIRES MANUAL EXECUTION**.

- [ ] OBSOLETE Serve mode: run `./OneFolder.AppImage --serve` and confirm the read-only web sidecar starts, binds, logs to `data/server.log`, and serves the SPA.
      Verify: the server banner appears, the port is reachable, and the SPA loads in a browser. Done-when: `--serve` works on Linux. **REQUIRES MANUAL EXECUTION**.
