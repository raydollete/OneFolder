/**
 * Auth middleware — INV-034 / TASK-134.
 *
 * Applies a single shared-secret gate in front of ALL sidecar routes.
 * The server serves real local files so nothing is public — every request
 * must carry a valid credential.
 *
 * Credential configuration
 * ------------------------
 * Set ONE of the following env-var pairs before launching the server:
 *
 *   ONEFOLDER_AUTH_SECRET=<any string>
 *     A plain shared secret used as both username and password for HTTP Basic
 *     auth.  The client encodes it as base64("<secret>:<secret>").
 *     This is the simplest option: set one env var, share it with the browser.
 *
 *   ONEFOLDER_AUTH_USER=<username>  ONEFOLDER_AUTH_PASSWORD=<password>
 *     Explicit username + password pair (HTTP Basic auth).
 *     Takes precedence over ONEFOLDER_AUTH_SECRET if both are set.
 *
 * If NEITHER is set the server starts but rejects EVERY request with 401.
 * A warning is printed to stderr at startup.
 *
 * Dual-path credential delivery
 * ------------------------------
 * HTTP API calls (HttpBackend#fetch) attach:
 *   Authorization: Basic <base64(user:password)>
 *
 * Image <img src> attributes cannot carry headers, so after a successful
 * Authorization-header check the middleware also accepts an HttpOnly signed
 * cookie named `of_auth`.  The cookie is issued by the POST /api/auth/login
 * endpoint and validated on every subsequent request.
 *
 * Cookie details:
 *   - Name:     of_auth
 *   - Value:    HMAC-SHA256 of (username + ":" + password) using COOKIE_SECRET,
 *               hex-encoded, prefixed with "s:" to match cookie-signature format.
 *   - Flags:    HttpOnly; SameSite=Strict; Secure (only when TLS is active)
 *   - Lifetime: SESSION (no Max-Age; cleared when browser is closed)
 *
 * COOP/COEP/CORP headers
 * ----------------------
 * These headers are applied by coopCoepMiddleware in index.ts BEFORE this
 * middleware runs, so they are present even on 401 responses.  This middleware
 * does NOT touch them.
 */

import { createHmac, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction, Router } from 'express';

// ---------------------------------------------------------------------------
// Minimal inline cookie helpers (avoids a dep on @types/cookie)
// ---------------------------------------------------------------------------

/**
 * Serialize a Set-Cookie header value.
 * Only the flags used by auth.ts are implemented.
 */
function serializeCookie(
  name: string,
  value: string,
  opts: {
    httpOnly?: boolean;
    sameSite?: 'strict' | 'lax' | 'none';
    secure?: boolean;
    path?: string;
    maxAge?: number;
  },
): string {
  let s = `${name}=${encodeURIComponent(value)}`;
  if (opts.path !== undefined) {
    s += `; Path=${opts.path}`;
  }
  if (opts.maxAge !== undefined) {
    s += `; Max-Age=${opts.maxAge}`;
  }
  if (opts.sameSite !== undefined) {
    s += `; SameSite=${opts.sameSite[0].toUpperCase()}${opts.sameSite.slice(1)}`;
  }
  if (opts.httpOnly) {
    s += '; HttpOnly';
  }
  if (opts.secure) {
    s += '; Secure';
  }
  return s;
}

/**
 * Parse a Cookie request header string into a key→value map.
 * Values are URI-decoded.
 */
function parseCookies(cookieHeader: string): Record<string, string | undefined> {
  const result: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) {
      continue;
    }
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key.length === 0) {
      continue;
    }
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cookie name used to store the auth session token. */
const COOKIE_NAME = 'of_auth';

/**
 * HMAC secret for signing the cookie value.
 * We derive it from the auth credentials so it is unique per deployment
 * without requiring a separate env var.  Combined with HttpOnly + SameSite
 * this is sufficient for single-user local browsing.
 */
function deriveCookieSecret(user: string, password: string): string {
  return createHmac('sha256', `${user}:${password}`).update('of_auth_cookie_secret').digest('hex');
}

/**
 * Compute the HMAC token that goes inside the cookie value.
 * Format: hex-encoded HMAC-SHA256(user+":"+password) using the derived secret.
 */
