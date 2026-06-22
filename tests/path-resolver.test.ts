/**
 * Unit tests for src/server/path-resolver.ts — INV-034 / TASK-128.
 *
 * Tests verify that:
 *  - resolveFilePath returns the correct absolute path for a valid in-library file ID.
 *  - resolveFilePath throws PathOutOfBoundsError for a file whose path is outside
 *    all registered locations.
 *  - resolveFilePath throws FileNotFoundError for an unknown file ID.
 *  - The convenience wrapper resolveFilePathSafe maps errors to HTTP status codes.
 *
 * NOTE: this suite uses a tiny in-memory stub of the better-sqlite3 surface that
 * path-resolver actually consumes (`prepare(sql).get()` / `prepare(sql).all()`),
 * rather than a real `better-sqlite3` database.  In this repo `better-sqlite3`
 * is compiled against Electron's ABI, so loading the native `.node` under Jest's
 * plain-Node runtime fails with a NODE_MODULE_VERSION mismatch.  The stub keeps
 * the security-critical logic under test (path.resolve normalisation, the
 * descendant/boundary check, and the error → HTTP-status mapping); exercising the
 * real SQLite driver against a live library is covered by the manual QA pass
 * (TASK-137).
 */

import path from 'path';
import type Database from 'better-sqlite3';

import {
  resolveFilePath,
  resolveFilePathSafe,
  PathOutOfBoundsError,
  FileNotFoundError,
} from '../src/server/path-resolver';

// ---------------------------------------------------------------------------
// Minimal better-sqlite3 stub
//
// path-resolver issues exactly two query shapes:
//   SELECT absolutePath FROM files WHERE id = ?   → .get(id)
//   SELECT path FROM locations                    → .all()
// The stub pattern-matches those and serves rows from in-memory state.
// ---------------------------------------------------------------------------

class FakeDb {
  /** id → absolutePath */
  readonly files = new Map<string, string>();
  /** registered location roots */
  locations: string[] = [];

  prepare(sql: string): { get: (arg?: unknown) => unknown; all: () => unknown[] } {
    if (/FROM\s+files\s+WHERE\s+id\s*=/.test(sql)) {
      return {
        get: (id: unknown) => {
          const absolutePath = this.files.get(id as string);
          return absolutePath !== undefined ? { absolutePath } : undefined;
        },
        all: () => [],
      };
    }
    if (/FROM\s+locations/.test(sql)) {
      return {
        get: () => undefined,
        all: () => this.locations.map((p) => ({ path: p })),
      };
    }
    throw new Error(`[test stub] unexpected SQL: ${sql}`);
  }

  close(): void {
    /* no-op */
  }
}

function makeDb(): FakeDb {
  return new FakeDb();
}

function insertFile(db: FakeDb, id: string, absolutePath: string): void {
  db.files.set(id, absolutePath);
}

function insertLocation(db: FakeDb, _id: string, locationPath: string): void {
  db.locations.push(locationPath);
}

/** Cast the stub to the better-sqlite3 type the resolver expects. */
function asDb(db: FakeDb): Database.Database {
  return db as unknown as Database.Database;
}

// ---------------------------------------------------------------------------
// Cross-platform location path used throughout the tests.
//
// On Windows the location root is C:\Photos (or the current drive letter's
// equivalent).  On POSIX it is /photos.  We derive these at test time so the
// assertions work on both CI and dev machines.
// ---------------------------------------------------------------------------

const SEP = path.sep;
const LOCATION_ROOT =
  process.platform === 'win32'
    ? path.join(process.env.SystemDrive ?? 'C:', SEP, 'Photos')
    : '/photos';

