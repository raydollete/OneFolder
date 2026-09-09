/**
 * Pure launch-context resolver for portable builds.
 *
 * OneFolder ships two portable packaging formats:
 *   - Windows: electron-builder's `portable` target wraps the app in an outer
 *     .exe and injects PORTABLE_EXECUTABLE_FILE / PORTABLE_EXECUTABLE_DIR.
 *   - Linux: the AppImage runtime exposes APPIMAGE (the absolute path of the
 *     outer .AppImage the user can move and relaunch).
 *
 * Both need the same thing from the boot path: the OUTER executable (so we can
 * relaunch it), the directory that holds it (the writable portable root), and
 * the adjacent `data/` directory. `src/main.ts` layers its filesystem opt-in
 * checks (`portable.txt` / an existing `data/` dir) and the actual
 * `app.setPath()` side effects on top of what this module returns.
 *
 * This module is deliberately PURE and dependency-free (only Node's `path`):
 *   - it takes an environment object, an executable path, isPackaged and the
 *     project root as inputs and returns a plain result,
 *   - it MUST NOT import 'electron' or call `app.*`,
 *   - it MUST NOT touch the filesystem or read `process.cwd()` — every path is
 *     derived from the inputs, so the result is current-working-directory
 *     independent.
 *
 * Keeping it pure is what makes the packaging precedence unit-testable.
 */

import path from 'path';

/**
 * The subset of environment variables that affect launch-context resolution.
 *
 * A plain index signature is included so a real `process.env` can be passed
 * without casting; only the named variables are read.
 */
export interface LaunchEnv {
  /** Windows electron-builder portable wrapper: the outer .exe on disk. */
  PORTABLE_EXECUTABLE_FILE?: string;
  /** Windows electron-builder portable wrapper: the directory holding the .exe. */
  PORTABLE_EXECUTABLE_DIR?: string;
  /** Linux AppImage: absolute path of the outer .AppImage the user relaunches. */
  APPIMAGE?: string;
  /**
   * Linux AppImage: the mounted read-only payload. Intentionally NOT used as
   * the writable portable root — it is a squashfs mount that disappears on
   * exit. Declared here only to document that it is deliberately ignored.
   */
  APPDIR?: string;
  [key: string]: string | undefined;
}

export interface ResolveLaunchContextInput {
  /** Environment variables (typically `process.env`). */
  env: LaunchEnv;
  /** The inner executable path (typically `process.execPath`). */
  execPath: string;
  /** Whether Electron considers the app packaged (typically `app.isPackaged`). */
  isPackaged: boolean;
  /**
   * The project root used as the portable-dir fallback in development
   * (mirrors `path.resolve(__dirname, '..')` in `src/main.ts`). Only consumed
   * when the app is neither a recognised portable format nor packaged.
   */
  projectRoot: string;
}

/** Which packaging format the launch context was resolved from. */
export type PortableFormat = 'windows-portable' | 'appimage' | 'packaged' | 'development';

export interface LaunchContext {
  /**
   * The OUTER executable the user can move and relaunch. For Windows portable
   * this is PORTABLE_EXECUTABLE_FILE; for AppImage it is APPIMAGE; otherwise it
   * is the given execPath.
   */
  executablePath: string;
  /**
   * The directory that holds the outer executable — the candidate writable
   * portable root. For Windows portable this is PORTABLE_EXECUTABLE_DIR (used
   * verbatim, as electron-builder sets it); for AppImage it is the AppImage's
   * containing directory; when packaged it is dirname(execPath); in dev it is
   * the project root.
   */
  portableDir: string;
  /** The adjacent data directory, always `join(portableDir, 'data')`. */
  dataDir: string;
  /**
   * True when the packaging FORMAT implies portable mode — i.e. a Windows
   * portable env var OR APPIMAGE is present. This is the format signal only;
   * `main.ts` may still enter portable mode via its `portable.txt` / `data/`
   * filesystem opt-in checks on top of a false value here.
   */
  isPortableFormat: boolean;
  /** Which branch of the precedence produced this context. */
  format: PortableFormat;
}

