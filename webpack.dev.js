// This file contains the development configuration for Webpack.
// Webpack is used to bundle our source code, in order to optimize which
// scripts are loaded and all required files to run the application are
// neatly put into the build directory.
// Based on https://taraksharma.com/setting-up-electron-typescript-react-webpack/

const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');
const path = require('path');

let mainConfig = {
  mode: 'development',
  entry: './src/main.ts',
  devtool: 'source-map',
  target: ['electron-main', 'es2022'],
  output: {
    filename: 'main.bundle.js',
    path: __dirname + '/build',
    clean: true,
    // keep filename ending the same: certain filename patterns required for certain Electron icon uses
    assetModuleFilename: 'assets/[hash]_[name][ext][query]',
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  resolve: {
    extensions: ['.js', '.json', '.ts'],
  },
  externals: {
    fsevents: "require('fsevents')",
    'better-sqlite3': "require('better-sqlite3')",
  },
  module: {
    rules: [
      {
        // All files with a '.ts' or '.tsx' extension will be handled by 'ts-loader'.
        test: /\.(ts)$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
        },
      },
      {
        test: /\.(jpg|png|gif|ico|icns|eot|ttf|woff|woff2)$/,
        type: 'asset/resource',
      },
    ],
  },
};

let rendererConfig = {
  mode: 'development',
  entry: './src/renderer.tsx',
  devtool: 'source-map',
  target: ['electron-renderer', 'es2022'],
  output: {
    filename: 'renderer.bundle.js',
    path: __dirname + '/build',
  },
  node: {
    __dirname: false,
    __filename: false,
  },
  experiments: {
    asyncWebAssembly: true,
  },
  resolve: {
    extensions: ['.js', '.json', '.ts', '.tsx', '.svg', '.wasm'],
    alias: {
      common: path.resolve(__dirname, 'common/'),
      widgets: path.resolve(__dirname, 'widgets/'),
      resources: path.resolve(__dirname, 'resources/'),
      src: path.resolve(__dirname, 'src/'),
      wasm: path.resolve(__dirname, 'wasm/'),
      // Platform seam: resolves to the Electron implementation for the desktop
      // bundle. The web SPA target (TASK-130) will override this alias to point
      // at platform.web.ts. See INV-034 / TASK-126.
      'src/frontend/platform': path.resolve(
        __dirname,
        'src/frontend/platform/platform.electron.ts',
      ),
    },
  },
  externals: {
    fsevents: "require('fsevents')",
    'better-sqlite3': "require('better-sqlite3')",
  },
  module: {
    rules: [
      {
        // All files with a '.ts' or '.tsx' extension will be handled by 'ts-loader'.
        test: /\.(ts|tsx)$/,
        exclude: /node_modules/,
        loader: 'ts-loader',
      },
      {
        test: /\.(scss|css)$/,
        use: [
          'style-loader',
          { loader: 'css-loader', options: { sourceMap: true } },
          { loader: 'sass-loader', options: { sourceMap: true } },
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
    // IS_WEB_BUILD is false in the Electron renderer bundle; this lets the
    // web-mode branch in renderer.tsx be dead-code-eliminated.
    // The web SPA webpack config (TASK-130) sets this to true.
    new webpack.DefinePlugin({ IS_WEB_BUILD: JSON.stringify(false) }),
  ],
};

module.exports = [mainConfig, rendererConfig];
