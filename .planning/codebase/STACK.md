# Technology Stack

**Analysis Date:** 2026-06-24

## Languages

**Primary:**
- TypeScript 4.9.5 - All source code (main process, renderer, backend, frontend)
- HTML/CSS/SCSS - UI markup and styling via SCSS with Sass loader

**Secondary:**
- Rust - WebAssembly modules for masonry layout and EXR decoding (Cargo 2021 edition)
- Perl - ExifTool scripting language (vendored in `resources/exiftool/`)
- JavaScript - Configuration files (webpack, jest, eslint)

## Runtime

**Environment:**
- Electron 41.7.2 (pinned; desktop main and renderer processes) - `src/main.ts`, `src/renderer.tsx`
- Node.js - Backend server process (`src/server/`) and build tools
- Browser (Web) - Headless web SPA target via webpack web build

**Package Manager:**
- Yarn 1.22.22 (enforced via `packageManager` in `package.json`)
- Lockfile: `yarn.lock` present (405 KB)

## Frameworks

**Core:**
- React 18.2.0 - UI component framework (`src/renderer.tsx`, `src/frontend/`)
- MobX 6.8.0 - Reactive state management with `@observer` HOC (`src/frontend/stores/`)
- Electron 41.7.2 - Desktop application framework (main and renderer)
- Express 5.2.1 - Headless web server (`src/server/index.ts`)

**Testing:**
- Jest 29.5.0 - Test runner with TypeScript support via ts-jest
- jsdom (via jest-environment-jsdom 30.4.1) - DOM simulation for component tests

**Build/Dev:**
- Webpack 5.75.0 - Module bundler with separate configs for Electron main/renderer and web
  - Development: `webpack.dev.js` (source maps)
  - Production: `webpack.prod.js` (minification, CSS extraction)
  - Web SPA: `webpack.web.js` (browser-only bundle)
  - Server: `webpack.server.js` (Node server bundle)
- ts-loader 9.4.2 - TypeScript loader for webpack
- ts-node 10.9.2 - TypeScript execution for scripts and dev server
- ESLint 8.34.0 - Linting with TypeScript support
- Prettier 2.8.4 - Code formatting

## Key Dependencies

**Critical:**
- better-sqlite3 12.10.0 - SQLite database (main process and server, native .node module)
  - Externalized in webpack (not bundled); stored at `node_modules/better-sqlite3/`
  - Unpacked in ASAR via `asarUnpack: ["node_modules/better-sqlite3/**"]`
- dexie 3.2.3 - IndexedDB abstraction (deprecated; migration from IndexedDB to SQLite complete)
  - Located: `src/backend/backend.ts` (deprecated, kept for reference)
- Comlink 4.4.1 - Web Worker RPC abstraction for thread communication
  - Used by: `src/frontend/workers/` (folderWatcher, heicReader, psdReader)

**Image & Media:**
- Sharp 0.35.2 - Native image processing (JPEG/PNG/WebP/GIF/BMP resizing and transcoding)
  - Main use: `src/server/thumbnails.ts` (server-side thumbnail generation via Sharp)
  - Also: `src/server/decode.ts` (image format conversion)
  - Native .node module; externalized in server webpack config
- libheif-js 1.17.1 - HEIC/HEIF image decoding
  - Worker: `src/frontend/workers/heicReader.worker.ts`
- ag-psd 15.0.0 - PSD (Adobe Photoshop) file decoding
  - Workers: `src/frontend/workers/psdReader.worker.ts`, server `src/server/decode.ts`
- UTIF 3.1.0 - TIFF image library
  - Loader: `src/frontend/image/TifLoader.ts`

**Media Processing:**
- FFmpeg (native binary) - Video encoding, clip creation, audio normalization
  - Windows: `resources/ffmpeg/ffmpeg.exe` and `ffprobe.exe` (bundled)
  - macOS/Linux: system ffmpeg (from PATH)
  - Runner: `src/media/FfmpegRunner.ts` (spawn + progress parsing)
  - Service: `src/media/MediaJobService.ts` (job queue and lifecycle)

**File & Metadata:**
- @logion/node-exiftool 2.3.1 - EXIF metadata reader/writer
  - Wrapper: `common/ExifIO.ts`
  - ExifTool binary: `resources/exiftool/exiftool.pl` (Perl script, macOS/Linux) or `.exe` (Windows)
