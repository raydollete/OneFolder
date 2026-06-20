---
id: TASK-126
title: 'Introduce build-time platform seam and migrate Node/Electron frontend imports behind it'
investigation: INV-034
status: planned
priority: high
blocked_by: []
date_created: 2026-06-20
date_completed:
files:
  - 'src/frontend/platform/index.ts (new — seam interface + default export)'
  - 'src/frontend/platform/platform.electron.ts (new — faithful pass-through)'
  - 'src/frontend/platform/platform.web.ts (new — HTTP/stub impl)'
  - 'src/frontend/image/ImageLoader.ts'
  - 'src/frontend/image/util.ts'
  - 'src/frontend/image/ThumbnailGeneration.tsx'
  - 'src/frontend/image/MediaReleaseCoordinator.ts'
  - 'src/frontend/entities/Location.ts'
  - 'src/frontend/entities/File.ts'
  - 'src/frontend/stores/{FileStore,UiStore,LocationStore}.ts'
  - 'src/frontend/hooks/useCustomTheme.tsx'
  - 'src/frontend/components/ImageDates.tsx'
  - 'src/frontend/containers/ContentView/{GalleryItem.tsx,menu-items.tsx,SlideMode/index.tsx}'
  - 'src/frontend/containers/Settings/ImportExport.tsx'
  - 'src/frontend/containers/Outliner/index.tsx'
  - 'src/frontend/containers/Outliner/LocationsPanel/{dnd.ts,index.tsx,useFileDnD.ts,LocationRecoveryDialog.tsx}'
  - 'src/ipc/renderer.ts (consumed via seam by 32 files)'
  - 'common/fs.ts (encodeFilePath made build-conditional)'
  - 'common/process.ts (process.platform shim hook)'
---

## What

Create a single build-time **platform seam** module under `src/frontend/platform/` with two implementations selected by a webpack alias: `platform.electron.ts` (a faithful pass-through to today's `fs-extra`/`path`/`shell`/`RendererMessenger`/`encodeFilePath` behavior — NO functional change) and `platform.web.ts` (browser-safe stubs / HTTP-backed for read-only). Migrate the ~26 frontend files that open-code Node imports and the desktop UI affordances that call `RendererMessenger`/`shell` so they import from the seam instead of `fs-extra`/`electron` directly. This removes the compile blockers for a future browser bundle while leaving the Electron runtime path byte-for-byte equivalent.

## Why

The root cause of "no web build is possible" is that Node/Electron concerns are fused into the frontend with no abstraction boundary. This task installs that boundary. See [INV-034](../investigations/INV-034_MEDIUM_OTHER_headless-sidecar-web-build.md) (Blast Radius items 4, 5, 9, 10).

## Implementation Steps

- [ ] 1. Define the seam interface in `src/frontend/platform/index.ts`. Group the surface the read-only web build needs: filesystem reads (`readFile`, `pathExists`, `stat`, `readdir` — used by `ImageLoader`, `Location`, `ThumbnailGeneration`, `util`), `path` helpers (basename/extname/join/dirname), image-source building (`encodeFilePath`), metadata access handle (`ExifIO`-shaped — actual swap in TASK-132), and desktop affordances (`showItemInFolder`, `openExternal`, window chrome, preview window, clip server, paths) as nullable/no-op-able operations. The default export resolves to the alias target.
- [ ] 2. Implement `platform.electron.ts` as a **faithful pass-through**: each method delegates to the exact API the call site uses today (`fse.readFile`, `path.basename`, `shell.openExternal`, `RendererMessenger.*`, the existing `file://` `encodeFilePath`). Goal: identical runtime behavior on desktop.
- [ ] 3. Implement `platform.web.ts` as browser-safe: fs reads throw/return "use HTTP endpoint" (callers that need bytes will fetch in TASK-129/131); `encodeFilePath` returns HTTP URLs (full impl in TASK-127); desktop affordances (`showItemInFolder`, `openExternal`, window chrome, preview window, clip server) become no-ops; path helpers use a browser-safe `path-browserify`-style util. Read-only ⇒ trash/delete/import/writeback methods reject loudly.
- [ ] 4. Wire the webpack alias (the real config lands in TASK-130, but add the alias key now to both `webpack.dev.js` and `webpack.prod.js` resolving `src/frontend/platform` → `platform.electron.ts` for existing targets, so desktop is unaffected).
- [ ] 5. Migrate each file in the `files` list to import from the seam instead of `fs-extra`/`path`/`electron`/`node-stream-zip`/`RendererMessenger` directly. Keep diffs mechanical — same call shapes, just sourced from the seam.
- [ ] 6. Make `encodeFilePath` in `common/fs.ts` route through the seam (electron impl unchanged → still emits `file://`).
- [ ] 7. Add a `process.platform` shim hook in `common/process.ts` so the web build can define it (DefinePlugin lands in TASK-130); electron path unchanged.
- [ ] 8. `yarn lint` and `yarn build` (electron target) must pass with no behavior change.

## Done When

- [ ] `src/frontend/platform/{index.ts,platform.electron.ts,platform.web.ts}` exist; the alias resolves to the electron impl for existing targets.
- [ ] All files in the `files` list import Node/Electron capabilities from the seam, not directly.
- [ ] `yarn build` (electron) and `yarn lint` pass.
- [ ] **Desktop regression (REQUIRES MANUAL EXECUTION):** run the portable desktop build and confirm unchanged behavior — gallery loads, jpg/png/HEIC/PSD/TIFF/EXR images load, thumbnails render, tagging/search work, show-in-folder/open-external work, deletes/media jobs work. Capture evidence (screenshot or log) that desktop behavior is identical.