/**
 * Resolve the outer executable, portable directory and adjacent `data/` dir
 * from the packaging format, applying this precedence:
 *
 *   1. Windows electron-builder portable wrapper (PORTABLE_EXECUTABLE_FILE /
 *      PORTABLE_EXECUTABLE_DIR).
 *   2. Linux AppImage (APPIMAGE; its containing directory is the portable dir).
 *   3. Ordinary packaged / dev fallback (execPath; dir = dirname(execPath) when
 *      packaged, or the project root when not packaged).
 *
 * Windows portable takes precedence over AppImage so that a stray APPIMAGE in
 * the environment can never override an actual Windows portable launch.
 */
export function resolveLaunchContext(input: ResolveLaunchContextInput): LaunchContext {
  const { env, execPath, isPackaged, projectRoot } = input;

  // 1. Windows electron-builder portable wrapper.
  if (env.PORTABLE_EXECUTABLE_DIR !== undefined) {
    // Use PORTABLE_EXECUTABLE_DIR verbatim (as main.ts does today) rather than
    // deriving it from PORTABLE_EXECUTABLE_FILE — electron-builder owns both.
    const portableDir = env.PORTABLE_EXECUTABLE_DIR;
    const executablePath = env.PORTABLE_EXECUTABLE_FILE ?? execPath;
    return {
      executablePath,
      portableDir,
      dataDir: path.join(portableDir, 'data'),
      isPortableFormat: true,
      format: 'windows-portable',
    };
  }

  // 2. Linux AppImage. APPDIR (the read-only mount) is intentionally ignored.
  if (env.APPIMAGE !== undefined) {
    const executablePath = env.APPIMAGE;
    const portableDir = path.dirname(env.APPIMAGE);
    return {
      executablePath,
      portableDir,
      dataDir: path.join(portableDir, 'data'),
      isPortableFormat: true,
      format: 'appimage',
    };
  }

  // 3. Ordinary packaged / dev fallback.
  const portableDir = isPackaged ? path.dirname(execPath) : projectRoot;
  return {
    executablePath: execPath,
    portableDir,
    dataDir: path.join(portableDir, 'data'),
    isPortableFormat: false,
    format: isPackaged ? 'packaged' : 'development',
  };
}

export interface RelaunchCommand {
  /** The executable to spawn. */
  exe: string;
  /** The argument vector to pass, with the user's own flags forwarded. */
  args: string[];
}

export interface BuildRelaunchCommandInput {
  /** The resolved launch context (its executablePath is the relaunch target). */
  context: LaunchContext;
  /** The full process argv (typically `process.argv`). */
  argv: readonly string[];
  /** Whether Electron considers the app packaged (typically `app.isPackaged`). */
  isPackaged: boolean;
}

/**
 * Build the `{ exe, args }` for relaunching this process, forwarding the user's
 * own flags (including `--serve` and `--port <n>`).
 *
 * Mirrors the existing forceRelaunch logic in `src/main.ts`:
 *   - exe   = PORTABLE_EXECUTABLE_FILE ?? APPIMAGE ?? execPath
 *             (== context.executablePath by construction),
 *   - dev vs packaged argv slicing is identical: packaged binaries know how to
 *     launch themselves (drop argv[0]); in dev, electron must be told which app
 *     bundle to load (keep argv[1]).
 *
 * Dropping the user's flags silently would turn a `--serve` process into a GUI
 * process with no listener the first time any relaunch path fires, so they are
 * always forwarded.
 */
export function buildRelaunchCommand(input: BuildRelaunchCommandInput): RelaunchCommand {
  const { context, argv, isPackaged } = input;

  const exe = context.executablePath;
  const userFlags = argv.slice(isPackaged ? 1 : 2);
  const args = isPackaged ? [...userFlags] : [argv[1], ...userFlags];

  return { exe, args };
}
