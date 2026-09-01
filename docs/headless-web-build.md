---
title: Headless / Sidecar Web Build
author: @system
last_updated: 2026-06-22
scope: feature
aliases: ["headless", "sidecar", "web-build", "remote-browse", "INV-034"]
---

# Headless / Sidecar Web Build

OneFolder can run headless — without an Electron window — as a local HTTP server that serves the same gallery UI to a web browser on another device. The library remains read-only from the browser: browse, search, filter, view tags, and inspect metadata, but no writes, deletes, or media jobs.

Headless is a **mode of the portable executable**, not a separate binary:

```bash
brave.exe --serve              # serve instead of opening the GUI
brave.exe --serve --port 9000  # custom port
```

See [INV-034](TODO/backlog/investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) for the original root-cause analysis (TASK-126 through TASK-137), and the OpenSpec change `add-portable-serve-mode` for the move into the portable executable and the optional-authentication contract.

## Overview

- **Single codebase, build-time seam.** A webpack alias selects one of two platform implementations at bundle time. The Electron build gets the pass-through; the web build gets HTTP-backed stubs. No code is forked.
- **One server, one host.** The server is a library (`startServer(opts)`) that derives nothing about its environment. The Electron main process resolves userData, the database, the thumbnail cache, exiftool and the SPA directory once, and passes them in. There is no second implementation to keep at parity.
- **`DataStorage` reuse.** The entire MobX store and component tree talks to the `DataStorage` interface. `HttpBackend` is a second implementation that `fetch()`es the sidecar's REST API. Stores and components are unchanged.
- **Read-only everywhere.** The server opens SQLite strictly `readonly: true`. Every write method in `HttpBackend` and the web platform seam throws immediately with a loud error message so broken call sites surface at development time rather than silently no-oping.
- **Desktop app unchanged.** The Electron seam is a literal, zero-logic delegation to the same APIs that existed before the seam was introduced. No desktop behaviour changes.

## The Platform Seam

### Problem

Before INV-034, the renderer imported `fs-extra`, `path`, `electron`, `RendererMessenger`, and `ExifIO` directly in ~26 frontend files. A browser bundle cannot compile or run any of these.

### Solution

`src/frontend/platform/` introduces a thin abstraction with two build-time implementations selected by a webpack alias:

| File | Selected by | Role |
|------|-------------|------|
| `src/frontend/platform/index.ts` | (interface only) | Defines `Platform`, `PlatformFs`, `PlatformPath`, `PlatformDesktop`, `PlatformExifHandle` |
| `src/frontend/platform/platform.electron.ts` | Electron builds | Faithful pass-through to `fse`, `nodePath`, `shell`, `RendererMessenger`, `ExifIO` |
| `src/frontend/platform/platform.web.ts` | Web SPA build | HTTP-backed reads, browser-safe path helpers, loud rejects for writes, ExifIO HTTP shim |

Callers import from the alias `src/frontend/platform` (or the directory path). The webpack alias in `webpack.dev.js` / `webpack.prod.js` resolves this to `platform.electron.ts`; `webpack.web.js` resolves it to `platform.web.ts`.

### Seam Surface (`Platform` interface)

```
Platform
  .fs              PlatformFs    — readFile, pathExists, stat, readdir, ensureDir, move, writeFile, …
  .path            PlatformPath  — basename, extname, join, dirname, normalize, sep
  .encodeFilePath  (path: string) => string
                   Electron: file:// URL via common/fs.ts
                   Web: /api/thumb/:id (UUID input) or /api/original/:id (via encodeOriginalPath)
  .encodePreviewPath (fileId: string) => string
                   Electron: same as encodeFilePath (renderer decodes locally)
                   Web: /api/preview/:id (sidecar decodes non-web formats server-side)
  .isWebBuild      boolean — false in Electron, true in the web build
  .desktop         PlatformDesktop — window chrome, shell, RendererMessenger, library/media ops
                   All web stubs either no-op or throw; write-path ops throw loudly
  .exif            PlatformExifHandle — getExifIO(hierarchicalSeparator?) => ExifIO
                   Electron: constructs a real ExifIO (native exiftool child process)
                   Web: returns an HTTP shim whose read methods call /api/metadata/by-path/*
```

