# Codebase Structure

**Analysis Date:** 2026-06-24

## Directory Layout

```
OneFolder/
├── src/                          # Electron main + renderer source (TypeScript)
│   ├── main.ts                   # Electron main process entry
│   ├── renderer.tsx              # Renderer entry; RootStore initialization
│   ├── style.scss                # Global styles
│   │
│   ├── api/                      # Data DTOs and interfaces
│   │   ├── data-storage.ts       # DataStorage interface (backend abstraction)
│   │   ├── data-storage-search.ts # Search criteria types
│   │   ├── file.ts               # FileDTO
│   │   ├── tag.ts                # TagDTO
│   │   ├── location.ts           # LocationDTO
│   │   ├── library.ts            # LibraryDTO
│   │   ├── file-search.ts        # FileSearchDTO
│   │   ├── visual-hash.ts        # VisualHashDTO (duplicate detection)
│   │   ├── dismissed-duplicate-group.ts
│   │   ├── data-backup.ts        # DataBackup interface
│   │   └── id.ts                 # ID type
│   │
│   ├── backend/                  # Data persistence layer (two implementations)
│   │   ├── backend.ts            # Shared backend utilities
│   │   ├── sqlite-backend.ts     # SQLite implementation (Electron)
│   │   ├── sqlite-config.ts      # SQLite schema, initialization
│   │   ├── sqlite-backup-scheduler.ts
│   │   ├── http-backend.ts       # HTTP implementation (web SPA)
│   │   ├── backup-scheduler.ts   # Backup scheduling interface
│   │   ├── config.ts             # Database configuration
│   │   ├── migration-indexeddb-to-sqlite.ts
│   │   └── README.md
│   │
│   ├── ipc/                      # Type-safe IPC messaging
│   │   ├── main.ts               # Main process handlers
│   │   ├── renderer.ts           # Renderer side caller (RendererMessenger)
│   │   └── messages.ts           # Message type definitions
│   │
│   ├── media/                    # FFmpeg job execution (Electron main only)
│   │   ├── FfmpegRunner.ts       # Low-level ffmpeg process + progress parsing
│   │   ├── MediaJobService.ts    # Mid-level job queue + dispatcher
│   │   ├── audioArgs.ts          # FFmpeg audio codec selection logic
│   │   └── subtractClip.ts       # FFmpeg filter for clip subtraction
│   │
│   ├── frontend/                 # React renderer + stores (runs in both Electron and web)
│   │   ├── App.tsx               # Root React component
│   │   ├── Preview.tsx           # Preview window app (Electron only)
│   │   ├── Overlay.tsx           # Overlay container
│   │
│   │   ├── platform/             # Platform seam (build-time abstraction)
│   │   │   ├── index.ts          # Interface definitions (PlatformFs, PlatformPath, etc.)
│   │   │   ├── platform.electron.ts # Electron implementation (pass-through)
│   │   │   └── platform.web.ts   # Web implementation (HTTP stubs + reads)
│   │
│   │   ├── stores/               # MobX state management
│   │   │   ├── RootStore.ts      # Factory; lifecycle (main + preview variants)
│   │   │   ├── FileStore.ts      # Files + selection, sorting, filtering
│   │   │   ├── TagStore.ts       # Tag tree operations
│   │   │   ├── LocationStore.ts  # Folders + file watching
│   │   │   ├── UiStore.ts        # Theme, layout, preferences, shortcuts
│   │   │   ├── SearchStore.ts    # Saved search definitions
│   │   │   ├── MediaQueueStore.ts # FFmpeg job progress
│   │   │   └── README.MD
│   │
│   │   ├── containers/           # Feature-level React containers
│   │   │   ├── App/              # (not used; App is at frontend/App.tsx)
│   │   │   ├── Main.tsx          # Layout hub (outliner + content view + inspector)
│   │   │   ├── AppToolbar.tsx    # Top toolbar
│   │   │   ├── ContentView/      # Gallery view (masonry + slide mode)
│   │   │   │   ├── Masonry/
│   │   │   │   └── SlideMode/
│   │   │   ├── Inspector/        # File details panel (right sidebar)
│   │   │   ├── Outliner/         # Left sidebar (locations, tags, searches, buttons)
│   │   │   │   ├── LocationsPanel/
│   │   │   │   ├── TagsPanel/
│   │   │   │   ├── SavedSearchesPanel/
│   │   │   │   └── NavigationPanel/
│   │   │   ├── MediaQueue/       # FFmpeg job queue (bottom drawer)
│   │   │   ├── Settings/         # Preferences dialog
│   │   │   ├── AdvancedSearch/   # Query builder dialog
│   │   │   ├── LibrarySelector.tsx # Multi-library UI
│   │   │   ├── SplashScreen.tsx  # Loading screen
│   │   │   ├── ErrorBoundary.tsx # Error UI
│   │   │   ├── About.tsx         # About dialog
│   │   │   ├── WindowTitlebar.tsx # macOS traffic light customization
│   │   │   ├── HelpCenter.tsx    # Help & shortcuts
│   │   │   └── PopupWindow.tsx   # Popup window wrapper
│   │
│   │   ├── components/           # Reusable React components
│   │   │   ├── FileTag.tsx
│   │   │   ├── FileInput.tsx
│   │   │   ├── Collapse.tsx
│   │   │   ├── TagSelector.tsx
│   │   │   ├── Toaster.tsx       # Toast notifications
│   │   │   ├── RemovalAlert.tsx
│   │   │   ├── ExternalLink.tsx
│   │   │   ├── ImageInfo.tsx
│   │   │   ├── ImageTools.tsx
│   │   │   ├── ImageDates.tsx
│   │   │   ├── ImageParameters.tsx
│   │   │   ├── ImageDescription.tsx
│   │   │   ├── ImagePrompt.tsx
│   │   │   ├── ImageMap.tsx
│   │   │   └── PopupWindow.tsx
│   │
│   │   ├── image/                # Thumbnail and format handling
│   │   │   ├── ImageLoader.ts    # Format decoder selection + loading
│   │   │   ├── ThumbnailGeneration.tsx # Worker pool orchestration
│   │   │   ├── HEICLoader.ts     # HEIC format decoder
│   │   │   ├── PSDLoader.ts      # PSD format decoder
│   │   │   ├── TifLoader.ts      # TIFF format decoder
│   │   │   ├── ExrLoader.ts      # OpenEXR format decoder (WASM)
│   │   │   ├── aiModels.ts       # TensorFlow.js models
│   │   │   ├── MediaReleaseCoordinator.ts # Playback lifecycle
│   │   │   ├── util.ts           # Image utility functions
│   │   │   └── videoFreezeRecovery.ts
│   │
│   │   ├── workers/              # Web Worker scripts
│   │   │   └── folderWatcher.worker.ts # Chokidar file watching
│   │
│   │   ├── contexts/             # React contexts
│   │   │   ├── StoreContext.tsx  # RootStore provider
│   │   │   └── DropContext.tsx   # Drag-drop context
│   │
│   │   ├── hooks/                # Custom React hooks
│   │   │   ├── useStore.ts       # Access RootStore from context
│   │   │   ├── useCustomTheme.tsx
│   │   │   └── useClipboardImporter.ts
│   │
│   │   ├── utils/                # Frontend utilities
│   │   │   ├── class-name.ts
│   │   │   ├── scroll.ts
│   │   │   └── (other helpers)
│   │
│   │   ├── data/                 # Frontend data helpers
│   │   │   └── (data transform utilities)
│   │
│   │   ├── entities/             # Frontend entity wrappers (MobX-enabled)
│   │   │   └── (observable File, Tag, Location classes)
│   │
│   │   └── styles/ (if separated)
│   │
│   └── renderer-migration.ts     # Multi-library migration logic
│
├── common/                       # Shared utilities (used by main, renderer, server)
│   ├── ExifIO.ts                # EXIF/XMP read/write via native exiftool
│   ├── library-registry.ts      # LibraryRegistry class + path helpers
│   ├── fs.ts                    # Filesystem utilities
│   ├── config.ts                # Configuration reading
│   ├── process.ts               # Process detection (IS_DEV, portable mode)
│   ├── window.ts                # Window constants
│   ├── core.ts                  # Core utilities
│   ├── fmt.ts                   # Formatting utilities (HMS → seconds, etc.)
│   ├── promise.ts               # Promise utilities
│   └── timeout.ts               # Timeout utilities
│
├── server/                       # Headless / web server (Node.js only, never bundled with Electron)
│   ├── index.ts                 # Express app initialization + HTTP listener
│   ├── auth.ts                  # Auth middleware + login/logout router
│   ├── path-resolver.ts         # Validates paths against registered locations
│   ├── thumbnails.ts            # Thumbnail generation + caching
│   ├── decode.ts                # DOM-less decoders (HEIC, PSD, EXR via WASM)
│   └── routes/
│       ├── data.ts              # /api/files, /api/tags, /api/locations, etc.
│       ├── images.ts            # /api/original/:id, /api/thumb/:id, /api/preview/:id
│       ├── metadata.ts          # /api/metadata/:id/*, /api/metadata/by-path/*
│       └── rescan.ts            # POST /api/rescan
│
├── wasm/                         # Rust → WebAssembly modules
│   ├── packages/
│   │   ├── masonry/             # Layout algorithm
│   │   └── exr/                 # OpenEXR decoder
│   └── (Rust source + build config)
│
├── widgets/                      # Custom UI component library (React)
│   ├── button.tsx
│   ├── checkbox.tsx
│   ├── radio.tsx
│   ├── combobox/
│   ├── menus/
│   ├── popovers/
│   ├── notifications/
│   ├── split.tsx
│   ├── tag.tsx
│   ├── toolbar.tsx
│   ├── tree.tsx
│   ├── MultiSplit/
│   ├── utility/
│   ├── icons.tsx
│   ├── KeyCombo.tsx
│   └── README.md
│
├── docs/                        # Project documentation (design, decisions, tasks)
│   ├── index.md                # Documentation index
│   ├── README.md               # Overview
│   ├── multi-library.md        # Multi-library architecture
│   ├── headless-web-build.md  # Web SPA + headless server
│   ├── thumbnail-generation.md
│   ├── metadata-sync-implementation.md
│   ├── location-loading.md
│   ├── create-clip.md
│   ├── reencode-x264.md
│   ├── rotate-video.md
│   ├── subtract-clip.md
│   ├── normalize-audio.md
│   ├── missing-files.md
│   ├── metadata-refactoring.md
│   ├── personal-fork-notes.md
│   └── TODO/                   # Task tracking
│       ├── backlog/
│       ├── pending_qa/
│       └── archive/
│
├── build/                       # Electron app packaging config
│
├── resources/                   # Static assets
│   ├── logo/
│   ├── exiftool/               # Bundled exiftool binary + config
│   └── (icon files)
│
├── declarations/                # TypeScript type stubs
│
├── .vscode/                     # VS Code settings
│
├── .github/                     # GitHub Actions CI
│
├── .claude/                     # Claude Code project settings
│   └── skills/                 # Project-specific skills (if any)
│
├── .planning/                   # GSD planning artifacts
│   └── codebase/               # Codebase analysis docs (this file)
│
├── data/                        # Local development data (gitignored, created at runtime)
│
├── webpack.dev.js              # Webpack dev config (Electron renderer)
├── webpack.prod.js             # Webpack prod config (Electron renderer)
├── webpack.web.js              # Webpack web config (web SPA)
├── webpack.server.js           # Webpack server config (Node server)
├── tsconfig.json               # TypeScript configuration
├── jest.config.js              # Jest test configuration
├── .eslintrc.json              # ESLint configuration
├── .prettierrc.json            # Prettier formatting config
├── package.json                # Dependencies, scripts, metadata
├── CLAUDE.md                   # Project instructions (read first!)
├── README.md                   # Project overview
├── LICENSE                     # ISC license
└── portable.txt                # Marker file for portable builds (created at build time)
```

