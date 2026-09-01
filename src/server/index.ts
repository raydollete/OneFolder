/**
 * Sidecar server — the read-only web host, as a LIBRARY.
 *
 * This module builds and starts the Express server. It derives NOTHING about
 * its environment: userData, database path, thumbnail directory, exiftool
 * binary, SPA directory, port, credential and TLS material are all supplied by
 * the caller. Two independent derivations of the same path will eventually
 * disagree, so there is exactly one deriver — the Electron main process — and
 * this module is a pure consumer of what it resolved.
 *
 * The caller today is serve mode (`src/serve-mode.ts`), reached via
 * `brave.exe --serve`. Startup failures REJECT the returned promise; this
 * module never calls process.exit(), because the process it is running in may
 * be the desktop application.
 *
 * What the server does:
 *  1. Opens the active library's SQLite database strictly READ-ONLY.
 *  2. Applies COOP/COEP/CORP headers on every response (masonry SharedArrayBuffer).
 *  3. Gates all routes behind the auth middleware — which is a pass-through
 *     when no credential is configured (authentication is optional).
 *  4. Mounts the DataStorage REST routes consumed by HttpBackend.
 *  5. Serves the compiled web SPA.
 *  6. Listens over HTTP, or HTTPS when TLS material is supplied.
 *
 * ============================================================================
 * Environment variables (read by the CALLER, not by this module)
 * ============================================================================
 *
 * Credential — optional. When none is configured the server serves every
 * request without an authentication gate.
 *
 *   ONEFOLDER_AUTH_SECRET=<shared-secret>
 *     Used as both HTTP Basic username and password.
 *
 *   ONEFOLDER_AUTH_USER=<user>  ONEFOLDER_AUTH_PASSWORD=<password>
 *     Explicit pair. Takes precedence over ONEFOLDER_AUTH_SECRET.
 *
 * TLS — all optional:
 *
 *   ONEFOLDER_TLS=1            Enable HTTPS.
 *   ONEFOLDER_TLS_CERT=<path>  PEM certificate.
 *   ONEFOLDER_TLS_KEY=<path>   Matching PEM private key.
 *
 *   With ONEFOLDER_TLS=1 and no cert/key, a self-signed certificate is
 *   generated via `openssl req` and cached in userData for reuse.
 *   Reverse-proxy alternative: leave ONEFOLDER_TLS unset and terminate TLS
 *   upstream (nginx / Caddy / Tailscale). Auth is unaffected by TLS.
 *
 *   PORT=<number>              Listening port (default 8666); --port overrides.
 */