function computeCookieToken(user: string, password: string): string {
  const secret = deriveCookieSecret(user, password);
  return createHmac('sha256', secret).update(`${user}:${password}`).digest('hex');
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

export interface Credential {
  user: string;
  password: string;
}

/**
 * Resolve credentials from env vars.
 * Returns null if no credential is configured (server will reject everything).
 */
export function resolveCredential(): Credential | null {
  const user = process.env.ONEFOLDER_AUTH_USER;
  const password = process.env.ONEFOLDER_AUTH_PASSWORD;

  if (user !== undefined && password !== undefined) {
    return { user, password };
  }

  const secret = process.env.ONEFOLDER_AUTH_SECRET;
  if (secret !== undefined) {
    return { user: secret, password: secret };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Cookie helpers (exported so tests and the login route can call them)
// ---------------------------------------------------------------------------

/**
 * Build the Set-Cookie header value for a new auth session cookie.
 * @param user       Validated username.
 * @param password   Validated password.
 * @param secure     True when TLS is active — adds the Secure flag.
 */
export function buildAuthCookieHeader(user: string, password: string, secure: boolean): string {
  const token = computeCookieToken(user, password);
  return serializeCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    // Session cookie (no maxAge) — cleared when browser closes.
  });
}

/**
 * Build the Set-Cookie header that clears the auth cookie.
 */
export function clearAuthCookieHeader(): string {
  return serializeCookie(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
}

// ---------------------------------------------------------------------------
// Auth middleware factory
// ---------------------------------------------------------------------------

/**
 * Returns an Express middleware function that gates all requests behind the
 * configured credential.
 *
 * @param cred    Resolved credential (from resolveCredential()). When null
 *                every request is rejected with 401.
 * @param secure  Whether TLS is active — used to add the Secure flag when
 *                issuing the auth cookie via the login endpoint.
 */
export function makeAuthMiddleware(
  cred: Credential | null,
  secure: boolean,
): (req: Request, res: Response, next: NextFunction) => void {
  // Pre-compute the expected cookie token once at startup.
  const expectedToken = cred ? computeCookieToken(cred.user, cred.password) : null;

  return function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Skip the login endpoint itself — it is the authentication handshake.
    if (req.path === '/api/auth/login' && req.method === 'POST') {
      // Attach the resolved credential to the request so the login handler
      // can access it without re-resolving from env.
      (req as AuthenticatedRequest).authCred = cred;
      (req as AuthenticatedRequest).authSecure = secure;
      next();
      return;
    }

    // No credential configured — fail everything loudly so the operator knows.
    if (cred === null || expectedToken === null) {
      res
        .status(401)
        .set('WWW-Authenticate', 'Basic realm="OneFolder"')
        .json({
          error:
            'Authentication required. ' +
            'Set ONEFOLDER_AUTH_SECRET (or ONEFOLDER_AUTH_USER + ONEFOLDER_AUTH_PASSWORD) ' +
            'before starting the server.',
        });
      return;
    }

    // -----------------------------------------------------------------------
    // Path 1: Authorization header (used by HttpBackend fetches)
    // -----------------------------------------------------------------------
    const authHeader = req.headers['authorization'];
    if (authHeader !== undefined) {
      if (checkBasicAuth(authHeader, cred.user, cred.password)) {
        next();
        return;
      }
      res
        .status(401)
        .set('WWW-Authenticate', 'Basic realm="OneFolder"')
        .json({ error: 'Invalid credentials.' });
      return;
    }

    // -----------------------------------------------------------------------
    // Path 2: Signed cookie (used by <img src> and browser navigation)
    // -----------------------------------------------------------------------
    const cookieHeader = req.headers['cookie'] ?? '';
    const cookies = parseCookies(cookieHeader);
    const cookieToken = cookies[COOKIE_NAME];

    if (cookieToken !== undefined && cookieToken.length > 0) {
      // Constant-time comparison to prevent timing attacks.
      const expected = Buffer.from(expectedToken, 'utf8');
      const received = Buffer.from(cookieToken, 'utf8');

      if (expected.length === received.length && timingSafeEqual(expected, received)) {
        next();
        return;
      }
    }

    // Neither path succeeded.
    res
      .status(401)
      .set('WWW-Authenticate', 'Basic realm="OneFolder"')
      .json({ error: 'Authentication required.' });
  };
}

// ---------------------------------------------------------------------------
// Basic-auth header parser
// ---------------------------------------------------------------------------

/**
 * Validate a raw "Authorization: Basic <base64>" header value against the
 * expected user and password using constant-time comparison.
 *
 * Returns true if the header is well-formed and matches.
 */
function checkBasicAuth(header: string, expectedUser: string, expectedPassword: string): boolean {
  if (!header.toLowerCase().startsWith('basic ')) {
    return false;
  }

  let decoded: string;
  try {
    decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
  } catch {
    return false;
  }

  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) {
    return false;
  }

  const user = decoded.slice(0, colonIdx);
  const password = decoded.slice(colonIdx + 1);

  // Constant-time comparison for both user and password.
  const userBuf = Buffer.from(user, 'utf8');
  const expectedUserBuf = Buffer.from(expectedUser, 'utf8');
  const passBuf = Buffer.from(password, 'utf8');
  const expectedPassBuf = Buffer.from(expectedPassword, 'utf8');

  // Lengths must match before timingSafeEqual (it throws on mismatched lengths).
  const userMatch =
    userBuf.length === expectedUserBuf.length && timingSafeEqual(userBuf, expectedUserBuf);
  const passMatch =
    passBuf.length === expectedPassBuf.length && timingSafeEqual(passBuf, expectedPassBuf);

  return userMatch && passMatch;
}

