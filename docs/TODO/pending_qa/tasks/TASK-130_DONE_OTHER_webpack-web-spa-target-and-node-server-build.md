---
id: TASK-130
title: 'Add webpack web SPA target (browser shims, exclude server-only code) and a Node server build'
investigation: INV-034
status: done
priority: high
blocked_by: [TASK-127]
date_created: 2026-06-20
date_completed: 2026-06-22
files:
  - 'webpack.web.js (new — browser SPA target)'
  - 'webpack.server.js (new — Node server build) OR ts build for src/server'
  - 'webpack.prod.js (platform alias wiring)'
  - 'webpack.dev.js (platform alias + dev:web)'
  - 'package.json (scripts: dev:web, build:web, build:server)'
  - 'src/frontend/platform/platform.web.ts (alias target for web)'
---

## What

Add a new webpack **web SPA target** (`webpack.web.js`, `target: 'web'`) that builds the pure-browser bundle: aliases `src/frontend/platform` → `platform.web.ts`, shims/excludes Node modules (`fs-extra`, `path`, `better-sqlite3`, `electron`, `node-stream-zip`, `chokidar`, `crypto`, `original-fs`), shims the `process` global via DefinePlugin, and excludes server-only modules (`src/server/**`, `src/backend/sqlite-*`). Add a Node build for the sidecar server. This is what makes the seam from TASK-126/127 actually produce a compilable browser bundle.

## Why

The only renderer target today is `electron-renderer` (`webpack.prod.js:64`), which permits Node imports. A `web` target with browser resolution is required to compile the SPA, and a server build is required to ship the sidecar. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Requirement 8; Blast Radius 12; Root Cause item 7).

## Implementation Steps

- [x] 1. Create `webpack.web.js` cloning the renderer config but with `target: 'web'`, entry `./src/renderer.tsx`, and a separate output dir (e.g. `build-web/`). Reuse the SCSS/SVG/WASM/asset rules.
- [x] 2. Set `resolve.alias` to point `src/frontend/platform` → `platform.web.ts`, and alias/`fallback: false` the Node-only modules (`fs`, `fs-extra`, `path`, `better-sqlite3`, `electron`, `node-stream-zip`, `chokidar`, `original-fs`, `crypto`) so they are not bundled. `path-browserify` is not installed; `path` aliased to false and the renderer.tsx static import stubbed via NormalModuleReplacementPlugin. Remove the `better-sqlite3`/`fsevents` `externals` (those are Electron-only).
- [x] 3. Add `DefinePlugin` to inject `IS_WEB_BUILD=true`, `process.platform='web'`, `process.env.NODE_ENV`, and `process.type` (Blast Radius 10).
- [x] 4. Keep the WASM rules (masonry) and `experiments.asyncWebAssembly`. COOP/COEP kept in the served HTML (`src/index.html`) — not added as meta tags; server sends the headers (TASK-128).
- [x] 5. Add `webpack.server.js` with `target: 'node'`, entry `./src/server/index.ts`, `externals` for `better-sqlite3`/sharp/native `.node` files. Output to `dist-server/`. Used webpack (not tsc) for consistency with existing config patterns and to produce a single deployable bundle for TASK-133 packaging. `node: { __dirname: false }` preserves real filesystem __dirname so server can locate dist-web/ at runtime.
- [x] 6. Added `package.json` scripts: `build:web`, `build:server`, `dev:web`. Electron `dev`/`production` scripts and their platform alias (→ `platform.electron.ts`) are untouched.
- [ ] 7. Build the web bundle and confirm **zero** Node/Electron module resolution errors (this is the proof the seam is complete; any failure names a file TASK-126 missed). DEFERRED to end-of-run batch build pass per standing instruction.

## Done When

- [ ] `yarn build:web` produces a browser bundle with no `fs`/`electron`/`better-sqlite3` import errors.
- [ ] `yarn build:server` produces a runnable Node server bundle (native deps externalized).
- [ ] The electron `production`/`dev` builds and their platform alias resolve to `platform.electron.ts` and are unchanged.
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** run the portable desktop build from the unchanged electron target and confirm identical behavior. Capture evidence.
