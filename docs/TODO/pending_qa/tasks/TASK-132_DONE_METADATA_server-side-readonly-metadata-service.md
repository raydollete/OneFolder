---
id: TASK-132
title: 'Server-side read-only metadata service (exiftool/dimensions/tags) exposed over HTTP; web ExifIO shim'
investigation: INV-034
status: done
priority: medium
blocked_by: [TASK-128]
date_created: 2026-06-20
date_completed: 2026-06-22
files:
  - 'src/server/routes/metadata.ts (new)'
  - 'common/ExifIO.ts (read paths reused server-side)'
  - 'src/frontend/platform/platform.web.ts (web ExifIO-shaped shim)'
  - 'src/frontend/stores/RootStore.ts (ExifIO via seam)'
---

## What

Expose read-only metadata over HTTP from the sidecar by reusing `common/ExifIO.ts`'s **read** paths (dimensions, tags, EXIF read) server-side, and provide a web `ExifIO`-shaped shim in the platform seam that fetches those values instead of spawning exiftool in the browser. Writeback is explicitly out of scope and the shim rejects it loudly.

## Why

`ExifIO` spawns native exiftool and is wired through `RootStore` → `entities/File.ts`, `ImageLoader`, and the annotation layer; reading dimensions/tags is load-bearing for display, so it cannot be a no-op. It has no browser equivalent and must become a server feature. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Blast Radius 8; Requirement 1/Explicit Rejections — no writeback).

## Implementation Steps

- [x] 1. In the sidecar, instantiate `ExifIO` (or its read methods) server-side. Add `src/server/routes/metadata.ts` exposing read endpoints: dimensions, dimensions+tags, EXIF read for a given file id (id resolved via the location-scoped guard, TASK-128). Return JSON.
- [x] 2. In `platform.web.ts`, provide an `ExifIO`-shaped object whose read methods (`getDimensions`, `getDimensionsAndTags`, `extractThumbnail`, EXIF reads) `fetch` the metadata routes, and whose **write** methods reject with a clear "read-only web build" error.
- [x] 3. Route `RootStore`'s `ExifIO` construction through the seam so the electron build keeps `new ExifIO(...)` (native, unchanged) and the web build gets the HTTP-backed shim. Confirm `entities/File.ts`, `ImageLoader`, and `AnnotoriousWrapper` consumers work against the shim's read surface (annotation write disabled in read-only).
- [x] 4. Ensure exiftool runs read-only on the server (no `overwrite_original_in_place` writes are reachable in the web path).

## Done When

- [ ] The browser shows file dimensions and metadata (read) sourced over HTTP; no exiftool process is expected in the browser.
- [ ] Metadata write attempts in the web build reject loudly (no silent no-op, no accidental disk write).
- [ ] `RootStore` constructs native `ExifIO` in electron mode and the HTTP shim in web mode via the seam.
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** confirm the portable desktop build still reads AND writes metadata via native exiftool unchanged (tagging writeback still works on desktop). Capture evidence.
