# Project Overview

OneFolder is a desktop photo management application built with Electron, React, and TypeScript. It follows a "Your files, your folder, forever" philosophy — photos remain as ordinary files with organization data stored in standard EXIF/XMP metadata.

# Architecture

- **Electron main process** (`src/main.ts`) — Window management, native APIs, IPC handlers
- **Library abstraction** (`src/api/library.ts`, `common/library-registry.ts`) — First-class "library" concept that scopes the SQLite database, preferences, thumbnails, and backups per library; the registry lives at `{userData}/libraries.json` (see `docs/multi-library.md`)
- **React renderer** (`src/renderer.tsx`) — UI layer with MobX state management
- **IPC layer** (`src/ipc/`) — Type-safe messaging between main and renderer
- **Backend** (`src/backend/`) — IndexedDB via Dexie for data persistence
- **API** (`src/api/`) — DTOs and data storage interfaces
- **Frontend** (`src/frontend/`) — React components, MobX stores, image loaders
- **Common** (`common/`) — Shared utilities (ExifTool, filesystem, config)
- **Widgets** (`widgets/`) — Custom UI component library
- **WASM** (`wasm/`) — Rust-compiled WebAssembly modules (masonry layout, EXR decoder)

Key technologies: Electron 27, React 18, MobX 6, TypeScript 4.9, Dexie 3, Chokidar, ExifTool, Sharp, TensorFlow.js

# Conventions

- Use TypeScript strict mode throughout
- MobX observables for state; `@observer` HOC for React components
- DTO objects define all API contracts (FileDTO, LocationDTO, TagDTO)
- Web Workers for heavy processing (file watching, thumbnail generation)
- SCSS for styling
- Follow existing patterns in neighboring code before writing new code

# Development

```bash
yarn install       # Install dependencies
yarn dev           # Webpack watch mode
yarn start         # Launch Electron app (in separate terminal)
yarn lint          # ESLint with auto-fix
yarn test          # Jest tests
yarn build         # Production build
yarn package       # Build + electron-builder for platform
```

# Platform Seam / Web Build

Frontend code must import platform capabilities (filesystem, path, shell, RendererMessenger, ExifIO) from **`src/frontend/platform`** — never directly from `fs-extra`, `electron`, `path` (Node), or `common/ExifIO`. Violating this invariant breaks the web bundle at compile time.

A webpack alias selects `platform.electron.ts` (faithful pass-through) or `platform.web.ts` (HTTP-backed stubs + loud rejects for writes) at bundle time. The Electron desktop build is unaffected.

Additional build targets for the headless sidecar web build (see `docs/headless-web-build.md`):

```bash
yarn dev:web            # webpack --watch, web SPA (output: dist-web/)
yarn dev:server         # ts-node src/server/index.ts (server from source)
yarn build:web          # production web SPA build
yarn build:server       # production Node server bundle
yarn package:headless   # build both + produce dist-headless/ SEA binary
```

# Documentation

Project documentation lives in `docs/` — read relevant docs before making changes to understand design decisions and system behavior.

Task tracking uses `docs/TODO/` with investigations and tasks managed by the agent workflow.
