---
id: INV-034
title: 'Headless / sidecar web build — browse a library read-only from a remote browser'
reported_bug: 'No way to browse a OneFolder library from another device. The renderer process IS the backend (nodeIntegration), so there is no browser-servable surface; the same fusion of Node/Electron into the frontend blocks any web target.'
date: 2026-06-20
status: tasks-created
superseded_by:
tasks_spawned: [TASK-126, TASK-127, TASK-128, TASK-129, TASK-130, TASK-131, TASK-132, TASK-133, TASK-134, TASK-135, TASK-136, TASK-137]
root_cause_category: architectural-shortcoming
affects:
  - 'Renderer/frontend layer (Node/Electron imports fused into ~26 frontend files)'
  - 'Data access layer (DataStorage / SQLiteBackend constructed in renderer)'
  - 'Image loading + thumbnail/preview pipeline (file:// + blob URLs, worker decoders)'
  - 'Metadata layer (ExifIO spawns native exiftool from the renderer)'
  - 'Build system (single electron-renderer webpack target)'
  - 'Packaging/distribution (electron-builder portable only)'
  - 'Desktop portable Electron app (hard constraint: must remain identical)'
---

<!--
  This is a NEW FEATURE investigation, not a defect report. It follows the
  investigation format because the feature is gated by an architectural flaw
  (Node/Electron fused into the renderer) that must be diagnosed and untangled
  holistically. Scope is deliberately narrow: read-only browse from a remote
  browser, single user, single session. See "Explicit Rejections".
-->

## Bug Report

### Observed Behavior

There is no way to browse a OneFolder library from a web browser on another device. OneFolder is **not** a thin Electron shell around a web app — the renderer process *is* the backend. With `nodeIntegration: true` / `contextIsolation: false` (`src/main.ts`), the React renderer directly:

- opens and queries the **SQLite database** via native `better-sqlite3` (`src/renderer.tsx:103` → `sqliteInit(dbPath)`; backend in `src/backend/sqlite-backend.ts`, `src/backend/sqlite-config.ts`),
- reads files from disk with `fs-extra` (~26 files under `src/frontend/**` and `common/**`, e.g. `src/frontend/image/ImageLoader.ts`, `src/frontend/image/util.ts`, `src/frontend/entities/Location.ts`),
- spawns the bundled **exiftool** binary (`common/ExifIO.ts:57`),
- calls Electron APIs from the UI: `ipcRenderer` via `RendererMessenger` (`src/ipc/renderer.ts`, consumed by 32 UI/store files), `shell.showItemInFolder/openExternal` (`src/frontend/stores/UiStore.ts` and 11 others), `webUtils.getPathForFile` (`src/frontend/containers/Outliner/LocationsPanel/dnd.ts:163`),
- decodes non-web formats (HEIC/PSD/TIFF/EXR) in **web workers that mix Node `fs` with browser Canvas** (`src/frontend/workers/thumbnailGenerator.worker.ts`, `src/frontend/workers/visualSimilarity.worker.ts`) and runs chokidar in `src/frontend/workers/folderWatcher.worker.ts`,
- turns disk paths into image sources via `encodeFilePath()` (`common/fs.ts:18`), which emits `file://` URLs.

A real browser has none of these (no Node, no native modules, no `electron`, no `file://` disk access). The browser bundle will not even compile while frontend code imports `fs-extra`, `path`, `better-sqlite3`, or `electron`.

### Expected Behavior

A single binary launches OneFolder **headless** (no Electron window) as a local Node server, so the same library can be browsed **read-only** from a web browser on another device:

- gallery, thumbnails, viewing originals, search/filter, browse tags, read metadata,
- behind a basic-auth gate + TLS, single user / single library / single session,
- packaged as one launchable that ships its native deps (`better-sqlite3` `.node`, exiftool) alongside, mirroring the existing portable build.

The standard portable Electron desktop app **must continue to function identically** — this is a hard constraint (see UX / Requirements Specification).

