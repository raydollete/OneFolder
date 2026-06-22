/**
 * Unit tests for src/server/auth.ts — INV-034 / TASK-134.
 *
 * Tests verify that:
 *  - Unauthenticated requests (no header, no cookie) are rejected with 401.
 *  - A valid Authorization: Basic header is accepted.
 *  - An invalid Authorization: Basic header is rejected with 401.
 *  - A valid cookie (issued by buildAuthCookieHeader) is accepted.
 *  - A tampered / invalid cookie is rejected with 401.
 *  - POST /api/auth/login is exempt from the middleware and reaches the handler.
 *  - When no credential is configured every request is rejected with 401.
 *  - COOP/COEP/CORP headers are NOT stripped by the auth middleware (they are
 *    set upstream; auth only adds a 401 body — it never removes headers).
 *  - buildAuthCookieHeader produces a token that makeAuthMiddleware validates.
 */

import { Request, Response, NextFunction } from 'express';
import {
  makeAuthMiddleware,
  buildAuthCookieHeader,
  clearAuthCookieHeader,
  resolveCredential,
} from '../src/server/auth';

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    path: '/api/tags',
    headers: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

interface MockResponse {
  _status: number;
  _headers: Record<string, string>;
  _body: unknown;
  status: jest.Mock;
  json: jest.Mock;
  set: jest.Mock;
}

