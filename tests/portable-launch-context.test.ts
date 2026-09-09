/**
 * Unit tests for src/portable-launch-context.ts.
 *
 * The resolver is pure: it decides the outer executable, the writable portable
 * directory and the adjacent `data/` dir from the packaging FORMAT (env vars +
 * isPackaged), never from the filesystem or the current working directory.
 *
 * These tests are table-driven and prove:
 *   - the Windows-portable → AppImage → packaged/dev precedence,
 *   - that Windows portable results are unchanged (byte-identical to today),
 *   - current-working-directory independence,
 *   - adjacent `data/` (and temp) derivation from the portable dir,
 *   - GUI and `--serve --port 9000` relaunch argument construction.
 *
 * Expected paths are built with the same `path` module the resolver uses, so
 * the assertions hold on both POSIX and Windows test runners.
 */

import path from 'path';
import os from 'os';

import {
  resolveLaunchContext,
  buildRelaunchCommand,
  LaunchContext,
  LaunchEnv,
} from '../src/portable-launch-context';

// A representative absolute path per platform, built via `path` so joins/dirnames
// use the runner's separator.
const ROOT = path.parse(process.cwd()).root; // e.g. '/' or 'C:\'
const WIN_PORTABLE_DIR = path.join(ROOT, 'Portable', 'OneFolder');
const WIN_PORTABLE_EXE = path.join(WIN_PORTABLE_DIR, 'OneFolder.exe');
const APPIMAGE_DIR = path.join(ROOT, 'home', 'user', 'Apps');
const APPIMAGE_FILE = path.join(APPIMAGE_DIR, 'OneFolder.AppImage');
const APPDIR_MOUNT = path.join(ROOT, 'tmp', '.mount_OneFoAbc123'); // read-only payload
const PACKAGED_EXE = path.join(ROOT, 'opt', 'OneFolder', 'onefolder');
const DEV_EXEC = path.join(ROOT, 'usr', 'bin', 'electron');
const PROJECT_ROOT = path.join(ROOT, 'src', 'OneFolder');

describe('resolveLaunchContext — precedence', () => {
  interface Case {
    name: string;
    env: LaunchEnv;
    execPath: string;
    isPackaged: boolean;
    expected: LaunchContext;
  }

  const cases: Case[] = [
    {
      name: 'Windows portable: uses PORTABLE_EXECUTABLE_FILE/_DIR',
      env: {
        PORTABLE_EXECUTABLE_FILE: WIN_PORTABLE_EXE,
        PORTABLE_EXECUTABLE_DIR: WIN_PORTABLE_DIR,
      },
      execPath: path.join(ROOT, 'tmp', 'nsis-extract', 'app.exe'),
      isPackaged: true,
      expected: {
        executablePath: WIN_PORTABLE_EXE,
        portableDir: WIN_PORTABLE_DIR,
        dataDir: path.join(WIN_PORTABLE_DIR, 'data'),
        isPortableFormat: true,
        format: 'windows-portable',
      },
    },
    {
      name: 'Windows portable takes precedence over a stray APPIMAGE',
      env: {
        PORTABLE_EXECUTABLE_FILE: WIN_PORTABLE_EXE,
        PORTABLE_EXECUTABLE_DIR: WIN_PORTABLE_DIR,
        APPIMAGE: APPIMAGE_FILE,
      },
      execPath: PACKAGED_EXE,
      isPackaged: true,
      expected: {
        executablePath: WIN_PORTABLE_EXE,
        portableDir: WIN_PORTABLE_DIR,
        dataDir: path.join(WIN_PORTABLE_DIR, 'data'),
        isPortableFormat: true,
        format: 'windows-portable',
      },
    },
    {
      name: 'AppImage: uses APPIMAGE and its containing directory',
      env: { APPIMAGE: APPIMAGE_FILE },
      execPath: PACKAGED_EXE, // inner electron binary inside the mount — ignored
      isPackaged: true,
      expected: {
        executablePath: APPIMAGE_FILE,
        portableDir: APPIMAGE_DIR,
        dataDir: path.join(APPIMAGE_DIR, 'data'),
        isPortableFormat: true,
        format: 'appimage',
      },
    },
    {
      name: 'AppImage: ignores APPDIR (the read-only mount) as the writable root',
      env: { APPIMAGE: APPIMAGE_FILE, APPDIR: APPDIR_MOUNT },
      execPath: path.join(APPDIR_MOUNT, 'usr', 'bin', 'onefolder'),
      isPackaged: true,
      expected: {
        executablePath: APPIMAGE_FILE,
        portableDir: APPIMAGE_DIR,
        dataDir: path.join(APPIMAGE_DIR, 'data'),
        isPortableFormat: true,
        format: 'appimage',
      },
    },
    {
      name: 'packaged (non-portable): falls back to dirname(execPath)',
      env: {},
      execPath: PACKAGED_EXE,
      isPackaged: true,
      expected: {
        executablePath: PACKAGED_EXE,
        portableDir: path.dirname(PACKAGED_EXE),
        dataDir: path.join(path.dirname(PACKAGED_EXE), 'data'),
        isPortableFormat: false,
        format: 'packaged',
      },
    },
    {
      name: 'development: falls back to the project root',
      env: {},
      execPath: DEV_EXEC,
      isPackaged: false,
      expected: {
        executablePath: DEV_EXEC,
        portableDir: PROJECT_ROOT,
        dataDir: path.join(PROJECT_ROOT, 'data'),
        isPortableFormat: false,
        format: 'development',
      },
    },
  ];

  it.each(cases)('$name', ({ env, execPath, isPackaged, expected }) => {
    const result = resolveLaunchContext({ env, execPath, isPackaged, projectRoot: PROJECT_ROOT });
    expect(result).toEqual(expected);
  });
});