### Reproduction Context

Deterministic. There is currently no web/headless target at all; the only webpack renderer target is `electron-renderer` (`webpack.prod.js:64`) and the only packaging target is the Electron portable build (`package.json`).

---

## Root Cause Analysis

**Category:** architectural-shortcoming

### Diagnosis

The underlying flaw is that **Node/Electron concerns are fused directly into the renderer/frontend layer with no platform-abstraction boundary.** Because `nodeIntegration` is on, every author who needed disk, DB, metadata, or a window affordance reached for the Node/Electron API directly from a React component, store, entity, worker, or image loader. There is no seam at which a non-Electron host could substitute browser-safe behavior.

This is the same root cause expressed many times over:

1. **Data access is constructed in the renderer.** `src/renderer.tsx` calls `sqliteInit(dbPath)` and `SQLiteBackend.init(db, …)` directly. The *good* news is that everything above the backend already talks through the `DataStorage` interface (`src/api/data-storage.ts`) — the entire MobX store/component tree (`RootStore`, `FileStore`, `TagStore`, search, etc.) is implementation-agnostic. The flaw is only the *construction site*, not the consumers.

2. **Disk access is open-coded.** ~26 files import `fs-extra`/`path`/`crypto`/`node-stream-zip` to read images, themes, locations, and thumbnails. None of these go through an abstraction.

3. **Image sourcing assumes `file://`.** `encodeFilePath()` (`common/fs.ts:18`) emits `file://` URLs, which a remote browser cannot load. The blob path (`getBlob`/`URL.createObjectURL` in `util.ts`) is already web-friendly; only the `file://` branch and the `fse.readFile` source feeding the decoders are the blockers.

4. **Decoding assumes a DOM + local fs in one process.** HEIC/PSD/TIFF/EXR decoders read bytes with `fse.readFile`, decode (some in browser workers, some via WASM), and paint with `OffscreenCanvas`/`document` Canvas. In a remote browser the bytes live on the server, not the client.

5. **Metadata is a spawned child process.** `ExifIO` (`common/ExifIO.ts`) spawns native exiftool — inherently server-side; it has no browser equivalent and is load-bearing (dimensions/tags) for display.

6. **Window/desktop affordances call IPC inline.** `RendererMessenger` (`src/ipc/renderer.ts`) is consumed by 32 files for zoom, maximize, fullscreen, show-in-folder, open-external, preview window, clip server, paths, etc. None are abstracted; each is a hard `ipcRenderer` dependency.

7. **The build and packaging assume Electron.** A single `electron-renderer` webpack target and electron-builder are the only outputs; there is no browser-SPA build and no Node-server build.

The key architectural reuse point that makes this tractable: **`DataStorage` is a clean abstraction.** Adding a second implementation, `HttpBackend implements DataStorage`, that `fetch()`es a sidecar REST API leaves the entire store/component tree unchanged. The work is therefore: introduce a **build-time platform seam** for the open-coded Node/Electron usage, add `HttpBackend`, build a Node **sidecar server** that owns the DB/FS/exiftool/decoders and serves images over HTTP, add a **web webpack target**, and **package** it as one binary.

### Diagnostic Questions Considered

- **Wrong mental model?** Partially — early development treated "renderer" and "backend" as the same thing because `nodeIntegration` made that free. That assumption is exactly what blocks a web target.
- **Architectural shortcoming?** Yes — the absence of a platform-abstraction boundary between frontend and Node/Electron is the root cause. The one place a boundary *does* exist (`DataStorage`) is precisely what makes the feature feasible.
- **Incorrect order of operations?** No.
- **Missing edge case?** Not a bug edge case; this is a missing capability (no non-Electron host).
- **Wrong abstraction?** `DataStorage` is the *right* abstraction and proves the pattern; the rest of the Node/Electron usage simply has *no* abstraction.
- **Silent failure?** No — a web build fails loudly at compile time on the first `fs-extra`/`electron` import.

