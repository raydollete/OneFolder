/**
 * Unit tests for serve mode — `OneFolder-<version>-x64.exe --serve`.
 *
 * Covers the pure logic that decides what serve mode does before any socket is
 * opened: flag parsing, port validation, and the startup banner that discloses
 * what the server is exposing.
 *
 * Imports `src/server/config` rather than `src/server/index` on purpose — the
 * primitives under test must not require express, better-sqlite3 or sharp.
 * The one exception is the suite at the bottom of the file, which mounts the
 * real image router to assert the Content-Type of a streamed original.
 */

import { parseServeArgs } from '../src/serve-args';
import { resolvePort, buildStartupBanner, messages, DEFAULT_PORT } from '../src/server/config';
import os from 'os';
import path from 'path';
import http from 'http';
import { AddressInfo } from 'net';
import fse from 'fs-extra';
import express from 'express';
import { makeImagesRouter } from '../src/server/routes/images';

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

// ---------------------------------------------------------------------------
// GET /api/original/:id and /api/preview/:id — container Content-Type for the
// extended video lane (support-mkv-ts-playback).
//
// The tests above are pure-logic and never load express/better-sqlite3/sharp.
// These assert the real streamed response, so they mount makeImagesRouter on a
// bare express app and drive it over HTTP on an ephemeral loopback port. The
// database is a stub: path-resolver (the sole gatekeeper) only ever calls
// prepare(sql).get(...) / prepare(sql).all(), so a two-method fake is a
// faithful read-only handle without the native driver.
// ---------------------------------------------------------------------------

/** The db parameter type of makeImagesRouter, without importing better-sqlite3. */
type ImagesRouterDb = Parameters<typeof makeImagesRouter>[0];

const MKV_ID = '2f7a1c34-9b2e-4a71-8c50-6d3e0b1a4f11';
const TS_ID = '2f7a1c34-9b2e-4a71-8c50-6d3e0b1a4f12';
const JPG_ID = '2f7a1c34-9b2e-4a71-8c50-6d3e0b1a4f13';
const TXT_ID = '2f7a1c34-9b2e-4a71-8c50-6d3e0b1a4f14';
const OUTSIDE_ID = '2f7a1c34-9b2e-4a71-8c50-6d3e0b1a4f15';
const MOV_ID = '2f7a1c34-9b2e-4a71-8c50-6d3e0b1a4f16';
const MP4_ID = '2f7a1c34-9b2e-4a71-8c50-6d3e0b1a4f17';
const WEBM_ID = '2f7a1c34-9b2e-4a71-8c50-6d3e0b1a4f18';
const OGG_ID = '2f7a1c34-9b2e-4a71-8c50-6d3e0b1a4f19';

/** Shared marker payload for the lane-container fixtures. */
const FIXTURE_BYTES = [0xde, 0xad, 0xbe, 0xef];

let libraryDir = '';
let outsideDir = '';
let thumbnailDir = '';
let server: http.Server;
let baseUrl = '';

/** Read-only stand-in for the better-sqlite3 handle the routes expect. */
function stubDb(root: string, outside: string): ImagesRouterDb {
  const rows = new Map<string, { absolutePath: string; locationId: string; relativePath: string }>([
    [MKV_ID, { absolutePath: path.join(root, 'clip.mkv'), locationId: 'loc-1', relativePath: 'clip.mkv' }],
    [TS_ID, { absolutePath: path.join(root, 'broadcast.ts'), locationId: 'loc-1', relativePath: 'broadcast.ts' }],
    [JPG_ID, { absolutePath: path.join(root, 'photo.jpg'), locationId: 'loc-1', relativePath: 'photo.jpg' }],
    [TXT_ID, { absolutePath: path.join(root, 'notes.txt'), locationId: 'loc-1', relativePath: 'notes.txt' }],
    [MOV_ID, { absolutePath: path.join(root, 'clip.mov'), locationId: 'loc-1', relativePath: 'clip.mov' }],
    [MP4_ID, { absolutePath: path.join(root, 'clip.mp4'), locationId: 'loc-1', relativePath: 'clip.mp4' }],
    [WEBM_ID, { absolutePath: path.join(root, 'clip.webm'), locationId: 'loc-1', relativePath: 'clip.webm' }],
    [OGG_ID, { absolutePath: path.join(root, 'clip.ogg'), locationId: 'loc-1', relativePath: 'clip.ogg' }],
    // Catalogued in the DB but living outside the registered location — the
    // containment assertion in path-resolver must still reject it.
    [OUTSIDE_ID, { absolutePath: path.join(outside, 'leaked.mkv'), locationId: 'loc-1', relativePath: 'leaked.mkv' }],
  ]);
  return {
    prepare(sql: string) {
      if (sql.includes('FROM files')) {
        return { get: (id: string) => rows.get(id) };
      }
      // 'SELECT path FROM locations' — the one registered library root.
      return { all: () => [{ path: root }] };
    },
  } as unknown as ImagesRouterDb;
}

