/**
 * Sidecar server entry point — INV-034 / TASK-128, extended TASK-134.
 *
 * Boots an Express HTTP (or HTTPS) server that:
 *  1. Re-derives the userData path the same way the portable Electron build does.
 *  2. Opens the active library's SQLite database strictly READ-ONLY.
 *  3. Applies COOP/COEP/CORP headers on every response (masonry SharedArrayBuffer).
 *  4. Gates ALL routes behind the auth middleware (TASK-134).
 *  5. Mounts the DataStorage REST routes (TASK-128, consumed by HttpBackend / TASK-127).
 *  6. Serves the compiled web SPA (produced by TASK-130) with COOP/COEP headers.
 *  7. Optionally starts an HTTPS listener when ONEFOLDER_TLS=1 (TASK-134).
 *
 * The desktop Electron app is unaffected — this file is never imported by the
 * Electron main or renderer bundle; it is only run as a standalone Node process.
 *
 * ============================================================================
 * Auth & TLS env vars (TASK-134)
 * ============================================================================
 *
 * Credential — ONE of the following:
 *
 *   ONEFOLDER_AUTH_SECRET=<shared-secret>
 *     Use the same string as both HTTP Basic username and password.
 *     Simplest option: set one var, share it with the browser.
 *
 *   ONEFOLDER_AUTH_USER=<user>  ONEFOLDER_AUTH_PASSWORD=<password>
 *     Explicit username + password pair.  Takes precedence over AUTH_SECRET.
 *
 * TLS — all optional:
 *
 *   ONEFOLDER_TLS=1            Enable HTTPS.  Without this the server uses
 *                              plain HTTP (fine for local loopback; use a
 *                              reverse proxy for TLS in production).
 *
 *   ONEFOLDER_TLS_CERT=<path>  Path to a PEM certificate file.
 *   ONEFOLDER_TLS_KEY=<path>   Path to the matching PEM private key file.
 *
 *   When ONEFOLDER_TLS=1 but no cert/key paths are provided, the server
 *   auto-generates a self-signed certificate via `openssl req` and stores
 *   it in the userData directory for reuse across restarts.
 *
 *   Reverse-proxy alternative: leave ONEFOLDER_TLS unset and terminate TLS
 *   upstream (nginx / Caddy / Tailscale), forwarding plain HTTP to PORT.
 *   The auth middleware remains in effect regardless of TLS.
 *
 * Other:
 *   PORT=<number>              Listening port (default: 8666).
 */

import path from 'path';
import os from 'os';
import fse from 'fs-extra';
import http from 'http';
import https from 'https';
import { execSync } from 'child_process';
import express, { Request, Response, NextFunction } from 'express';
import Database from 'better-sqlite3';
import {
  LibraryRegistry,
  getSqliteDbPath,
  getDefaultThumbnailDir,
} from '../../common/library-registry';
import SQLiteBackend from '../backend/sqlite-backend';
import { makeDataRouter } from './routes/data';
import { makeImagesRouter } from './routes/images';
import { makeMetadataRouter } from './routes/metadata';
import { makeRescanRouter } from './routes/rescan';
import ExifIO from '../../common/ExifIO';
import { resolveCredential, makeAuthMiddleware, makeLoginRouter } from './auth';

/**
 * Whether the current process is running as a Node SEA binary.
 * `node:sea` is available in Node v21.7+; it returns false when running as a
 * plain Node process (ts-node, `node server.bundle.js`).
 * We guard with a try/catch for forward-compat with older Node versions.
 */
function isSea(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const sea = require('node:sea') as { isSea: () => boolean };
    return sea.isSea();
  } catch {
    return false;
  }
}
const IS_SEA = isSea();

// ---------------------------------------------------------------------------
// SEA-aware binary directory resolution (INV-034 / TASK-133)
//
// In a Node SEA (Single Executable Application), __dirname is virtualised to
// a path inside the injected blob (e.g. /snapshot/project/dist-server/).
// It does NOT refer to the directory that contains the running binary.
//
// We detect the SEA environment via `node:sea` and, when packaged, resolve
// resource paths relative to `path.dirname(process.execPath)` instead.
//
// In dev mode (ts-node or plain node dist-server/server.bundle.js) `isSea()`
// returns false, so we fall back to __dirname-relative paths as before.
// ---------------------------------------------------------------------------

/**
 * Returns the directory that contains the running server binary (or script).
 *
 * - Packaged SEA binary: directory of process.execPath
 *   e.g. /Users/alice/onefolder-server/ → /Users/alice/onefolder-server/
 * - Dev (ts-node src/server/index.ts): two levels up from __dirname (= src/server/)
 *   → repo root
 * - Dev (node dist-server/server.bundle.js): two levels up from __dirname
 *   (= dist-server/) → repo root, which contains dist-web/ and resources/
 */
