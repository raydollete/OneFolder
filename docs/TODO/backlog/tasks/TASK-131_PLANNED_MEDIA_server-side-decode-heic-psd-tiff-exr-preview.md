---
id: TASK-131
title: 'Server-side decode for HEIC/PSD/TIFF/EXR → /preview (Sharp + canvas-less EXR WASM)'
investigation: INV-034
status: planned
priority: medium
blocked_by: [TASK-129]
date_created: 2026-06-20
date_completed:
files:
  - 'src/server/routes/images.ts (add /preview)'
  - 'src/server/decode.ts (new — DOM-less decoders)'
  - 'src/server/thumbnails.ts (extend for decoded formats)'
  - 'wasm/packages/exr/* (EXR WASM run in Node)'
---

## What

Add `GET /preview/:id` (Phase B) that decodes non-web formats (HEIC, PSD, TIFF, EXR) to a web format (webp/jpeg) **server-side, DOM-less**. Use Sharp/libvips for HEIC/TIFF/PSD; run the existing EXR WASM decoder in Node with a canvas-less raw-pixel → encoder path (no `toBlob`/`OffscreenCanvas`). Extend server thumbnail generation so thumbs for these formats are produced the same way. This is the main "unknown" of the project besides packaging.

## Why

The current decoders read bytes with `fse.readFile` and paint via browser Canvas — neither exists for a remote browser. Decoding must move to the server. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Requirement 6; Blast Radius 6, 7; Risks 2).

## Implementation Steps

- [ ] 1. Create `src/server/decode.ts`. For HEIC/TIFF/PSD, decode + re-encode to webp/jpeg via **Sharp** (already a transitive dep / libvips). Confirm Sharp's HEIF/TIFF support in the shipped build; for PSD, use Sharp if it supports the file, else `ag-psd` (already a dep) to raster, then encode with Sharp.
- [ ] 2. For **EXR**, load the existing WASM decoder (`wasm/packages/exr`) in Node, decode to a raw RGBA/float buffer, tone-map/convert to 8-bit, and encode to webp/jpeg with Sharp — explicitly avoiding any `document`/`OffscreenCanvas`/`toBlob` path.
- [ ] 3. Add `GET /preview/:id` to `src/server/routes/images.ts`: resolve id→path (location-scoped guard), dispatch to the right decoder by extension, return webp/jpeg with `Content-Type` + CORP headers. Cache decoded previews on disk (reuse the thumbnail dir scheme or a sibling `previews/` dir).
- [ ] 4. Extend `src/server/thumbnails.ts` so `/thumb` for these formats decodes-then-resizes (not just web formats).
- [ ] 5. Ensure the web seam / `HttpBackend.encodeFilePath` (TASK-127) routes non-web formats to `/preview` and `/thumb` correctly (the gallery uses thumbs, the viewer uses preview/original).

## Done When

- [ ] Opening a HEIC, PSD, TIFF, and EXR file in the browser renders a decoded preview; server logs show Sharp/WASM decode; the response is webp/jpeg.
- [ ] Thumbnails for these formats render in the gallery.
- [ ] Decoded previews are cached and re-served without re-decoding.
- [ ] No `document`/Canvas calls run on the server (EXR uses the raw-pixel → Sharp path).
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** confirm the portable desktop build still decodes HEIC/PSD/TIFF/EXR via the unchanged renderer-side loaders. Capture evidence.
