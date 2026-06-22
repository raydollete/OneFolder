/**
 * Webpack configuration for the sidecar Node server (INV-034 / TASK-130).
 *
 * Produces a single Node.js bundle at dist-server/server.bundle.js that:
 *  - runs as a plain Node process (no Electron)
 *  - opens the SQLite database read-only via better-sqlite3 (externalized)
 *  - serves the web SPA from dist-web/ with COOP/COEP headers
 *  - exposes the DataStorage REST API consumed by HttpBackend
 *
 * Why webpack (not tsc)?
 *   The project already uses webpack for all other build targets.  Webpack's
 *   externals pattern cleanly handles better-sqlite3 (a native .node module
 *   that cannot be inlined): it emits require('better-sqlite3') in the bundle
 *   so the native file is loaded at runtime from node_modules alongside the
 *   built artifact.  tsc would produce many individual .js files (the full
 *   module graph) rather than a single deployable bundle, which complicates
 *   single-binary packaging (TASK-133).  Webpack is the right tool here.
 *
 * Output: dist-server/server.bundle.js
 *   Run with: node dist-server/server.bundle.js
 *
 * __dirname behaviour:
 *   Setting `node: { __dirname: false }` (same as the Electron main config)
 *   preserves the real filesystem __dirname at runtime.  This is required
 *   because src/server/index.ts uses __dirname to resolve the dist-web SPA dir:
 *     path.resolve(__dirname, '..', '..', 'dist-web')
 *   which from dist-server/server.bundle.js → ../../dist-web → repo-root/dist-web/
 *
 * Externals:
 *   better-sqlite3  — native .node file; must be require()'d at runtime, not inlined.
 *   sharp           — native .node file; used by server-side image decoding (TASK-131).
 *   fsevents        — macOS-only optional dep of chokidar; not used by the server.
 *   Any *.node file  — catch-all for other native modules (e.g. @tensorflow binaries).
 *
 * See INV-034 / TASK-130.
 */

const webpack = require('webpack');
const path = require('path');

module.exports = (env, argv) => {
  const mode = (argv && argv.mode) || 'production';

  return {
    mode,
    entry: './src/server/index.ts',
    // Node target: webpack sets up module system for Node.js, not a browser.
    target: ['node', 'es2022'],
    devtool: mode !== 'production' ? 'source-map' : false,

    output: {
      filename: 'server.bundle.js',
      path: path.resolve(__dirname, 'dist-server'),
      clean: true,
    },

    // Preserve real __dirname so the server can locate dist-web/ at runtime.
    // Matches the pattern used by the Electron mainConfig in webpack.dev.js /
    // webpack.prod.js.
    node: {
      __dirname: false,
      __filename: false,
    },

    // ---------------------------------------------------------------------------
    // Externals — modules that must be require()'d at runtime rather than bundled.
    //
    // better-sqlite3 contains a native .node binary that cannot be inlined.
    // sharp similarly ships native binaries.
    // The function form catches any *.node file that webpack encounters while
    // traversing the module graph (e.g. native addons in transitive deps).
    // ---------------------------------------------------------------------------
    externals: [
      // Named externals for the known native packages.
      {
        'better-sqlite3': "require('better-sqlite3')",
        sharp: "require('sharp')",
        fsevents: "require('fsevents')",
      },
      // Function form: any require() of a *.node file → keep as require() at runtime.
      function ({ request }, callback) {
        if (request && request.endsWith('.node')) {
          callback(null, 'commonjs ' + request);
          return;
        }
        callback();
      },
    ],

    resolve: {
      extensions: ['.js', '.json', '.ts', '.tsx'],
      alias: {
        // Shared directory aliases — same as all other webpack configs.
        common: path.resolve(__dirname, 'common/'),
        src: path.resolve(__dirname, 'src/'),
        wasm: path.resolve(__dirname, 'wasm/'),
      },
    },

    module: {
      rules: [
        {
          test: /\.(ts|tsx)$/,
          exclude: /node_modules/,
          loader: 'ts-loader',
          options: {
            // transpileOnly avoids full type-checking during bundle (fast builds).
            // Type errors are caught by `yarn lint` / `tsc --noEmit`.
            transpileOnly: true,
          },
        },
        {
          // Preserve native .node files as external resources (belt-and-suspenders
          // alongside the externals function above).
          test: /\.node$/,
          loader: 'node-loader',
        },
      ],
    },

    plugins: [
      // Provide a stable NODE_ENV for Express and other deps that check it.
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify(mode),
      }),
    ],
  };
};