function resolveExeDir(): string {
  if (IS_SEA) {
    // Packaged: binary lives in dist-headless/; all resources are siblings.
    return path.dirname(process.execPath);
  }
  // Development: __dirname is src/server/ (ts-node) or dist-server/ (webpack).
  // Two levels up reaches the repo root where dist-web/ and resources/ live.
  return path.resolve(__dirname, '..', '..');
}

/**
 * Returns the absolute path to the exiftool runnable for the current platform,
 * resolved relative to the exe directory (SEA-safe).
 *
 * Packaged layout (mirrors asarUnpack/extraResources in the Electron build):
 *   <exeDir>/resources/exiftool/exiftool.exe   (Windows)
 *   <exeDir>/resources/exiftool/exiftool.pl    (macOS/Linux)
 *
 * Dev layout (ts-node / plain node server.bundle.js):
 *   <repoRoot>/resources/exiftool/exiftool.exe
 */
function resolveExiftoolPath(exeDir: string): string {
  const runnable = process.platform === 'win32' ? 'exiftool.exe' : 'exiftool.pl';
  return path.join(exeDir, 'resources', 'exiftool', runnable);
}

// ---------------------------------------------------------------------------
// Portable-path resolution
//
// The server binary ships alongside the portable Electron build.  The portable
// build stores user data in a `data/` directory next to the executable.  We
// re-derive that same path here so library/DB discovery works without Electron.
//
// Resolution order (mirrors src/main.ts):
//   1. $PORTABLE_EXECUTABLE_DIR env-var  — set by electron-builder portable target
//   2. exe directory (SEA: dirname of process.execPath; dev: repo root) with a
//      portable.txt marker or data/ subdirectory present.
//   3. Fall back to the standard OS userData location so development-mode runs
//      against the same library as the desktop app.
// ---------------------------------------------------------------------------

function resolveUserDataPath(exeDir: string): string {
  // Electron-builder portable sets this env var; respect it when present.
  if (process.env.PORTABLE_EXECUTABLE_DIR !== undefined) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data');
  }

  const portableDataDir = path.join(exeDir, 'data');
  const isPortable =
    fse.pathExistsSync(path.join(exeDir, 'portable.txt')) || fse.pathExistsSync(portableDataDir);

  if (isPortable) {
    return portableDataDir;
  }

  // Non-portable / development: mirror the OS-standard Electron userData path.
  //   Windows: %APPDATA%\OneFolder
  //   macOS:   ~/Library/Application Support/OneFolder
  //   Linux:   ~/.config/OneFolder
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA ?? os.homedir(), 'OneFolder');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'OneFolder');
    default:
      return path.join(os.homedir(), '.config', 'OneFolder');
  }
}

// ---------------------------------------------------------------------------
// TLS — self-signed cert generation
//
// When ONEFOLDER_TLS=1 and no ONEFOLDER_TLS_CERT/KEY paths are provided,
// a self-signed cert is generated via `openssl req` and cached in userData.
// The cert is valid for 3650 days (10 years) and reused across restarts.
//
// Operators who need a trusted cert should either:
//   a) Provide their own via ONEFOLDER_TLS_CERT + ONEFOLDER_TLS_KEY, or
//   b) Use a reverse proxy (nginx / Caddy / Tailscale) for TLS termination.
// ---------------------------------------------------------------------------

interface TlsMaterial {
  cert: string;
  key: string;
}

