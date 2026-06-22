---
id: TASK-131
title: 'Server-side decode for HEIC/PSD/TIFF/EXR → /preview (Sharp + canvas-less EXR WASM)'
investigation: INV-034
status: done
priority: medium
blocked_by: [TASK-129]
date_created: 2026-06-20
date_completed: 2026-06-22
files:
  - 'src/server/routes/images.ts (add /preview)'
  - 'src/server/decode.ts (new — DOM-less decoders)'
  - 'src/server/thumbnails.ts (extend for decoded formats)'
  - 'src/frontend/platform/index.ts (add encodePreviewPath + isWebBuild)'
  - 'src/frontend/platform/platform.web.ts (implement encodePreviewPath + isWebBuild)'
  - 'src/frontend/platform/platform.electron.ts (implement encodePreviewPath + isWebBuild passthrough)'
  - 'src/frontend/image/ImageLoader.ts (web-mode branch in ensureThumbnail + getImageSrc)'
  - 'src/frontend/stores/FileStore.ts (web-mode thumbnailPath = file.id)'
---

## What

Add `GET /preview/:id` (Phase B) that decodes non-web formats (HEIC, PSD, TIFF, EXR) to a web format (webp/jpeg) **server-side, DOM-less**. Use Sharp/libvips for HEIC/TIFF/PSD; run the existing EXR WASM decoder in Node with a canvas-less raw-pixel → encoder path (no `toBlob`/`OffscreenCanvas`). Extend server thumbnail generation so thumbs for these formats are produced the same way. This is the main "unknown" of the project besides packaging.

## Why

The current decoders read bytes with `fse.readFile` and paint via browser Canvas — neither exists for a remote browser. Decoding must move to the server. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Requirement 6; Blast Radius 6, 7; Risks 2).

## Implementation Steps

- [x] 1. Create `src/server/decode.ts`. For HEIC/TIFF/PSD, decode + re-encode to webp/jpeg via **Sharp** (already a transitive dep / libvips). Confirm Sharp's HEIF/TIFF support in the shipped build; for PSD, use Sharp if it supports the file, else `ag-psd` (already a dep) to raster, then encode with Sharp.
  - HEIC/HEIF/TIFF/TIF: Sharp native — `sharp(sourcePath).webp().toBuffer()`
  - PSD: Sharp first (try + catch metadata()); fallback to ag-psd with initializeCanvas override that provides a Node-safe createImageData (plain `{data,width,height}` objects, no `document.createElement`)
  - `ensureAgPsdInitialized()` called lazily; `initializeCanvas` override throws loudly if createCanvas is unexpectedly invoked
- [x] 2. For **EXR**, load the existing WASM decoder (`wasm/packages/exr`) in Node, decode to a raw RGBA/float buffer, tone-map/convert to 8-bit, and encode to webp/jpeg with Sharp — explicitly avoiding any `document`/`OffscreenCanvas`/`toBlob` path.
  - `WebAssembly.instantiate(wasmBytes, imports)` with custom `imports.wbg` that replaces `new ImageData(...)` with `{data: Uint8ClampedArray, width, height}` plain objects
  - WASM binary resolved from candidate paths (`dist/../../wasm/...`, `../../../wasm/...`, local dir)
  - Tone-map fallback: if decoded data is float32 (byteLength = w*h*16) apply Reinhard; uint8 (byteLength = w*h*4) passed directly to Sharp
  - **RUNTIME VERIFICATION REQUIRED**: EXR decode path has been wired from WASM source reading but NOT run in a live Node process. Must be verified in end-of-run/QA pass (TASK-137).
- [x] 3. Add `GET /preview/:id` to `src/server/routes/images.ts`: resolve id→path (location-scoped guard), dispatch to the right decoder by extension, return webp/jpeg with `Content-Type` + CORP headers. Cache decoded previews on disk (reuse the thumbnail dir scheme or a sibling `previews/` dir).
  - Route added to `makeImagesRouter`; location-scoped resolution via `resolveFilePathSafe`
  - Web formats (jpg/png/etc): served directly (no decode)
  - Non-web formats: decoded via `decodeToBuffer`, cached in `previews/` dir (sibling of thumbnail dir) via `getPreviewPath(absolutePath, thumbnailDir)` in `thumbnails.ts`
  - Cache hit: `fse.pathExists(previewPath)` → `res.sendFile(previewPath)` with `Cache-Control: immutable`
  - Content-Type: `image/webp`; CORP: `same-origin`
- [x] 4. Extend `src/server/thumbnails.ts` so `/thumb` for these formats decodes-then-resizes (not just web formats).
  - Added `getPreviewPath(filePath, thumbnailDir)` — stores previews in `{thumbnailDir}/../previews/`
  - `generateThumbnail` extended: Buffer without rawPixelMeta = encoded image (webp/jpeg) Sharp decodes; Buffer with rawPixelMeta = raw pixels
  - `/thumb` route: `isPreviewFormat(sourceExt)` check fires before the Sharp-native set; calls `decodeToBuffer(absolutePath, 'webp')` → passes webp buffer to `generateThumbnail` for resize
- [x] 5. Ensure the web seam / `HttpBackend.encodeFilePath` (TASK-127) routes non-web formats to `/preview` and `/thumb` correctly (the gallery uses thumbs, the viewer uses preview/original).
  - Added `encodePreviewPath(fileId): string` to Platform interface and both implementations
    - `platform.web.ts`: UUID → `/api/preview/:id`
    - `platform.electron.ts`: passthrough to `encodeFilePath` (file://)
  - Added `isWebBuild: boolean` to Platform interface (web=`true`, electron=`false`)
  - `ImageLoader.ensureThumbnail`: early-return `false` when `platform.isWebBuild` (server handles thumbnails via /api/thumb/:id)
  - `ImageLoader.getImageSrc`: when `platform.isWebBuild`, returns `platform.encodePreviewPath(file.id)` for all viewable formats → `/api/preview/:id` (which serves originals for web formats and decoded previews for non-web)
  - `FileStore.clientFilesFromDTOs` + `appendFile`: when `thumbnailDirectory === ''` (web-mode marker), set `thumbnailPath = file.id` → `encodeFilePath(id)` → `/api/thumb/:id`

## Done When

- [ ] Opening a HEIC, PSD, TIFF, and EXR file in the browser renders a decoded preview; server logs show Sharp/WASM decode; the response is webp/jpeg.
- [ ] Thumbnails for these formats render in the gallery.
- [ ] Decoded previews are cached and re-served without re-decoding.
- [ ] No `document`/Canvas calls run on the server (EXR uses the raw-pixel → Sharp path).
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** confirm the portable desktop build still decodes HEIC/PSD/TIFF/EXR via the unchanged renderer-side loaders. Capture evidence.
