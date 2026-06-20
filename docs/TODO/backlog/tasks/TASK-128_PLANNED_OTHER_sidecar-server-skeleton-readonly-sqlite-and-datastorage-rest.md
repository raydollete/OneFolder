---
id: TASK-128
title: 'Build sidecar Node server: read-only SQLite, DataStorage REST routes, SPA serving, COOP/COEP, location-scoped traversal guard'
investigation: INV-034
status: planned
priority: high
blocked_by: [TASK-127]
date_created: 2026-06-20
date_completed:
files:
  - 'src/server/index.ts (new — server entrypoint)'
  - 'src/server/routes/data.ts (new — DataStorage read routes)'
  - 'src/server/path-resolver.ts (new — id→path, location-scoped guard)'
  - 'src/backend/sqlite-backend.ts (reused, read path only)'
  - 'src/backend/sqlite-config.ts (reused for read-only open)'
  - 'common/library-registry.ts (reused for db path resolution)'
---

## What

Create the headless sidecar server entrypoint (`src/server/index.ts`) using Express or Fastify. It opens the active library's SQLite database **read-only** (`new Database(path, { readonly: true })`), reusing `src/backend/sqlite-config.ts` / `src/backend/sqlite-backend.ts` read paths and `common/library-registry.ts` for the db path. It exposes the `DataStorage` **read** methods as REST/JSON routes (the contract `HttpBackend` consumes), serves the built browser SPA with COOP/COEP headers, and implements a location-scoped path-traversal guard used by the image endpoints in TASK-129/131.

## Why

The renderer cannot run Node in a browser, so the server becomes the new home for everything fused into the renderer. Reusing `SQLiteBackend`'s read paths server-side avoids duplicating query logic. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Holistic Solution step 3; Requirements 3, 5, 10; Blast Radius 2, 11).

## Implementation Steps

- [ ] 1. Add `express` (or `fastify`) as a dependency. Create `src/server/index.ts` that: resolves `userData`/library paths the same way the portable app does (re-derive at launch), reads the active library id, resolves the db path via `getSqliteDbPath`, and opens the DB **read-only**.
- [ ] 2. Instantiate `SQLiteBackend` against the read-only DB handle (read methods only) so existing query/deserialization code is reused. Do not call any write/init-write path.
- [ ] 3. In `src/server/routes/data.ts`, expose REST routes mapping 1:1 to the `DataStorage` read methods consumed by `HttpBackend` (TASK-127): tags, files (with order/direction), files-by-id, files-by-key, locations, searches, searchFiles (criteria in body), countFiles, visualHashes, dismissed-duplicate-groups. Return DTOs as JSON (Dates as ISO strings). Reject any non-GET/non-read route.
- [ ] 4. Implement `src/server/path-resolver.ts`: given a file ID, look up the absolutePath from the DB, then assert it resolves (after `path.resolve`/normalization) **inside one of the library's `locations`**. Reject (403/404) anything outside. Never accept a raw client-supplied path. Export this for TASK-129/131 image endpoints.
- [ ] 5. Serve the built SPA assets (from the web webpack output dir, produced in TASK-130) as static files, sending `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the HTML so masonry `SharedArrayBuffer` works (mirrors `src/index.html`).
- [ ] 6. Add a `dev:server` script to run the server with ts-node (or the Node build from TASK-130) against a real test library.

## Done When

- [ ] Server starts, opens the library DB read-only, and serves the SPA.
- [ ] Every `DataStorage` read route returns correct JSON DTOs (verify with `curl`/Network tab against a real test library).
- [ ] `path-resolver` returns the correct path for a valid id and rejects ids/paths outside the library locations (unit-tested with an in-library and an out-of-tree path).
- [ ] HTML response carries COOP/COEP headers.
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** the server is additive (new files only); confirm `yarn build` (electron) and the portable desktop build still work unchanged. Capture evidence.