const IN_LIBRARY_PATH = path.join(LOCATION_ROOT, 'vacation', 'img001.jpg');
const OUT_OF_TREE_PATH =
  process.platform === 'win32'
    ? path.join(process.env.SystemDrive ?? 'C:', SEP, 'secret', 'file.jpg')
    : '/etc/passwd';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('path-resolver', () => {
  let db: FakeDb;

  beforeEach(() => {
    db = makeDb();
    // Register a single location root
    insertLocation(db, 'loc-1', LOCATION_ROOT);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // resolveFilePath
  // -------------------------------------------------------------------------

  describe('resolveFilePath', () => {
    it('returns the correct path for a valid in-library file ID', () => {
      insertFile(db, 'file-in-library', IN_LIBRARY_PATH);

      const result = resolveFilePath(asDb(db), 'file-in-library');
      expect(result).toBe(IN_LIBRARY_PATH);
    });

    it('throws PathOutOfBoundsError for a path outside all locations', () => {
      insertFile(db, 'file-outside', OUT_OF_TREE_PATH);

      expect(() => resolveFilePath(asDb(db), 'file-outside')).toThrow(PathOutOfBoundsError);
    });

    it('includes the file ID and absolute path in the PathOutOfBoundsError', () => {
      insertFile(db, 'file-outside-detail', OUT_OF_TREE_PATH);

      expect(() => resolveFilePath(asDb(db), 'file-outside-detail')).toThrow(
        expect.objectContaining({
          fileId: 'file-outside-detail',
          absolutePath: OUT_OF_TREE_PATH,
        }),
      );
    });

    it('throws FileNotFoundError for an unknown file ID', () => {
      expect(() => resolveFilePath(asDb(db), 'nonexistent-id')).toThrow(FileNotFoundError);
    });

    it('includes the file ID in the FileNotFoundError', () => {
      expect(() => resolveFilePath(asDb(db), 'ghost')).toThrow(
        expect.objectContaining({ fileId: 'ghost' }),
      );
    });

    it('rejects a path traversal attempt using ../ in the stored path', () => {
      // path.resolve() collapses ./ and ../ so a stored value like
      // LOCATION_ROOT + '/../../../etc/passwd' would resolve outside.
      const traversalPath = path.resolve(LOCATION_ROOT, '..', '..', 'escape', 'file.jpg');
      insertFile(db, 'traversal-file', traversalPath);

      expect(() => resolveFilePath(asDb(db), 'traversal-file')).toThrow(PathOutOfBoundsError);
    });

    it('accepts a file at the exact location root', () => {
      // A file located exactly at the location directory itself (edge case).
      const atRoot = path.join(LOCATION_ROOT, 'root-file.jpg');
      insertFile(db, 'root-file', atRoot);

      expect(resolveFilePath(asDb(db), 'root-file')).toBe(atRoot);
    });

    it('throws PathOutOfBoundsError when there are no locations registered', () => {
      // Remove the location we set up in beforeEach
      db.locations = [];
      insertFile(db, 'any-file', IN_LIBRARY_PATH);

      expect(() => resolveFilePath(asDb(db), 'any-file')).toThrow(PathOutOfBoundsError);
    });
  });

  // -------------------------------------------------------------------------
  // resolveFilePathSafe
  // -------------------------------------------------------------------------

  describe('resolveFilePathSafe', () => {
    it('returns { ok: true, absolutePath } for a valid in-library file', () => {
      insertFile(db, 'safe-in-lib', IN_LIBRARY_PATH);

      const result = resolveFilePathSafe(asDb(db), 'safe-in-lib');
      expect(result).toEqual({ ok: true, absolutePath: IN_LIBRARY_PATH });
    });

    it('returns { ok: false, status: 403 } for out-of-bounds path', () => {
      insertFile(db, 'safe-out-of-bounds', OUT_OF_TREE_PATH);

      const result = resolveFilePathSafe(asDb(db), 'safe-out-of-bounds');
      expect(result).toMatchObject({ ok: false, status: 403 });
    });

    it('returns { ok: false, status: 404 } for unknown file ID', () => {
      const result = resolveFilePathSafe(asDb(db), 'unknown-id');
      expect(result).toMatchObject({ ok: false, status: 404 });
    });
  });
});
