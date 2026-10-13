<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/OneFolderApp/OneFolder/assets/27826950/e12e0f46-a1a8-484f-a443-b71d4a30d37f">
  <img alt="Text changing depending on mode. Light: 'So light!' Dark: 'So dark!'" src="https://github.com/OneFolderApp/OneFolder/assets/27826950/b6291e54-daf9-42c1-8649-ec14532d79c7">
</picture>

> **This is a personal fork of [OneFolderApp/OneFolder](https://github.com/OneFolderApp/OneFolder)**, modified by Ray Dollete starting 2026-04-04 and distributed under the same [GPL-3.0](LICENSE) license. It is not affiliated with or endorsed by the upstream project. The deviations from upstream are documented in [docs/personal-fork-notes.md](docs/personal-fork-notes.md). The website, roadmap, and contributor form below belong to upstream. Bundled third-party binaries carry their own notices (see [resources/THIRD_PARTY.md](resources/THIRD_PARTY.md)).

- Upstream website: https://onefolder.app/
- Upstream roadmap: https://onefolder.canny.io/feedback

## What is it?

Desktop app to view your photos like you do in Google Photos or Apple Photos (e.g. Calendar, list, map, etc..) but locally and respecting metadata open standards (not creating a separate database to store that information\*).

Sorting your files this way ensures you always own them, and can store them wathever you want: any cloud provider, a USB Drive or just your computer. They are just files!

![of-screenshot](https://github.com/OneFolderApp/OneFolder/assets/27826950/8a720625-18ce-4bf2-8ad5-c70896af514e)
![Screenshot 2024-01-25 at 08 33-PhotoRoom](https://github.com/OneFolderApp/OneFolder/assets/27826950/fc735aff-1941-4120-b5e6-b52894e2308a)

## The OneFolder Manifesto

_Your files, your folder, forever._

1. **File-Over-App**  
   Your pictures live as ordinary image files—no proprietary library, no lock-in.

2. **One Source of Truth**  
   Every photo you care about sits in a single folder you control. Back it up or sync it anywhere; the structure stays intact.

3. **Open Standards First**  
   We read and write well-known metadata (EXIF / XMP) instead of inventing new formats. Any modern viewer can understand your photos today—and in 20 years.

4. **No Silent Overwrites**  
   Edits never overwrite originals without your say-so. Your folder remains a reliable archive, not a guessing game.

5. **Future-Proof Freedom**  
   Because the rules live in the files, you can switch tools, change clouds, or hand the folder to your grand-kids—and everything still works.

## Features

- Watch folders (it does not copy them in a separate place, it watches and updates the folder in question)
- List and Grid View
- Edit metadata

Comming soon:

- Map View
- Calendar View
- Detect duplicates
- HEIC

## Do you want to help?

There is many ways people can help:

- Test new features
- feedback and suggestion on design
- Copy Writting and bloggin
- Detect new communities for growth
- Coding

If you are interested in helping upstream OneFolder, here is their form so they can reach out:
https://forms.gle/TpU1NxBQSreadki18

## Documentation

### Stack

This project is a fork from [Allusion](https://github.com/allusion-app/Allusion).

- [ElectronJS](https://www.electronjs.org/) - the framework for desktop development
- [ReactJS](https://react.dev/) - Front-end library
- [MobX](https://mobx.js.org/README.html) - State Manadgment
- [ExifTool](https://exiftool.org/) - Edit image metadata
- [Annotorious](https://annotorious.github.io/) - Face selection on images
- [TenserFlowJS](https://www.tensorflow.org/js) - Face detection

### Quick Start

You need to have [NodeJS](https://nodejs.org/en/download/) and a package manager such as [Yarn](https://yarnpkg.com/lang/en/docs/install/) installed.
Then run the following commands to get started:

1. Run `yarn install` to install or update all necessary dependencies.
2. Run `yarn dev` to build the project files to the `/build` directory. This will keep running to immediately build changed files when they are updated.
3. In a second terminal, run `yarn start` to start the application. Refresh the window (Ctrl/Cmd + R) after modifying a file to load the updated build files.

### Portable builds

This fork exists specifically for **portable builds**. It produces exactly two artifacts — one Windows portable `.exe` and one Linux `.AppImage` — and each keeps all of its state (libraries, preferences, thumbnails, backups) in a sibling `data/` directory beside the file. There are no installers, no auto-update, and no code signing. Packaging uses [electron-builder](https://www.electron.build/), configured by the `build` section of `package.json`. Build each artifact on its own OS: native modules (`better-sqlite3`, `sharp`, `@img/*`) are compiled for the build host.

Both builds need Node.js ≥ 22.12 and Yarn 1.22.

#### Windows (portable .exe)

Build on a Windows x64 host:

1. `yarn install`
2. `yarn build`
3. `yarn package:portable` → `dist/OneFolder-<version>-x64.exe` (the only artifact; no installer)

**Set up a portable directory:** copy `OneFolder-<version>-x64.exe` into any writable folder and run it. A `data/` directory is created beside it on first launch. To move the app, close it and move the `.exe` **and** `data/` together. Windows Task Manager shows the running process as `OneFolder.exe`.

**Upgrade an existing portable directory** (including one from an older build that shipped as `brave.exe`):

1. Close the app.
2. Delete the previous `.exe` from the directory.
3. Drop the new `OneFolder-<version>-x64.exe` in its place.
4. Keep `data/` — the new build opens the same libraries, preferences, and thumbnails.

#### Linux (AppImage)

The Linux target is a single **AppImage** (x86_64 only). Build and verify it on a Linux x86_64 host:

1. `yarn install`
2. Fetch the Linux `ffmpeg`/`ffprobe`. They are **not tracked in git** (each is well over GitHub's 100 MB file limit). Download the BtbN archive named in [`resources/THIRD_PARTY.md`](resources/THIRD_PARTY.md), place its `bin/ffmpeg` and `bin/ffprobe` in `resources/ffmpeg/linux/` with mode 0755, and compare their checksums with that record:

   ```bash
   curl -LO https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz
   tar -xJf ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz -C resources/ffmpeg/linux \
     --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'
   chmod 0755 resources/ffmpeg/linux/ffmpeg resources/ffmpeg/linux/ffprobe
   sha256sum resources/ffmpeg/linux/ffmpeg resources/ffmpeg/linux/ffprobe
   ```

   The `latest` URL is a moving target. If the checksums differ, BtbN has published a newer build: update the version, sizes, and SHA-256 values in `resources/THIRD_PARTY.md` to match what you are shipping.
3. `yarn package:appimage` → `dist/OneFolder-<version>-x86_64.AppImage` (exactly one artifact)
4. `yarn verify:appimage` — inspect the extracted payload before shipping

`yarn verify:appimage` checks the extracted payload: exact-case resources, executable bits, ELF architecture, desktop metadata, icons, native modules, absence of Windows PE binaries, and an `ffmpeg h264_nvenc` smoke test.

**The portable unit is the `.AppImage` file PLUS a sibling `data/` directory** created beside it on first launch (it holds userData, `backups/`, `thumbnails/`, `themes/`, and the app temp). This mirrors the Windows portable `OneFolder-<version>-x64.exe` + `data/` model. To relocate the app, move the `.AppImage` **and** its sibling `data/` together, and do so **only while the app is CLOSED** — SQLite (`better-sqlite3`) holds file locks and helper (ExifTool / ffmpeg) processes must be released first. Close the app, move both, then reopen.

The AppImage plus `data/` must live in a location that is both **writable and executable**. If launched from a read-only or `noexec` path (a still-mounted image, `/tmp` mounted `noexec`, a read-only volume), startup **fails loud** with a concrete error naming the directory — there is **no** fallback to the system user-data directory, by design, so state always stays beside the artifact.

**Dual-boot: one shared library across Windows and Linux.** Put both portable executables (`OneFolder-<version>-x64.exe` and the `.AppImage`) and **one shared `data/`** in the same portable directory, with your photos in a subfolder beside them. The same library then opens from either OS with **no per-boot Location Recovery and no thumbnail/preview/visual-hash re-derivation** — file identity is the portable `(locationId, relativePath)` pair (not the per-OS absolute path), location roots inside the portable directory are anchored and resolved per-OS at load, and existing caches are renamed (not rebuilt) to the portable key on first upgrade (the DB is backed up first). One OS at a time (SQLite single-writer lock). Keep the shared tree's case-sensitivity consistent between boots — on a case-sensitive share, `A.jpg`/`a.jpg` stay distinct even when opened from Windows. See [docs/multi-library.md → Dual-boot shared library](docs/multi-library.md#dual-boot-shared-library-one-library-two-oses).

Running an AppImage requires **no installation**. Optional user-level desktop integration (copying/generating a `.desktop` entry, or tools like Gear Lever / AppImageLauncher) is a convenience, not a prerequisite — the build already sets the app identity (`onefolder.desktop`, `Name=OneFolder`, `StartupWMClass=OneFolder`, `Icon=onefolder`), so GNOME under native Wayland associates the correct name, icon, and window class. Do **not** force XWayland; Electron selects Ozone/Wayland automatically (`ozone-platform-hint=auto`). XWayland is only a diagnostic fallback if a specific compositor issue appears.

**Host prerequisites:**

- **Perl** — ExifTool ships as the Perl script `exiftool.pl` and needs `/usr/bin/perl` on the host. The Ubuntu/GNOME baseline includes it; install the `perl` package if it is missing. A missing Perl surfaces as a concrete startup/feature error, never a silent fallback. (Provenance and the exact missing-Perl error text are recorded in [`resources/THIRD_PARTY.md`](resources/THIRD_PARTY.md).)
- **NVIDIA / NVENC** — media jobs use the bundled ffmpeg's `h264_nvenc` encoder, which requires compatible NVIDIA hardware and drivers. There is **no software-encoder fallback**; it stays fail-loud on unsupported hosts. Linux encoding is not universal.

The bundled Linux `ffmpeg`/`ffprobe` are GPLv3 static builds (BtbN); their provenance, SHA-256, license/redistribution obligations, and build flags are recorded in [`resources/THIRD_PARTY.md`](resources/THIRD_PARTY.md).

Library file **paths are case-sensitive on Linux** — `Clip.mp4` and `clip.mp4` are distinct files (Windows stays case-insensitive). Windows drive-letter library paths (e.g. `X:\...`) are **not** auto-migrated to Linux mount paths; cross-OS library migration is out of scope.

The Linux build **does not** provide Flatpak/Snap/`.deb`/`.rpm` packages, ARM64 or musl/Alpine binaries, a bundled Perl runtime, a software-encoding fallback, automatic updates, or code signing.

### Build Options

OneFolder builds from a single codebase to two different targets, selected at build time by a webpack "platform seam" (`src/frontend/platform`). The MobX store/component tree is identical in both; only the platform implementation and the backend differ.

| Target | What it is | Build command(s) |
| --- | --- | --- |
| **Desktop (Electron)** | The full read/write app. `nodeIntegration` renderer talks to SQLite, the filesystem, and exiftool directly. | `yarn package` / `yarn package:portable` (Windows) · `yarn package:appimage` (Linux) |
| **Headless (web sidecar)** | A **read-only**, single-user web server that serves a browser SPA so you can browse one library from another device. It is a **mode of the same executable**, not a separate binary. | `yarn package:portable`, then `OneFolder-<version>-x64.exe --serve` (Windows) · `yarn package:appimage`, then `./OneFolder-<version>-x86_64.AppImage --serve` (Linux) |

The headless mode is **additive** — it does not affect the desktop app. It is read-only by design (no edits, tagging writeback, deletes, or media jobs). See [`docs/headless-web-build.md`](docs/headless-web-build.md) for the full architecture (seam, endpoints, packaging, security boundary).

### Running Headless

Serve mode opens the active library's SQLite database **read-only**, serves the SPA, and streams images/metadata over HTTP. It serves on **port `8666`** by default and binds every network interface, so other devices on your network can reach it.

**From the portable build (Windows):**

```bat
OneFolder-<version>-x64.exe --serve                 :: open, no authentication
OneFolder-<version>-x64.exe --serve --port 9000     :: custom port

set ONEFOLDER_AUTH_SECRET=changeme && OneFolder-<version>-x64.exe --serve
```

**From the AppImage (Linux):**

```bash
./OneFolder-<version>-x86_64.AppImage --serve               # open, no authentication
./OneFolder-<version>-x86_64.AppImage --serve --port 9000   # custom port

ONEFOLDER_AUTH_SECRET=changeme ./OneFolder-<version>-x86_64.AppImage --serve
```

Set `ONEFOLDER_AUTH_SECRET` (or `ONEFOLDER_AUTH_USER` + `ONEFOLDER_AUTH_PASSWORD`) before launching to require HTTP Basic authentication. Leave them unset and the server runs open — its startup banner says so, and lists every URL it is reachable on. On Linux use POSIX shell syntax (`VAR=value ./OneFolder...AppImage --serve`), **not** Windows `set VAR=`.

**From source (development):**

```bash
yarn dev                                   # build main + renderer bundles (watch)
yarn build:web                             # build the browser SPA into dist-web/
electron ./build/main.bundle.js --serve     # run serve mode from source
```

The startup banner is written to stdout **and** to `data/server.log` (`data\server.log` on Windows); on Windows the log file is the reliable record, because a GUI-subsystem binary's stdout does not consistently attach to the console that launched it. On Linux the AppImage writes the same `data/server.log` beside the artifact.

Then open the URL from the banner on any device on the network.

**Configuration (environment variables):**

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8666` | HTTP/HTTPS listening port (`--port` overrides it) |
| `ONEFOLDER_AUTH_SECRET` | — | Shared secret used as both basic-auth username and password. **Optional** — unset means no authentication |
| `ONEFOLDER_AUTH_USER` / `ONEFOLDER_AUTH_PASSWORD` | — | Explicit basic-auth credentials (take precedence over `ONEFOLDER_AUTH_SECRET`) |
| `ONEFOLDER_TLS` | `0` | Set to `1` to serve HTTPS instead of HTTP |
| `ONEFOLDER_TLS_CERT` / `ONEFOLDER_TLS_KEY` | — | Paths to the PEM cert/key when `ONEFOLDER_TLS=1` |

Empty or whitespace-only credential values count as unset.

Authentication is optional by design: the intended deployment is browsing your own library from your own phone on your own wifi, where a password is friction rather than protection. With no credential configured the server serves every request — so it prints exactly what it is exposing at startup:

```
[server] OneFolder serve mode — listening on port 8666
[server]   http://127.0.0.1:8666
[server]   http://192.168.1.42:8666   (reachable from your network)
[server] Authentication: DISABLED — no credential configured
```

The library is read-only over HTTP and only paths resolved from the library's registered locations are served (a path-traversal guard rejects anything outside), so the exposure is disclosure of your photos, not modification of them. On an untrusted network, set a credential or put it behind TLS / a reverse proxy / Tailscale.

### Migrating from pre-SQLite backups

Starting with the SQLite data layer (introduced with INV-002), backup files are produced as SQLite `.db` files. Older OneFolder versions produced `.json` backups via `dexie-export-import`. The in-app restore flow only accepts `.db` files, so a legacy `.json` backup must be converted first.

A one-off converter script is included:

```bash
yarn convert-backup <input.json> [output.db]
```

- If `[output.db]` is omitted, the `.db` is written next to the input with the same base name.
- The script runs under Electron (not plain Node) so it can load `better-sqlite3`, which is rebuilt for Electron's ABI.
- The generated `.db` uses the current v1 schema (including the FTS5 full-text index) so it can be consumed directly by **Settings → Import/Export → Restore Backup** inside the app.
- The source JSON is never modified.

The conversion is defensive about older Dexie schema versions — missing fields (`ino`, `dateLastIndexed`, `annotations`, tag `color`, etc.) are populated with sensible defaults, matching the behavior of the in-app IndexedDB → SQLite migration.

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=OneFolderApp/OneFolder&type=Date)](https://star-history.com/#OneFolderApp/OneFolder&Date)

### Releasing

When you want to create a new release, follow these steps:

1. Update the version in your project's `package.json` file (e.g. `1.2.3`)
2. Add `git add .`
3. Commit that change (`git commit -am v1.2.3`)
4. Tag your commit (`git tag v1.2.3`). Make sure your tag name's format is `v*.*.*`. Your workflow will use this tag to detect when to create a release
5. Push your changes to GitHub (`git push && git push --tags`)

note: the release name of the release has to start with the version number and a hyphen (e.g. `1.0.19 - ...`) if not the auto downloader won't pick it up

After building successfully, the action will publish your release artifacts. By default, a new release draft will be created on GitHub with download links for your app. If you want to change this behavior, have a look at the [`electron-builder` docs](https://www.electron.build).
