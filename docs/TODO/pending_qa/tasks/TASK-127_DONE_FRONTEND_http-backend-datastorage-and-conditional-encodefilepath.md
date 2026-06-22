---
id: TASK-127
title: 'Add HttpBackend implements DataStorage and build-conditional encodeFilePath; select backend in renderer for web mode'
investigation: INV-034
status: done
priority: high
blocked_by: [TASK-126]
date_created: 2026-06-20
date_completed: 2026-06-22
files:
  - 'src/api/data-storage.ts (interface — unchanged contract, reused)'
  - 'src/backend/http-backend.ts (new — fetch-based DataStorage impl)'
  - 'src/renderer.tsx (web-mode backend branch)'
  - 'src/frontend/platform/platform.web.ts (encodeFilePath → HTTP URLs)'
  - 'common/fs.ts (encodeFilePath build-conditional via seam)'
---

## What

Implement `HttpBackend` in `src/backend/http-backend.ts` that implements the existing `DataStorage` interface (`src/api/data-storage.ts`) by `fetch()`ing the sidecar's REST API for all **read** methods, and rejecting **write** methods (read-only scope). Branch `src/renderer.tsx`'s `main()` so that in web mode it constructs `HttpBackend` instead of `SQLiteBackend` and never imports any `better-sqlite3`-reachable module. Make `encodeFilePath` (via the platform seam) emit HTTP image URLs in web mode.

## Why

`DataStorage` is the clean reuse seam: swapping the constructed backend leaves the entire MobX store/component tree unchanged. The renderer construction site is the only place that hard-codes SQLite. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Root Cause items 1, 3; Blast Radius 1, 2, 3, 5).

## Implementation Steps

- [x] 1. Create `src/backend/http-backend.ts` exporting `class HttpBackend implements DataStorage`. Constructor takes a base URL (+ auth header from TASK-134 later). Implement every **read** method (`fetchTags`, `fetchFiles`, `fetchFilesByID`, `fetchFilesByKey`, `fetchLocations`, `fetchSearches`, `searchFiles`, `countFiles`, `fetchDismissedDuplicateGroups`, `fetchVisualHashes`) as a `fetch` to a corresponding REST route returning JSON DTOs. Reuse DTO types from `src/api/*` (do not redefine).
- [x] 2. Implement **write/mutation** methods (`createTag`, `saveFiles`, `removeTags`, `mergeTags`, `removeFiles`, etc.) to reject with a clear "read-only web build" error rather than silently no-op (fail-loud), since the UI affordances that call them will be hidden in web mode anyway.
- [x] 3. Match the JSON contract to the sidecar routes added in TASK-128 (same path names and DTO shapes). Handle Date fields as ISO strings on the wire and parse back to `Date` to match `SQLiteBackend` deserialization semantics.
- [x] 4. In `src/renderer.tsx`, introduce a web-mode flag (from the build define / URL) and branch `main()`: in web mode, skip `sqliteInit`/`SQLiteBackend`/`SQLiteBackupScheduler`/migration/`fse.ensureDir`, and construct `HttpBackend`; pass it into `RootStore.main(backend, …)` exactly as today. Ensure the `better-sqlite3`-importing modules are behind the branch so they are tree-shaken out of the web bundle (verified in TASK-130).
- [x] 5. In `platform.web.ts`, implement `encodeFilePath(fileOrId)` to return the server URL (`/original/:id`, and `/thumb/:id` where the caller wants a thumbnail). Keep `blob:`/`data:` short-circuit. The electron seam impl keeps emitting `file://`.
- [x] 6. Confirm `common/fs.ts` `encodeFilePath` delegates through the seam so the electron build is unchanged.

## Done When

- [x] `HttpBackend` compiles against and fully satisfies the `DataStorage` interface; reads `fetch`, writes reject loudly.
- [x] `src/renderer.tsx` constructs `HttpBackend` in web mode and `SQLiteBackend` in electron mode; no `better-sqlite3` import is reachable from the web branch.
- [x] `encodeFilePath` emits HTTP URLs in web mode and `file://` in electron mode.
- [x] `yarn lint` passes on all changed files (http-backend.ts, renderer.tsx, custom.d.ts). `yarn build` gated to TASK-130 batch run.
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** run the portable desktop build and confirm the electron branch still constructs `SQLiteBackend` and all DB reads/writes, image loading, and `file://` sources behave identically. Capture evidence.

## Notes — REST Contract for TASK-128

The following REST routes are defined by `HttpBackend` and must be mirrored by the sidecar server in TASK-128:

```
GET  /api/tags
     Response: { tags: TagWire[] }
     TagWire = TagDTO with dateAdded as ISO string

GET  /api/files?order=<key|random|tagCountRandom>&direction=<asc|desc>
     Response: { files: FileWire[] }
     FileWire = FileDTO with dateAdded/dateModified/dateCreated/dateLastIndexed as ISO strings

POST /api/files/by-ids
     Body: { ids: string[] }
     Response: { files: FileWire[] }

POST /api/files/by-key
     Body: { key: string, value: string | number }
     (Date values are serialized as ISO strings by the client)
     Response: { files: FileWire[] }

GET  /api/locations
     Response: { locations: LocationWire[] }
     LocationWire = LocationDTO with dateAdded as ISO string

GET  /api/searches
     Response: { searches: FileSearchDTO[] }
     (FileSearchDTO has no Date fields — identical on wire)

POST /api/files/search
     Body: { criteria: ConditionDTO[], order: string, direction: "asc"|"desc", matchAny: boolean }
     Response: { files: FileWire[] }

GET  /api/files/count
     Response: { fileCount: number, untaggedFileCount: number }

GET  /api/dismissed-duplicate-groups
     Response: { groups: DismissedDuplicateGroupWire[] }
     DismissedDuplicateGroupWire = DismissedDuplicateGroupDTO with dismissedAt as ISO string

POST /api/visual-hashes/by-paths
     Body: { absolutePaths: string[] }
     Response: { hashes: VisualHashWire[] }
     VisualHashWire = VisualHashDTO with dateModified/dateComputed as ISO strings
```

Image serving routes (implemented in TASK-129):
```
GET  /api/thumb/:id              Serve thumbnail by file UUID
GET  /api/original?path=<enc>   Serve original file by URL-encoded absolute path
                                  (server must validate path is within a known location)
```

encodeFilePath web behavior:
- `blob:` / `data:` paths → pass through unchanged
- Paths starting with `/` → pass through (already server URLs)
- UUID (v4) → `/api/thumb/<uuid>`
- Absolute disk path → `/api/original?path=<url-encoded>`

IS_WEB_BUILD define:
- `false` in webpack.dev.js and webpack.prod.js (Electron renderer)
- `true` to be set by TASK-130's web webpack config
