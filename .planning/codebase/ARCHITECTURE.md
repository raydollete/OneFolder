<!-- refreshed: 2026-06-24 -->
# Architecture

**Analysis Date:** 2026-06-24

## System Overview

OneFolder is a desktop photo management application built with Electron and React. The architecture separates concerns into layers: a native Electron main process handles OS integration and file operations; a React renderer provides the UI backed by MobX state management; data flows through a backend abstraction layer that supports multiple storage implementations (SQLite for Electron, HTTP for the read-only web build); and a platform seam enforces filesystem/IPC boundaries to allow the same codebase to compile into both a native desktop app and a read-only web SPA.

```text
┌─────────────────────────────────────────────────────────────────┐
│                   React UI (Renderer Process)                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  App, Settings, Inspector, ContentView, Outliner, etc.   │  │
│  │  `src/frontend/containers/`, `src/frontend/components/`  │  │
│  └──────────────────────┬──────────────────────────────────┘  │
│                         │ (MobX observables + @observer HOC)   │
│  ┌──────────────────────▼──────────────────────────────────┐  │
│  │              MobX State Management Layer                │  │
│  │  ┌────────────────────────────────────────────────────┐ │  │
│  │  │  RootStore (container)                            │ │  │
│  │  │    ├─ FileStore (file list, selection, sorting)  │ │  │
│  │  │    ├─ TagStore (tag tree, operations)             │ │  │
│  │  │    ├─ LocationStore (watched folders, watchers)   │ │  │
│  │  │    ├─ UiStore (UI state, preferences)             │ │  │
│  │  │    ├─ SearchStore (search definitions)            │ │  │
│  │  │    ├─ MediaQueueStore (FFmpeg job queue)          │ │  │
│  │  │    ├─ ImageLoader (format decoders, thumbnails)   │ │  │
│  │  │    ├─ ExifIO (metadata reader/writer)             │ │  │
│  │  │    └─ MediaReleaseCoordinator (playback lifecycle)│ │  │
│  │  └────────────────────────────────────────────────────┘ │  │
│  │  `src/frontend/stores/`                                  │  │
│  └──────────────────────┬──────────────────────────────────┘  │
└─────────────────────────┼──────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                   │
┌───────▼──────────────────┐    ┌──────────▼──────────────────┐
│   Platform Seam Layer    │    │   IPC Layer (Electron)      │
│  `src/frontend/platform` │    │   `src/ipc/`                │
│                          │    │                              │
│ Abstracts:              │    │ Type-safe messaging:        │
│ • Filesystem (fs)       │    │ • Library operations        │
│ • Path (path)           │    │ • Media jobs                │
│ • Desktop (shell, etc)  │    │ • Window control            │
│ • ExifIO (metadata)     │    │ • File dialogs              │
│ • RendererMessenger     │    │                              │
│                          │    │ Implementations:            │
│ Two implementations:     │    │ • MainMessenger            │
│ • platform.electron.ts  │    │ • RendererMessenger        │
│   (pass-through)        │    │                              │
│ • platform.web.ts       │    │                              │
│   (HTTP stubs + reads)  │    │                              │
└───────┬──────────────────┘    └──────────┬──────────────────┘
        │                                   │
        └─────────────────┬─────────────────┘
                          │
        ┌─────────────────▼──────────────────┐
        │    Data Storage Abstraction        │
        │    (DataStorage interface)         │
        │    `src/api/data-storage.ts`       │
        │                                    │
        │  Methods: fetch*, create*, save*,  │
        │           remove*, search, count   │
        │                                    │
        │  Two implementations:              │
        │  • SQLiteBackend (Electron)        │
        │  • HttpBackend (web SPA)           │
        └────────┬─────────────────┬────────┘
                 │                 │
        ┌────────▼──────┐   ┌──────▼─────────┐
        │  SQLite DB    │   │  HTTP Server   │
        │  (better-     │   │  (Express)     │
        │   sqlite3)    │   │  `src/server/` │
        │               │   │                │
        │ Per-library:  │   │ Routes:        │
        │ • data        │   │ • /api/files   │
        │ • backups     │   │ • /api/tags    │
        │ • preferences │   │ • /api/images  │
        │               │   │ • /api/metadata│
        │ Location:     │   │ • Auth + login │
        │ {userData}/   │   │                │
        │ libraries/{id}│   │ Reads data     │
        │              │   │ from SQLite    │
        └──────────────┘   │ (readonly)     │
                           └────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| **RootStore** | Instantiates and coordinates all child stores; manages lifecycle (startup/teardown) | `src/frontend/stores/RootStore.ts` |
| **FileStore** | File listing, selection, sorting, filtering, thumbnail coordination; sole writer of file list state | `src/frontend/stores/FileStore.ts` |
| **TagStore** | Tag tree operations, hierarchy, creation, merging, deletion | `src/frontend/stores/TagStore.ts` |
| **LocationStore** | Folder watching via Chokidar workers; file discovery; location CRUD | `src/frontend/stores/LocationStore.ts` |
| **UiStore** | Theme, layout preferences, keyboard shortcuts, inspector state, full-screen, zoom | `src/frontend/stores/UiStore.ts` |
| **SearchStore** | Saved search definitions and operations | `src/frontend/stores/SearchStore.ts` |
| **MediaQueueStore** | FFmpeg job queue, progress tracking, cancellation | `src/frontend/stores/MediaQueueStore.ts` |
| **ImageLoader** | Format-specific decoders (HEIC, PSD, TIFF, EXR) and thumbnail generation | `src/frontend/image/ImageLoader.ts` |
| **ExifIO** | EXIF/XMP metadata read/write via native exiftool subprocess | `common/ExifIO.ts` |
| **MediaReleaseCoordinator** | Lifecycle tracking for media playback and resource cleanup | `src/frontend/image/MediaReleaseCoordinator.ts` |
| **LibraryRegistry** | Multi-library management: registry persistence, active library tracking | `common/library-registry.ts` |
| **FfmpegRunner** | FFmpeg process orchestration for media jobs; spawns ffmpeg with args and monitors progress | `src/media/FfmpegRunner.ts` |
| **MediaJobService** | Media job coordination; dispatches jobs to FfmpegRunner; updates MediaQueueStore | `src/media/MediaJobService.ts` |
| **App** | Top-level React component; context providers, theme, error boundary, dialogs | `src/frontend/App.tsx` |

## Pattern Overview

**Overall:** Layered monolithic architecture with a platform seam for multi-target builds.

**Key Characteristics:**
- **Single codebase, multiple targets** — The same TypeScript source compiles to Electron (desktop native), web SPA (read-only HTTP client), and headless server (Node SEA binary). Webpack aliases select implementations at build time.
- **Data abstraction** — The `DataStorage` interface decouples the store layer from persistence. SQLite for Electron; HTTP for web.
- **MobX state management** — All renderer-side state is MobX observable; UI components use the `@observer` HOC to react to changes.
- **IPC bridging** — Type-safe message passing between main and renderer via `MainMessenger` / `RendererMessenger`.
- **Per-library scoping** — SQLite database, preferences, thumbnails, and backups are all per-library. Libraries are switched via full page reload.
- **Platform seam** — Frontend code imports filesystem/shell/IPC capabilities from `src/frontend/platform`, never directly from Node or Electron modules. The webpack alias swaps implementations at bundle time.
- **Web Workers** — Heavy I/O (file watching, thumbnail generation) runs in Web Workers to keep the renderer responsive.

## Layers

**Electron Main Process:**
- Purpose: Window management, file I/O, native APIs, media job execution, IPC request handling
- Location: `src/main.ts`
- Contains: Window lifecycle, dialogs, file operations, ffmpeg spawning, menu setup, library registry management
- Depends on: `better-sqlite3`, `fs-extra`, `chokidar`, `ffmpeg`, `exiftool`, Electron APIs
- Used by: IPC handlers called from the renderer

**Platform Seam / Frontend Abstraction:**
- Purpose: Isolate Node/Electron-specific code so the same app.tsx tree compiles for Electron (native) and web (HTTP-backed)
- Location: `src/frontend/platform/index.ts` (interface), `platform.electron.ts` (desktop), `platform.web.ts` (browser)
- Contains: `PlatformFs` (readFile, pathExists, stat, readdir, ensureDir, move, writeFile); `PlatformPath` (basename, extname, join, dirname, normalize, sep); `PlatformDesktop` (shell, window chrome, RendererMessenger, library/media ops); `PlatformExifHandle` (ExifIO getter)
- Depends on: fs-extra, path, electron (Electron build only); fetch (web build only)
- Used by: Every frontend component or store that needs filesystem or OS access

**IPC Layer:**
- Purpose: Type-safe, promise-based async messaging between main and renderer
- Location: `src/ipc/main.ts` (main-side handler registration), `src/ipc/renderer.ts` (renderer-side caller), `src/ipc/messages.ts` (message type definitions)
- Contains: Message types (StoreFileMessage, OpenDialogMessage, MediaJobStartResult, etc); handler implementations in main.ts; async caller interface in renderer.ts
- Depends on: Electron ipcMain / ipcRenderer
- Used by: Renderer calls `RendererMessenger.<method>()` to request main-process work; main calls `mainWindow.webContents.send()` to push events (e.g., media progress)

**MobX Stores (Renderer State):**
- Purpose: Maintain all UI and data state; coordinate between backend and components
- Location: `src/frontend/stores/`
- Contains: RootStore (factory + lifecycle), FileStore (files + selection), TagStore (tag tree), LocationStore (folders + watchers), UiStore (preferences + layout), SearchStore (saved searches), MediaQueueStore (job progress)
- Depends on: DataStorage interface (backend abstraction), ExifIO (metadata), ImageLoader (formats), IPC (main-process calls)
- Used by: React components via `@observer` HOC and `useStore()` hook

**Data Storage Abstraction:**
- Purpose: Decouple data access from persistence backend
- Location: `src/api/data-storage.ts` (interface), `src/backend/sqlite-backend.ts` (SQLite), `src/backend/http-backend.ts` (HTTP)
- Contains: `DataStorage` interface with methods for files, tags, locations, searches, duplicates, visual hashes; two implementations for different targets
- Depends on: DTOs (FileDTO, TagDTO, LocationDTO, etc.), search criteria, order-by definitions
- Used by: Every store that reads/writes data (FileStore, TagStore, LocationStore, RootStore)

**SQLite Backend (Electron):**
- Purpose: Local persistent storage via `better-sqlite3`
- Location: `src/backend/sqlite-backend.ts`, `src/backend/sqlite-config.ts`, `src/backend/sqlite-backup-scheduler.ts`
- Contains: CRUD operations on the onefolder.db SQLite database; automatic WAL-mode checkpointing; backup scheduling; schema initialization
- Depends on: better-sqlite3, fs-extra, path, library-registry (for per-library paths)
- Used by: RootStore → FileStore, TagStore, LocationStore, SearchStore

**HTTP Backend (Web SPA):**
- Purpose: Read-only HTTP client for the web-only SPA build
- Location: `src/backend/http-backend.ts`
- Contains: All DataStorage methods implemented as `fetch()` calls to `/api/` endpoints; Basic Auth header attachment; serialization of Date objects to ISO 8601
- Depends on: fetch(), Base64 encoding for auth
- Used by: RootStore (in web builds only) → stores → components

**Server Layer (Headless Build):**
- Purpose: Read-only HTTP server that serves the web SPA and handles REST API queries
- Location: `src/server/`
- Contains: Express middleware (COOP/COEP/CORP, auth, login router); data routes (`/api/files`, `/api/tags`, `/api/locations`, `/api/searches`, `/api/metadata/*, /api/images/`, `/api/rescan`); auth (Basic + session cookie); path resolver (validates all client-supplied paths against registered locations); image decoders (Sharp for HEIC/TIFF, ag-psd for PSD, WASM for EXR); thumbnails and preview cache
- Depends on: Express, better-sqlite3 (readonly mode), exiftool, sharp, ag-psd, WASM modules, fs-extra for cache I/O
- Used by: Deployed as a Node SEA binary or run via `yarn dev:server`; serves `dist-web/` + API

**Frontend Components & Containers:**
- Purpose: React UI tree; renders stores as interactive views
- Location: `src/frontend/components/`, `src/frontend/containers/`
- Contains: App (root), Main (layout hub), ContentView (masonry/slide views), Inspector (file details), Outliner (folders + tags + searches), Settings, AppToolbar, MediaQueue (job drawer)
- Depends on: MobX stores (via `@observer`), platform seam (for file ops), custom hooks
- Used by: React tree; renders MobX observables

**Media Subsystem (3 layers):**
1. **FfmpegRunner** (`src/media/FfmpegRunner.ts`) — Low-level ffmpeg process orchestration. Spawns ffmpeg with args; monitors stdout for progress (not for exits); captures stderr; provides `kill()` and `await done()` methods.
2. **MediaJobService** (`src/media/MediaJobService.ts`) — Mid-level job coordinator. Queues jobs; dispatches to FfmpegRunner; updates MediaQueueStore with progress; handles cleanup and state updates.
3. **ingestFile (renderer side)** — High-level entry point in renderer via IPC. Called by FileStore when media needs re-encoding. Routes to MediaJobService.

## Data Flow

### Primary Request Path (File Loading)

1. **Page load** (`src/renderer.tsx:main()`) — Renderer initializes RootStore with a DataStorage backend (SQLite or HTTP).
2. **RootStore.main()** (`src/frontend/stores/RootStore.ts`) — Instantiates FileStore, TagStore, LocationStore, and other child stores.
3. **FileStore initialization** — Auto-runs a fetch via `FileStore.fetchAndApplyFiles()`, which calls `backend.fetchFiles()` with the current sort order.
4. **Backend query** — SQLiteBackend executes a SQL query; HttpBackend makes a `GET /api/files` request.
5. **Store update** — FileStore receives the array of `FileDTO[]`, creates observable File objects, emits a `@observable files` array.
6. **Component reaction** — React components observe `@observable fileStore.files`; `@observer` HOC triggers re-render.
7. **Thumbnail gen** — As components render `<FileView>` items, `ImageLoader.getThumbnail(file)` is called.
8. **Thumbnail cache** — If the thumbnail exists on disk, serve it; otherwise generate via Sharp/format decoders and cache.

### Tag Operations Flow

1. User clicks "Add Tag" → `TagStore.createTag(tag)` (MobX action).
2. Action calls `backend.createTag(tag)` → persists to SQLite or HTTP POST `/api/tags`.
3. If successful, the action updates `tagStore.tags` (observable).
4. Components observing `tagStore.tags` re-render to show the new tag.

### Media Job Flow

1. User clicks "Re-encode → H.264" on a video file.
2. Renderer IPC calls `RendererMessenger.startMediaJob({ type: 'reencode-x264', fileId, ... })`.
3. Main process receives the IPC message; handler calls `mediaJobService.startJob(...)`.
4. `MediaJobService` checks FFmpeg availability, updates `MediaQueueStore.addJob()` (renderer-side MobX).
5. Service spawns `FfmpegRunner` with codec args.
6. FfmpegRunner parses ffmpeg's stdout for progress; calls `notifyProgress(progress)`.
7. Progress callback updates `MediaQueueStore` → observing components re-render with progress bar.
8. FFmpeg exits → FfmpegRunner resolves its `done()` promise.
9. Service handles cleanup: moves output file to destination, updates FileStore, updates DB.
10. Renderer shows success toast; clears job from queue.

### Library Switching Flow

1. User selects a different library from Settings → LibrarySelector.
2. Renderer calls `RendererMessenger.switchLibrary(newLibraryId)`.
3. Main process handler calls `registry.setActiveLibrary(newLibraryId)` → writes `active-library.json`.
4. Main closes the preview window (holds old library's data).
5. Main calls `mainWindow.loadURL(...?libraryId=<newId>)` → triggers page reload.
6. Reload fires `beforeunload` → `RootStore.close()` → flushes ExifTool, closes Chokidar watchers, closes SQLite handle.
7. New renderer init parses URL query string; opens the new library's SQLite DB.
8. New stores initialize from the new DB; UI renders the new library's files.

**State Management:**
- All state lives in MobX stores. Components read observables; calling actions mutates observables and often the backend.
- Changes are batched and debounced where appropriate (e.g., preferences saved with 200ms delay).
- Library switching clears all stores and re-initializes from the new library's database.

## Key Abstractions

**DataStorage interface** (`src/api/data-storage.ts`):
- Purpose: Abstract the database from the store layer
- Examples: `FileStore` calls `backend.fetchFiles()`, `FileStore.saveFiles()`, `backend.removeFiles()`. The backend implementation (SQLite vs. HTTP) is transparent.
- Pattern: Dependency injection — RootStore constructor receives a DataStorage instance.

**Platform interface** (`src/frontend/platform/index.ts`):
- Purpose: Abstract Node/Electron APIs from the renderer
- Examples: `platform.fs.readFile()`, `platform.path.join()`, `platform.desktop.shell.showItemInFolder()`, `platform.exif.getExifIO()`. Frontend components call these, not Node modules directly.
- Pattern: Webpack alias selects implementation at build time (platform.electron.ts vs. platform.web.ts).

**File / Tag / Location DTOs** (`src/api/file.ts`, `src/api/tag.ts`, `src/api/location.ts`):
- Purpose: Define the data contract between backend and store
- Examples: `FileDTO` with fields: id, absolutePath, fileName, fileSize, type, createdAt, modifiedAt, orientation, duration, tags, searches, etc. Stores use DTOs directly; components often wrap them in observable classes (FileStore.File).
- Pattern: Plain data objects; stores add behavior via MobX.

**LibraryRegistry / LibraryDTO** (`common/library-registry.ts`, `src/api/library.ts`):
- Purpose: Multi-library support — treat each library as a first-class entity with its own database
- Examples: `LibraryRegistry` reads/writes `{userData}/libraries.json` and `{userData}/active-library.json`. Each library UUID scopes its own `{userData}/libraries/{id}/onefolder.db` and thumbnails at `{temp}/OneFolder/{id}/thumbnails/`.
- Pattern: Registry pattern for global state (active library); per-entity isolation for database/thumbnails.

**ImageLoader with format decoders** (`src/frontend/image/ImageLoader.ts`, HEICLoader, PSDLoader, TifLoader, ExrLoader):
- Purpose: Lazy-load format-specific decoding logic; abstract format handling
- Examples: HEIC images use `HEICLoader` (Sharp-backed); PSD uses `PSDLoader` (ag-psd); TIFF uses `TifLoader` (Sharp); EXR uses `ExrLoader` (WASM). The loader picks the right decoder based on file extension.
- Pattern: Strategy pattern — each format has a loader class; ImageLoader delegates based on file type.

**MediaReleaseCoordinator** (`src/frontend/image/MediaReleaseCoordinator.ts`):
- Purpose: Lifecycle management for media playback (slide mode, video viewing) — ensure file handles are released when media is no longer visible
- Examples: Tracking which file is currently being viewed; releasing old file when switching; preventing resource leaks.
- Pattern: Coordinator pattern — centralized lifecycle tracking.

## Entry Points

**Electron Main Process Entry:**
- Location: `src/main.ts`
- Triggers: Electron app initialization (`app.ready` event)
- Responsibilities: Create main window, load renderer HTML, register IPC handlers, set up Electron menu, manage media jobs, handle file dialogs, library registry management

**Renderer Entry:**
- Location: `src/renderer.tsx:main()`
- Triggers: DOM ready (index.html loads this file)
- Responsibilities: Parse URL query string for libraryId; migrate old databases if needed; initialize RootStore with backend (SQLite or HTTP); render React tree; set up MobX reactions for persistence

**Server Entry (Headless / Web Build):**
- Location: `src/server/index.ts`
- Triggers: `node onefolder-server` (SEA binary or `yarn dev:server`)
- Responsibilities: Detect SEA mode vs. dev mode; derive paths; load auth credentials; open read-only SQLite DB; build Express app; start HTTP listener

**Library Selector:**
- Location: `src/frontend/containers/LibrarySelector.tsx`
- Triggers: Renderer init detects multiple libraries and no URL `libraryId` param
- Responsibilities: Display list of libraries; allow create/rename/delete/open; call `switchLibrary()` to reload with new ID

## Architectural Constraints

- **Threading:** Single-threaded event loop in both main and renderer. Heavy I/O (file watching, thumbnail generation) runs in Web Workers (`src/frontend/workers/`, `FolderWatcherWorker`).
- **Global state:** No module-level singletons in the store layer (all state lives in RootStore to allow testing). Module-level singletons for workers (thumbnail worker pool in `ThumbnailGeneration.tsx`) and platform API objects (ExifIO is per-RootStore instance, not global).
- **Circular imports:** None detected in critical paths. Stores are wired in RootStore constructor to enforce acyclic dependency graph.
- **Per-library isolation:** All data (SQLite DB, thumbnails, preferences, backups) is per-library. Switching libraries reloads the entire renderer.
- **Platform seam invariant:** Frontend code MUST import `fs`, `path`, `shell`, `RendererMessenger`, `ExifIO` from `src/frontend/platform`, never directly from Node/Electron modules. Violating this breaks the web bundle at compile time.
- **Read-only web build:** HttpBackend and web platform seam throw loudly on all write operations (createTag, saveFiles, removeFiles, etc.). The server opens the SQLite DB in readonly mode. No writes are possible from the browser.
- **Per-library preferences scoping:** localStorage keys for per-library settings (FileStore, UiStore, LocationStore, ExifTool separator) are prefixed with `{libraryId}:`. Global keys (window fullscreen state, editor heights) are unprefixed.

## Anti-Patterns

### Direct Electron/Node imports in frontend code

**What happens:** A component imports `fs-extra` or `electron` directly instead of going through `src/frontend/platform`.
**Why it's wrong:** The web bundle cannot compile; the browser has no `fs` or Electron APIs. The webpack build fails with a hard error about unresolved module dependencies.
**Do this instead:** Import `platform` from `src/frontend/platform` and call `platform.fs.readFile()`, `platform.desktop.shell.openPath()`, etc. The webpack alias selects the right implementation.

### Synchronous database access in the renderer

**What happens:** A component tries to call `await backend.fetchFiles().then(...)` synchronously, or assumes data is immediately available without waiting for the Promise.
**Why it's wrong:** The backend is async by design (better-sqlite3 can block, HTTP is always async). Synchronous access would block the UI thread.
**Do this instead:** Always `await backend` calls or let MobX stores handle the Promise resolution. Stores expose observables; components observe them.

### Bypassing DataStorage for direct DB access

**What happens:** Code reaches past the store layer and calls `better-sqlite3` directly, or constructs SQL queries without going through the backend abstraction.
**Why it's wrong:** The web build cannot compile (better-sqlite3 is Node-only); the abstraction is broken. If a feature needs new DB queries, add them to the DataStorage interface.
**Do this instead:** Add a new method to `src/api/data-storage.ts`, implement it in SQLiteBackend and HttpBackend, and call it from the store layer.

### Holding onto File references across library switches

**What happens:** A store or component caches a FileDTO or File object (MobX-wrapped) across a library switch.
**Why it's wrong:** The file ID may collide with a file in the new library (UUIDs are not globally unique across libraries); the file metadata will be stale; operations on the old File will silently no-op or corrupt state.
**Do this instead:** Always re-fetch files after a library switch. The renderer reload automatically discards all references, so this is enforced by design.

## Error Handling

**Strategy:** Loud, immediate errors that stop execution rather than silent failures or fallbacks.

**Patterns:**
- IPC calls reject with an error message describing what failed (e.g., "No NVENC GPU detected"; "File is outside all registered locations").
- Main process logs errors to console and optionally shows a dialog for user-facing operations.
- Renderer stores catch backend errors and emit them to the UI (toast notifications, error boundaries).
- Media jobs that fail update MediaQueueStore with an error status; the UI shows the failure reason.
- Write operations in web mode throw immediately with a message like "[web] removeFiles: not supported in the read-only web build" — catching these at dev time prevents production bugs.

## Cross-Cutting Concerns

**Logging:** Console logging throughout with `console.log()`, `console.error()`, `console.warn()`, `console.groupCollapsed()`. Development mode logs more detail.

**Validation:** Input validation at the IPC boundary (main process checks path containment, file IDs, library IDs). Data validation in stores before mutation. Server validates all client-supplied paths against registered locations.

**Authentication:** Web server requires Basic Auth header or session cookie on every request. Desktop app (Electron) has no auth — it's a local app with filesystem access.

---

*Architecture analysis: 2026-06-24*
