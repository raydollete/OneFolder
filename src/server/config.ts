/**
 * Serve-mode configuration primitives — port validation, operator-facing
 * messages, and the startup banner.
 *
 * Deliberately dependency-light (only `os`): everything here is pure logic
 * that must be testable without loading express, better-sqlite3 or sharp.
 * `src/server/index.ts` re-exports these so callers have one import site.
 */

import os from 'os';

export const DEFAULT_PORT = 8666;

// ---------------------------------------------------------------------------
// Operator-facing messages — defined once so the log, stdout and any test all
// assert the same strings.
// ---------------------------------------------------------------------------

export const messages = {
  invalidPort: (value: string): string =>
    `[server] --port requires a whole number between 1 and 65535 (got '${value}').`,
  portInUse: (port: number): string =>
    `[server] Port ${port} is already in use. Another OneFolder server may already be running. ` +
    'Use --port <n> to choose a different port.',
  noLibrary: (userData: string): string =>
    `[server] No library found in ${userData}. Launch OneFolder normally at least once to create a library.`,
  dbNotFound: (dbPath: string): string => `[server] Database not found at ${dbPath}.`,
  // A brand-new portable install registers a default library at first launch,
  // but the DATABASE is created by the renderer on its first GUI run. Serve
  // mode reaches a registered library with no database file and would
  // otherwise just name a missing path with no way to act on it.
  dbNotFoundHint: (): string =>
    '[server] The library is registered but its database has not been created yet. ' +
    'Launch OneFolder normally once, then try --serve again.',
  shuttingDown: (): string => '[server] Shutting down — closing database and exiftool.',
};

// ---------------------------------------------------------------------------
// Port validation
//
// The previous implementation was `Number(process.env.PORT ?? 8666)`, which
// turns PORT='' into 0 (the OS then assigns a random ephemeral port nobody can
// find) and PORT='abc' into NaN. Absent or malformed configuration must be an
// explicit failure, never a silently different behaviour.
// ---------------------------------------------------------------------------

/**
 * Validate a port from `--port` or `PORT`.
 *
 * @param raw   The raw value, or undefined/empty when unset.
 * @returns     A whole number in [1, 65535]; DEFAULT_PORT when nothing was set.
 * @throws      Error carrying `messages.invalidPort(raw)` for anything else.
 */
export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_PORT;
  }
  const trimmed = raw.trim();
  // Only plain digits are a port — rejects '8666.5', '0x10', '1e3', '-1'.
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(messages.invalidPort(raw));
  }
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(messages.invalidPort(raw));
  }
  return port;
}

// ---------------------------------------------------------------------------
// Startup banner
//
// The listener binds every interface (listen() takes no host argument), so the
// banner must say so. The previous log line hard-coded "localhost" while
// binding 0.0.0.0, which told the operator the opposite of the truth.
// ---------------------------------------------------------------------------

/** Every non-internal IPv4 address of this machine. */
export function lanAddresses(): string[] {
  const found: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      // Node reports family as 'IPv4' (string) on modern versions, 4 on older.
      const isIPv4 = entry.family === 'IPv4' || (entry.family as unknown as number) === 4;
      if (isIPv4 && !entry.internal) {
        found.push(entry.address);
      }
    }
  }
  return found;
}

export interface BannerInput {
  port: number;
  protocol: 'http' | 'https';
  /** Resolved user name when authentication is on; null when it is off. */
  authUser: string | null;
  /**
   * True when the credential came from ONEFOLDER_AUTH_SECRET, where the user
   * name IS the password. The banner then reports "(shared secret)" instead of
   * the name — printing it would write the secret into server.log in plaintext.
   */
  authIsSharedSecret?: boolean;
  libraryName: string;
  logFilePath: string;
  /** Injected for testability; defaults to this machine's LAN addresses. */
  addresses?: string[];
}

/**
 * Build the startup banner. The credential VALUE is never included.
 */
export function buildStartupBanner(input: BannerInput): string[] {
  const { port, protocol, authUser, libraryName, logFilePath } = input;
  const addresses = input.addresses ?? lanAddresses();

  const lines: string[] = [`[server] OneFolder serve mode — listening on port ${port}`];
  lines.push(`[server]   ${protocol}://127.0.0.1:${port}`);
  for (const address of addresses) {
    lines.push(`[server]   ${protocol}://${address}:${port}   (reachable from your network)`);
  }
  if (authUser === null) {
    lines.push('[server] Authentication: DISABLED — no credential configured');
  } else if (input.authIsSharedSecret === true) {
    lines.push('[server] Authentication: enabled (shared secret)');
  } else {
    lines.push(`[server] Authentication: enabled (user: ${authUser})`);
  }
  lines.push(`[server] Library: ${libraryName}`);
  if (logFilePath !== '') {
    lines.push(`[server] Log file: ${logFilePath}`);
  }
  return lines;
}