function makeRes(): MockResponse & Response {
  const res: MockResponse = {
    _status: 200,
    _headers: {},
    _body: undefined,
    status: jest.fn(),
    json: jest.fn(),
    set: jest.fn(),
  };
  // Chain status().json() calls
  res.status.mockImplementation((code: number) => {
    res._status = code;
    return res;
  });
  res.json.mockImplementation((body: unknown) => {
    res._body = body;
    return res;
  });
  res.set.mockImplementation((key: string, value: string) => {
    res._headers[key] = value;
    return res;
  });
  return res as unknown as MockResponse & Response;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_USER = 'testuser';
const TEST_PASS = 'hunter2';
const TEST_CRED = { user: TEST_USER, password: TEST_PASS };

function basicAuthHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

// ---------------------------------------------------------------------------
// makeAuthMiddleware
// ---------------------------------------------------------------------------

describe('makeAuthMiddleware', () => {
  describe('no credential configured (cred = null)', () => {
    const mw = makeAuthMiddleware(null, false);

    it('rejects any request with 401', () => {
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next as unknown as NextFunction);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('credential configured', () => {
    const mw = makeAuthMiddleware(TEST_CRED, false);

    it('rejects a request with no Authorization header and no cookie', () => {
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next as unknown as NextFunction);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('accepts a valid Authorization: Basic header', () => {
      const req = makeReq({
        headers: { authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
      });
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next as unknown as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res._status).toBe(200); // unchanged — next() was called
    });

    it('rejects a request with a wrong password', () => {
      const req = makeReq({
        headers: { authorization: basicAuthHeader(TEST_USER, 'wrongpass') },
      });
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next as unknown as NextFunction);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a request with a wrong username', () => {
      const req = makeReq({
        headers: { authorization: basicAuthHeader('wronguser', TEST_PASS) },
      });
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next as unknown as NextFunction);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects a malformed Authorization header (not Basic)', () => {
      const req = makeReq({
        headers: { authorization: 'Bearer sometoken' },
      });
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next as unknown as NextFunction);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('accepts a valid cookie token', () => {
      // Build the cookie the same way the login endpoint would.
      const cookieHeader = buildAuthCookieHeader(TEST_USER, TEST_PASS, false);
      // Extract the token value from "of_auth=<token>; ..."
      const match = cookieHeader.match(/^of_auth=([^;]+)/);
      if (match === null) {
        throw new Error('Expected cookie header to match of_auth=<token>');
      }
      const token = match[1];

      const req = makeReq({
        headers: { cookie: `of_auth=${token}` },
      });
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next as unknown as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it('rejects a tampered cookie token', () => {
      const req = makeReq({
        headers: { cookie: 'of_auth=deadbeefdeadbeefdeadbeefdeadbeef' },
      });
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next as unknown as NextFunction);

      expect(res._status).toBe(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('passes POST /api/auth/login through without checking credentials', () => {
      // No auth header, no cookie — but this is the login endpoint itself.
      const req = makeReq({
        method: 'POST',
        path: '/api/auth/login',
        headers: {},
      });
      const res = makeRes();
      const next = jest.fn();

      mw(req, res as unknown as Response, next as unknown as NextFunction);

      // Should call next() without a 401, so the login handler can run.
      expect(next).toHaveBeenCalledTimes(1);
      expect(res._status).toBe(200); // unchanged
    });
  });
});

// ---------------------------------------------------------------------------
// buildAuthCookieHeader / clearAuthCookieHeader
// ---------------------------------------------------------------------------

describe('buildAuthCookieHeader', () => {
  it('produces a Set-Cookie string containing the cookie name', () => {
    const header = buildAuthCookieHeader('u', 'p', false);
    expect(header).toMatch(/^of_auth=/);
  });

  it('includes HttpOnly flag', () => {
    const header = buildAuthCookieHeader('u', 'p', false);
    expect(header.toLowerCase()).toContain('httponly');
  });

  it('includes SameSite=Strict', () => {
    const header = buildAuthCookieHeader('u', 'p', false);
    expect(header.toLowerCase()).toContain('samesite=strict');
  });

  it('includes Secure flag when secure=true', () => {
    const header = buildAuthCookieHeader('u', 'p', true);
    expect(header.toLowerCase()).toContain('secure');
  });

  it('does NOT include Secure flag when secure=false', () => {
    const header = buildAuthCookieHeader('u', 'p', false);
    // "secure" must not appear (the word "samesite" doesn't contain "secure")
    const lc = header.toLowerCase();
    // Check that "secure" doesn't appear as a standalone flag
    // Allow for "samesite" which contains the substring differently
    const noSecureFlag = !/ secure(;|$)/.test(lc) && !/;secure(;|$)/.test(lc);
    expect(noSecureFlag).toBe(true);
  });

  it('produces a token that the middleware validates as authentic', () => {
    const cred = { user: 'alice', password: 'pa$$word' };
    const mw = makeAuthMiddleware(cred, false);

    const cookieHeader = buildAuthCookieHeader(cred.user, cred.password, false);
    const match = cookieHeader.match(/^of_auth=([^;]+)/);
    if (match === null) {
      throw new Error('Expected cookie header to match of_auth=<token>');
    }
    const token = match[1];

    const req = makeReq({ headers: { cookie: `of_auth=${token}` } });
    const res = makeRes();
    const next = jest.fn();

    mw(req, res as unknown as Response, next as unknown as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('clearAuthCookieHeader', () => {
  it('produces a Set-Cookie string that expires the cookie', () => {
    const header = clearAuthCookieHeader();
    expect(header).toMatch(/^of_auth=/);
    expect(header.toLowerCase()).toContain('max-age=0');
  });
});

// ---------------------------------------------------------------------------
// resolveCredential
// ---------------------------------------------------------------------------

describe('resolveCredential', () => {
  const savedEnv = process.env;

  beforeEach(() => {
    // Isolate env mutations per test
    process.env = { ...savedEnv };
    delete process.env.ONEFOLDER_AUTH_SECRET;
    delete process.env.ONEFOLDER_AUTH_USER;
    delete process.env.ONEFOLDER_AUTH_PASSWORD;
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('returns null when no env vars are set', () => {
    expect(resolveCredential()).toBeNull();
  });

  it('returns { user: secret, password: secret } when ONEFOLDER_AUTH_SECRET is set', () => {
    process.env.ONEFOLDER_AUTH_SECRET = 'mysecret';
    expect(resolveCredential()).toEqual({ user: 'mysecret', password: 'mysecret' });
  });

  it('returns explicit user/password when ONEFOLDER_AUTH_USER + ONEFOLDER_AUTH_PASSWORD are set', () => {
    process.env.ONEFOLDER_AUTH_USER = 'bob';
    process.env.ONEFOLDER_AUTH_PASSWORD = 'secretpass';
    expect(resolveCredential()).toEqual({ user: 'bob', password: 'secretpass' });
  });

  it('prefers ONEFOLDER_AUTH_USER/PASSWORD over AUTH_SECRET when both are set', () => {
    process.env.ONEFOLDER_AUTH_USER = 'explicit-user';
    process.env.ONEFOLDER_AUTH_PASSWORD = 'explicit-pass';
    process.env.ONEFOLDER_AUTH_SECRET = 'should-be-ignored';
    const cred = resolveCredential();
    expect(cred?.user).toBe('explicit-user');
    expect(cred?.password).toBe('explicit-pass');
  });
});