- fs-extra 11.1.0 - File system utilities (async file ops, directory sync)
- chokidar 3.5.3 - File system watcher for folder changes
  - Worker: `src/frontend/workers/folderWatcher.worker.ts`
- node-stream-zip 1.15.0 - ZIP file extraction
- copy-webpack-plugin 11.0.0 - Webpack plugin to copy static assets

**AI & Machine Learning:**
- @tensorflow/tfjs 4.14.0 - TensorFlow.js runtime
- @tensorflow-models/blazeface 0.1.0 - Face detection ML model
  - Loader: `src/frontend/image/aiModels.ts`

**Mapping & Geolocation:**
- mapbox-gl 3.0.1 - Mapbox vector tile map library
  - Components: `src/frontend/components/ImageMap.tsx`, `src/frontend/containers/ContentView/MapView.tsx`
  - Access token: Embedded in component (not env-based)
- geo-coordinates-parser 1.6.3 - GPS coordinate parsing from EXIF

**UI & Styling:**
- mobx-react-lite 3.4.0 - MobX React integration (hooks)
- react-colorful 5.6.1 - Color picker component
- react-virtuoso 4.13.0 - Virtual scrolling (large lists)
- react-window 1.8.8 - Virtualized list/grid components
- react-json-view 1.21.3 - JSON tree viewer
- @floating-ui/react-dom 1.3.0 - Popover/tooltip positioning
- normalize.css 8.0.1 - CSS normalization
- Sass 1.58.1 - SCSS preprocessor

**WASM:**
- wasm-feature-detect 1.2.11 - WebAssembly feature detection
- Rust WASM modules (compiled from `wasm/`):
  - `wasm/masonry/` - Masonry layout algorithm (scalar + SIMD variants)
  - `wasm/exr-decoder/` - OpenEXR image decoding

**Utilities:**
- @svgr/webpack 6.5.1 - Webpack plugin to convert SVG to React components
- sourcemapped-stacktrace 1.1.11 - Improved error stack traces with source maps
- dexie-export-import 1.0.3 - IndexedDB backup/restore (legacy)

## Configuration

**Environment:**
- Portable mode detection via `PORTABLE_EXECUTABLE_DIR` (electron-builder Windows portable)
- User data path resolution: `app.getPath('userData')` (Electron) or computed on server
- Library registry: `{userData}/libraries.json` (first-class library concept)
- Active library tracking: `{userData}/active-library.json`

**Build:**
- TypeScript: `tsconfig.json` with path aliases (`common/*`, `src/*`, `widgets/*`, `resources/*`, `wasm/*`)
- ESLint: `.eslintrc.json` with TypeScript parser, React hooks rules
- Prettier: `.prettierrc.json` (single quotes, 100 char width, trailing commas)
- Jest: `jest.config.js` (ts-jest preset, fake-indexeddb for tests, module name mapping)

**Build Targets:**
1. **Desktop Electron** (production): `yarn build` → `webpack.prod.js` → `build/` → `electron-builder` (portable Windows)
2. **Development Electron**: `yarn dev` → `webpack.dev.js` (watch mode) → `build/`
3. **Web SPA**: `yarn build:web` → `webpack.web.js` → `dist-web/`
4. **Server Node bundle**: `yarn build:server` → `webpack.server.js` → `dist-server/server.bundle.js`
5. **Headless package**: `yarn package:headless` → builds web + server, wraps in Node SEA

## Platform Requirements

**Development:**
- Node.js (for webpack, jest, ts-node)
- Rust/Cargo (for WASM modules via `wasm/wasm-build/Cargo.toml`)
- Yarn 1.22.22
- Native build tools (for better-sqlite3 and Sharp on Linux/macOS)

**Production (Desktop - Windows Portable):**
- Windows 7+ (Electron requirement)
- NVIDIA GPU with NVENC support (optional; H.264 re-encode fails without it)
- 64-bit executable

**Production (Headless Web/Server):**
- Node.js 21.7+ (for Node SEA binary support)
- ffmpeg and ffprobe in PATH (or bundled)
- SQLite database file (read-only for web server)

---

*Stack analysis: 2026-06-24*