---

## Blast Radius

Every area below is affected by the same root cause (Node/Electron fused into the frontend with no seam). Counts verified against the current tree.

1. **Data construction (`src/renderer.tsx`)** — Imports `sqliteInit`, `SQLiteBackend`, `SQLiteBackupScheduler`, `migration-*`, `fse`, `path`, `getSqliteDbPath`. `main()` must branch so the web bundle never imports any `better-sqlite3`-reachable module. Transitive trap: `common/library-registry.ts` imports `src/backend/sqlite-config.ts` (value-imports `better-sqlite3`) just for `SQLITE_DB_FILENAME`.
2. **Backend modules (`src/backend/sqlite-config.ts`, `sqlite-backend.ts`, `sqlite-backup-scheduler.ts`, `migration-indexeddb-to-sqlite.ts`)** — value-import `better-sqlite3`; renderer-reachable. Must be excluded from the web bundle but **reused as-is by the sidecar server** (read path only).
3. **`DataStorage` interface (`src/api/data-storage.ts`)** — clean; no Node imports. The reuse seam: needs a second impl `HttpBackend`.
4. **Open-coded disk access (~26 files)** — `fs-extra`/`path`/`crypto`/`node-stream-zip` in: `image/ImageLoader.ts`, `image/util.ts`, `image/ThumbnailGeneration.tsx`, `image/MediaReleaseCoordinator.ts`, `entities/Location.ts`, `entities/File.ts`, `stores/FileStore.ts`, `stores/UiStore.ts`, `stores/LocationStore.ts`, `components/ImageDates.tsx`, `hooks/useCustomTheme.tsx`, `containers/ContentView/GalleryItem.tsx`, `containers/ContentView/menu-items.tsx`, `containers/ContentView/SlideMode/index.tsx`, `containers/Settings/ImportExport.tsx`, `containers/Outliner/index.tsx`, `containers/Outliner/LocationsPanel/{dnd.ts,index.tsx,useFileDnD.ts,LocationRecoveryDialog.tsx}`, plus `common/fs.ts`. All must route through the seam (read-only ⇒ most write/OS methods become web stubs).
5. **`encodeFilePath` + image sourcing (`common/fs.ts`)** — emits `file://`; must become build-conditional so the web build emits HTTP URLs (`/original`, `/thumb`, `/preview`). `getThumbnailPath`, `isDirEmpty`, `getMediaJobTempPath`, `getUniqueSiblingPath`, `getExtraResourcePath`, `getFfmpegPath/ffprobe` are also Node-coupled (out-of-scope helpers become web no-ops/unused).
6. **Per-format decoders (`src/frontend/image/*`)** — `TifLoader`, `ExrLoader` (WASM), `HEICLoader`/`PSDLoader` (workers) are browser-safe **except** the `Decoder.decode(buffer: Buffer)` typing (`util.ts`) on the Node `Buffer` global. The bytes source (`fse.readFile`) and the Canvas sinks (`getBlob`/`generateThumbnail` use `document.*`) must move server-side for the web target; for read-only, decode happens on the server and serves webp/jpeg.
7. **Workers (`src/frontend/workers/*`)** — `thumbnailGenerator.worker.ts` + `visualSimilarity.worker.ts` mix `fse` with Canvas; `folderWatcher.worker.ts` is Node-only (chokidar/`fs`/`original-fs`). For read-only these become server-side (decode/thumbs) or dropped (watcher → on-demand rescan endpoint). `heicReader.worker.ts`/`psdReader.worker.ts`/masonry worker are browser-safe.
8. **Metadata (`common/ExifIO.ts`)** — spawns native exiftool; wired through `RootStore` → `entities/File.ts`, `image/ImageLoader.ts`, `containers/ContentView/SlideMode/AnnotoriousWrapper.ts`. Must become a server-side read-only metadata service exposed over HTTP; the web build receives a remote-backed `ExifIO`-shaped object (not a no-op — dimensions/tags are load-bearing).
9. **Window/desktop IPC (`src/ipc/renderer.ts`, 32 consumers)** — zoom, maximize, fullscreen, system buttons, show-in-folder, open-external, preview window, clip server, `getPath`, `getDefaultThumbnailDirectory`, etc. Must become web no-ops behind the seam and the corresponding UI controls hidden. `shell.*` importers (13 files) likewise.
10. **`process.platform` globals** — `App.tsx:21`, `components/PopupWindow.tsx:5`, `common/process.ts`. Need a browser shim / DefinePlugin replacement for the `process` global.
11. **Headers / SharedArrayBuffer (`src/index.html`)** — sets COOP `same-origin` + COEP `require-corp` for masonry WASM `SharedArrayBuffer`. Served over HTTP, the server must send COOP/COEP **and** a `Cross-Origin-Resource-Policy` header on every asset/image response, or images silently fail.
12. **Build system (`webpack.prod.js`, `webpack.dev.js`)** — only `electron-renderer` + `electron-main` targets exist. Need a new `web` SPA target (aliases electron/Node to browser shims, excludes server-only code) plus a Node build for the sidecar.
13. **Packaging (`package.json`)** — electron-builder portable only. Need a single-binary path (Node SEA or `pkg`) shipping the SPA assets + `better-sqlite3` `.node` + exiftool alongside, mirroring `asarUnpack`/`extraResources`.
14. **Desktop portable Electron app (regression surface)** — the seam edits ~15+ frontend files the desktop also uses. The Electron seam impl must be a faithful pass-through; **every task must re-test the portable desktop build.**

