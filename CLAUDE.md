# Project Overview

OneFolder is a desktop photo management application built with Electron, React, and TypeScript. It follows a "Your files, your folder, forever" philosophy — photos remain as ordinary files with organization data stored in standard EXIF/XMP metadata.

# Workflow Routing (migration in progress)

This project is migrating from a homegrown investigation/task pipeline to **OpenSpec** (spec-driven development). Until the migration completes:

- **All NEW bugs and features go through OpenSpec.** Use `/opsx:explore` to investigate/clarify, then `/opsx:propose` to create the change (proposal + design + tasks + delta specs), `/opsx:apply` to implement, and `/opsx:sync` → `/opsx:archive` to merge specs and finalize. `openspec/specs/**` is the living source of truth; in-flight changes live in `openspec/changes/`. `/opsx:explore` is the new "investigate first" step (it replaces the `task-writer` root-cause phase for new work).
- **The `docs/TODO/` pipeline is FROZEN for new work.** Its agents (`task-writer`, `task-runner`, `task-closer`) are used **only** to finish items already in `docs/TODO/backlog/`, `pending_qa/`, or `completed/`. Do not create new investigations/tasks there. (`bomb-squad` remains available for ad-hoc root-cause analysis.)
- When `docs/TODO/backlog/` and `docs/TODO/pending_qa/` are empty, the old pipeline is retired and OpenSpec becomes the sole workflow.
- Carry the manual-QA evidence gate forward: any OpenSpec task needing Windows/GUI verification is marked `REQUIRES MANUAL EXECUTION` and requires concrete evidence before it is considered done (see `docs/TODO/QA-DISCIPLINE.md`).

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

Additional build targets for the web SPA (see `docs/headless-web-build.md`):

```bash
yarn dev:web            # webpack --watch, web SPA (output: dist-web/)
yarn build:web          # production web SPA build (also run by `yarn build`)
```

The sidecar server is **not a separate binary**. It runs inside the portable
executable: `OneFolder-<version>-x64.exe --serve [--port <n>]` starts the read-only web server in
the same portable context instead of opening the desktop GUI. Authentication is
optional — with no `ONEFOLDER_AUTH_SECRET` / `ONEFOLDER_AUTH_USER` +
`ONEFOLDER_AUTH_PASSWORD` configured the server runs open, binds all interfaces,
and discloses that in its startup banner. Serve mode logs to `data\server.log`,
because a GUI-subsystem binary's stdout does not reliably reach a console.

# Documentation

Project documentation lives in `docs/` — read relevant docs before making changes to understand design decisions and system behavior.

Task tracking for NEW work uses **OpenSpec** (`openspec/`, `/opsx:*` commands) — see "Workflow Routing" above. The legacy `docs/TODO/` investigation/task pipeline is frozen to in-flight items only.
