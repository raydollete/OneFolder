---
title: Headless / Sidecar Web Build
author: @system
last_updated: 2026-06-22
scope: feature
aliases: ["headless", "sidecar", "web-build", "remote-browse", "INV-034"]
---

# Headless / Sidecar Web Build

OneFolder can run headless — without an Electron window — as a local Node HTTP server that serves the same gallery UI to a web browser on another device. The library remains read-only from the browser: browse, search, filter, view tags, and inspect metadata, but no writes, deletes, or media jobs.

See [INV-034](TODO/backlog/investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) for the root-cause analysis and design decisions. The spawned implementation tasks are TASK-126 through TASK-137.

## Overview

- **Single codebase, build-time seam.** A webpack alias selects one of two platform implementations at bundle time. The Electron build gets the pass-through; the web build gets HTTP-backed stubs. No code is forked.
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

### Authentication

All routes (except `POST /api/auth/login`) require a valid credential. Two delivery paths:

1. **`Authorization: Basic <base64(user:password)>`** — used by `HttpBackend` for all `fetch()` calls.
2. **Signed session cookie `of_auth`** — issued by `POST /api/auth/login`. Allows `<img src>` tags and browser navigation to carry auth without custom headers. The cookie is `HttpOnly; SameSite=Strict; Secure` (when TLS is active).

The cookie value is an HMAC-SHA256 token derived from the credentials; comparison uses `timingSafeEqual` to prevent timing attacks.

If no credential is configured at startup, the server rejects every request with HTTP 401 and logs a warning.

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

`src/server/index.ts` is the entry point. It is never imported by the Electron main or renderer bundle — it runs as a standalone Node process.

### Startup sequence

1. Detect SEA vs. dev mode via `node:sea`; derive `exeDir` accordingly.
2. Re-derive `userData` (same logic as the portable Electron build: `PORTABLE_EXECUTABLE_DIR` env var, then portable markers, then OS-standard path).
3. Resolve auth credentials from env vars (`resolveCredential()`). Warn loudly if none are set.
4. Optionally load TLS material.
5. Open the active library's SQLite database **read-only** (`new Database(path, { readonly: true })`).
6. Derive the thumbnail directory for the active library.
7. Construct `SQLiteBackend` with a no-op `notifyChange`.
8. Initialize a shared `ExifIO` instance (single persistent exiftool child process reused for all metadata reads).
9. Build the Express app: COOP/COEP/CORP middleware → auth middleware → login router → SPA static files → API routers → SPA fallback.
10. Start HTTP or HTTPS listener on `PORT` (default: 8666).
11. Register `SIGTERM`/`SIGINT` handlers to close DB + exiftool cleanly.

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

### Node Server (`webpack.server.js`)

Target: `['node', 'es2022']`. Output: `dist-server/server.bundle.js`.

- `node: { __dirname: false }` — preserves real filesystem `__dirname` so the server can locate `dist-web/` at runtime
- `externals`: `better-sqlite3`, `sharp`, `fsevents`, and any `*.node` file are kept as `require()` calls (native modules cannot be inlined)

### Development Commands

```bash
yarn dev:web            # webpack --watch, web SPA in development mode (output: dist-web/)
yarn dev:server         # ts-node src/server/index.ts (runs server from source directly)
yarn build:web          # one-shot production web SPA build
yarn build:server       # one-shot production server bundle build
yarn package:headless   # build both + produce dist-headless/ SEA binary
```

The Electron development commands (`yarn dev`, `yarn start`) are unchanged.

## Packaging — Node SEA (`scripts/package-headless.js`)

Produces a self-contained `dist-headless/` directory using Node SEA (Single Executable Application, Node v20+). No Node installation is required on the target machine.

### Output layout

```
dist-headless/
  onefolder-server[.exe]          ← SEA binary (copy of node binary + injected blob)
  dist-web/                       ← compiled SPA assets
  resources/
    exiftool/
      exiftool[.exe|.pl]
      .Exiftool_config
      lib/                        ← (macOS/Linux: perl lib tree)
  node_modules/
    better-sqlite3/
      build/Release/
        better_sqlite3.node
    @img/
      sharp-<platform>/
        lib/
          sharp-<platform>-<ver>.node
          *.dll                   ← (Windows: libvips + friends)
  portable.txt                    ← packaged-mode marker
```

Native modules (`better-sqlite3`, `sharp`) cannot be inlined into the JS bundle. They ship alongside in a `node_modules/` subtree that mirrors the `require()` paths emitted by the webpack bundle.

### SEA build process

1. Run `yarn build:server` and `yarn build:web`.
2. Write `sea-config.json` pointing at `dist-server/server.bundle.js`.
3. Run `node --experimental-sea-config sea-config.json` to produce a blob.
4. Copy the running `node` binary to `dist-headless/onefolder-server[.exe]`.
5. On Windows: strip the Authenticode signature with `signtool` (required before `postject`).
6. Inject the blob via `npx postject`.
7. Write `portable.txt` so the server detects packaged mode.