---

## UX / Requirements Specification

### Purpose

Let a single user browse their own OneFolder library, **read-only**, from a web browser on another device, by launching one headless binary on the machine that holds the library. Make this additive to a single codebase via a build-time seam — never a fork — so the desktop app is untouched.

### User-Stated Design Decisions

1. **Single codebase, build-time seam (webpack alias selecting Electron vs Web impls)** — NOT a separate fork. Rationale: less duplication, no divergence, fits the portable-only fork. The Electron impl of every seam is a faithful pass-through (no functional change).
2. **`HttpBackend implements DataStorage`, selected in `src/renderer.tsx` for web mode** — Rationale: the whole MobX store/component tree stays unchanged; only the constructed backend instance differs. This is the single most important reuse point.
3. **Sidecar Node server (Express/Fastify) owns DB/FS/exiftool/decoders** — opens SQLite **read-only** (`new Database(path, { readonly: true })`), reusing `sqlite-config.ts`/`sqlite-backend.ts` read paths; exposes `DataStorage` reads as REST/JSON; serves `/original`, `/thumb`, `/preview`. Rationale: the renderer cannot run Node in a browser; the server is the new home for everything that was fused in.
4. **Serve images over HTTP, not `file://`/blob** — make `encodeFilePath` build-conditional; add `/original`, `/thumb`, `/preview` endpoints. Rationale: browsers can't load `file://` from a web origin.
5. **Path-traversal guard scoped to library `locations`** — the server resolves IDs → paths from the DB and refuses anything outside the library's `locations`; never accept raw client paths. Rationale: the server serves real local files; this + auth is the security boundary.
6. **Relocate HEIC/PSD/TIFF/EXR + thumbnail decoding to a DOM-less Node server** — Sharp/libvips for most formats (already a dep); EXR WASM in Node with a canvas-less raw-pixel → encoder path (no `toBlob`). Serve webp/jpeg. Rationale: `OffscreenCanvas`/`createImageBitmap` don't exist in Node and the client doesn't have the bytes.
7. **Single binary via Node SEA or `pkg`** — ship native `better-sqlite3` `.node` + exiftool alongside (mirror `asarUnpack`/`extraResources`); re-derive paths at launch (consistent with the portable-only fork). Rationale: native modules can't be inlined into a JS bundle.
8. **New webpack `web` target** (current target is `electron-renderer`) aliasing electron/Node modules to browser shims and excluding server-only code; plus a Node build for the server.
9. **Stub web-mode no-ops for window/desktop IPC** — zoom, maximize, fullscreen, show-in-folder, open-external, preview window, clip server — via the same seam; hide the corresponding UI controls.
10. **COOP/COEP/CORP headers from the server** — replicate `src/index.html`'s COOP/COEP and add CORP to every image/asset response so masonry `SharedArrayBuffer` works and images don't silently fail.
11. **Basic-auth gate + TLS** — single shared secret / basic-auth, self-signed or reverse-proxy TLS. Rationale: "just me, remote" still opens a network port.
12. **Library currency without a watcher** — drop chokidar for read-only; on-demand/periodic rescan endpoint instead. Not a blocker for a first cut.

