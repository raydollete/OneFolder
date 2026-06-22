/**
 * Webpack configuration for the web SPA bundle (INV-034 / TASK-130).
 *
 * Produces a browser-only bundle that:
 *  - targets the `web` platform (no Node/Electron builtins assumed)
 *  - selects the web platform seam implementation via resolve.alias
 *  - stubs out Electron-only static imports that live in dead-code branches
 *    of src/renderer.tsx (NormalModuleReplacementPlugin + empty-stub.ts)
 *  - disables all Node built-in fallbacks (resolve.fallback: false)
 *  - sets IS_WEB_BUILD=true so webpack dead-code-eliminates the Electron branch
 *  - shims process.platform so runtime guards in App.tsx / common/process.ts work
 *  - keeps asyncWebAssembly + WASM asset rules for the masonry layout module
 *
 * Output: dist-web/
 *   The sidecar server (src/server/index.ts) looks for the SPA at
 *   path.resolve(__dirname, '..', '..', 'dist-web') relative to its own
 *   build output (dist-server/).  Both output dirs sit at the repo root.
 *
 * Scripts (see package.json):
 *   yarn build:web          one-shot production build
 *   yarn dev:web            webpack --watch in development mode
 *
 * The Electron dev/production configs (webpack.dev.js / webpack.prod.js) are
 * completely unchanged — they retain target:electron-renderer,
 * IS_WEB_BUILD=false, and the platform.electron.ts alias.
 *
 * See INV-034 / TASK-130.
 */

const HtmlWebpackPlugin = require('html-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');
const webpack = require('webpack');
const path = require('path');

// ---------------------------------------------------------------------------
// Stub path — all Electron-only static imports in renderer.tsx are redirected
// here so webpack never touches better-sqlite3 / fs-extra / electron / etc.
// The stub exports nothing; the dead-code branch that uses it is eliminated by
// DefinePlugin (IS_WEB_BUILD=true).
// ---------------------------------------------------------------------------
const EMPTY_STUB = path.resolve(__dirname, 'src/frontend/platform/empty-stub.ts');

// ---------------------------------------------------------------------------
// folderWatcher stub — redirects the chokidar/original-fs/Node-fs watcher
// worker to a no-op browser-safe stub (TASK-135).
// ---------------------------------------------------------------------------
const FOLDER_WATCHER_STUB = path.resolve(
  __dirname,
  'src/frontend/workers/folderWatcher.worker.stub.ts',
);

