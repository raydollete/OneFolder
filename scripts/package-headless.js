/**
 * scripts/package-headless.js — INV-034 / TASK-133
 *
 * Packages the OneFolder headless sidecar server as a standalone Node SEA
 * (Single Executable Application) binary, shipping all native dependencies
 * and the compiled web SPA alongside — no Node.js installation required.
 *
 * Why Node SEA (not pkg)?
 *   Node v20+ ships SEA as a first-class feature.  This project runs Node v24,
 *   so no extra dependency is required.  `pkg` / `@yao-pkg/pkg` is in
 *   maintenance mode and requires an extra dep.  SEA is the official, zero-dep
 *   path and produces a native exe from a copy of the running node binary.
 *
 * Native modules cannot be inlined:
 *   better-sqlite3 and sharp load native .node binaries at runtime.  These
 *   ship ALONGSIDE the exe in a node_modules/ subtree that mirrors the paths
 *   they are require()'d from inside the webpack bundle:
 *
 *     dist-headless/
 *       onefolder-server[.exe]          ← SEA binary
 *       dist-web/                       ← compiled SPA assets
 *       resources/
 *         exiftool/
 *           exiftool[.exe|.pl]
 *           .Exiftool_config
 *           lib/                        ← (macOS/Linux: perl lib tree)
 *       node_modules/
 *         better-sqlite3/
 *           build/Release/
 *             better_sqlite3.node
 *         @img/
 *           sharp-<platform>/
 *             lib/
 *               sharp-<platform>-<ver>.node
 *               *.dll (Windows only — libvips and friends)
 *
 * Path re-derivation:
 *   src/server/index.ts detects whether it is running as a packaged SEA via
 *   the `sea.isSea()` API (Node v21.7+) and, when true, resolves all resource
 *   paths relative to `path.dirname(process.execPath)` rather than __dirname
 *   (which inside a SEA bundle is a virtualised location, not the exe dir).
 *
 * Usage:
 *   node scripts/package-headless.js          # build first, then package
 *   node scripts/package-headless.js --no-build  # skip build steps (already built)
 *
 * Or via yarn:
 *   yarn package:headless
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const os = require('os');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist-headless');
const SERVER_BUNDLE = path.join(ROOT, 'dist-server', 'server.bundle.js');
const SPA_DIR = path.join(ROOT, 'dist-web');
const RESOURCES_DIR = path.join(ROOT, 'resources');
const NM_DIR = path.join(ROOT, 'node_modules');

const IS_WIN = process.platform === 'win32';
const EXE_NAME = IS_WIN ? 'onefolder-server.exe' : 'onefolder-server';
const EXE_OUT = path.join(OUT_DIR, EXE_NAME);

// SEA config file consumed by `node --experimental-sea-config`
const SEA_CONFIG = path.join(ROOT, 'sea-config.json');
const SEA_BLOB = path.join(OUT_DIR, 'server.blob');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd, opts = {}) {
  console.info(`  $ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`  [warn] copyDir: source not found, skipping: ${src}`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`  [warn] copyFile: source not found, skipping: ${src}`);
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// ---------------------------------------------------------------------------
// Step 1: Build server bundle + SPA (unless --no-build)
// ---------------------------------------------------------------------------

const noBuild = process.argv.includes('--no-build');

if (noBuild) {
  console.info('[package-headless] --no-build: skipping build steps.');
} else {
  console.info('[package-headless] 1/5 Building server bundle (build:server)...');
  run('yarn build:server');

  console.info('[package-headless] 2/5 Building web SPA (build:web)...');
  run('yarn build:web');
}

// Validate outputs exist
if (!fs.existsSync(SERVER_BUNDLE)) {
  console.error(`[package-headless] ERROR: server bundle not found at ${SERVER_BUNDLE}`);
  console.error('  Run `yarn build:server` first, or omit --no-build.');
  process.exit(1);
}
if (!fs.existsSync(SPA_DIR)) {
  console.error(`[package-headless] ERROR: SPA dist-web not found at ${SPA_DIR}`);
  console.error('  Run `yarn build:web` first, or omit --no-build.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 2: Prepare output directory
// ---------------------------------------------------------------------------

console.info('[package-headless] 3/5 Assembling output directory...');
ensureDir(OUT_DIR);

// ---------------------------------------------------------------------------
// Step 3: Copy the compiled SPA assets into dist-headless/dist-web/
// ---------------------------------------------------------------------------

console.info('  Copying SPA assets -> dist-headless/dist-web/');
copyDir(SPA_DIR, path.join(OUT_DIR, 'dist-web'));

// ---------------------------------------------------------------------------
// Step 4: Copy native resources alongside the exe
//
// Layout mirrors asarUnpack / extraResources in the Electron portable build:
//
//   resources/exiftool/
//     exiftool.exe  (Windows) | exiftool.pl (macOS/Linux)
//     .Exiftool_config
//     lib/          (macOS/Linux perl lib tree, if present)
//
//   node_modules/better-sqlite3/build/Release/better_sqlite3.node
//   node_modules/@img/sharp-<platform>/lib/  (node + DLLs on Windows)
// ---------------------------------------------------------------------------

// Exiftool
console.info('  Copying exiftool resources -> dist-headless/resources/exiftool/');
const exiftoolSrc = path.join(RESOURCES_DIR, 'exiftool');
const exiftoolDest = path.join(OUT_DIR, 'resources', 'exiftool');

if (fs.existsSync(exiftoolSrc)) {
  if (IS_WIN) {
    // Windows: copy just the exe + config (no lib/ tree needed)
    const filesToCopy = ['exiftool.exe', '.Exiftool_config'];
    for (const f of filesToCopy) {
      const src = path.join(exiftoolSrc, f);
      if (fs.existsSync(src)) {
        copyFile(src, path.join(exiftoolDest, f));
      }
    }
  } else {
    // macOS/Linux: copy the .pl script + config + lib/ perl tree
    copyDir(exiftoolSrc, exiftoolDest);
  }
} else {
  console.warn('  [warn] resources/exiftool not found — exiftool will not be available.');
}

// better-sqlite3 native .node
console.info('  Copying better-sqlite3 .node -> dist-headless/node_modules/...');
const bsqliteSrc = path.join(NM_DIR, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const bsqliteDest = path.join(
  OUT_DIR,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);
copyFile(bsqliteSrc, bsqliteDest);

// sharp native .node (and DLLs on Windows)
// sharp v0.35+ uses the @img/<platform> scoped package for platform binaries.
console.info('  Copying sharp native binaries -> dist-headless/node_modules/...');
const sharpImgDir = path.join(NM_DIR, '@img');
if (fs.existsSync(sharpImgDir)) {
  // Find platform-specific subdirectories (e.g. sharp-win32-x64, sharp-linux-x64)
  for (const entry of fs.readdirSync(sharpImgDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('sharp-')) {
      const platformSrc = path.join(sharpImgDir, entry.name, 'lib');
      const platformDest = path.join(OUT_DIR, 'node_modules', '@img', entry.name, 'lib');
      if (fs.existsSync(platformSrc)) {
        console.info(`    @img/${entry.name}/lib/`);
        copyDir(platformSrc, platformDest);
      }
    }
  }
} else {
  console.warn('  [warn] node_modules/@img not found — sharp will not be available.');
}

// ---------------------------------------------------------------------------
// Step 5: Build Node SEA binary
//
// Process:
//   a) Write a sea-config.json pointing at the server bundle.
//   b) Run `node --experimental-sea-config sea-config.json` to produce the blob.
//   c) Copy the running node binary to the output exe name.
//   d) On Windows, remove the signature from the copy (postject requirement).
//   e) Inject the blob into the copied binary with `postject`.
//   f) On Windows, re-sign with signtool if available (best-effort).
// ---------------------------------------------------------------------------

console.info('[package-headless] 4/5 Building Node SEA binary...');

// Write sea-config.json
const seaConfig = {
  main: SERVER_BUNDLE,
  output: SEA_BLOB,
  // Disable the experimental warning banner that Node prints for SEA.
  // Node 21.7+ supports this field.
  disableExperimentalSEAWarning: true,
  // useSnapshot and useCodeCache are false by default; the server bundle
  // is not pre-snapshot-compatible (async top-level isn't supported).
  useSnapshot: false,
  useCodeCache: true,
};

fs.writeFileSync(SEA_CONFIG, JSON.stringify(seaConfig, null, 2), 'utf8');
console.info(`  Wrote SEA config: ${SEA_CONFIG}`);

// Generate the blob
console.info('  Generating SEA blob...');
run(`node --experimental-sea-config "${SEA_CONFIG}"`);

if (!fs.existsSync(SEA_BLOB)) {
  console.error(`[package-headless] ERROR: SEA blob not generated at ${SEA_BLOB}`);
  process.exit(1);
}

// Copy the current node binary to the output exe
const nodeBin = process.execPath;
console.info(`  Copying node binary: ${nodeBin} -> ${EXE_OUT}`);
fs.copyFileSync(nodeBin, EXE_OUT);
if (!IS_WIN) {
  fs.chmodSync(EXE_OUT, 0o755);
}

// On Windows, strip the Authenticode signature from the copied node.exe so
// postject can modify the binary (signtool will reject a modified signed file,
// and postject itself cannot write into a signed PE).
if (IS_WIN) {
  console.info('  Removing signature from copied node.exe (Windows)...');
  try {
    // signtool is part of the Windows SDK.  If it is not on PATH, skip — the
    // binary is unsigned and postject can inject directly.
    execSync(`signtool remove /s "${EXE_OUT}"`, { stdio: 'pipe', cwd: ROOT });
    console.info('    Signature removed via signtool.');
  } catch {
    // signtool not available or binary was already unsigned — that's fine.
    console.info('    signtool not available or binary already unsigned — continuing.');
  }
}

// Inject the SEA blob using postject.
// postject is the Node-team-maintained injector for SEA: https://github.com/nicolo-ribaudo/postject
// It is available as a zero-install npx package.
console.info('  Injecting SEA blob with postject...');

const postjectArgs = [
  `"${EXE_OUT}"`,
  'NODE_SEA_BLOB',
  `"${SEA_BLOB}"`,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];

if (IS_WIN) {
  // Windows PE: use --overwrite so repeated runs don't fail
  postjectArgs.push('--overwrite');
}

if (process.platform === 'darwin') {
  // macOS Mach-O: blob goes into __NODE_SEA,NODE_SEA_BLOB section
  postjectArgs.push('--macho-segment-name', '__NODE_SEA');
}

const postjectCmd = `npx postject ${postjectArgs.join(' ')}`;
run(postjectCmd);

// ---------------------------------------------------------------------------
// Step 6: Write a portable.txt marker so the server binary can detect it is
// running from the packaged layout (same detection logic as the Electron
// portable build: presence of portable.txt next to the exe).
// ---------------------------------------------------------------------------

fs.writeFileSync(path.join(OUT_DIR, 'portable.txt'), '', 'utf8');
console.info('  Wrote portable.txt marker (packaged-mode detection).');

// ---------------------------------------------------------------------------
// Clean up the temporary SEA config + blob
// ---------------------------------------------------------------------------

try {
  fs.unlinkSync(SEA_CONFIG);
  fs.unlinkSync(SEA_BLOB);
} catch {
  // Non-fatal — intermediate files are in the output or root dir
}

// ---------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------

console.info('[package-headless] 5/5 Done!');
console.info('');
console.info('Output layout:');
console.info(`  ${OUT_DIR}/`);
console.info(`    ${EXE_NAME}            <- standalone server binary`);
console.info('    dist-web/              <- compiled SPA assets');
console.info('    resources/exiftool/    <- exiftool binary + config');
console.info('    node_modules/          <- better-sqlite3 + sharp native .node files');
console.info('    portable.txt           <- packaged-mode marker');
console.info('');
console.info('Run the server:');
console.info(`  cd "${OUT_DIR}" && ONEFOLDER_AUTH_SECRET=changeme ./${EXE_NAME}`);
console.info('');
console.info('Smoke-test checklist (deferred to TASK-137 QA pass):');
console.info('  1. Binary starts and logs "listening on http://localhost:8666"');
console.info('  2. Browser shows the SPA gallery at http://localhost:8666');
console.info('  3. /api/files returns JSON from the active library');
console.info('  4. /api/thumb/<id> returns an image (better-sqlite3 + sharp loaded)');
console.info('  5. /api/metadata/<id> returns EXIF data (exiftool loaded from resources/)');
console.info('  6. Test on a machine with no Node installed to verify self-containment.');