## Directory Purposes

**src/**
- Contains all application source code (TypeScript).
- Compiled by webpack into `dist/` (Electron) or `dist-web/` (web SPA) or `dist-server/` (Node server).

**src/api/**
- Data contracts (DTOs, interfaces) — no implementation.
- Defines the shape of files, tags, locations, libraries, search criteria, visual hashes.
- Used by both backend and frontend to ensure type safety.

**src/backend/**
- Persistence layer implementations.
- SQLiteBackend for Electron (uses better-sqlite3); HttpBackend for web SPA (fetch-based).
- Implements the DataStorage interface.

**src/ipc/**
- Electron inter-process communication.
- Type-safe async message definitions and handlers.
- Main process registers handlers; renderer calls them via RendererMessenger.

**src/media/**
- FFmpeg orchestration (Electron main process only).
- FfmpegRunner: low-level process spawning and progress parsing.
- MediaJobService: queuing and job lifecycle management.

**src/frontend/**
- React UI + MobX stores.
- Compiled into both Electron and web SPA bundles.
- Imports OS/Node capabilities exclusively through `src/frontend/platform` to enable web builds.

**src/frontend/platform/**
- **build-time seam** — two implementations selected by webpack alias.
- Electron: faithful pass-through to fs-extra, path, shell, RendererMessenger, ExifIO.
- Web: HTTP-backed reads, browser stubs, loud rejects for writes.
- Enforced invariant: frontend code MUST import from here, never directly from Node/Electron.

**src/frontend/stores/**
- MobX observable stores managing UI and data state.
- RootStore is the factory; child stores (FileStore, TagStore, etc.) are composed into it.
- All mutations go through MobX actions; all reads are via @observable or @computed.

**src/frontend/containers/**
- Feature-level React components (compound components that own state or handle complex UI).
- App, Main, ContentView (masonry/slide modes), Inspector, Outliner (with sub-panels), Settings, MediaQueue, AdvancedSearch, LibrarySelector.

**src/frontend/components/**
- Reusable, presentational React components.
- No store dependency; accept props from parent containers.

**src/frontend/image/**
- Thumbnail generation, format detection, decoder selection.
- ImageLoader: facade that delegates to format-specific loaders (HEICLoader, PSDLoader, etc.).
- ThumbnailGeneration: Web Worker pool management.
- MediaReleaseCoordinator: lifecycle management for active media playback.

**src/frontend/workers/**
- Web Worker scripts (run in separate threads to keep renderer responsive).
- folderWatcher.worker.ts: Chokidar file watching for location changes.

**common/**
- Shared code used by main process, renderer, and server.
- ExifIO (metadata read/write).
- LibraryRegistry (multi-library management + path derivation).
- Filesystem, process detection, formatting utilities.
- **NOT** compiled separately — included in each target's webpack config.

**server/**
- Headless Node.js server for the web SPA.
- Entry: index.ts (Express app setup, SQLite open in readonly mode, HTTP listener).
- Routes: /api/files, /api/tags, /api/locations, /api/images, /api/metadata, /api/auth.
- Decoders: HEIC/TIFF (Sharp), PSD (ag-psd), EXR (WASM).
- **NEVER** bundled with Electron — runs as a separate Node server or SEA binary.

**wasm/**
- Rust source compiled to WebAssembly modules.
- masonry/: Layout algorithm for the gallery view.
- exr/: OpenEXR image format decoder.
- Linked into both Electron and web SPA bundles.

**widgets/**
- Custom UI component library (React).
- Buttons, checkboxes, radios, comboboxes, menus, popovers, trees, icons, etc.
- No MobX dependency; purely presentational.

**docs/**
- Project documentation (design decisions, feature explanations, architecture notes).
- **Read CLAUDE.md before modifying any code.** It describes conventions and philosophy.
- **Read multi-library.md before touching library registry or path handling.**
- **Read headless-web-build.md before touching the platform seam or server routes.**
- TODO/: Task tracking (investigations, tasks, backlog, pending_qa, archive).

**build/, resources/, declarations/, .vscode/, .github/**, **.claude/, .planning/**
- Configuration, assets, type stubs, CI/CD, tooling.

## Key File Locations

**Entry Points:**
- `src/main.ts` — Electron main process; window creation, IPC setup, media job handling
- `src/renderer.tsx` — Renderer initialization; library selection, RootStore creation, React mounting
- `src/server/index.ts` — Headless server; Express app bootstrap, DB open, HTTP listener startup

**Configuration:**
- `src/backend/sqlite-config.ts` — SQLite schema, initialization, WAL settings
- `src/frontend/platform/index.ts` — Platform interface definitions
- `tsconfig.json` — TypeScript strict mode settings
- `webpack.dev.js`, `webpack.prod.js`, `webpack.web.js`, `webpack.server.js` — Build configurations
- `package.json` — Dependencies (Electron 27, React 18, MobX 6, TypeScript 4.9, Dexie 3, Sharp, ExifTool, TensorFlow.js)

**Core Logic:**
- `src/frontend/stores/RootStore.ts` — Store orchestration and lifecycle
- `src/frontend/stores/FileStore.ts` — File list, selection, sorting, filtering, mutations
- `src/api/data-storage.ts` — Backend abstraction interface
- `src/backend/sqlite-backend.ts` — SQLite CRUD implementation
- `src/backend/http-backend.ts` — HTTP REST client
- `common/library-registry.ts` — Multi-library registry + path derivation
- `common/ExifIO.ts` — EXIF/XMP metadata operations

**Testing:**
- `jest.config.js` — Jest configuration
- `*.test.ts`, `*.spec.ts` — Test files (co-located with source)

**Platform Seam (Critical):**
- `src/frontend/platform/index.ts` — Interface
- `src/frontend/platform/platform.electron.ts` — Desktop implementation
- `src/frontend/platform/platform.web.ts` — Browser implementation
- Webpack aliases in `webpack.dev.js`, `webpack.prod.js` (select electron), `webpack.web.js` (select web)

## Naming Conventions

**Files:**
- React components: `PascalCase.tsx` (e.g., `FileTag.tsx`, `Inspector.tsx`)
- Stores: `PascalCase.ts` with `export default` (e.g., `FileStore.ts`)
- Utilities: `camelCase.ts` (e.g., `util.ts`, `fmt.ts`)
- Worker scripts: `*.worker.ts` (e.g., `folderWatcher.worker.ts`)
- DTOs/types: `PascalCase.ts` (e.g., `file.ts`, `tag.ts`)
- Test files: `*.test.ts` or `*.spec.ts` (co-located)

**Directories:**
- Feature containers: `containers/FeatureName/` (e.g., `ContentView/`, `Outliner/`)
- Component groups: `components/` (flat or grouped by feature)
- Store: `stores/` (flat; one file per store)
- Utilities: `utils/` (camelCase subdir names)
- Data models/entities: `entities/` (observable wrappers around DTOs)

**TypeScript classes & types:**
- Classes: `PascalCase` (e.g., `FileStore`, `RootStore`, `ExifIO`)
- Interfaces: `PascalCase` or `PascalCaseInterface` (e.g., `DataStorage`, `Platform`)
- Enums: `PascalCase` (e.g., `WindowSystemButtonPress`)
- Type aliases: `PascalCase` or `camelCase` depending on scope (e.g., `FileDTO`, `OrderBy<T>`)
- Functions: `camelCase` (e.g., `getThumbnail`, `fetchFiles`, `createTag`)
- Variables: `camelCase` (e.g., `isOpen`, `selectedFileIds`, `libraryId`)

**CSS / SCSS:**
- Files: `component-name.scss` or `feature.module.scss`
- Class names: `kebab-case` (e.g., `.file-list`, `.inspector-panel`)
- BEM convention for nested elements: `.block__element--modifier`

## Where to Add New Code

**New Feature (e.g., "Add watermark tool"):**
- **Store logic:** Add methods to `FileStore` or a new store class in `src/frontend/stores/`
- **React UI:** Add a container in `src/frontend/containers/` and components in `src/frontend/components/`
- **IPC (if main process work needed):** Add message type in `src/ipc/messages.ts`, handler in `src/ipc/main.ts`, caller in `src/ipc/renderer.ts`
- **Media job (if FFmpeg involved):** Add job type to `MEDIA_JOB_SPECS` in `src/main.ts`; implement args in `src/media/`
- **Backend (if new database queries):** Add method to `DataStorage` interface in `src/api/data-storage.ts`; implement in `SQLiteBackend` and `HttpBackend`
- **Tests:** Add `*.test.ts` files co-located with the feature code

**New Utility:**
- Filesystem: Add to `common/fs.ts` or `src/frontend/platform/`
- UI helpers: Add to `src/frontend/utils/`
- Data transforms: Add to `src/frontend/data/` or `common/fmt.ts`
- Tests: Create `*.test.ts` alongside

**New Component:**
- Presentational: `src/frontend/components/ComponentName.tsx`
- Feature/container: `src/frontend/containers/FeatureName/`
- Widget (reusable UI): `widgets/component-name.tsx`

**New Database Entity:**
- DTO: `src/api/entity-name.ts` (interface only, no logic)
- Store method: Add CRUD methods to `DataStorage` in `src/api/data-storage.ts`
- Backend: Implement in `src/backend/sqlite-backend.ts` and `src/backend/http-backend.ts`
- Server route (web build): Add to `src/server/routes/`

**Multi-library concern:**
- If localStorage-based preferences need per-library scoping, use the `getStorageKey(libraryId)` helper pattern (see `FileStore`, `UiStore`).
- Per-library data goes under `{userData}/libraries/{libraryId}/`; shared data goes at `{userData}/`.
- Always tear down resources in `RootStore.close()` during library switches (ExifTool, Chokidar watchers, etc.).

**Platform seam invariant:**
- Any code that needs filesystem, path, shell, or ExifIO in the renderer MUST import from `src/frontend/platform`.
- The webpack alias selects `platform.electron.ts` (desktop) or `platform.web.ts` (browser) at build time.
- Violating this breaks the web bundle. Code reviewers should flag direct `fs-extra`, `path`, `electron`, `common/ExifIO` imports in frontend files.

**Web build considerations:**
- All write operations in HttpBackend throw loudly with a message like "[web] method: not supported".
- Server routes validate all client-supplied paths against registered locations before serving images or metadata.
- Image decoding happens server-side (Sharp, ag-psd, WASM); clients receive ready-to-display images.
- No Chokidar file watching in web mode; client calls `POST /api/rescan` on demand.

## Special Directories

**data/:**
- Purpose: Local development artifacts (gitignored).
- Generated: Yes (at runtime).
- Committed: No.
- Contains: Test photos, temporary thumbnails, development databases.

**.planning/codebase/:**
- Purpose: GSD (Ghost Semen Doll?) codebase analysis documents (ARCHITECTURE.md, STRUCTURE.md, CONVENTIONS.md, TESTING.md, CONCERNS.md, STACK.md, INTEGRATIONS.md).
- Generated: By gsd-map-codebase skill.
- Committed: Yes (for reference by gsd-plan-phase and gsd-execute-phase).

**docs/TODO/:**
- Purpose: Task tracking (investigations, tasks, backlog, pending_qa, archive).
- Generated: By gsd agents and user task-writer.
- Committed: Yes (history of decisions).

**build/:**
- Purpose: electron-builder configuration and output.
- Generated: Yes (during `yarn package`).
- Committed: Config files yes; artifacts no.

**dist/, dist-web/, dist-server/, dist-headless/:**
- Purpose: Build output.
- Generated: Yes (webpack compilation).
- Committed: No (always rebuild from source).

---

*Structure analysis: 2026-06-24*