function ensureSelfSignedCert(userData: string): TlsMaterial {
  const certPath = path.join(userData, 'server-cert.pem');
  const keyPath = path.join(userData, 'server-key.pem');

  if (fse.pathExistsSync(certPath) && fse.pathExistsSync(keyPath)) {
    return {
      cert: fse.readFileSync(certPath, 'utf8'),
      key: fse.readFileSync(keyPath, 'utf8'),
    };
  }

  console.info('[server] Generating self-signed TLS certificate (valid 10 years)...');

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

    console.info('[server] Self-signed certificate written to:', certPath);
    console.info('[server] Private key written to:', keyPath);
    console.info(
      '[server] NOTE: Your browser will show a security warning for self-signed certificates.',
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

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8666);

  // Resolve the binary's home directory first — all other resource paths derive from it.
  const exeDir = resolveExeDir();
  console.info('[server] exe directory:', exeDir);
  console.info('[server] running as SEA binary:', IS_SEA);

  const userData = resolveUserDataPath(exeDir);

  console.info('[server] userData path:', userData);

  // ---------------------------------------------------------------------------
  // Auth credential — resolve at startup so misconfiguration is caught early.
  // ---------------------------------------------------------------------------
  const cred = resolveCredential();
  if (cred === null) {
    console.warn(
      '[server] WARNING: No auth credential configured. ' +
        'Set ONEFOLDER_AUTH_SECRET (or ONEFOLDER_AUTH_USER + ONEFOLDER_AUTH_PASSWORD). ' +
        'ALL requests will be rejected with 401 until a credential is configured.',
    );
  } else {
    console.info('[server] Auth credential configured (user:', cred.user, ').');
  }

  // ---------------------------------------------------------------------------
  // TLS configuration — optional.
  // ---------------------------------------------------------------------------
  const tlsEnabled = process.env.ONEFOLDER_TLS === '1' || process.env.ONEFOLDER_TLS === 'true';
  const tlsSecure = tlsEnabled; // whether to add Secure flag to cookies

  let tlsMaterial: TlsMaterial | null = null;
  if (tlsEnabled) {
    const certEnv = process.env.ONEFOLDER_TLS_CERT;
    const keyEnv = process.env.ONEFOLDER_TLS_KEY;

    if (certEnv !== undefined && keyEnv !== undefined) {
      // Operator-provided cert + key.
      if (!fse.pathExistsSync(certEnv)) {
        console.error('[server] ONEFOLDER_TLS_CERT path not found:', certEnv);
        process.exit(1);
      }
      if (!fse.pathExistsSync(keyEnv)) {
        console.error('[server] ONEFOLDER_TLS_KEY path not found:', keyEnv);
        process.exit(1);
      }
      tlsMaterial = {
        cert: fse.readFileSync(certEnv, 'utf8'),
        key: fse.readFileSync(keyEnv, 'utf8'),
      };
      console.info('[server] Using operator-provided TLS certificate:', certEnv);
    } else {
      // Auto-generate a self-signed cert.
      tlsMaterial = ensureSelfSignedCert(userData);
    }
  }

  // Resolve active library
  const registry = new LibraryRegistry(userData);
  const activeLibraryId = registry.getActiveLibraryId();

  if (!activeLibraryId) {
    console.error(
      '[server] No active library found at',
      userData,
      '— launch the desktop app at least once to create a library.',
    );
    process.exit(1);
  }

  const dbPath = getSqliteDbPath(userData, activeLibraryId);

  if (!fse.pathExistsSync(dbPath)) {
    console.error('[server] Database not found at', dbPath);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Derive the thumbnail directory for the active library.
  //
  // The server runs alongside the portable build where userData is the portable
  // data directory.  We detect portable mode the same way resolveUserDataPath()
  // does: PORTABLE_EXECUTABLE_DIR env-var or presence of a portable.txt / data/
  // directory next to the executable.
  //
  // In portable mode: thumbnails live at {userData}/thumbnails/{libraryId}
  // In dev / non-portable: thumbnails live at {os.tmpdir()}/OneFolder/{libraryId}/thumbnails
  // ---------------------------------------------------------------------------

  // isPortable is determined by the same markers that resolveUserDataPath uses.
  // exeDir already accounts for SEA vs dev mode.
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR ?? exeDir;
  const isPortable =
    process.env.PORTABLE_EXECUTABLE_DIR !== undefined ||
    fse.pathExistsSync(path.join(portableDir, 'portable.txt')) ||
    fse.pathExistsSync(path.join(portableDir, 'data'));

  const tempPath = isPortable
    ? userData // In portable mode temp is remapped to userData by RendererMessenger
    : path.join(os.tmpdir());

  const thumbnailDir = getDefaultThumbnailDir(userData, tempPath, isPortable, activeLibraryId);

  console.info('[server] Thumbnail directory:', thumbnailDir);

  // Open strictly read-only — the sidecar must never write to the library.
  const db = new Database(dbPath, { readonly: true });

  // WAL + foreign-key pragma set at connection time (read-only DB still needs WAL
  // reader checkpoint mode so it sees the latest WAL frames written by the desktop).
  db.pragma('journal_mode = WAL');

  // Construct SQLiteBackend with the read-only connection.
  // Pass a no-op notifyChange — the server never fires change notifications.
  const backend = new SQLiteBackend(db, () => {});

  // ---------------------------------------------------------------------------
  // ExifIO — read-only metadata service.
  //
  // We create a single shared ExifIO instance for the lifetime of the server
  // process.  ExifIO holds a persistent exiftool child process (node-exiftool)
  // that it reuses for all metadata reads, which avoids the startup overhead of
  // launching exiftool per request.
  //
  // Only read methods are exposed via HTTP — there are no write endpoints in
  // makeMetadataRouter, so the "overwrite_original_in_place" write args are
  // never reached from the web path.
  //
  // The hierarchical separator defaults to '|' (the OneFolder standard); the
  // server doesn't have access to per-library localStorage preferences, so it
  // always uses the default.  Tag hierarchy reads will parse correctly for any
  // library using the default separator.
  // ---------------------------------------------------------------------------
  // Re-derive the exiftool path relative to the exe directory (SEA-safe).
  // This replaces the getExtraResourcePath() call that ExifIO.ts uses at
  // module-level — which works in dev/Electron but is virtualised in a SEA.
  const exiftoolPath = resolveExiftoolPath(exeDir);
  console.info('[server] exiftool path:', exiftoolPath);

  const exifIO = new ExifIO('|', exiftoolPath);
  try {
    await exifIO.initialize();
    console.info('[server] ExifIO (exiftool) initialized.');
  } catch (exifErr) {
    // Non-fatal: metadata routes will fail gracefully if exiftool cannot start,
    // but image serving and DB reads are unaffected.
    console.warn(
      '[server] ExifIO initialization failed — metadata routes will be unavailable:',
      exifErr,
    );
  }

  // ---------------------------------------------------------------------------
  // Express app
  // ---------------------------------------------------------------------------

  const app = express();

  // Parse JSON request bodies (needed by POST routes in the data router).
  app.use(express.json());

  // ---------------------------------------------------------------------------
  // COOP / COEP / CORP — applied first so they are present on EVERY response,
  // including 401 auth rejections.  This ensures assets that are loaded after
  // authentication still see the correct headers and masonry SharedArrayBuffer
  // continues to work.
  // ---------------------------------------------------------------------------

  function coopCoepMiddleware(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    next();
  }

  app.use(coopCoepMiddleware);

  // ---------------------------------------------------------------------------
  // Auth — applied globally after COOP/COEP/CORP (so 401 responses still carry
  // the security headers) but before all route handlers, static files, and the
  // SPA fallback.
  //
  // POST /api/auth/login is explicitly exempted inside makeAuthMiddleware so the
  // browser can exchange credentials for a session cookie on first visit.
  // ---------------------------------------------------------------------------

  app.use(makeAuthMiddleware(cred, tlsSecure));

  // ---------------------------------------------------------------------------
  // Login / logout router — must be mounted BEFORE static files and the API
  // routers so it takes precedence.
  // ---------------------------------------------------------------------------
  app.use('/api', makeLoginRouter(cred, tlsSecure));

  // ---------------------------------------------------------------------------
  // SPA static files (from TASK-130's web webpack output).
  // The directory may not exist yet during development; serve it conditionally.
  // ---------------------------------------------------------------------------

  // Resolve the SPA dist dir relative to the exe directory (SEA-safe).
  // Packaged layout: dist-headless/dist-web/  (exeDir = dist-headless/)
  // Dev layout:      repo-root/dist-web/       (exeDir = repo root)
  const spaDir = path.join(exeDir, 'dist-web');

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
    console.warn(
      '[server] SPA dist-web directory not found at',
      spaDir,
      '— static serving disabled.',
    );
  }

  // ---------------------------------------------------------------------------
  // API routes
  // ---------------------------------------------------------------------------

  app.use('/api', makeDataRouter(backend, db));
  app.use('/api', makeImagesRouter(db, thumbnailDir));
  app.use('/api', makeMetadataRouter(db, exifIO));
  app.use('/api', makeRescanRouter(db));

  // ---------------------------------------------------------------------------
  // SPA fallback — return index.html for any non-/api route so the React
  // router handles client-side navigation.
  // ---------------------------------------------------------------------------

  const indexHtml = path.join(spaDir, 'index.html');

  app.get('*', (_req: Request, res: Response) => {
    if (fse.pathExistsSync(indexHtml)) {
      res.sendFile(indexHtml);
    } else {
      res.status(503).json({
        error: 'SPA not built yet. Run `yarn build:web` (TASK-130) to produce dist-web/.',
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Start listening — HTTP or HTTPS depending on ONEFOLDER_TLS.
  // ---------------------------------------------------------------------------

  if (tlsMaterial !== null) {
    // HTTPS listener.
    const server = https.createServer({ cert: tlsMaterial.cert, key: tlsMaterial.key }, app);
    server.listen(port, () => {
      console.info(`[server] OneFolder sidecar listening on https://localhost:${port}`);
      console.info('[server] Active library id:', activeLibraryId);
      console.info('[server] Database path:', dbPath);
      console.info('[server] TLS: enabled');
    });
  } else {
    // Plain HTTP listener.
    http.createServer(app).listen(port, () => {
      console.info(`[server] OneFolder sidecar listening on http://localhost:${port}`);
      console.info('[server] Active library id:', activeLibraryId);
      console.info('[server] Database path:', dbPath);
      console.info('[server] TLS: disabled (plain HTTP)');
    });
  }

  // Graceful shutdown: close the DB on SIGTERM/SIGINT so better-sqlite3
  // checkpoints the WAL before the process exits.
  function shutdown(signal: string): void {
    console.info(`[server] ${signal} received — closing database and exiftool...`);
    exifIO.close().catch(console.warn);
    db.close();
    process.exit(0);
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[server] Fatal error during startup:', err);
  process.exit(1);
});
