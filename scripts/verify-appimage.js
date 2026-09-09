/**
 * Extracted-payload verifier for the Linux AppImage build.
 *
 * Runs AFTER `yarn package:appimage`. It locates the built AppImage under `dist/`,
 * extracts it, and asserts the packaging contract end-to-end: exact-case resources,
 * executable bits, ELF x86_64 architecture, Linux-native modules, desktop metadata,
 * icons, the absence of any leaked Windows PE helpers, and a live ffmpeg smoke test
 * that proves the shipped binary is the GPL build with h264_nvenc.
 *
 * Every failure is LOUD and specific; the process exits non-zero on the first failure
 * class collected. Run: `node scripts/verify-appimage.js`
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const failures = [];
function fail(msg) {
  failures.push(msg);
  // eslint-disable-next-line no-console
  console.error(`  ✗ ${msg}`);
}
function ok(msg) {
  // eslint-disable-next-line no-console
  console.log(`  ✓ ${msg}`);
}
function section(msg) {
  // eslint-disable-next-line no-console
  console.log(`\n[verify:appimage] ${msg}`);
}

/** Recursively collect every file/dir path under `dir`. */
function walk(dir, acc) {
  acc = acc || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    acc.push(full);
    if (e.isDirectory() && !e.isSymbolicLink()) {
      walk(full, acc);
    }
  }
  return acc;
}

/** Find the single path under `root` whose path ends with `suffix` (posix-normalized). */
function findBySuffix(allPaths, suffix) {
  const norm = suffix.split(path.sep).join('/');
  return allPaths.find((p) => p.split(path.sep).join('/').endsWith(norm));
}
function findAllBySuffix(allPaths, suffix) {
  const norm = suffix.split(path.sep).join('/');
  return allPaths.filter((p) => p.split(path.sep).join('/').endsWith(norm));
}

/** True if `file` is an ELF x86_64 (e_machine == 0x3E). */
function isElfX86_64(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(20);
    fs.readSync(fd, buf, 0, 20, 0);
    const isElf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
    if (!isElf) {
      return { elf: false, machine: null };
    }
    const machine = buf.readUInt16LE(18); // e_machine
    return { elf: true, machine };
  } finally {
    fs.closeSync(fd);
  }
}