describe('resolveLaunchContext — Windows portable results are unchanged', () => {
  // Guards the byte-identical contract with the current src/main.ts detection:
  //   _portableAppDir = PORTABLE_EXECUTABLE_DIR
  //   exe             = PORTABLE_EXECUTABLE_FILE ?? execPath
  //   dataDir         = join(_portableAppDir, 'data')
  it('mirrors the legacy PORTABLE_EXECUTABLE_DIR-based derivation exactly', () => {
    const env: LaunchEnv = {
      PORTABLE_EXECUTABLE_FILE: WIN_PORTABLE_EXE,
      PORTABLE_EXECUTABLE_DIR: WIN_PORTABLE_DIR,
    };
    const result = resolveLaunchContext({
      env,
      execPath: path.join(ROOT, 'tmp', 'nsis', 'app.exe'),
      isPackaged: true,
      projectRoot: PROJECT_ROOT,
    });

    // Legacy: _portableAppDir === PORTABLE_EXECUTABLE_DIR (verbatim, not dirname(FILE)).
    expect(result.portableDir).toBe(env.PORTABLE_EXECUTABLE_DIR);
    expect(result.dataDir).toBe(path.join(env.PORTABLE_EXECUTABLE_DIR!, 'data'));
    expect(result.isPortableFormat).toBe(true);
  });

  it('uses PORTABLE_EXECUTABLE_DIR verbatim even when it differs from dirname(FILE)', () => {
    // electron-builder owns both vars independently; the resolver must not
    // re-derive the dir from the file path.
    const oddDir = path.join(ROOT, 'Portable', 'elsewhere');
    const result = resolveLaunchContext({
      env: {
        PORTABLE_EXECUTABLE_FILE: WIN_PORTABLE_EXE,
        PORTABLE_EXECUTABLE_DIR: oddDir,
      },
      execPath: PACKAGED_EXE,
      isPackaged: true,
      projectRoot: PROJECT_ROOT,
    });
    expect(result.portableDir).toBe(oddDir);
    expect(result.portableDir).not.toBe(path.dirname(WIN_PORTABLE_EXE));
  });
});