### Invariant

**Frontend code MUST import platform capabilities from `src/frontend/platform`, never directly from `fs-extra`, `electron`, `path` (Node), or `common/ExifIO`.** Violating this invariant causes the web bundle to fail at compile time with a hard error naming the offending import.

## `HttpBackend` — the Web DataStorage

`src/backend/http-backend.ts` implements `DataStorage` entirely over `fetch()`. It is constructed in `src/renderer.tsx` when `IS_WEB_BUILD` is true (set by `DefinePlugin` in `webpack.web.js`), replacing `SQLiteBackend`. The entire store and component tree above it is unchanged.

### Authentication

`HttpBackend` attaches an `Authorization: Basic <base64>` header on every request. Both `user` and `password` are derived from the same env vars the server reads at startup (see Security section below).

For `<img src>` attributes (which cannot carry custom headers), the browser uses the session cookie issued by `POST /api/auth/login` instead.

### REST Contract

All endpoints are under `/api`. Date fields are ISO 8601 strings on the wire; `HttpBackend` deserializes them back to `Date` objects.

| Method | Path | Body / Query | Response |
|--------|------|-------------|----------|
| GET | `/api/tags` | — | `{ tags: TagWire[] }` |
| GET | `/api/files` | `?order=<key\|random\|tagCountRandom>&direction=<asc\|desc>` | `{ files: FileWire[] }` |
| GET | `/api/files/count` | — | `{ fileCount, untaggedFileCount }` |
| POST | `/api/files/by-ids` | `{ ids: string[] }` | `{ files: FileWire[] }` |
| POST | `/api/files/by-key` | `{ key, value }` | `{ files: FileWire[] }` |
| POST | `/api/files/search` | `{ criteria, order, direction, matchAny }` | `{ files: FileWire[] }` |
| GET | `/api/locations` | — | `{ locations: LocationWire[] }` |
| GET | `/api/searches` | — | `{ searches: FileSearchDTO[] }` |
| GET | `/api/dismissed-duplicate-groups` | — | `{ groups: DismissedDuplicateGroupWire[] }` |
| POST | `/api/visual-hashes/by-paths` | `{ absolutePaths: string[] }` | `{ hashes: VisualHashWire[] }` |

## Image Endpoints

