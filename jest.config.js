const path = require('path');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: [
    // FIXME: I did not manage to get Dexie working in an actual Electron test environment. Testing in JavaScript is
    // cursed, so indexeddb is replaced by an in-memory implementation.
    'fake-indexeddb/auto',
    // Crypto module is not stable in the node version we use, nor can we use the browser.
    '<rootDir>/tests/setup/jest.crypto.js',
  ],
  transform: {
    // Enable esModuleInterop so that `import foo from 'bar'` works for CommonJS
    // modules (path, fs-extra, etc.) in the Node test environment.
    // The main tsconfig omits esModuleInterop because Webpack handles interop
    // itself; ts-jest must do it explicitly here.
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { esModuleInterop: true } }],
  },
  moduleNameMapper: {
    // Stub CSS/SCSS FIRST — before the path-alias mappers below resolve
    // widget imports (e.g. 'widgets/utility/utility.scss') to real file paths.
    // moduleNameMapper tests patterns against the original import string in
    // order, so placing this first ensures .scss imports are stubbed regardless
    // of which alias namespace they come from.
    '\\.(css|scss|sass)$': '<rootDir>/tests/setup/style-stub.js',
    // Stub out Electron and other native modules that cannot run in Node.
    '^electron$': '<rootDir>/tests/setup/module-stubs.js',
    // Resolve path aliases from tsconfig baseUrl so that imports like
    // `'common/fs'` and `'src/frontend/...'` work inside ts-jest.
    '^common/(.*)$': path.join(__dirname, 'common/$1'),
    '^src/(.*)$': path.join(__dirname, 'src/$1'),
    '^widgets/(.*)$': path.join(__dirname, 'widgets/$1'),
  },
};