### Path re-derivation in SEA mode

Inside a SEA binary, `__dirname` is virtualised to a path inside the injected blob — it does not refer to the directory containing the binary. `src/server/index.ts` detects SEA mode via `require('node:sea').isSea()` and when true resolves all resource paths relative to `path.dirname(process.execPath)` instead. This is the same "re-derive at launch" pattern used by the portable Electron build.

### Running the packaged binary

```bash
cd dist-headless/

# Simplest — one shared secret used as both user and password:
ONEFOLDER_AUTH_SECRET=changeme ./onefolder-server

# Explicit user + password:
ONEFOLDER_AUTH_USER=alice ONEFOLDER_AUTH_PASSWORD=secret ./onefolder-server

# With HTTPS (auto-generates self-signed cert on first run):
ONEFOLDER_AUTH_SECRET=changeme ONEFOLDER_TLS=1 ./onefolder-server

# Custom port:
PORT=8080 ONEFOLDER_AUTH_SECRET=changeme ./onefolder-server
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8666` | HTTP/HTTPS listening port |
| `ONEFOLDER_AUTH_SECRET` | (none) | Shared secret used as both username and password for HTTP Basic auth |
| `ONEFOLDER_AUTH_USER` | (none) | Explicit username (takes precedence over `AUTH_SECRET`) |
| `ONEFOLDER_AUTH_PASSWORD` | (none) | Explicit password (used with `AUTH_USER`) |
| `ONEFOLDER_TLS` | (off) | Set to `1` or `true` to enable HTTPS |
| `ONEFOLDER_TLS_CERT` | (auto) | Path to PEM certificate file |
| `ONEFOLDER_TLS_KEY` | (auto) | Path to matching PEM private key |
| `PORTABLE_EXECUTABLE_DIR` | (derived) | Override the userData base directory (set automatically by electron-builder portable target) |

If neither `ONEFOLDER_AUTH_SECRET` nor `ONEFOLDER_AUTH_USER`+`ONEFOLDER_AUTH_PASSWORD` is set, the server starts but rejects every request with HTTP 401 and logs a warning at startup.

## Key Files

| File | Role |
|------|------|
| `src/frontend/platform/index.ts` | Platform interface definitions (`Platform`, `PlatformFs`, `PlatformPath`, `PlatformDesktop`, `PlatformExifHandle`) |
| `src/frontend/platform/platform.electron.ts` | Electron seam implementation — faithful pass-through |
| `src/frontend/platform/platform.web.ts` | Web seam implementation — HTTP reads, loud rejects for writes, ExifIO HTTP shim, `triggerRescan()` |
| `src/backend/http-backend.ts` | `HttpBackend implements DataStorage` — all reads over `fetch()`, all writes throw |
| `src/server/index.ts` | Sidecar server entry point — SEA detection, userData derivation, DB open, Express bootstrap |
| `src/server/auth.ts` | Auth middleware — dual header+cookie, HMAC signing, login/logout router |
| `src/server/path-resolver.ts` | Location-scoped path guard — ID→path lookup with location containment assertion |
| `src/server/thumbnails.ts` | Sharp-based thumbnail generation and preview cache path helpers |
| `src/server/decode.ts` | DOM-less image decoders — Sharp (HEIC/TIFF), ag-psd (PSD), WASM (EXR) |
| `src/server/routes/data.ts` | DataStorage REST routes (`/api/tags`, `/api/files`, `/api/locations`, …) |
| `src/server/routes/images.ts` | Image endpoints (`/api/original/:id`, `/api/thumb/:id`, `/api/preview/:id`) |
| `src/server/routes/metadata.ts` | ExifIO read endpoints (ID-based and by-path) |
| `src/server/routes/rescan.ts` | `POST /api/rescan` — on-demand DB count refresh |
| `webpack.web.js` | Web SPA webpack config — platform alias, Node stubs, `IS_WEB_BUILD=true` |
| `webpack.server.js` | Node server webpack config — externals for native modules |
| `scripts/package-headless.js` | Node SEA packaging script → `dist-headless/` |

## Scope and Explicit Rejections

The headless build is **read-only, single-user, single-library, single-session**.

The following are explicitly out of scope:

- Tag/metadata writeback, deletes, recycle, FFmpeg/NVENC media jobs, drag-drop import — web stubs throw loudly if called
- Multi-tenancy, sandboxing, per-user isolation
- Chokidar live file watching — replaced by the on-demand `POST /api/rescan` endpoint
- Raw client-supplied filesystem paths — all image and metadata endpoints are ID-based
- Codebase fork — the desktop Electron app is completely unchanged by this feature
