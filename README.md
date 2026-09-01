<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://github.com/OneFolderApp/OneFolder/assets/27826950/e12e0f46-a1a8-484f-a443-b71d4a30d37f">
  <img alt="Text changing depending on mode. Light: 'So light!' Dark: 'So dark!'" src="https://github.com/OneFolderApp/OneFolder/assets/27826950/b6291e54-daf9-42c1-8649-ec14532d79c7">
</picture>

- Website: https://onefolder.app/
- Roadmap: https://onefolder.canny.io/feedback

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

If you are interested here is a form so we can reach out:
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

### Release Build

An installable executable can be built using `yarn package` for your platform in the `/dist` folder. The building is performed using the [electron-builder](https://www.electron.build/) package, and is configured by a section in the `package.json` file.
Builds are automatically published to Github Releases when a tag is created in GitHub.

> This fork ships **portable-only** on Windows. Use `yarn package:portable` to produce the portable `.exe` (`yarn package:appimage` for the Linux AppImage). Nothing about the desktop build changed when the headless build below was added — the two are entirely separate build paths from the same codebase.

### Build Options

OneFolder builds from a single codebase to two different targets, selected at build time by a webpack "platform seam" (`src/frontend/platform`). The MobX store/component tree is identical in both; only the platform implementation and the backend differ.

| Target | What it is | Build command(s) |
| --- | --- | --- |
| **Desktop (Electron)** | The full read/write app. `nodeIntegration` renderer talks to SQLite, the filesystem, and exiftool directly. | `yarn package` / `yarn package:portable` |
| **Headless (web sidecar)** | A **read-only**, single-user web server that serves a browser SPA so you can browse one library from another device. It is a **mode of the same executable**, not a separate binary. | `yarn package:portable`, then `brave.exe --serve` |

The headless mode is **additive** — it does not affect the desktop app. It is read-only by design (no edits, tagging writeback, deletes, or media jobs). See [`docs/headless-web-build.md`](docs/headless-web-build.md) for the full architecture (seam, endpoints, packaging, security boundary).

### Running Headless

Serve mode opens the active library's SQLite database **read-only**, serves the SPA, and streams images/metadata over HTTP. It serves on **port `8666`** by default and binds every network interface, so other devices on your network can reach it.

**From the portable build:**

```bash
brave.exe --serve                 # open, no authentication
brave.exe --serve --port 9000     # custom port
```

Set `ONEFOLDER_AUTH_SECRET` (or `ONEFOLDER_AUTH_USER` + `ONEFOLDER_AUTH_PASSWORD`) before launching to require HTTP Basic authentication. Leave them unset and the server runs open — its startup banner says so, and lists every URL it is reachable on.

**From source (development):**

```bash
yarn dev                                   # build main + renderer bundles (watch)
yarn build:web                             # build the browser SPA into dist-web/
electron ./build/main.bundle.js --serve     # run serve mode from source
```

The startup banner is written to stdout **and** to `data\server.log`; on Windows the log file is the reliable record, because a GUI-subsystem binary's stdout does not consistently attach to the console that launched it.

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
