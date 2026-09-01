---
id: TASK-137
title: 'QA: end-to-end headless web build across phases + full desktop portable regression'
investigation: INV-034
status: pending_qa
priority: high
blocked_by: [TASK-129, TASK-131, TASK-132, TASK-133, TASK-134]
date_created: 2026-06-20
date_completed:
files:
  - '(QA only — no source changes)'
---

## What

End-to-end manual QA of the headless web build across all three phases, plus a full regression pass of the portable desktop Electron app to prove the build-time seam introduced no desktop change. This is the gate before the investigation may be promoted out of backlog.

## Why

The seam edits ~15+ frontend files the desktop also uses; "desktop still works" must be tested, not assumed. The web feature spans DB-over-HTTP, image decoding, metadata, packaging, and security, each with concrete acceptance criteria. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Behavioral Specifications; Risks 1, 4, 5).

## Implementation Steps

- [ ] 1. **Phase A (REQUIRES MANUAL EXECUTION):** launch the sidecar against a real test library; from a browser on another device, confirm the gallery lists files (DB read over HTTP), thumbnails render, a jpg/png/webp original opens full-size. Inspect Network tab for `/thumb` + `/original` 200s with CORP headers; confirm no `electron`/Node module errors in the browser console; confirm masonry layout (SharedArrayBuffer) works. Capture screenshots/log.
- [ ] 2. **Phase B (REQUIRES MANUAL EXECUTION):** open a HEIC, PSD, TIFF, and EXR file in the browser; confirm a decoded preview renders; confirm server logs show Sharp/WASM decode and the response is webp/jpeg. Capture evidence.
- [ ] 3. **Metadata (REQUIRES MANUAL EXECUTION):** confirm dimensions/tags/EXIF read display in the browser; confirm any write attempt is rejected (read-only). Capture evidence.
- [ ] 4. **Phase C — OBSOLETE.** Superseded by the OpenSpec change `add-portable-serve-mode` (see `openspec/changes/add-portable-serve-mode/`). Both premises of this step are void: there is no longer a standalone packaged binary (the Node SEA target, `scripts/package-headless.js` and `webpack.server.js` were deleted — the server now runs inside the portable executable via `brave.exe --serve`), and an unauthenticated request is no longer required to return 401 (authentication became optional; with no credential configured the server serves every request by design). The surviving coverage lives in that change's tasks 7.1-7.6: browser verification with and without a credential, the non-web-format decode path, GUI/serve coexistence, a packaged-build desktop regression, and a real phone-on-wifi check. The traversal guard remains covered by `tests/path-resolver.test.ts`.
- [ ] 5. **Desktop regression (REQUIRES MANUAL EXECUTION):** build and run the portable desktop Electron app; verify unchanged behavior — DB read/write, image loading incl. HEIC/PSD/TIFF/EXR, thumbnail generation, tagging writeback, search/filter, show-in-folder/open-external, media jobs (re-encode/normalize/clip/rotate), and deletes/recycle. Capture evidence that desktop behavior is identical to pre-INV-034.

## Agent-Reachable QA — COMPLETED 2026-06-22

The single batched build + test pass for the whole INV-034 sequence was run after all
implementation tasks (per the "batch builds at the end" discipline). Results:

- **`yarn build` (Electron desktop target):** PASS — compiles clean (only the pre-existing
  mapbox-gl `Critical dependency` warning). Proves the platform-seam migration of ~19
  frontend files did not break the desktop renderer build.
- **`yarn build:web` (browser SPA):** PASS — compiles with **zero** Node/Electron module
  resolution errors (the definitive proof the seam is complete). **One bug found & fixed
  during this pass:** the web `resolve.alias` `src/frontend/platform` → `platform.web.ts`
  was shadowed by the broader `src` alias, so `index.ts`'s static `export { default } from
  './platform.electron'` pulled the Electron impl (node-stream-zip → `util`) into the
  browser bundle. Fixed by adding a `NormalModuleReplacementPlugin(/platform\.electron$/ →
  platform.web.ts)` to `webpack.web.js`. Remaining web warnings are benign (dead-code
  `RendererMessenger` named imports in the eliminated Electron branch of `renderer.tsx`;
  asset-size advisories).
- **`yarn build:server` (Node sidecar bundle):** PASS — `dist-server/server.bundle.js`
  emitted, `better-sqlite3`/`sharp` externalized (only the standard Express dynamic-require
  warning).
- **`yarn test` (Jest):** PASS — 188/188 tests across 22 suites. The new
  `tests/path-resolver.test.ts` originally failed because it instantiated real
  `better-sqlite3` (compiled for Electron's ABI — `NODE_MODULE_VERSION` mismatch under
  Jest's Node). Refactored to stub the narrow `prepare().get()/.all()` surface, keeping the
  security-critical location-scoping logic under test. The new `tests/server-auth.test.ts`
  passes. `tests/path-resolver.test.ts` integration against a live SQLite library is folded
  into the manual Phase A QA below.
- **Lint:** new INV-034 files (`src/server/**`, `src/frontend/platform/**`,
  `http-backend.ts`, the watcher stub) lint **clean**. Enabled the conventional `^_`
  `argsIgnorePattern`/`varsIgnorePattern` on `no-unused-vars` (the no-op stub methods rely
  on it) and removed two genuine dead symbols. The remaining ~48 `yarn lint` errors are
  **pre-existing** repo debt in files unrelated to this work (the baseline `yarn lint`
  already failed); intentionally left untouched.

**Still REQUIRES MANUAL EXECUTION (cannot be done by an agent):** everything below — a real
browser on another device, real HEIC/PSD/TIFF/EXR files (esp. EXR-WASM-in-Node runtime
verification, the project's flagged main risk), a clean machine with no Node for the packaged
binary, and a hands-on desktop portable regression run.

## Done When

- [ ] All Phase A/B/C acceptance criteria pass with attached evidence (screenshots, log lines, Network captures).
- [ ] The traversal guard and auth gate are demonstrated to reject (403/404, 401).
- [ ] The desktop portable build is demonstrated identical to pre-seam behavior across all listed surfaces, with evidence.
- [ ] Evidence is linked from this file (per QA discipline) before INV-034 is promoted to pending_qa.