All image endpoints are ID-based. The client **never** supplies a filesystem path.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/original/:id` | Streams a web-format original (jpg/png/webp/gif/bmp). Non-web formats return HTTP 415 with a hint to use `/api/preview/:id`. |
| GET | `/api/thumb/:id` | Returns a cached thumbnail (webp, max 600 px). Generates via Sharp on first request. Non-web formats are decoded first via `decode.ts` then resized. Cached on disk. |
| GET | `/api/preview/:id` | Full-size server-decoded preview for non-web formats (HEIC/HEIF/TIFF/PSD/EXR → webp). Cached on disk alongside thumbnails. Web formats are served directly. |

All three endpoints send:
- `Content-Type: image/<format>`
- `Cross-Origin-Resource-Policy: same-origin` (required under COEP for `<img>` to load)
- `Cache-Control` (thumbnails/previews: `public, max-age=86400, immutable`; originals: `public, max-age=3600`)

### Server-Side Decoders (`src/server/decode.ts`)

No `document`, `OffscreenCanvas`, `createImageBitmap`, or `toBlob` — runs in plain Node.

| Format | Decoder |
|--------|---------|
| HEIC / HEIF / TIFF / TIF | Sharp (libvips native) |
| PSD / PSB | Sharp first; ag-psd fallback with a Node-safe `createImageData` shim (returns a plain `{ data, width, height }` object instead of a DOM canvas) |
| EXR | WASM decoder (`wasm/packages/exr/exr_decoder_bg.wasm`) loaded via `WebAssembly.instantiate` with a custom `wbg` import that captures the raw pixel buffer without constructing a DOM `ImageData`; Reinhard tone-map fallback if float32 data is returned |

## Metadata Endpoints

All metadata routes require that the requested file exists in the `files` DB table and is inside a registered library location. There are no write endpoints — `ExifIO` write methods are never reachable via HTTP.

### ID-based routes

| Method | Path | Response |
|--------|------|----------|
| GET | `/api/metadata/:id/dimensions` | `{ width, height }` |
| GET | `/api/metadata/:id/dimensions-and-tags` | `{ dimensions: { width, height }, tags: string[][] }` |
| GET | `/api/metadata/:id/tags` | `{ tags: string[][] }` |
| GET | `/api/metadata/:id/faces` | `{ regionInfo: MWGRegionInfo \| null }` |
| POST | `/api/metadata/:id/exif-tags` | body `{ tags: string[] }` → `{ values: (string\|undefined)[] }` |
| GET | `/api/metadata/:id/all-exif` | `{ exif: Record<string, unknown> }` |
| GET | `/api/metadata/:id/description` | `{ description: string \| null }` |

### Path-based routes (used by the web ExifIO shim)

Same sub-paths but prefixed with `/api/metadata/by-path/` and accepting `?absolutePath=<urlencoded>` instead of `:id`. Used by `platform.web.ts`'s `createWebExifIOShim` because the SPA has `absolutePath` strings from the files API, not always the file UUID.

Example: `GET /api/metadata/by-path/dimensions?absolutePath=%2Fphotos%2Fimg001.jpg`

## Rescan Endpoint

`POST /api/rescan` — re-queries the read-only SQLite DB and returns current file/location counts. Used in place of the chokidar file watcher (which is Node-only and dropped for the web build). The web client calls this to detect whether a store refresh is worthwhile.

Response: `{ ok: true, fileCount, locationCount, scannedAt: <ISO 8601> }`

## Auth Endpoints

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/auth/login` | Body `{ user, password }` or `Authorization: Basic` header. On success, sets an `HttpOnly` signed session cookie (`of_auth`). |
| DELETE | `/api/auth/login` | Clears the session cookie. |

## Security Boundary

### Authentication is optional

**If no credential is configured, there is no authentication gate** — every request is served, and `POST /api/auth/login` is a successful no-op. This is deliberate: the intended deployment is browsing your own library from your own phone on your own wifi.

An empty or whitespace-only environment variable counts as *not configured*. (Treating `''` as a credential would have accepted `Authorization: Basic Og==` — base64 of `":"` — while the startup banner claimed authentication was enabled.)

When a credential **is** configured, all routes except `POST /api/auth/login` require it, via two delivery paths:

1. **`Authorization: Basic <base64(user:password)>`** — used by `HttpBackend` for all `fetch()` calls.
2. **Signed session cookie `of_auth`** — issued by `POST /api/auth/login`. Allows `<img src>` tags and browser navigation to carry auth without custom headers. The cookie is `HttpOnly; SameSite=Strict; Secure` (when TLS is active).

The cookie value is an HMAC-SHA256 token derived from the credentials; comparison uses `timingSafeEqual` to prevent timing attacks.

### Exposure is disclosed, not restricted

The listener binds **every network interface** so other devices can reach it. Because that combines with optional authentication, the server states what it resolved at startup — to the log file and to stdout:

```
[server] OneFolder serve mode — listening on port 8666
[server]   http://127.0.0.1:8666
[server]   http://192.168.1.42:8666   (reachable from your network)
[server] Authentication: DISABLED — no credential configured
[server] Library: My Library
[server] Log file: D:\OneFolder\data\server.log
```

The credential value is never logged; only the resolved user name, and only when authentication is enabled.

### Location-Scoped Path Resolver (`src/server/path-resolver.ts`)

The server **never accepts a raw filesystem path from the client.** Every image and metadata endpoint is ID-based. The path resolver:

1. Looks up `absolutePath` from the `files` table using the UUID.
2. Loads all `locations` from the DB.
3. Asserts the resolved path is a descendant of at least one location root (case-insensitive on Windows via `path.resolve` + lower-case normalisation).
4. Returns HTTP 404 if the ID is unknown; HTTP 403 if the path is outside all locations.

The metadata by-path routes (`/api/metadata/by-path/*`) accept `absolutePath` but validate it the same way from the other direction: confirm the path exists in the `files` table, then assert location containment.

