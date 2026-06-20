---
id: TASK-135
title: 'On-demand library rescan endpoint to replace the dropped chokidar watcher (read-only currency)'
investigation: INV-034
status: planned
priority: low
blocked_by: [TASK-128]
date_created: 2026-06-20
date_completed:
files:
  - 'src/server/routes/rescan.ts (new)'
  - 'src/frontend/platform/platform.web.ts (folderWatcher no-op + rescan trigger)'
---

## What

Provide an on-demand (and optionally periodic) rescan endpoint on the sidecar so the read-only web client can refresh library currency without a live file watcher. In the web build, the chokidar `folderWatcher.worker.ts` is not used (it is Node-only with no browser equivalent); the seam stubs it and the client refreshes via this endpoint instead.

## Why

Chokidar runs in a renderer worker and is Node-only. For read-only viewing, a periodic/on-demand rescan is sufficient and avoids reimplementing live watching for a first cut. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Requirement 12; Blast Radius 7).

## Implementation Steps

- [ ] 1. Add `POST /rescan` (or `GET /rescan`) to the sidecar that re-reads locations from the DB and reports any changes the read-only client should reflect (the server DB is opened read-only, so this re-queries; it does not write).
- [ ] 2. In `platform.web.ts`, make the folder-watcher seam a no-op and expose a "refresh" action the UI can call (or a periodic poll) that hits `/rescan` and re-fetches via `HttpBackend`.
- [ ] 3. Keep this minimal — it is explicitly a first-cut substitute for the watcher, not a live-watch reimplementation.

## Done When

- [ ] The web client can trigger a rescan/refresh and see updated file/tag listings without a live watcher.
- [ ] No chokidar/`fs` code is reachable in the web bundle.
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** confirm the portable desktop build still uses the live chokidar watcher unchanged. Capture evidence.
