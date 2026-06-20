---
id: TASK-137
title: 'QA: end-to-end headless web build across phases + full desktop portable regression'
investigation: INV-034
status: planned
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
- [ ] 4. **Phase C (REQUIRES MANUAL EXECUTION):** run the packaged binary on a clean machine with no Node installed; confirm it starts, the auth gate rejects unauthenticated requests (401), and browsing works over HTTPS on the network. Confirm a path outside the library's locations returns 403/404 (traversal guard). Capture evidence.
- [ ] 5. **Desktop regression (REQUIRES MANUAL EXECUTION):** build and run the portable desktop Electron app; verify unchanged behavior — DB read/write, image loading incl. HEIC/PSD/TIFF/EXR, thumbnail generation, tagging writeback, search/filter, show-in-folder/open-external, media jobs (re-encode/normalize/clip/rotate), and deletes/recycle. Capture evidence that desktop behavior is identical to pre-INV-034.

## Done When

- [ ] All Phase A/B/C acceptance criteria pass with attached evidence (screenshots, log lines, Network captures).
- [ ] The traversal guard and auth gate are demonstrated to reject (403/404, 401).
- [ ] The desktop portable build is demonstrated identical to pre-seam behavior across all listed surfaces, with evidence.
- [ ] Evidence is linked from this file (per QA discipline) before INV-034 is promoted to pending_qa.