function main() {
  // --- 1. Exactly one versioned x86_64 AppImage artifact -----------------------
  section('Locating AppImage artifact');
  if (!fs.existsSync(DIST)) {
    fail(`dist/ does not exist — did \`yarn package:appimage\` run? (${DIST})`);
    return finish();
  }
  const artifacts = fs
    .readdirSync(DIST)
    .filter((f) => /^OneFolder-.*-x86_64\.AppImage$/.test(f));
  if (artifacts.length !== 1) {
    fail(
      `expected exactly ONE versioned x86_64 AppImage (OneFolder-<version>-x86_64.AppImage) in dist/, found ${artifacts.length}: ${JSON.stringify(
        artifacts,
      )}`,
    );
    // Without an artifact we cannot do payload checks.
    if (artifacts.length === 0) {
      return finish();
    }
  } else {
    ok(`one versioned artifact: ${artifacts[0]}`);
  }
  const appImage = path.join(DIST, artifacts[0]);
  const sizeMb = (fs.statSync(appImage).size / (1024 * 1024)).toFixed(1);
  ok(`artifact size ${sizeMb} MB`);

  // The AppImage itself must be an executable ELF x86_64.
  const appImageElf = isElfX86_64(appImage);
  if (!appImageElf.elf || appImageElf.machine !== 0x3e) {
    fail(`AppImage is not an ELF x86_64 (elf=${appImageElf.elf} machine=${appImageElf.machine})`);
  } else {
    ok('AppImage is ELF x86_64');
  }
  if (!(fs.statSync(appImage).mode & 0o111)) {
    fail(`AppImage is not executable (mode ${fs.statSync(appImage).mode.toString(8)})`);
  } else {
    ok('AppImage is executable');
  }

  // --- 2. Extract the payload --------------------------------------------------
  section('Extracting payload');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'appimage-verify-'));
  try {
    fs.chmodSync(appImage, 0o755);
  } catch {
    /* best effort */
  }
  let squashRoot;
  try {
    execFileSync(appImage, ['--appimage-extract'], { cwd: tmp, stdio: 'pipe' });
    squashRoot = path.join(tmp, 'squashfs-root');
    if (!fs.existsSync(squashRoot)) {
      throw new Error('squashfs-root not produced by --appimage-extract');
    }
    ok(`extracted to ${squashRoot}`);
  } catch (err) {
    fail(`--appimage-extract failed: ${err && err.message ? err.message : err}`);
    return finish();
  }

  const paths = walk(squashRoot);

  // --- 3. Exact-case exiftool resources ---------------------------------------
  section('Exact-case resource inputs');
  const exifConfig = findBySuffix(paths, 'resources/exiftool/.ExifTool_config');
  if (!exifConfig) {
    fail('missing exact-case resources/exiftool/.ExifTool_config (capital E, T)');
  } else {
    ok('resources/exiftool/.ExifTool_config present (exact case)');
  }
  // A lowercase-t variant must NOT exist — that is the case-sensitivity bug.
  const misspelled = findAllBySuffix(paths, 'resources/exiftool/.Exiftool_config');
  if (misspelled.length) {
    fail(`misspelled .Exiftool_config (lowercase t) leaked into payload: ${misspelled.join(', ')}`);
  } else {
    ok('no misspelled .Exiftool_config in payload');
  }
  const exiftoolPl = findBySuffix(paths, 'resources/exiftool/exiftool.pl');
  if (!exiftoolPl) {
    fail('missing resources/exiftool/exiftool.pl');
  } else {
    ok('resources/exiftool/exiftool.pl present');
  }
  const exiftoolLib = findBySuffix(paths, 'resources/exiftool/lib');
  if (!exiftoolLib || !fs.statSync(exiftoolLib).isDirectory()) {
    fail('missing resources/exiftool/lib directory');
  } else {
    ok('resources/exiftool/lib present');
  }

  // --- 4. Helper presence + execute bits --------------------------------------
  section('Helper presence and execute bits');
  const ffmpeg = findBySuffix(paths, 'resources/ffmpeg/ffmpeg');
  const ffprobe = findBySuffix(paths, 'resources/ffmpeg/ffprobe');
  const execTargets = [
    ['resources/ffmpeg/ffmpeg', ffmpeg],
    ['resources/ffmpeg/ffprobe', ffprobe],
    ['resources/exiftool/exiftool.pl', exiftoolPl],
  ];
  for (const [label, p] of execTargets) {
    if (!p) {
      fail(`missing ${label}`);
      continue;
    }
    const mode = fs.statSync(p).mode;
    if (!(mode & 0o111)) {
      fail(`${label} is not executable (mode ${mode.toString(8)})`);
    } else {
      ok(`${label} executable (mode ${(mode & 0o777).toString(8)})`);
    }
  }

  // --- 5. ELF architecture / ABI ----------------------------------------------
  section('ELF architecture / ABI (x86_64)');
  for (const [label, p] of [
    ['ffmpeg', ffmpeg],
    ['ffprobe', ffprobe],
  ]) {
    if (!p) continue;
    const info = isElfX86_64(p);
    if (!info.elf) {
      fail(`${label} is not an ELF binary`);
    } else if (info.machine !== 0x3e) {
      fail(`${label} is ELF but not x86_64 (e_machine=0x${info.machine.toString(16)})`);
    } else {
      ok(`${label} is ELF x86_64`);
    }
  }

  // --- 6. Native modules under the unpacked asar ------------------------------
  section('Linux-native modules under app.asar.unpacked');
  const unpackedRoot = findBySuffix(paths, 'app.asar.unpacked');
  if (!unpackedRoot) {
    fail('app.asar.unpacked not found in payload — asarUnpack did not run');
  } else {
    ok('app.asar.unpacked present');
    for (const mod of [
      'app.asar.unpacked/node_modules/better-sqlite3',
      'app.asar.unpacked/node_modules/sharp',
      'app.asar.unpacked/node_modules/@img',
    ]) {
      const p = findBySuffix(paths, mod);
      if (!p) {
        fail(`missing ${mod} under unpacked asar`);
      } else {
        ok(`${mod} present`);
      }
    }
    // At least one .node must be ELF x86_64 (proves a Linux native rebuild).
    const nodeFiles = paths.filter(
      (p) => p.includes('app.asar.unpacked') && p.endsWith('.node') && fs.statSync(p).isFile(),
    );
    if (!nodeFiles.length) {
      fail('no *.node native module found under app.asar.unpacked');
    } else {
      let anyX86 = false;
      for (const nf of nodeFiles) {
        const info = isElfX86_64(nf);
        if (info.elf && info.machine === 0x3e) {
          anyX86 = true;
          ok(`native module ELF x86_64: ${path.basename(nf)}`);
          break;
        }
      }
      if (!anyX86) {
        fail(
          `no ELF x86_64 *.node found (checked ${nodeFiles.length}): ${nodeFiles
            .map((p) => path.basename(p))
            .join(', ')}`,
        );
      }
    }
  }

  // --- 7. Desktop metadata -----------------------------------------------------
  section('Desktop metadata');
  const desktopFile = findAllBySuffix(paths, '.desktop').find((p) => fs.statSync(p).isFile());
  if (!desktopFile) {
    fail('no .desktop entry in payload');
  } else {
    ok(`desktop entry: ${path.basename(desktopFile)}`);
    // The executableName identity is carried by the .desktop FILENAME (onefolder.desktop)
    // and Icon=onefolder. For AppImage, electron-builder intentionally sets
    // Exec=`AppRun --no-sandbox %U` (the AppImage launcher), so Exec is NOT the raw
    // executableName — asserting the filename is the correct identity linkage.
    if (path.basename(desktopFile) !== 'onefolder.desktop') {
      fail(`.desktop filename expected onefolder.desktop, got ${path.basename(desktopFile)}`);
    } else {
      ok('.desktop filename is onefolder.desktop (executableName identity)');
    }
    const content = fs.readFileSync(desktopFile, 'utf8');
    const entry = {};
    for (const line of content.split(/\r?\n/)) {
      const m = /^([A-Za-z0-9-]+)=(.*)$/.exec(line);
      if (m) entry[m[1]] = m[2];
    }
    const checks = [
      ['Name', 'OneFolder', (v) => v === 'OneFolder'],
      // AppImage launches through AppRun; accept that or a direct executableName Exec.
      ['Exec', 'AppRun|onefolder', (v) => /AppRun|onefolder/.test(v)],
      ['StartupWMClass', 'OneFolder', (v) => v === 'OneFolder'],
      ['Icon', 'onefolder', (v) => v === 'onefolder'],
    ];
    for (const [key, expected, pred] of checks) {
      if (!pred(entry[key] || '')) {
        fail(`.desktop ${key} expected ${expected}, got ${JSON.stringify(entry[key])}`);
      } else {
        ok(`.desktop ${key}=${entry[key]}`);
      }
    }
  }

  // --- 8. Icons ----------------------------------------------------------------
  section('Icons');
  const iconPngs = paths.filter(
    (p) =>
      p.endsWith('.png') &&
      (p.includes(`${path.sep}icons${path.sep}`) ||
        /\/(apps)\//.test(p.split(path.sep).join('/')) ||
        /onefolder.*\.png$/i.test(path.basename(p))),
  );
  if (!iconPngs.length) {
    fail('no icon PNG packaged in payload');
  } else {
    ok(`${iconPngs.length} icon PNG(s) packaged (e.g. ${path.relative(squashRoot, iconPngs[0])})`);
  }

  // --- 9. No Windows PE helpers ------------------------------------------------
  section('No Windows PE helpers in Linux payload');
  const exeFiles = paths.filter(
    (p) => p.toLowerCase().endsWith('.exe') && fs.statSync(p).isFile(),
  );
  if (exeFiles.length) {
    fail(
      `Windows PE helper(s) leaked into Linux payload: ${exeFiles
        .map((p) => path.relative(squashRoot, p))
        .join(', ')}`,
    );
  } else {
    ok('no *.exe files in payload');
  }

  // --- 10. ffmpeg smoke test (h264_nvenc) -------------------------------------
  section('ffmpeg smoke test');
  if (ffmpeg) {
    try {
      const version = execFileSync(ffmpeg, ['-hide_banner', '-version'], {
        stdio: 'pipe',
      }).toString();
      ok(`ffmpeg -version: ${version.split(/\r?\n/)[0]}`);
    } catch (err) {
      fail(`ffmpeg -version failed: ${err && err.message ? err.message : err}`);
    }
    try {
      const encoders = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], {
        stdio: 'pipe',
      }).toString();
      if (/h264_nvenc/.test(encoders)) {
        ok('ffmpeg advertises h264_nvenc encoder');
      } else {
        fail('ffmpeg does not advertise h264_nvenc — wrong build shipped');
      }
    } catch (err) {
      fail(`ffmpeg -encoders failed: ${err && err.message ? err.message : err}`);
    }
  }

  // Cleanup best-effort.
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  return finish();
}

function finish() {
  // eslint-disable-next-line no-console
  console.log('');
  if (failures.length) {
    // eslint-disable-next-line no-console
    console.error(
      `[verify:appimage] FAILED with ${failures.length} problem(s):\n` +
        failures.map((f) => `  - ${f}`).join('\n'),
    );
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.log('[verify:appimage] PASSED — AppImage payload satisfies the packaging contract.');
  process.exit(0);
}

main();