// ---------------------------------------------------------------------------
// Mode — set by --mode flag from the yarn script.
// Defaults to 'development' for safety; build:web passes --mode production.
// ---------------------------------------------------------------------------
module.exports = (env, argv) => {
  const mode = (argv && argv.mode) || 'development';
  const isDev = mode !== 'production';

  return {
    mode,
    entry: './src/renderer.tsx',
    // `web` target: no Node built-ins assumed; webpack resolves everything for
    // a browser environment.
    target: ['web', 'es2022'],
    devtool: isDev ? 'source-map' : false,

    output: {
      filename: 'renderer.bundle.js',
      // The sidecar server (dist-server/) looks for this dir via '../../dist-web'.
      path: path.resolve(__dirname, 'dist-web'),
      // Needed so assets (WASM, images, fonts) are fetched from the right prefix
      // when the SPA is served by Express at the repo root.
      publicPath: '/',
      // Clean old assets on each production build.
      clean: !isDev,
      assetModuleFilename: 'assets/[hash]_[name][ext][query]',
    },

    // ---------------------------------------------------------------------------
    // asyncWebAssembly: required by the masonry layout WASM module.
    // ---------------------------------------------------------------------------
    experiments: {
      asyncWebAssembly: true,
    },

    // ---------------------------------------------------------------------------
    // Resolve
    // ---------------------------------------------------------------------------
    resolve: {
      extensions: ['.js', '.json', '.ts', '.tsx', '.svg', '.wasm'],

      alias: {
        // Shared directory aliases — identical to the Electron renderer config.
        common: path.resolve(__dirname, 'common/'),
        widgets: path.resolve(__dirname, 'widgets/'),
        resources: path.resolve(__dirname, 'resources/'),
        src: path.resolve(__dirname, 'src/'),
        wasm: path.resolve(__dirname, 'wasm/'),

        // Platform seam: web implementation instead of the Electron pass-through.
        // This is the only alias that differs from webpack.dev.js / webpack.prod.js.
        'src/frontend/platform': path.resolve(
          __dirname,
          'src/frontend/platform/platform.web.ts',
        ),
      },

      // ---------------------------------------------------------------------------
      // Node built-in fallbacks — ALL disabled.
      //
      // webpack 5 no longer polyfills Node built-ins automatically.  Setting each
      // to `false` (or omitting it) means any import of these modules that webpack
      // actually tries to resolve (i.e. not redirected to the empty stub) will emit
      // a hard build error, which is what we want: it names the file TASK-126 missed.
      //
      // Modules explicitly falsy here:
      //   fs / fs-extra / original-fs   — redirected to empty-stub by NormalModuleReplacementPlugin
      //                                   for the renderer.tsx static imports; fallback
      //                                   guards against any other import escaping the stub.
      //   better-sqlite3                — native module; must never reach the browser bundle.
      //   electron                      — Electron API; must never reach the browser bundle.
      //   node-stream-zip               — Node-only zip reader used in platform.electron.ts only.
      //   chokidar                      — Node file watcher; dropped for the read-only web build.
      //   crypto                        — Node crypto; web builds use the SubtleCrypto API instead.
      //   path                          — platform.web.ts supplies its own path helpers;
      //                                   the NormalModuleReplacementPlugin also stubs
      //                                   the renderer.tsx static `import path from 'path'`.
      //   os                            — only used server-side.
      //   stream / buffer               — not needed in the browser bundle.
      // ---------------------------------------------------------------------------
      fallback: {
        fs: false,
        'fs-extra': false,
        'original-fs': false,
        'better-sqlite3': false,
        electron: false,
        'node-stream-zip': false,
        chokidar: false,
        crypto: false,
        path: false,
        os: false,
        stream: false,
        buffer: false,
        net: false,
        tls: false,
        http: false,
        https: false,
        zlib: false,
        child_process: false,
        worker_threads: false,
      },
    },

    // ---------------------------------------------------------------------------
    // No externals — the web bundle must be self-contained.  The Electron configs
    // use externals for better-sqlite3/fsevents so those native modules are
    // required() at runtime; that pattern does not apply to a browser bundle.
    // ---------------------------------------------------------------------------

    // ---------------------------------------------------------------------------
    // Module rules — mirrors the Electron renderer config with:
    //   • style-loader in dev (inline styles, HMR friendly)
    //   • MiniCssExtractPlugin.loader in production (separate .css file)
    //   • WASM assets kept (masonry requires asyncWebAssembly)
    //   • No node-loader (.node files are never needed in a browser bundle)
    // ---------------------------------------------------------------------------
    module: {
      rules: [
        {
          test: /\.(ts|tsx)$/,
          exclude: /node_modules/,
          loader: 'ts-loader',
        },
        {
          test: /\.(scss|css)$/,
          use: [
            isDev ? 'style-loader' : MiniCssExtractPlugin.loader,
            { loader: 'css-loader', options: { sourceMap: isDev } },
            { loader: 'sass-loader', options: { sourceMap: isDev } },
          ],
        },
        {
          test: /\.(jpg|png|gif|ico|icns|eot|ttf|woff|woff2)$/,
          type: 'asset/resource',
        },
        {
          test: /\.wasm$/,
          type: 'asset/resource',
        },
        {
          test: /\.js$/,
          resourceQuery: /file/,
          type: 'asset/resource',
        },
        {
          test: /\.svg$/,
          oneOf: [
            {
              issuer: /\.scss$/,
              type: 'asset/resource',
            },
            {
              issuer: /.tsx?$/,
              loader: '@svgr/webpack',
            },
          ],
        },
      ],
    },

    plugins: [
      new HtmlWebpackPlugin({
        template: path.resolve(__dirname, './src/index.html'),
      }),

      // -----------------------------------------------------------------------
      // IS_WEB_BUILD=true — activates the HttpBackend branch in renderer.tsx
      // and dead-code-eliminates the Electron (SQLite/IPC) branch from the bundle.
      //
      // process.platform — shimmed to 'web' so runtime guards in App.tsx and
      // common/process.ts (which check process.platform for the OS-specific UI)
      // receive a predictable, non-'darwin'/'win32'/'linux' value.
      //
      // process.env.NODE_ENV — required by React and MobX for production tree-shaking.
      // -----------------------------------------------------------------------
      new webpack.DefinePlugin({
        IS_WEB_BUILD: JSON.stringify(true),
        'process.platform': JSON.stringify('web'),
        'process.env.NODE_ENV': JSON.stringify(mode),
        // Prevent `typeof process` checks from breaking when webpack replaces usages.
        // Only define the properties actually referenced in the codebase.
        'process.type': JSON.stringify('renderer'),
      }),

      // -----------------------------------------------------------------------
      // NormalModuleReplacementPlugin — redirect static Electron-only imports in
      // src/renderer.tsx to empty-stub.ts so webpack never resolves or bundles
      // the Node/native modules they transitively reference.
      //
      // These modules are only used inside the `if (!IS_WEB_BUILD)` dead-code
      // branch of renderer.tsx; redirecting them here means the resolver never
      // needs to find better-sqlite3, original-fs, or the electron IPC layer.
      //
      // Pattern: match the exact module specifier strings as they appear in the
      // import statements.  Each plugin instance matches one pattern.
      // -----------------------------------------------------------------------

      // fs-extra — used directly in renderer.tsx (Electron branch) and in many
      // platform.electron.ts callers; platform.web.ts never uses it.
      new webpack.NormalModuleReplacementPlugin(/^fs-extra$/, EMPTY_STUB),

      // path — standard Node path; platform.web.ts provides its own path helpers.
      new webpack.NormalModuleReplacementPlugin(/^path$/, EMPTY_STUB),

      // common/library-registry — imports sqlite-config which value-imports better-sqlite3.
      new webpack.NormalModuleReplacementPlugin(/common\/library-registry$/, EMPTY_STUB),

      // Electron IPC layer — imports ipcRenderer from electron.
      new webpack.NormalModuleReplacementPlugin(/src\/ipc\/renderer$/, EMPTY_STUB),

      // SQLite backend modules — all import better-sqlite3 directly.
      new webpack.NormalModuleReplacementPlugin(/\/backend\/sqlite-backend$/, EMPTY_STUB),
      new webpack.NormalModuleReplacementPlugin(/\/backend\/sqlite-backup-scheduler$/, EMPTY_STUB),
      new webpack.NormalModuleReplacementPlugin(/\/backend\/sqlite-config$/, EMPTY_STUB),
      new webpack.NormalModuleReplacementPlugin(
        /\/backend\/migration-indexeddb-to-sqlite$/,
        EMPTY_STUB,
      ),

      // renderer-migration — imports fs-extra and path for one-time layout migration.
      new webpack.NormalModuleReplacementPlugin(/\/renderer-migration$/, EMPTY_STUB),

      // platform.electron — the seam's index.ts statically re-exports the Electron
      // implementation (`export { default } from './platform.electron'`).  The broader
      // `src` resolve.alias fires before the specific `src/frontend/platform` alias, so
      // a bare `import platform from 'src/frontend/platform'` resolves to the directory's
      // index.ts (not platform.web.ts) and drags in the Electron impl (node-stream-zip,
      // RendererMessenger, etc.).  Redirect platform.electron → platform.web here so the
      // default export resolves to the web impl regardless of alias ordering.
      new webpack.NormalModuleReplacementPlugin(
        /platform\.electron$/,
        path.resolve(__dirname, 'src/frontend/platform/platform.web.ts'),
      ),

      // common/ExifIO — spawns native exiftool via @logion/node-exiftool (child_process).
      // In the web build, ExifIO is provided by the platform seam's HTTP shim
      // (platform.web.ts → createWebExifIOShim).  The real ExifIO class is never
      // instantiated in the browser; RootStore uses platform.exif.getExifIO() instead
      // of `new ExifIO(...)` (TASK-132).
      new webpack.NormalModuleReplacementPlugin(/common\/ExifIO$/, EMPTY_STUB),

      // folderWatcher.worker — imports chokidar, original-fs, and Node fs.
      // In the web build the watcher is not used (TASK-135): platform.fs.pathExists()
      // returns false so ClientLocation.init() never calls watch().  The stub exports
      // a no-op FolderWatcherWorker so the TypeScript import in entities/Location.ts
      // resolves without pulling Node-only modules into the browser bundle.
      new webpack.NormalModuleReplacementPlugin(
        /workers\/folderWatcher\.worker$/,
        FOLDER_WATCHER_STUB,
      ),

      ...(isDev
        ? []
        : [
            new MiniCssExtractPlugin({
              filename: '[name].[contenthash].css',
              chunkFilename: '[id].[contenthash].css',
            }),
          ]),
    ],
  };
};