### Behavioral Specifications

- **Access model:** one user, one library, one session at a time. NO multi-tenancy, NO sandboxing, NO per-user isolation.
- **Phasing (reflected in task ordering):**
  - **Phase A (PoC):** platform seam + `HttpBackend` + server with DB reads + `/original` & `/thumb` for **web formats only** (jpg/png/webp/gif/bmp). Proves the split end-to-end.
  - **Phase B:** server-side decode for HEIC/PSD/TIFF/EXR (`/preview`).
  - **Phase C:** single-binary packaging + auth/TLS.
- **Phase A verification:** from a browser on another device, gallery lists files (DB read over HTTP), thumbnails render, a jpg/png original opens full-size; Network tab shows `/thumb` + `/original` 200s; no `electron`/Node module errors in the browser console; masonry layout (SharedArrayBuffer) works.
- **Phase B verification:** open a HEIC/PSD/TIFF/EXR file in the browser → decoded preview renders; server logs show Sharp/WASM decode; response is webp/jpeg.
- **Phase C verification:** run the packaged binary on a clean machine with no Node installed → it starts, auth gate rejects unauthenticated requests, browsing works over the network; requesting a path outside the library's locations returns 403/404.
- **Desktop regression (every phase):** re-run the portable desktop build and confirm unchanged behavior — DB read/write, image loading incl. HEIC/PSD/TIFF/EXR, tagging, media jobs, deletes. "Desktop still works" is tested, not assumed.

### Explicit Rejections

- **OUT OF SCOPE — do not implement:** edits, tag/metadata **writeback**, deletes/recycle, FFmpeg/NVENC media jobs, drag-drop import, exiftool writeback. View + browse only.
- **Do NOT widen the access model** — no multi-tenancy, no sandboxing, no per-user isolation, no concurrent sessions.
- **Do NOT fork the codebase** — single codebase with a build-time seam only.
- **Do NOT change desktop behavior** — the Electron seam impl must be a faithful pass-through; any desktop regression is a defect in this work.
- **Do NOT keep chokidar in the web path** — read-only currency is on-demand rescan, not a live watcher (for the first cut).
- **Do NOT serve raw client-supplied paths** — IDs resolve to DB paths, location-scoped only.

---

## Holistic Solution

### Approach

Solve the root cause (no platform boundary) by introducing one, then build the web host on top of it. Ordered by dependency:

**Foundation (Phase A):**
1. **Introduce a `platform` seam** (TASK-126): a small module (`src/frontend/platform/`) with two build-time implementations selected by webpack alias — `platform.electron.ts` (faithful pass-through to `fse`/`path`/`shell`/`RendererMessenger`/`ExifIO`/`encodeFilePath`) and `platform.web.ts` (HTTP/stub). Migrate the ~26 open-coded importers and the 32 `RendererMessenger` consumers to the seam. Read-only lets most write/OS methods be web stubs.
2. **Add `HttpBackend implements DataStorage`** (TASK-127) and branch `src/renderer.tsx` to construct it in web mode, leaving stores/components untouched. Includes a build-conditional `encodeFilePath` (web → `/original|/thumb|/preview` URLs).
3. **Build the sidecar server skeleton** (TASK-128): Express/Fastify, opens SQLite **read-only** reusing `sqlite-config.ts`/`sqlite-backend.ts` read paths, exposes `DataStorage` reads as REST/JSON, serves the SPA with COOP/COEP, location-scoped path-traversal guard.
4. **`/original` + `/thumb` for web formats** (TASK-129): serve originals and persisted thumbnails (generated by Sharp server-side if missing) with CORP headers, for jpg/png/webp/gif/bmp only.
5. **New webpack `web` SPA target + Node server build** (TASK-130): alias electron/Node → browser shims, exclude server-only modules, shim the `process` global, add a `dev:web` script.

**Phase B:**
6. **Server-side decode for HEIC/PSD/TIFF/EXR → `/preview`** (TASK-131): Sharp/libvips for HEIC/TIFF/PSD; EXR via the existing WASM decoder run in Node with a canvas-less raw-pixel → encoder path; emit webp/jpeg.
7. **Server-side read-only metadata service** (TASK-132): reuse `common/ExifIO.ts` read paths server-side; expose dimensions/tags/EXIF reads over HTTP; web `ExifIO` shim in the seam fetches them.

**Phase C:**
8. **Single-binary packaging** (TASK-133): Node SEA (or `pkg`) bundling server + SPA assets, shipping `better-sqlite3` `.node` + exiftool alongside, paths re-derived at launch.
9. **Basic-auth gate + TLS** (TASK-134): shared-secret/basic-auth middleware on all routes incl. image endpoints; self-signed TLS option; reject unauthenticated.
10. **On-demand rescan endpoint** (TASK-135): replace the dropped chokidar watcher for read-only currency.

**Cross-cutting:**
11. **Documentation** (TASK-136): `docs/headless-web-build.md` + CLAUDE.md note.
12. **End-to-end QA across phases incl. desktop regression** (TASK-137).

### Expected Outcomes

- The same library is browsable read-only from a remote browser: gallery, thumbnails, originals, search/filter, tag browse, metadata read.
- The MobX store/component tree is unchanged; only the constructed backend and the platform seam impl differ by build.
- The desktop portable Electron app behaves identically (seam is a faithful pass-through, verified each task).
- One launchable binary serves the SPA + images, behind auth + TLS, with a location-scoped traversal guard.

### Risks and Tradeoffs

1. **Seam touches working desktop code (~15+ files).** Mitigation: Electron impl is a literal pass-through; every task re-tests the portable desktop build.
2. **Server-side EXR via WASM without a canvas** is the main unknown besides packaging — needs a raw-pixel → encoder path. Mitigation: Sharp covers HEIC/TIFF/PSD; only EXR needs the WASM-in-Node path, isolated to TASK-131.
3. **Single-binary packaging of a native module** (`better-sqlite3` `.node`) can't be inlined. Mitigation: ship alongside via SEA/pkg, mirror existing `asarUnpack`/`extraResources`, re-derive paths at launch.
4. **Security:** the server serves real local files. Mitigation: auth gate (TASK-134) + DB-resolved, location-scoped paths (TASK-128) are the boundary; never accept raw client paths.
5. **COEP/CORP correctness:** missing CORP on image responses silently breaks loading under COEP. Mitigation: explicit header tests in QA (TASK-137).
6. **Scope creep risk:** writeback/delete/media are tempting but explicitly out of scope. Mitigation: web seam stubs reject/hide those affordances.

---

## Documentation Updates

- [ ] Updated: `docs/headless-web-build.md` (new) — architecture of the seam, sidecar, endpoints, packaging, security boundary (TASK-136).
- [ ] Updated: `CLAUDE.md` — note the platform seam and the additional `web` build target (TASK-136).