describe('resolveLaunchContext — current-working-directory independence', () => {
  const inputs = {
    env: { APPIMAGE: APPIMAGE_FILE } as LaunchEnv,
    execPath: PACKAGED_EXE,
    isPackaged: true,
    projectRoot: PROJECT_ROOT,
  };

  it('returns identical results regardless of process.cwd()', () => {
    const originalCwd = process.cwd();
    try {
      process.chdir(os.tmpdir());
      const fromTmp = resolveLaunchContext(inputs);

      process.chdir(ROOT);
      const fromRoot = resolveLaunchContext(inputs);

      expect(fromTmp).toEqual(fromRoot);
      expect(fromTmp.portableDir).toBe(APPIMAGE_DIR);
      expect(fromTmp.dataDir).toBe(path.join(APPIMAGE_DIR, 'data'));
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe('resolveLaunchContext — adjacent data/temp derivation', () => {
  // main.ts points BOTH userData and temp at this single adjacent data/ dir,
  // so proving dataDir === join(portableDir, 'data') covers both redirects.
  it.each([
    ['windows portable', { PORTABLE_EXECUTABLE_DIR: WIN_PORTABLE_DIR } as LaunchEnv, WIN_PORTABLE_DIR],
    ['appimage', { APPIMAGE: APPIMAGE_FILE } as LaunchEnv, APPIMAGE_DIR],
  ])('%s: dataDir (and temp) is join(portableDir, "data")', (_name, env, dir) => {
    const result = resolveLaunchContext({
      env,
      execPath: PACKAGED_EXE,
      isPackaged: true,
      projectRoot: PROJECT_ROOT,
    });
    expect(result.dataDir).toBe(path.join(dir, 'data'));
    expect(result.dataDir).toBe(path.join(result.portableDir, 'data'));
  });
});

describe('buildRelaunchCommand', () => {
  function ctx(env: LaunchEnv, execPath: string, isPackaged: boolean): LaunchContext {
    return resolveLaunchContext({ env, execPath, isPackaged, projectRoot: PROJECT_ROOT });
  }

  it('packaged GUI relaunch: exe = execPath, forwards no injected argv[0]', () => {
    const context = ctx({}, PACKAGED_EXE, true);
    const argv = [PACKAGED_EXE];
    expect(buildRelaunchCommand({ context, argv, isPackaged: true })).toEqual({
      exe: PACKAGED_EXE,
      args: [],
    });
  });

  it('dev GUI relaunch: keeps argv[1] (the app bundle) and drops electron argv[0..1] flag base', () => {
    const context = ctx({}, DEV_EXEC, false);
    const argv = [DEV_EXEC, 'build/main.bundle.js'];
    expect(buildRelaunchCommand({ context, argv, isPackaged: false })).toEqual({
      exe: DEV_EXEC,
      args: ['build/main.bundle.js'],
    });
  });

  it('Windows portable relaunch: exe = PORTABLE_EXECUTABLE_FILE, forwards user flags', () => {
    const env: LaunchEnv = {
      PORTABLE_EXECUTABLE_FILE: WIN_PORTABLE_EXE,
      PORTABLE_EXECUTABLE_DIR: WIN_PORTABLE_DIR,
    };
    const context = ctx(env, path.join(ROOT, 'tmp', 'nsis', 'app.exe'), true);
    const argv = [WIN_PORTABLE_EXE, '--serve', '--port', '9000'];
    expect(buildRelaunchCommand({ context, argv, isPackaged: true })).toEqual({
      exe: WIN_PORTABLE_EXE,
      args: ['--serve', '--port', '9000'],
    });
  });

  it('AppImage relaunch: exe = APPIMAGE (not the inner execPath), forwards --serve --port 9000', () => {
    const context = ctx({ APPIMAGE: APPIMAGE_FILE }, PACKAGED_EXE, true);
    const argv = [APPIMAGE_FILE, '--serve', '--port', '9000'];
    expect(buildRelaunchCommand({ context, argv, isPackaged: true })).toEqual({
      exe: APPIMAGE_FILE,
      args: ['--serve', '--port', '9000'],
    });
  });

  it('dev serve relaunch: keeps the bundle path AND forwards --serve --port 9000', () => {
    const context = ctx({}, DEV_EXEC, false);
    const argv = [DEV_EXEC, 'build/main.bundle.js', '--serve', '--port', '9000'];
    expect(buildRelaunchCommand({ context, argv, isPackaged: false })).toEqual({
      exe: DEV_EXEC,
      args: ['build/main.bundle.js', '--serve', '--port', '9000'],
    });
  });

  it('forwards the equals form of --port as-is', () => {
    const context = ctx({ APPIMAGE: APPIMAGE_FILE }, PACKAGED_EXE, true);
    const argv = [APPIMAGE_FILE, '--serve', '--port=9000'];
    expect(buildRelaunchCommand({ context, argv, isPackaged: true })).toEqual({
      exe: APPIMAGE_FILE,
      args: ['--serve', '--port=9000'],
    });
  });
});
