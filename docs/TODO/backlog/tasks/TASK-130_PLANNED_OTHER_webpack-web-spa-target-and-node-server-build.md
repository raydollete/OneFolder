---
id: TASK-130
title: 'Add webpack web SPA target (browser shims, exclude server-only code) and a Node server build'
investigation: INV-034
status: planned
priority: high
blocked_by: [TASK-127]
date_created: 2026-06-20
date_completed:
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

- [ ] 1. Create `webpack.web.js` cloning the renderer config but with `target: 'web'`, entry `./src/renderer.tsx`, and a separate output dir (e.g. `build-web/`). Reuse the SCSS/SVG/WASM/asset rules.
- [ ] 2. Set `resolve.alias` to point `src/frontend/platform` → `platform.web.ts`, and alias/`fallback: false` the Node-only modules (`fs`, `fs-extra`, `path`→`path-browserify`, `better-sqlite3`, `electron`, `node-stream-zip`, `chokidar`, `original-fs`, `crypto`) so they are not bundled. Remove the `better-sqlite3`/`fsevents` `externals` (those are Electron-only).
- [ ] 3. Add `DefinePlugin` to inject the web-mode flag (consumed by `src/renderer.tsx` TASK-127) and a `process.platform` value (Blast Radius 10).
- [ ] 4. Keep the WASM rules (masonry, EXR client side is not needed for read-only, but masonry IS) and `experiments.asyncWebAssembly`. Keep COOP/COEP via the served HTML (TASK-128) rather than the meta tags.
- [ ] 5. Add a Node server build (`webpack.server.js` with `target: 'node'`, entry `./src/server/index.ts`, `externals` for `better-sqlite3`/native deps) or a tsc build for `src/server`. Output to `build-server/`.
- [ ] 6. Add `package.json` scripts: `build:web`, `build:server`, and `dev:web` (web webpack watch). Confirm the electron `dev`/`production` scripts and their alias (→ `platform.electron.ts`) are untouched.
- [ ] 7. Build the web bundle and confirm **zero** Node/Electron module resolution errors (this is the proof the seam is complete; any failure names a file TASK-126 missed).

## Done When

- [ ] `yarn build:web` produces a browser bundle with no `fs`/`electron`/`better-sqlite3` import errors.
- [ ] `yarn build:server` produces a runnable Node server bundle (native deps externalized).
- [ ] The electron `production`/`dev` builds and their platform alias resolve to `platform.electron.ts` and are unchanged.
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** run the portable desktop build from the unchanged electron target and confirm identical behavior. Capture evidence.
