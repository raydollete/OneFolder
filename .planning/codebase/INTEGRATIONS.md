# External Integrations

**Analysis Date:** 2026-06-24

## APIs & External Services

**Mapbox (Geolocation):**
- Mapbox GL JS - Vector tile mapping and visualization
  - SDK/Client: mapbox-gl (3.0.1)
  - Auth: hardcoded access token (embedded in `src/frontend/components/ImageMap.tsx`)
  - Usage: Display geo-tagged photos on a map in `MapView.tsx`
  - Endpoint: Mapbox vector tile API (external)

**TensorFlow.js (AI):**
- TensorFlow.js with WebGL backend - On-device ML inference
  - SDK: @tensorflow/tfjs (4.14.0) + @tensorflow-models/blazeface (0.1.0)
  - Usage: Face detection for photos (not actively integrated; code present but unused)
  - Implementation: `src/frontend/image/aiModels.ts`

## Data Storage

**Databases:**
- SQLite 3 (via better-sqlite3)
  - Connection: Main process opens database file at library path
  - Client: `better-sqlite3` 12.10.0 (native Node.js module)
  - Schema: Managed in `src/backend/sqlite-config.ts` and `src/backend/sqlite-backend.ts`
  - Tables: files, tags, locations, searches, dismissedDuplicateGroups, visualHashes
  - Usage: Primary persistent data store (file metadata, tags, search state)
  - Portability: Database file copied per-library; stored at `{userData}/libraries/{libraryId}/library.db`

- Dexie (IndexedDB) - DEPRECATED
  - Client: dexie 3.2.3
  - Status: Legacy code only; migration to SQLite complete
  - Location: `src/backend/backend.ts` (marked deprecated)
  - Backup/restore: dexie-export-import 1.0.3 (legacy)

**File Storage:**
- Local filesystem only
  - User's photo library folder (any local path, watched via chokidar)
  - Thumbnails cache: `{userData}/libraries/{libraryId}/thumbnails/`
  - Temp staging: `{app.getPath('temp')}/onefolder-*` (ffmpeg output before move)
  - Backups: `{userData}/libraries/{libraryId}/backups/` (auto-scheduled, SQLite exports)

**Caching:**
- In-memory MobX observables for UI state
- Thumbnail cache directory (persistent, on-disk)
- No external cache service (Redis, memcached)

## Authentication & Identity

**Auth Provider:**
- Custom (headless web server only)
  - Implementation: HTTP Basic Authentication middleware
  - Configuration env vars:
    - `ONEFOLDER_AUTH_SECRET=<shared-secret>` (username and password both set to secret)
    - OR `ONEFOLDER_AUTH_USER=<user>` + `ONEFOLDER_AUTH_PASSWORD=<password>`
  - Location: `src/server/auth.ts` (not yet split out; in `src/server/index.ts`)
  - Scope: Web/headless server only; Electron app has no auth

**Session Management:**
- Stateless HTTP Basic auth (per-request credentials)
- No session tokens or cookies implemented

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry, Rollbar, or similar)
- Local logging only: console.log/console.error

**Logs:**
- Console output (main process, renderer, server)
- Electron main process logs: printed to stdout/stderr
- Server logs: printed to stdout/stderr when `yarn dev:server` or Node SEA binary runs
- No persistent log file rotation or aggregation

## CI/CD & Deployment

**Hosting:**
- Electron desktop app
  - Distribution: GitHub Releases (implicit from repository)
  - Packaging: electron-builder 26.15.2 (Windows portable only)
  - Code signing: macOS notarization script at `scripts/notarize.js` (not implemented for Windows)

- Headless web sidecar (optional deployment target)
  - Deployment: Node.js server (Node SEA single executable or normal Node)
  - Distribution: Manual; no CI/CD pipeline documented
  - Hosting: Any server that runs Node.js

**CI Pipeline:**
- None detected (no GitHub Actions, CircleCI, or similar workflow files)

## Environment Configuration

**Required env vars (headless server only):**
- `ONEFOLDER_AUTH_SECRET` or (`ONEFOLDER_AUTH_USER` + `ONEFOLDER_AUTH_PASSWORD`) - HTTP Basic auth
- `ONEFOLDER_TLS=1` - Enable HTTPS (optional; default: HTTP)
- `ONEFOLDER_TLS_CERT=<path>` - TLS certificate file (optional; auto-generates if missing)
- `ONEFOLDER_TLS_KEY=<path>` - TLS private key file (optional; auto-generates if missing)
- `PORT=<number>` - Server listen port (default: 8666)

**Optional env vars (desktop):**
- `PORTABLE_EXECUTABLE_DIR` - Set automatically by electron-builder portable target; triggers portable mode
- `IS_DEV` - Internal flag (set via `common/process.ts`)

**Secrets location:**
- Desktop: None (no secrets management; all config in-app)
- Server: Environment variables only (passed at server start)

## Webhooks & Callbacks

**Incoming:**
- None (no incoming webhooks)