async function request(
  pathname: string,
  method = 'GET',
): Promise<{ status: number; contentType: string | null; bytes: Uint8Array }> {
  const res = await fetch(`${baseUrl}${pathname}`, { method });
  return {
    status: res.status,
    contentType: res.headers.get('content-type'),
    bytes: new Uint8Array(await res.arrayBuffer()),
  };
}

describe('sidecar /api/original/:id and /api/preview/:id container Content-Type', () => {
  beforeAll(async () => {
    libraryDir = await fse.mkdtemp(path.join(os.tmpdir(), 'onefolder-serve-mime-'));
    outsideDir = await fse.mkdtemp(path.join(os.tmpdir(), 'onefolder-serve-outside-'));
    thumbnailDir = await fse.mkdtemp(path.join(os.tmpdir(), 'onefolder-serve-thumbs-'));
    // Byte contents are irrelevant — the route only checks existence and streams.
    await fse.writeFile(path.join(libraryDir, 'clip.mkv'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    await fse.writeFile(path.join(libraryDir, 'broadcast.ts'), Buffer.from([0x47]));
    await fse.writeFile(path.join(libraryDir, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    await fse.writeFile(path.join(libraryDir, 'notes.txt'), 'export const x = 1;\n');
    await fse.writeFile(path.join(libraryDir, 'clip.mov'), Buffer.from(FIXTURE_BYTES));
    await fse.writeFile(path.join(libraryDir, 'clip.mp4'), Buffer.from(FIXTURE_BYTES));
    await fse.writeFile(path.join(libraryDir, 'clip.webm'), Buffer.from(FIXTURE_BYTES));
    await fse.writeFile(path.join(libraryDir, 'clip.ogg'), Buffer.from(FIXTURE_BYTES));
    await fse.writeFile(path.join(outsideDir, 'leaked.mkv'), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));

    const app = express();
    app.use('/api', makeImagesRouter(stubDb(libraryDir, outsideDir), thumbnailDir));
    // Promise.withResolvers is untyped at this repo's TypeScript 4.9, so the
    // executor form is the only one that compiles here.
    server = await new Promise<http.Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await Promise.all([libraryDir, outsideDir, thumbnailDir].map((dir) => fse.remove(dir)));
  });

  it('serves a .mkv original as video/x-matroska', async () => {
    const res = await request(`/api/original/${MKV_ID}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('video/x-matroska');
    // The bytes really streamed, not just a header.
    expect(Array.from(res.bytes)).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  });

  it('serves a .ts original as video/mp2t', async () => {
    const res = await request(`/api/original/${TS_ID}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('video/mp2t');
    expect(Array.from(res.bytes)).toEqual([0x47]);
  });

  // The web seam's full-size media request (ImageLoader.getImageSrc → encodePreviewPath
  // for every video format) lands on /api/preview, so the containers must be served
  // there too, with the same Content-Type as /original.
  it('serves a .mkv through the preview route as video/x-matroska', async () => {
    const res = await request(`/api/preview/${MKV_ID}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('video/x-matroska');
  });

  it('serves a .ts through the preview route as video/mp2t', async () => {
    const res = await request(`/api/preview/${TS_ID}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('video/mp2t');
  });

  // The containers the video lane already recognised. Before this change they
  // fell through to 415 while mkv/ts streamed — the inconsistency the blast
  // radius calls out ("must serve mkv/ts … AND web-loadable formats
  // consistently").
  const laneContainers: ReadonlyArray<readonly [string, string, string]> = [
    ['mov', MOV_ID, 'video/quicktime'],
    ['mp4', MP4_ID, 'video/mp4'],
    ['webm', WEBM_ID, 'video/webm'],
    ['ogg', OGG_ID, 'video/ogg'],
  ];
  for (const [ext, id, mimeType] of laneContainers) {
    it(`serves a .${ext} original as ${mimeType}`, async () => {
      const res = await request(`/api/original/${id}`);
      expect(res.status).toBe(200);
      expect(res.contentType).toBe(mimeType);
      expect(Array.from(res.bytes)).toEqual(FIXTURE_BYTES);
    });
  }

  it('still serves rasters through the image-only map', async () => {
    const res = await request(`/api/original/${JPG_ID}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('image/jpeg');
  });

  it('refuses an extension on neither map with 415', async () => {
    const res = await request(`/api/original/${TXT_ID}`);
    expect(res.status).toBe(415);
    expect(res.contentType).toContain('application/json');
  });

  it('404s an id with no row — a .ts source that was never ingested', async () => {
    const res = await request('/api/original/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
  });

  it('403s a catalogued path outside the registered location', async () => {
    const res = await request(`/api/original/${OUTSIDE_ID}`);
    expect(res.status).toBe(403);
  });

  it('adds no write affordance — POST is not routed', async () => {
    const res = await request(`/api/original/${MKV_ID}`, 'POST');
    expect(res.status).toBe(404);
  });

  it('leaves the thumbnail lane unchanged for the new containers (no Sharp path)', async () => {
    const res = await request(`/api/thumb/${MKV_ID}`);
    expect(res.status).toBe(501);
  });
});