### COOP / COEP / CORP

Every response (including 401 errors) carries:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
```

This is required so the masonry layout module can use `SharedArrayBuffer`. The image endpoints additionally set CORP explicitly as belt-and-suspenders.

### TLS

| Env var | Effect |
|---------|--------|
| `ONEFOLDER_TLS=1` | Enable HTTPS listener. |
| `ONEFOLDER_TLS_CERT=<path>` | Operator-provided PEM certificate. |
| `ONEFOLDER_TLS_KEY=<path>` | Matching PEM private key. |

When `ONEFOLDER_TLS=1` but no cert/key paths are provided, the server auto-generates a 10-year self-signed certificate via `openssl req` and caches it in the userData directory for reuse across restarts. For a trusted cert use a reverse proxy (nginx / Caddy / Tailscale) with TLS termination and leave `ONEFOLDER_TLS` unset.

## The Sidecar Server (`src/server/`)

`src/server/index.ts` exports `startServer(opts)`. It is a **library, not a script**: it derives nothing about its environment, never reads `process.argv` or `process.env`, and never calls `process.exit()` — the process it runs in may be the desktop application. Startup failures reject the returned promise.

`src/serve-mode.ts` is the only glue between Electron and that library. `src/main.ts` parses `--serve` at module scope (before the single-instance lock, which also runs at module scope) and calls it.

### Startup sequence

1. `src/main.ts` resolves portable mode and remaps `userData`/`temp` — this already happens for the GUI, before any flag is read.
2. `parseServeArgs(process.argv)` detects `--serve` and `--port`.
3. Serve mode **skips** the single-instance lock, window creation, and ffmpeg temp staging. The lock is keyed on the `userData` directory the GUI and the server share, so taking it would make them mutually exclusive; a second server is stopped by `EADDRINUSE` instead.
4. `startServeMode()` opens the log file, validates the port, looks up the active library, and resolves the database, thumbnail directory, exiftool path and SPA directory from what Electron already knew.
5. `resolveCredential(env)` — absent, empty or whitespace-only means no authentication.
6. `resolveTlsMaterial(userData, env)` — only when `ONEFOLDER_TLS` is set.
7. `startServer(opts)` opens the database **read-only**, constructs `SQLiteBackend` with a no-op `notifyChange`, initializes a shared `ExifIO` (one persistent exiftool child process), and builds the Express app: COOP/COEP/CORP middleware → auth middleware → login router → SPA static files → API routers → SPA fallback.
8. The listener binds all interfaces on the resolved port; `EADDRINUSE` becomes an operator-facing message rather than a stack trace.
9. The startup banner is written to the log file and stdout.
10. `SIGINT`/`SIGTERM` close the listener, exiftool and the database.

**No `journal_mode` pragma is issued.** WAL is a property of the database *file* that readers detect automatically, and a read-only connection cannot change it — the previous `db.pragma('journal_mode = WAL')` either no-oped or threw `SQLITE_READONLY`.

### Logging

Serve mode writes to `{userData}\server.log` as well as stdout, and the **file is the record**. The portable executable is a Windows GUI-subsystem binary, so its stdout does not reliably attach to the console that launched it: in testing, probe output vanished entirely on some runs and on others arrived late, interleaved with a later command's output.

### Express middleware stack (in order)

```
coopCoepMiddleware          — COOP/COEP/CORP on every response (incl. 401s)
makeAuthMiddleware(cred)    — auth gate; skips POST /api/auth/login
makeLoginRouter             — POST/DELETE /api/auth/login
express.static(dist-web/)  — SPA assets (if dist-web/ exists)
makeDataRouter              — /api/tags, /api/files, /api/locations, …
makeImagesRouter            — /api/original/:id, /api/thumb/:id, /api/preview/:id
makeMetadataRouter          — /api/metadata/:id/*, /api/metadata/by-path/*
makeRescanRouter            — POST /api/rescan
GET *                       — SPA fallback (serves index.html)
```

## Build Targets

### Web SPA (`webpack.web.js`)

Target: `['web', 'es2022']`. Output: `dist-web/`.

Key differences from the Electron renderer config:

- `resolve.alias['src/frontend/platform']` → `platform.web.ts`
- `DefinePlugin`: `IS_WEB_BUILD=true`, `process.platform='web'`
- `NormalModuleReplacementPlugin` redirects `fs-extra`, `path`, `common/library-registry`, `src/ipc/renderer`, all SQLite backend modules, `renderer-migration`, `common/ExifIO`, and `workers/folderWatcher.worker` to `empty-stub.ts`
- `folderWatcher.worker` additionally replaced with `folderWatcher.worker.stub.ts`
- `resolve.fallback`: all Node built-ins set to `false` (hard error if any escape the stubs)
- No `externals` — the browser bundle must be self-contained

### Electron main bundle (`webpack.prod.js` / `webpack.dev.js`)

The server now lives inside the Electron main bundle, so its native dependency is externalised there too:

- `externals`: `better-sqlite3`, `sharp`, `fsevents` are kept as `require()` calls (native modules cannot be inlined)
- `asarUnpack`: `better-sqlite3`, `sharp` and `@img/*` — the native binaries must exist on disk, not inside the archive
- `extraResources`: `dist-web` (the SPA) and `wasm/packages/exr` (the EXR decoder), both beside the asar so `express.static` does not read image bytes through it

There is no separate Node server bundle. `webpack.server.js`, `scripts/package-headless.js` and the `build:server` / `dev:server` / `package:headless` scripts were removed when serve mode moved into the portable executable — one implementation in one host means parity is structural rather than something QA re-verifies each release.

### Development Commands

```bash
yarn dev:web            # webpack --watch, web SPA in development mode (output: dist-web/)
yarn build:web          # one-shot production web SPA build (also run by `yarn build`)
```

The Electron development commands (`yarn dev`, `yarn start`) are unchanged. To run serve mode from source:

```bash
yarn dev                                  # build main + renderer bundles
yarn build:web                            # build the SPA into dist-web/
electron ./build/main.bundle.js --serve
```

## Packaging

Serve mode ships inside the normal portable build — `yarn build && yarn package:portable`. There is no separate packaging step, no SEA binary, and no hand-copied native-module tree.

`yarn build` runs `yarn build:web`, so packaging cannot silently ship without the SPA.

### Packaged layout (the parts serve mode uses)

```
<portable dir>/
  brave.exe
  data/                             ← userData: libraries, thumbnails, server.log
  resources/
    app.asar                        ← main + renderer bundles
    app.asar.unpacked/
      node_modules/
        better-sqlite3/…            ← native .node
        sharp/… , @img/…            ← native .node + libvips DLLs
    dist-web/                       ← SPA assets (extraResources)
    wasm/packages/exr/              ← EXR decoder wasm (extraResources)
    resources/exiftool/             ← exiftool binary (extraResources)
```

Paths are resolved from Electron (`app.getPath('userData')`, `process.resourcesPath`), never from `process.execPath`: on the Windows portable target that points at the NSIS temp extraction directory, which is wiped on exit.

### Running serve mode

```bash
# Simplest — no credential, open on the local network:
brave.exe --serve

# One shared secret used as both user and password:
set ONEFOLDER_AUTH_SECRET=changeme && brave.exe --serve

# Explicit user + password:
set ONEFOLDER_AUTH_USER=alice && set ONEFOLDER_AUTH_PASSWORD=secret && brave.exe --serve

# With HTTPS (auto-generates a self-signed cert on first run):
set ONEFOLDER_TLS=1 && brave.exe --serve

# Custom port:
brave.exe --serve --port 8080
```

Serve mode coexists with a running desktop instance: it does not take the single-instance lock (which is keyed on the shared `userData` directory), and the database is opened read-only. A second serve process on the same port exits with a port-in-use message.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8666` | HTTP/HTTPS listening port. `--port <n>` takes precedence. Must be a whole number in 1-65535 — anything else is a startup error, not a coerced value |
| `ONEFOLDER_AUTH_SECRET` | (none) | Shared secret used as both username and password for HTTP Basic auth |
| `ONEFOLDER_AUTH_USER` | (none) | Explicit username (takes precedence over `AUTH_SECRET`) |
| `ONEFOLDER_AUTH_PASSWORD` | (none) | Explicit password (used with `AUTH_USER`) |
| `ONEFOLDER_TLS` | (off) | Set to `1` or `true` to enable HTTPS |
| `ONEFOLDER_TLS_CERT` | (auto) | Path to PEM certificate file |
| `ONEFOLDER_TLS_KEY` | (auto) | Path to matching PEM private key |
| `PORTABLE_EXECUTABLE_DIR` | (derived) | Override the userData base directory (set automatically by electron-builder portable target) |

Credential variables are optional, and empty or whitespace-only values count as unset. With none configured the server runs **without** an authentication gate and says so in its startup banner.

### Operator-facing failures

Each is written to `server.log` and stdout, then the process exits non-zero:

```
[server] Port 8666 is already in use. Another OneFolder server may already be running. Use --port <n> to choose a different port.
[server] No library found in <path>. Launch OneFolder normally at least once to create a library.
[server] Database not found at <path>.
[server] The library is registered but its database has not been created yet. Launch OneFolder normally once, then try --serve again.
[server] --port requires a whole number between 1 and 65535 (got '<value>').
```

The database hint matters on a **fresh portable install**: first launch registers a default library, but the SQLite file is created by the renderer on its first GUI run. Until the desktop app has been opened once, there is nothing for serve mode to read.

## Key Files

| File | Role |
|------|------|
| `src/frontend/platform/index.ts` | Platform interface definitions (`Platform`, `PlatformFs`, `PlatformPath`, `PlatformDesktop`, `PlatformExifHandle`) |
| `src/frontend/platform/platform.electron.ts` | Electron seam implementation — faithful pass-through |
| `src/frontend/platform/platform.web.ts` | Web seam implementation — HTTP reads, loud rejects for writes, ExifIO HTTP shim, `triggerRescan()` |
| `src/backend/http-backend.ts` | `HttpBackend implements DataStorage` — all reads over `fetch()`, all writes throw |
| `src/server/index.ts` | `startServer(opts)` — the server as a library: DB open, Express bootstrap, listener, startup banner. Derives nothing, never exits the process |
| `src/serve-mode.ts` | Electron glue — `parseServeArgs`, path resolution from what main.ts already knew, operator-facing failures |
| `src/server/logger.ts` | File + stdout logger for serve mode (`data\server.log`) |
| `src/server/auth.ts` | Auth middleware — optional gate, dual header+cookie, HMAC signing, login/logout router |
| `src/server/path-resolver.ts` | Location-scoped path guard — ID→path lookup with location containment assertion |
| `src/server/thumbnails.ts` | Sharp-based thumbnail generation and preview cache path helpers |
| `src/server/decode.ts` | DOM-less image decoders — Sharp (HEIC/TIFF), ag-psd (PSD), WASM (EXR) |
| `src/server/routes/data.ts` | DataStorage REST routes (`/api/tags`, `/api/files`, `/api/locations`, …) |
| `src/server/routes/images.ts` | Image endpoints (`/api/original/:id`, `/api/thumb/:id`, `/api/preview/:id`) |
| `src/server/routes/metadata.ts` | ExifIO read endpoints (ID-based and by-path) |
| `src/server/routes/rescan.ts` | `POST /api/rescan` — on-demand DB count refresh |
| `webpack.web.js` | Web SPA webpack config — platform alias, Node stubs, `IS_WEB_BUILD=true` |

## Scope and Explicit Rejections

The headless build is **read-only, single-user, single-library, single-session**.

The following are explicitly out of scope:

- Tag/metadata writeback, deletes, recycle, FFmpeg/NVENC media jobs, drag-drop import — web stubs throw loudly if called
- Multi-tenancy, sandboxing, per-user isolation
- Chokidar live file watching — replaced by the on-demand `POST /api/rescan` endpoint
- Raw client-supplied filesystem paths — all image and metadata endpoints are ID-based
- Codebase fork — the desktop Electron app is unchanged when `--serve` is absent
- Starting or stopping the server from the desktop UI — serve mode is a launch flag; `startServer` is a fire-once bootstrap
- A tray icon or any other visible affordance for the running server