import path from 'path';
import fse from 'fs-extra';
import http from 'http';
import https from 'https';
import { execSync } from 'child_process';
import express, { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import SQLiteBackend from '../backend/sqlite-backend';
import { makeDataRouter } from './routes/data';
import { makeImagesRouter } from './routes/images';
import { makeMetadataRouter } from './routes/metadata';
import { makeRescanRouter } from './routes/rescan';
import ExifIO from '../../common/ExifIO';
import { makeAuthMiddleware, makeLoginRouter, Credential } from './auth';
import { ServerLogger, createConsoleLogger } from './logger';
import { messages, buildStartupBanner } from './config';

// Re-exported so callers have a single import site for the server API.
export { DEFAULT_PORT, messages, resolvePort, lanAddresses, buildStartupBanner } from './config';
export type { BannerInput } from './config';

export interface TlsMaterial {
  cert: string;
  key: string;
}

export interface ServeOptions {
  /** Portable data directory — `app.getPath('userData')`, already remapped. */
  userData: string;
  /** Absolute path to the active library's SQLite file. */
  dbPath: string;
  /** Absolute path to the active library's thumbnail cache. */
  thumbnailDir: string;
  /** Absolute path to the bundled exiftool runnable. */
  exiftoolPath: string;
  /** Absolute path to the compiled web SPA directory. */
  spaDir: string;
  /** Validated listening port. */
  port: number;
  /** Library display name, for the startup banner. */
  libraryName: string;
  /** Resolved credential, or null for an open (unauthenticated) server. */
  credential: Credential | null;
  /** TLS material, or null for plain HTTP. */
  tls: TlsMaterial | null;
  /** Logger; falls back to console-only when omitted. */
  logger?: ServerLogger;
}

export interface ServerHandle {
  /** The port actually bound. */
  port: number;
  /** Close the listener, the database and exiftool. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// TLS — self-signed cert generation
//
// Exported so the caller resolves TLS material explicitly and passes it in;
// this module never reads the environment itself.
// ---------------------------------------------------------------------------

function ensureSelfSignedCert(userData: string, logger: ServerLogger): TlsMaterial {
  const certPath = path.join(userData, 'server-cert.pem');
  const keyPath = path.join(userData, 'server-key.pem');

  if (fse.pathExistsSync(certPath) && fse.pathExistsSync(keyPath)) {
    return {
      cert: fse.readFileSync(certPath, 'utf8'),
      key: fse.readFileSync(keyPath, 'utf8'),
    };
  }

  logger.info('[server] Generating self-signed TLS certificate (valid 10 years)...');

  try {
    fse.mkdirsSync(userData);
    execSync(
      [
        'openssl req -x509 -newkey rsa:2048 -sha256 -days 3650',
        '-nodes',
        `-keyout "${keyPath}"`,
        `-out "${certPath}"`,
        '-subj "/CN=OneFolderSidecar"',
        '-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"',
      ].join(' '),
      { stdio: 'pipe', timeout: 30_000 },
    );

    logger.info(`[server] Self-signed certificate written to: ${certPath}`);
    logger.info(
      '[server] NOTE: Your browser will show a security warning for self-signed certificates. ' +
        'Add the cert to your browser trust store or use a reverse proxy with a trusted cert.',
    );

    return {
      cert: fse.readFileSync(certPath, 'utf8'),
      key: fse.readFileSync(keyPath, 'utf8'),
    };
  } catch (err) {
    throw new Error(
      '[server] Failed to generate self-signed TLS cert. ' +
        `Is openssl installed? Error: ${String(err)}`,
    );
  }
}

/**
 * Resolve TLS material from the environment, caching a self-signed cert in
 * `userData` when TLS is requested without an explicit cert/key pair.
 *
 * @param userData  Directory used to cache a generated certificate.
 * @param env       Environment to read (injected so this stays testable).
 * @returns         TLS material, or null when TLS is not enabled.
 */
export function resolveTlsMaterial(
  userData: string,
  env: NodeJS.ProcessEnv = process.env,
  logger: ServerLogger = createConsoleLogger(),
): TlsMaterial | null {
  const enabled = env.ONEFOLDER_TLS === '1' || env.ONEFOLDER_TLS === 'true';
  if (!enabled) {
    return null;
  }

  const certEnv = env.ONEFOLDER_TLS_CERT;
  const keyEnv = env.ONEFOLDER_TLS_KEY;

  if (certEnv !== undefined && certEnv !== '' && keyEnv !== undefined && keyEnv !== '') {
    if (!fse.pathExistsSync(certEnv)) {
      throw new Error(`[server] ONEFOLDER_TLS_CERT path not found: ${certEnv}`);
    }
    if (!fse.pathExistsSync(keyEnv)) {
      throw new Error(`[server] ONEFOLDER_TLS_KEY path not found: ${keyEnv}`);
    }
    logger.info(`[server] Using operator-provided TLS certificate: ${certEnv}`);
    return {
      cert: fse.readFileSync(certEnv, 'utf8'),
      key: fse.readFileSync(keyEnv, 'utf8'),
    };
  }

  return ensureSelfSignedCert(userData, logger);
}

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

/**
 * Release everything a (possibly only partially) started server owns.
 *
 * Safe to call at any point after the two handles exist: `exifIO.close()` on a
 * child that never opened is a no-op, and closing a read-only sqlite handle
 * twice is guarded by the caller.
 */
async function closeServerResources(
  db: InstanceType<typeof Database>,
  exifIO: ExifIO,
): Promise<void> {
  await exifIO.close().catch(() => undefined);
  db.close();
}

/**
 * Build and start the sidecar server.
 *
 * Rejects (never exits the process) when the database is missing, the port is
 * taken, or the listener cannot start.
 */
export async function startServer(opts: ServeOptions): Promise<ServerHandle> {
  const logger = opts.logger ?? createConsoleLogger();

  if (!fse.pathExistsSync(opts.dbPath)) {
    throw new Error(messages.dbNotFound(opts.dbPath));
  }

  // Open strictly read-only — the sidecar must never write to the library.
  //
  // No journal_mode pragma is issued here. WAL is a property of the database
  // FILE which readers detect automatically; a read-only connection cannot
  // change it, so the previous `db.pragma('journal_mode = WAL')` either no-oped
  // or threw SQLITE_READONLY depending on the file's current mode. Inside the
  // Electron main process that would take serve mode down at startup.
  const db = new Database(opts.dbPath, { readonly: true });

  // ExifIO spawns a long-lived exiftool child process. From here on the server
  // owns two OS resources, so EVERY failure path below must release them before
  // it propagates — a rejected start that skips this leaves an orphaned
  // exiftool.exe behind for the lifetime of the machine. Measured: launching a
  // second serve process on a taken port left one exiftool child per attempt.
  const exifIO = new ExifIO('|', opts.exiftoolPath);
  try {
    return await buildAndListen(opts, logger, db, exifIO);
  } catch (err) {
    await closeServerResources(db, exifIO);
    throw err;
  }
}

/**
 * Wire up the Express app and open the listener.
 *
 * Split out of `startServer` so that the database handle and the exiftool child
 * are owned by a scope that closes them when this rejects.
 */
async function buildAndListen(
  opts: ServeOptions,
  logger: ServerLogger,
  db: InstanceType<typeof Database>,
  exifIO: ExifIO,
): Promise<ServerHandle> {
  // Construct SQLiteBackend with the read-only connection.
  // Pass a no-op notifyChange — the server never fires change notifications.
  const backend = new SQLiteBackend(db, () => {});

  // ExifIO — read-only metadata service, one persistent exiftool child process
  // reused for all reads. Only read methods are exposed over HTTP; there are no
  // write endpoints in makeMetadataRouter.
  //
  // The hierarchical separator defaults to '|' (the OneFolder standard); the
  // server has no access to per-library localStorage preferences.
  try {
    await exifIO.initialize();
    logger.info('[server] ExifIO (exiftool) initialized.');
  } catch (exifErr) {
    // Non-fatal: metadata routes fail gracefully if exiftool cannot start, but
    // image serving and DB reads are unaffected.
    logger.warn(
      `[server] ExifIO initialization failed — metadata routes will be unavailable: ${String(
        exifErr,
      )}`,
    );
  }

  const app = express();

  // Parse JSON request bodies (needed by POST routes in the data router).
  app.use(express.json());

  // COOP/COEP/CORP first, so they are present on EVERY response including auth
  // rejections — assets loaded after authentication still see correct headers
  // and masonry's SharedArrayBuffer keeps working.
  function coopCoepMiddleware(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  }
  app.use(coopCoepMiddleware);

  // Auth gate. With no credential configured this is a pass-through — see
  // makeAuthMiddleware. Mounted after the security headers and before every
  // route handler, static file and the SPA fallback.
  const tlsActive = opts.tls !== null;
  app.use(makeAuthMiddleware(opts.credential, tlsActive));

  // Login / logout — mounted before static files so it takes precedence.
  app.use('/api', makeLoginRouter(opts.credential, tlsActive));

  // SPA static files.
  const spaDir = opts.spaDir;
  if (fse.pathExistsSync(spaDir)) {
    app.use(
      express.static(spaDir, {
        // Do not cache the HTML entry-point so fresh deployments are picked up.
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
  } else {
    logger.warn(`[server] SPA assets not found at ${spaDir} — static serving disabled.`);
  }

  // API routes.
  app.use('/api', makeDataRouter(backend, db));
  app.use('/api', makeImagesRouter(db, opts.thumbnailDir));
  app.use('/api', makeMetadataRouter(db, exifIO));
  app.use('/api', makeRescanRouter(db));

  // SPA fallback — index.html for any non-/api route so the client router
  // handles navigation.
  // A RegExp, not the string '*': Express 5 switched to path-to-regexp v8,
  // where a bare '*' is a parse error ("Missing parameter name at index 1")
  // rather than a wildcard. A RegExp means the same thing in both versions.
  const indexHtml = path.join(spaDir, 'index.html');
  app.get(/.*/, (_req: Request, res: Response) => {
    if (fse.pathExistsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      res.status(503).json({
        error: `SPA assets not found at ${spaDir}. Run \`yarn build\` to produce them.`,
      });
    }
  });

  const server =
    opts.tls !== null
      ? https.createServer({ cert: opts.tls.cert, key: opts.tls.key }, app)
      : http.createServer(app);

  // Bind. No host argument: the server listens on every interface so other
  // devices on the network can reach it — the banner discloses exactly that.
  await new Promise<void>((resolve, reject) => {
    function onError(err: NodeJS.ErrnoException): void {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(messages.portInUse(opts.port)));
      } else {
        reject(err);
      }
    }
    function onListening(): void {
      server.removeListener('error', onError);
      resolve();
    }
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port);
  });

  for (const line of buildStartupBanner({
    port: opts.port,
    protocol: opts.tls !== null ? 'https' : 'http',
    authUser: opts.credential === null ? null : opts.credential.user,
    authIsSharedSecret: opts.credential?.kind === 'secret',
    libraryName: opts.libraryName,
    logFilePath: logger.filePath,
  })) {
    logger.info(line);
  }

  let closed = false;
  return {
    port: opts.port,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      logger.info(messages.shuttingDown());
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeServerResources(db, exifIO);
    },
  };
}
