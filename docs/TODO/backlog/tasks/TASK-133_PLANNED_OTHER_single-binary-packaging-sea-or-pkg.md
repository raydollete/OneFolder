---
id: TASK-133
title: 'Package headless build as a single binary (Node SEA or pkg) shipping better-sqlite3 .node + exiftool alongside'
investigation: INV-034
status: planned
priority: medium
blocked_by: [TASK-130, TASK-131, TASK-132]
date_created: 2026-06-20
date_completed:
files:
  - 'package.json (scripts + packaging config)'
  - 'scripts/package-headless.js (new — SEA/pkg orchestration)'
  - 'src/server/index.ts (launch-time path re-derivation)'
---

## What

Package the sidecar server + built SPA assets + native/external resources into **one launchable binary** using Node SEA (or `pkg`). Native modules (`better-sqlite3` `.node`) and the exiftool binary cannot be inlined into a JS bundle, so they ship **alongside** the exe and paths are re-derived at launch — mirroring the existing `asarUnpack`/`extraResources` config in `package.json`.

## Why

The deliverable is a single binary a user runs on the machine holding the library. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Requirement 7; Blast Radius 13; Risks 3).

## Implementation Steps

- [ ] 1. Choose Node SEA (preferred, no extra dep) or `pkg`. Create `scripts/package-headless.js` that: builds the server (`build:server`) and SPA (`build:web`), assembles an output dir with the binary, the SPA assets, `better-sqlite3`'s prebuilt `.node`, and the exiftool binary + config (`resources/exiftool/*`).
- [ ] 2. In `src/server/index.ts`, re-derive all resource paths at launch relative to the binary location (not `__dirname` inside a bundle): SPA asset dir, exiftool path (replace `getExtraResourcePath` for the server context), thumbnail/preview cache dir, library/db path. Consistent with the portable-only fork's launch-time path logic.
- [ ] 3. Mirror the existing native-resource shipping: the `.node` and exiftool sit beside the exe exactly as `asarUnpack`/`extraResources` do for the Electron build.
- [ ] 4. Add a `package:headless` script.
- [ ] 5. Smoke-test the binary on the dev machine, then on a clean machine with no Node installed (full verification belongs to TASK-137).

## Done When

- [ ] `yarn package:headless` produces a single launchable binary plus its alongside resources.
- [ ] The binary starts and serves the SPA + image/metadata endpoints against a real library on the dev machine.
- [ ] `better-sqlite3` loads and exiftool runs from the packaged layout (paths re-derived at launch, not hard-coded).
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** confirm `yarn package:portable` (the Electron portable build) still produces a working desktop app — the headless packaging is a separate, additive path. Capture evidence.