// ---------------------------------------------------------------------------
// Login / logout router
// ---------------------------------------------------------------------------

/** Request type augmented with auth credential (set by authMiddleware). */
export interface AuthenticatedRequest extends Request {
  authCred?: Credential | null;
  authSecure?: boolean;
}

/**
 * Creates a minimal router for the auth handshake:
 *
 *   POST /api/auth/login
 *     Body: { user: string; password: string }  — or Basic Auth header.
 *     On success: sets the HttpOnly signed cookie and returns { ok: true }.
 *     On failure: returns 401.
 *
 *   DELETE /api/auth/login
 *     Clears the auth cookie.
 *
 * Note: the POST handler does NOT require a prior auth cookie — it IS the
 * credential-to-cookie exchange.  The authMiddleware above explicitly skips
 * /api/auth/login POST so it reaches this handler.
 */
export function makeLoginRouter(cred: Credential | null, secure: boolean): Router {
  const router = Router();

  // POST /api/auth/login — exchange credentials for a cookie.
  router.post('/auth/login', (req: Request, res: Response): void => {
    if (cred === null) {
      res.status(503).json({
        error:
          'Server has no credentials configured. ' +
          'Set ONEFOLDER_AUTH_SECRET before starting the server.',
      });
      return;
    }

    // Accept credentials either from the Authorization header or a JSON body.
    let user: string | undefined;
    let password: string | undefined;

    const authHeader = req.headers['authorization'];
    if (authHeader !== undefined) {
      if (!authHeader.toLowerCase().startsWith('basic ')) {
        res.status(400).json({ error: 'Expected Basic auth header.' });
        return;
      }
      let decoded: string;
      try {
        decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
      } catch {
        res.status(400).json({ error: 'Malformed Basic auth header.' });
        return;
      }
      const colonIdx = decoded.indexOf(':');
      if (colonIdx === -1) {
        res.status(400).json({ error: 'Malformed Basic auth header.' });
        return;
      }
      user = decoded.slice(0, colonIdx);
      password = decoded.slice(colonIdx + 1);
    } else {
      // Fall back to JSON body.
      const body = req.body as { user?: unknown; password?: unknown } | undefined;
      if (typeof body?.user === 'string' && typeof body.password === 'string') {
        user = body.user;
        password = body.password;
      }
    }

    if (user === undefined || password === undefined) {
      res.status(400).json({
        error: 'Provide credentials via Authorization: Basic header or JSON body {user, password}.',
      });
      return;
    }

    // Validate against the configured credential.
    const userBuf = Buffer.from(user, 'utf8');
    const expectedUserBuf = Buffer.from(cred.user, 'utf8');
    const passBuf = Buffer.from(password, 'utf8');
    const expectedPassBuf = Buffer.from(cred.password, 'utf8');

    const userMatch =
      userBuf.length === expectedUserBuf.length && timingSafeEqual(userBuf, expectedUserBuf);
    const passMatch =
      passBuf.length === expectedPassBuf.length && timingSafeEqual(passBuf, expectedPassBuf);

    if (!userMatch || !passMatch) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    // Issue the session cookie.
    res.setHeader('Set-Cookie', buildAuthCookieHeader(cred.user, cred.password, secure));
    res.json({ ok: true });
  });

  // DELETE /api/auth/login — clear the session cookie.
  router.delete('/auth/login', (_req: Request, res: Response): void => {
    res.setHeader('Set-Cookie', clearAuthCookieHeader());
    res.json({ ok: true });
  });

  return router;
}
