---
id: TASK-133
title: 'Package headless build as a single binary (Node SEA or pkg) shipping better-sqlite3 .node + exiftool alongside'
investigation: INV-034
status: done
priority: medium
blocked_by: [TASK-130, TASK-131, TASK-132]
date_created: 2026-06-20
date_completed: 2026-06-22
files:
  - 'package.json (scripts + packaging config)'
  - 'scripts/package-headless.js (new — SEA/pkg orchestration)'
  - 'src/server/index.ts (launch-time path re-derivation)'
  - 'common/ExifIO.ts (optional exiftoolPath constructor param for SEA-safe path)'
---

## What

Package the sidecar server + built SPA assets + native/external resources into **one launchable binary** using Node SEA (or `pkg`). Native modules (`better-sqlite3` `.node`) and the exiftool binary cannot be inlined into a JS bundle, so they ship **alongside** the exe and paths are re-derived at launch — mirroring the existing `asarUnpack`/`extraResources` config in `package.json`.

## Why

The deliverable is a single binary a user runs on the machine holding the library. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Requirement 7; Blast Radius 13; Risks 3).

## Implementation Steps

- [x] 1. Choose Node SEA (preferred, no extra dep) or `pkg`. Create `scripts/package-headless.js` that: builds the server (`build:server`) and SPA (`build:web`), assembles an output dir with the binary, the SPA assets, `better-sqlite3`'s prebuilt `.node`, and the exiftool binary + config (`resources/exiftool/*`).
  - Chose **Node SEA**: Node v24 ships SEA as a first-class feature (no extra dep). `pkg`/`@yao-pkg/pkg` is in maintenance mode and requires an extra dep.
  - `scripts/package-headless.js` created: runs `build:server` + `build:web`, generates SEA config, copies node binary, strips signature (Windows), injects blob via `postject`, copies `dist-web/`, `resources/exiftool/`, `node_modules/better-sqlite3/build/Release/better_sqlite3.node`, and `node_modules/@img/sharp-*/lib/` (node + DLLs). Writes `portable.txt` marker.
  - `postject` added to devDependencies in `package.json`.
- [x] 2. In `src/server/index.ts`, re-derive all resource paths at launch relative to the binary location (not `__dirname` inside a bundle): SPA asset dir, exiftool path (replace `getExtraResourcePath` for the server context), thumbnail/preview cache dir, library/db path. Consistent with the portable-only fork's launch-time path logic.
  - Added `isSea()` helper using `node:sea` API (try/catch for compat), evaluated to `IS_SEA` constant.
  - Added `resolveExeDir()`: returns `path.dirname(process.execPath)` when SEA, otherwise `__dirname`-relative repo root (preserves dev/ts-node behavior).
  - Added `resolveExiftoolPath(exeDir)`: builds `<exeDir>/resources/exiftool/exiftool[.exe|.pl]` — replaces `getExtraResourcePath` in the server context.
  - Updated `resolveUserDataPath` to accept `exeDir` param and use it for portable detection, eliminating its own `__dirname` usage.
  - Updated `spaDir` from `path.resolve(__dirname, '..', '..', 'dist-web')` to `path.join(exeDir, 'dist-web')`.
  - Updated thumbnail `portableDir` from `path.resolve(__dirname, '..', '..')` to `exeDir`.
  - Passes derived `exiftoolPath` to `new ExifIO('|', exiftoolPath)`.
  - Dev (ts-node / plain node) path unchanged: `isSea()` returns false, `resolveExeDir()` returns repo root via `__dirname`.
- [x] 3. Mirror the existing native-resource shipping: the `.node` and exiftool sit beside the exe exactly as `asarUnpack`/`extraResources` do for the Electron build.
  - `scripts/package-headless.js` copies: `better_sqlite3.node` to `node_modules/better-sqlite3/build/Release/`, `@img/sharp-*/lib/` (including DLLs) to `node_modules/@img/sharp-*/lib/`, and `resources/exiftool/{exiftool.exe,.Exiftool_config}` (Windows) to `resources/exiftool/`.
  - Paths mirror what webpack externalizes as `require('better-sqlite3')` and `require('sharp')` — so the runtime require() calls resolve correctly from the bundle.
- [x] 4. Add a `package:headless` script.
  - Added `"package:headless": "node scripts/package-headless.js"` to `package.json` scripts.
- [x] 5. Smoke-test the binary on the dev machine, then on a clean machine with no Node installed (full verification belongs to TASK-137).
  - **DEFERRED**: Per orchestrator constraints, no build/package step is run in this task. Binary smoke-testing (binary starts, SPA serves, DB reads, native modules load) is explicitly deferred to the end-of-run build+test pass and TASK-137 QA.

## Additional Change: common/ExifIO.ts

`ExifIO.ts` was minimally modified to support an optional `exiftoolPath` constructor parameter:
- Added private `_ep: exiftool.ExiftoolProcess` field.
- Constructor now accepts `exiftoolPath?: string`: when provided, creates a new `ExiftoolProcess` with that path; when omitted, uses the module-level singleton (`ep`) — preserving identical behavior for the Electron desktop build.
- All method bodies updated from bare `ep.` to `this._ep.` (no behavioral change for callers that don't pass a path).

## Done When

- [ ] `yarn package:headless` produces a single launchable binary plus its alongside resources.
  — DEFERRED to end-of-run build pass / TASK-137.
- [ ] The binary starts and serves the SPA + image/metadata endpoints against a real library on the dev machine.
  — DEFERRED to TASK-137.
- [ ] `better-sqlite3` loads and exiftool runs from the packaged layout (paths re-derived at launch, not hard-coded).
  — DEFERRED to TASK-137.
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** confirm `yarn package:portable` (the Electron portable build) still produces a working desktop app — the headless packaging is a separate, additive path. Capture evidence.
  — MANUAL QA item for TASK-137; not marked done here.
