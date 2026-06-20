---
id: TASK-136
title: 'Document the headless/sidecar web build architecture (seam, server, endpoints, packaging, security)'
investigation: INV-034
status: planned
priority: low
blocked_by: [TASK-128, TASK-133, TASK-134]
date_created: 2026-06-20
date_completed:
files:
  - 'docs/headless-web-build.md (new)'
  - 'CLAUDE.md'
---

## What

Write `docs/headless-web-build.md` describing the platform seam, the sidecar server, the REST/image/metadata endpoints, the build targets, the single-binary packaging, and the security boundary (auth + location-scoped traversal guard). Add a short note to `CLAUDE.md` about the platform seam and the additional `web` build target so future contributors don't reintroduce direct Node/Electron imports in the frontend.

## Why

The seam is a new architectural invariant: frontend code must go through `src/frontend/platform` rather than importing Node/Electron directly, or the web build breaks. This must be documented per project convention. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Documentation Updates).

## Implementation Steps

- [ ] 1. Create `docs/headless-web-build.md` with: scope (read-only, single user/session), the platform seam (electron vs web impls, alias), `HttpBackend`/`DataStorage` reuse, sidecar architecture (read-only SQLite, routes), image endpoints (`/original`, `/thumb`, `/preview`) + Sharp/EXR decoding, metadata service, COOP/COEP/CORP requirements, packaging (SEA/pkg + alongside native deps), and the security boundary (auth + location-scoped path resolver). Match the front-matter style of `docs/multi-library.md`.
- [ ] 2. Add a "Build seam / web target" note to `CLAUDE.md`: frontend code imports platform capabilities from `src/frontend/platform`, never `fs-extra`/`electron` directly; list the web build commands.
- [ ] 3. Cross-link INV-034 and the spawned tasks.

## Done When

- [ ] `docs/headless-web-build.md` exists and accurately reflects the shipped seam/server/endpoints/packaging.
- [ ] `CLAUDE.md` documents the seam invariant and the web build commands.
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** docs-only change; confirm no code touched and the portable desktop build is unaffected (trivial). Note in the task.