**Outgoing:**
- ffmpeg progress parsing (`src/media/FfmpegRunner.ts`)
  - Child process spawning with pipe streams for progress
  - Not HTTP-based; local IPC via child_process

**File Watcher Callbacks:**
- Chokidar folder watcher (`src/frontend/workers/folderWatcher.worker.ts`)
  - Detects file changes in watched photo locations
  - Callbacks: add, change, unlink events
  - Forwarded via Comlink to renderer (not external webhooks)

## Media Processing Integrations

**FFmpeg / FFprobe (Local Binaries):**
- FFmpeg binary invocation
  - Windows: `resources/ffmpeg/ffmpeg.exe` (bundled)
  - macOS/Linux: system PATH (not bundled; user must have ffmpeg installed)
  - Runner: `src/media/FfmpegRunner.ts`
  - Service: `src/media/MediaJobService.ts`
  - Operations:
    - `reencode-x264`: NVIDIA NVENC H.264 encoding (fails if NVENC unavailable)
    - `normalize-audio`: Audio compression and loudness normalization (EBU R128)
    - `create-clip`: Stream-copy lossless trim
    - `subtract-clip`: Remove marked section with crossfade
    - `rotate-cw`, `rotate-ccw`: 90° rotation via NVENC
  - Progress reporting: Machine-readable ffmpeg `-progress pipe:1` output

- FFprobe binary invocation
  - Windows: `resources/ffmpeg/ffprobe.exe` (bundled)
  - macOS/Linux: system PATH
  - Usage: Probe media duration and audio codec (for transcoding decisions)
  - Location: `src/media/FfmpegRunner.ts` (probeFirstAudioCodec method)

**ExifTool (Local Binary):**
- ExifTool binary invocation
  - Windows: `resources/exiftool/exiftool.exe`
  - macOS/Linux: `resources/exiftool/exiftool.pl` (Perl script; requires system Perl)
  - Config: `resources/exiftool/.Exiftool_config`
  - Library: @logion/node-exiftool 2.3.1
  - Wrapper: `common/ExifIO.ts`
  - Operations:
    - Read EXIF/XMP metadata (tags, GPS, dates)
    - Write EXIF/XMP metadata (tag assignments, metadata updates)
    - Batch operations (e.g., write to all files with a tag)

**Sharp (Native Image Library):**
- Sharp C++ binding (native .node module)
  - Client: sharp 0.35.2
  - Usage:
    - Server: `src/server/thumbnails.ts` (resize, transcode to WebP)
    - Server: `src/server/decode.ts` (decode JPEG, PNG, WebP, GIF, BMP)
  - Not used in Electron renderer (image decode handled by browser/dedicated workers)

**LibHEIF / HEIC Decoding:**
- libheif-js library (WebAssembly binding)
  - Client: libheif-js 1.17.1
  - Worker: `src/frontend/workers/heicReader.worker.ts` (Comlink-wrapped)
  - Usage: Decode HEIC/HEIF images in web and Electron renderer

**PSD Decoding:**
- ag-psd library (Adobe Photoshop file parser)
  - Client: ag-psd 15.0.0
  - Worker: `src/frontend/workers/psdReader.worker.ts` (Comlink-wrapped)
  - Usage: Read PSD file structure and render raster image

**TIFF Decoding:**
- UTIF library (TIFF + BigTIFF parser)
  - Client: utif 3.1.0
  - Loader: `src/frontend/image/TifLoader.ts`
  - Usage: Decode TIFF images in renderer

**WebAssembly Modules:**
- Masonry layout algorithm (Rust → WASM)
  - Source: `wasm/masonry/` (Cargo.toml)
  - Variants: Scalar + SIMD (feature-gated)
  - Usage: Efficient grid layout for photo thumbnails
  - Build: `yarn build:masonry`

- OpenEXR decoder (Rust → WASM)
  - Source: `wasm/exr-decoder/` (Cargo.toml)
  - Usage: Decode EXR high-dynamic-range images
  - Build: `yarn build:exr`

## Data Formats Supported

**Photo Formats:**
- Standard: JPEG, PNG, WebP, GIF, BMP (native browser/Sharp)
- Specialty: HEIC/HEIF, TIFF, BigTIFF, PSD, EXR
- All formats support EXIF/XMP metadata preservation

**Metadata Formats:**
- EXIF (via ExifTool)
- XMP (via ExifTool)
- IPTC (read-only via ExifTool)
- GPS/Geolocation (stored in EXIF GPSLatitude/Longitude)

**Video Formats:**
- Input: Any format supported by ffmpeg (MP4, MOV, WebM, MKV, etc.)
- Output: MP4 (H.264 NVENC) for all re-encode operations

## Cross-Origin (COOP/COEP) Headers

**Headless Web Server:**
- COOP/COEP headers applied on all responses
- Purpose: Enable SharedArrayBuffer for WASM masonry layout (must run in secure context)
- Implementation: Middleware in `src/server/index.ts`

---

*Integration audit: 2026-06-24*
