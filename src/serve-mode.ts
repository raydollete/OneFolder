/**
 * Serve mode — `brave.exe --serve` starts the read-only web sidecar instead of
 * the desktop GUI, in the same portable context.
 *
 * This module is the ONLY glue between Electron and the server library. It
 * takes paths that the Electron main process already resolved (main.ts remaps
 * userData/temp for portable mode at module scope, before anything else runs)
 * and hands them to `startServer`, which derives nothing itself.
 *
 * Why that split matters: the server used to re-derive its own exe directory,
 * userData path and exiftool path. Two independent derivations of the same
 * path eventually disagree — and on the Windows portable target they already
 * would, because `process.execPath` points at the NSIS temp extraction
 * directory rather than the folder holding the user's executable.
 */

import path from 'path';
import fse from 'fs-extra';
import {
  LibraryRegistry,
  getSqliteDbPath,
  getDefaultThumbnailDir,
} from '../common/library-registry';
import { resolveCredential } from './server/auth';
import {
  startServer,
  resolvePort,
  resolveTlsMaterial,
  messages,
  ServerHandle,
} from './server/index';
import { createServerLogger } from './server/logger';

export const SERVE_LOG_FILENAME = 'server.log';

export interface ServeModeDeps {
  /** `app.getPath('userData')` — already remapped for portable mode. */
  userData: string;
  /** `app.getPath('temp')` — already remapped for portable mode. */
  tempPath: string;
  /** Whether the app is running in portable mode. */
  isPortable: boolean;
  /** The registry main.ts already constructed. */
  registry: LibraryRegistry;
  /** Absolute path to the bundled exiftool runnable. */
  exiftoolPath: string;
  /** Absolute path to the compiled web SPA directory. */
  spaDir: string;
  /** Raw `--port` value from argv, if any. */
  rawPort: string | undefined;
  /** Environment to read PORT / auth / TLS from. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Start serve mode. Rejects with an operator-facing message (already logged)
 * when the port is invalid or taken, or when no library / database exists.
 */
export async function startServeMode(deps: ServeModeDeps): Promise<ServerHandle> {
  const env = deps.env ?? process.env;
  const logger = createServerLogger(path.join(deps.userData, SERVE_LOG_FILENAME));

  // Port: --port wins over PORT; both are validated rather than coerced, and
  // resolvePort returns DEFAULT_PORT when neither is set.
  let port: number;
  try {
    port = resolvePort(deps.rawPort ?? env.PORT);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    throw err;
  }

  const activeLibraryId = deps.registry.getActiveLibraryId();
  if (activeLibraryId === null) {
    const message = messages.noLibrary(deps.userData);
    logger.error(message);
    throw new Error(message);
  }

  const library = deps.registry.getLibraries().find((lib) => lib.id === activeLibraryId);
  const libraryName = library?.name ?? activeLibraryId;

  const dbPath = getSqliteDbPath(deps.userData, activeLibraryId);
  if (!fse.pathExistsSync(dbPath)) {
    const message = messages.dbNotFound(dbPath);
    logger.error(message);
    logger.error(messages.dbNotFoundHint());
    throw new Error(message);
  }

  const thumbnailDir = getDefaultThumbnailDir(
    deps.userData,
    deps.tempPath,
    deps.isPortable,
    activeLibraryId,
  );

  const credential = resolveCredential(env);

  let tls = null;
  try {
    tls = resolveTlsMaterial(deps.userData, env, logger);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    throw err;
  }

  try {
    return await startServer({
      userData: deps.userData,
      dbPath,
      thumbnailDir,
      exiftoolPath: deps.exiftoolPath,
      spaDir: deps.spaDir,
      port,
      libraryName,
      credential,
      tls,
      logger,
    });
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    throw err;
  }
}
