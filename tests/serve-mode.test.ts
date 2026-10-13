/**
 * Unit tests for serve mode — `OneFolder-<version>-x64.exe --serve`.
 *
 * Covers the pure logic that decides what serve mode does before any socket is
 * opened: flag parsing, port validation, and the startup banner that discloses
 * what the server is exposing.
 *
 * Imports `src/server/config` rather than `src/server/index` on purpose — the
 * primitives under test must not require express, better-sqlite3 or sharp.
 */

import { parseServeArgs } from '../src/serve-args';
import { resolvePort, buildStartupBanner, messages, DEFAULT_PORT } from '../src/server/config';

describe('parseServeArgs', () => {
  it('reports serve=false for a normal desktop launch', () => {
    expect(parseServeArgs(['OneFolder.exe'])).toEqual({ serve: false, rawPort: undefined });
  });

  it('detects --serve in a packaged argv', () => {
    expect(parseServeArgs(['OneFolder.exe', '--serve']).serve).toBe(true);
  });

  it('detects --serve in a dev argv (electron.exe main.bundle.js --serve)', () => {
    expect(parseServeArgs(['electron.exe', 'build/main.bundle.js', '--serve']).serve).toBe(true);
  });

  it('reads a space-separated --port', () => {
    expect(parseServeArgs(['OneFolder.exe', '--serve', '--port', '9000']).rawPort).toBe('9000');
  });

  it('reads an equals-separated --port', () => {
    expect(parseServeArgs(['OneFolder.exe', '--serve', '--port=9000']).rawPort).toBe('9000');
  });

  it('does not treat --headless as serve mode (it collides with a Chromium switch)', () => {
    expect(parseServeArgs(['OneFolder.exe', '--headless']).serve).toBe(false);
  });

  it('ignores unrelated Chromium switches', () => {
    const args = parseServeArgs([
      'OneFolder.exe',
      '--enable-features=SharedArrayBuffer',
      '--serve',
    ]);
    expect(args).toEqual({ serve: true, rawPort: undefined });
  });
});

describe('resolvePort', () => {
  it('defaults to 8666 when nothing is configured', () => {
    expect(resolvePort(undefined)).toBe(DEFAULT_PORT);
  });

  it('accepts a valid port', () => {
    expect(resolvePort('9000')).toBe(9000);
  });

  it('accepts the boundaries', () => {
    expect(resolvePort('1')).toBe(1);
    expect(resolvePort('65535')).toBe(65535);
  });

  // PORT='' used to become Number('') === 0, which makes the OS assign a random
  // ephemeral port — the server would start on an address nobody could find.
  it('treats an empty value as unset rather than port 0', () => {
    expect(resolvePort('')).toBe(DEFAULT_PORT);
    expect(resolvePort('   ')).toBe(DEFAULT_PORT);
  });

  it.each([
    ['abc', 'non-numeric'],
    ['0', 'below range'],
    ['70000', 'above range'],
    ['-1', 'negative'],
    ['8666.5', 'fractional'],
    ['1e3', 'exponent notation'],
    ['0x10', 'hex'],
  ])('rejects %s (%s)', (value) => {
    expect(() => resolvePort(value)).toThrow(messages.invalidPort(value));
  });
});

describe('buildStartupBanner', () => {
  const base = {
    port: 8666,
    protocol: 'http' as const,
    libraryName: 'My Library',
    logFilePath: 'D:\\OneFolder\\data\\server.log',
    addresses: ['192.168.1.42'],
  };

  it('states the port, the loopback URL and every LAN URL', () => {
    const lines = buildStartupBanner({ ...base, authUser: null });

    expect(lines[0]).toBe('[server] OneFolder serve mode — listening on port 8666');
    expect(lines).toContain('[server]   http://127.0.0.1:8666');
    expect(lines).toContain('[server]   http://192.168.1.42:8666   (reachable from your network)');
  });

  it('says authentication is disabled when no credential is configured', () => {
    const lines = buildStartupBanner({ ...base, authUser: null });
    expect(lines).toContain('[server] Authentication: DISABLED — no credential configured');
  });

  it('names the user when an explicit user/password pair is configured', () => {
    const lines = buildStartupBanner({ ...base, authUser: 'alice' });
    expect(lines).toContain('[server] Authentication: enabled (user: alice)');
  });

  // ONEFOLDER_AUTH_SECRET makes user === password, so printing the user name
  // would write the shared secret in plaintext into server.log.
  it('does not print the name when the credential is a shared secret', () => {
    const lines = buildStartupBanner({
      ...base,
      authUser: 'hunter2',
      authIsSharedSecret: true,
    });
    expect(lines).toContain('[server] Authentication: enabled (shared secret)');
    expect(lines.join('\n')).not.toContain('hunter2');
  });

  it('reports the library name and log file', () => {
    const lines = buildStartupBanner({ ...base, authUser: null });
    expect(lines).toContain('[server] Library: My Library');
    expect(lines).toContain('[server] Log file: D:\\OneFolder\\data\\server.log');
  });

  it('uses https when TLS is active', () => {
    const lines = buildStartupBanner({ ...base, protocol: 'https', authUser: null });
    expect(lines).toContain('[server]   https://127.0.0.1:8666');
  });

  it('omits the LAN lines when the machine has no external address', () => {
    const lines = buildStartupBanner({ ...base, addresses: [], authUser: null });
    expect(lines.some((l) => l.includes('reachable from your network'))).toBe(false);
    expect(lines).toContain('[server]   http://127.0.0.1:8666');
  });
});

describe('operator-facing messages', () => {
  it('names the port and the remedy when the port is taken', () => {
    expect(messages.portInUse(8666)).toBe(
      '[server] Port 8666 is already in use. Another OneFolder server may already be running. ' +
        'Use --port <n> to choose a different port.',
    );
  });

  it('names the searched directory when no library exists', () => {
    expect(messages.noLibrary('D:\\OneFolder\\data')).toBe(
      '[server] No library found in D:\\OneFolder\\data. Launch OneFolder normally at least once to create a library.',
    );
  });

  it('names the database path when the file is missing', () => {
    expect(messages.dbNotFound('D:\\db.sqlite')).toBe(
      '[server] Database not found at D:\\db.sqlite.',
    );
  });
});
