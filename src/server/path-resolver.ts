/**
 * Location-scoped path resolver — INV-034 / TASK-128.
 *
 * Resolves a file ID to its absolute filesystem path while asserting that the
 * path is contained within one of the library's known locations.
 *
 * Security contract (INV-034 § "Path-traversal guard"):
 *  - The server NEVER accepts a raw client-supplied filesystem path.
 *  - The client supplies only an opaque file ID (a UUID).
 *  - This module looks up `absolutePath` from the DB for that ID, then checks
 *    (after path.resolve + case-normalisation on Windows) that the resolved
 *    path is a descendant of at least one registered location.
 *  - Anything outside the locations is rejected with a PathOutOfBoundsError,
 *    which the caller (TASK-129 / TASK-131 image endpoints) should map to
 *    HTTP 403.
 *
 * This module is exported for use by image endpoint handlers in TASK-129/131.
 *
 * NOTE — encodeFilePath security concern (flagged per task instructions):
 *   HttpBackend (TASK-127) currently derives image URLs via a build-conditional
 *   `encodeFilePath` that emits `/api/original?path=<encoded-path>`.  Accepting
 *   a raw (even encoded) path on the server breaks this module's invariant.
 *   TASK-129 SHOULD instead use ID-based URLs (`/api/original/:id`) so that
 *   this resolver is the sole gatekeeper and path traversal from a crafted URL
 *   is structurally impossible.  The `path=` query-string form should be treated
 *   as a temporary PoC shortcut to be replaced before any auth/TLS deployment.
 */

import path from 'path';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/** Thrown when a file ID resolves to a path outside all registered locations. */
export class PathOutOfBoundsError extends Error {
  readonly fileId: string;
  readonly absolutePath: string;

  constructor(fileId: string, absolutePath: string) {
    super(
      `[path-resolver] File id=${fileId} resolves to "${absolutePath}" which is outside all ` +
        'registered library locations. Request denied.',
    );
    this.name = 'PathOutOfBoundsError';
    this.fileId = fileId;
    this.absolutePath = absolutePath;
  }
}

/** Thrown when a file ID does not exist in the database. */
export class FileNotFoundError extends Error {
  readonly fileId: string;

  constructor(fileId: string) {
    super(`[path-resolver] No file with id="${fileId}" found in the database.`);
    this.name = 'FileNotFoundError';
    this.fileId = fileId;
  }
}

// ---------------------------------------------------------------------------
// Internal DB query types
// ---------------------------------------------------------------------------

interface FilePathRow {
  absolutePath: string;
}

interface LocationPathRow {
  path: string;
}

// ---------------------------------------------------------------------------
// Path normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a path for comparison: resolve to absolute, then lower-case on
 * Windows (NTFS is case-insensitive by default).
 */
function normalisePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Returns true if `child` is inside `parent` (or is `parent` itself).
 * Both arguments must already be normalised via `normalisePath`.
 */
function isDescendant(child: string, parent: string): boolean {
  // Ensure parent ends with the separator so that a path like /photos-extra
  // does not match when parent is /photos.
  const parentWithSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child === parent || child.startsWith(parentWithSep);
}

// ---------------------------------------------------------------------------
// PathResolver
// ---------------------------------------------------------------------------

/**
 * Resolves a file ID to its validated absolute path.
 *
 * @param db      - A `better-sqlite3` Database opened on the active library.
 *                  The connection MUST be read-only (enforced at open time in
 *                  `src/server/index.ts`).
 * @param fileId  - The opaque file UUID from the client request.
 * @returns       The absolute filesystem path to the file.
 * @throws        FileNotFoundError if the ID is not in the database.
 * @throws        PathOutOfBoundsError if the path escapes every location root.
 */
export function resolveFilePath(db: Database.Database, fileId: string): string {
  // Step 1: look up the file's absolutePath from the DB.
  const fileRow = db
    .prepare<string, FilePathRow>('SELECT absolutePath FROM files WHERE id = ?')
    .get(fileId);

  if (!fileRow) {
    throw new FileNotFoundError(fileId);
  }

  const absolutePath = fileRow.absolutePath;

  // Step 2: load all location roots from the DB.
  const locationRows = db.prepare<[], LocationPathRow>('SELECT path FROM locations').all();

  if (locationRows.length === 0) {
    // No locations registered means no files should be accessible — fail safe.
    throw new PathOutOfBoundsError(fileId, absolutePath);
  }

  // Step 3: assert the resolved path is inside at least one location.
  const normFile = normalisePath(absolutePath);
  const isInBounds = locationRows.some((loc) => isDescendant(normFile, normalisePath(loc.path)));

  if (!isInBounds) {
    throw new PathOutOfBoundsError(fileId, absolutePath);
  }

  return absolutePath;
}

// ---------------------------------------------------------------------------
// Convenience helper for Express route handlers (TASK-129/131)
// ---------------------------------------------------------------------------

/**
 * Wraps `resolveFilePath` with HTTP-semantics error mapping.
 *
 * Returns `{ ok: true, absolutePath }` on success, or
 * `{ ok: false, status: 404 | 403, message }` on failure — so callers can
 * `res.status(result.status).json({ error: result.message })` without a
 * try/catch at every call site.
 */
export function resolveFilePathSafe(
  db: Database.Database,
  fileId: string,
): { ok: true; absolutePath: string } | { ok: false; status: 404 | 403; message: string } {
  try {
    return { ok: true, absolutePath: resolveFilePath(db, fileId) };
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      return { ok: false, status: 404, message: `File not found: ${fileId}` };
    }
    if (err instanceof PathOutOfBoundsError) {
      return {
        ok: false,
        status: 403,
        message: 'Access denied: path is outside library locations',
      };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Absolute-path-based resolution (TASK-132 metadata routes)
// ---------------------------------------------------------------------------

interface FileIdRow {
  id: string;
}

/**
 * Validates an absolute filesystem path against the DB and registered locations.
 *
 * Unlike `resolveFilePath` (which maps an ID → path), this function takes a
 * path supplied by the web SPA and validates it from the other direction:
 *
 *   path → DB lookup (SELECT id FROM files WHERE absolutePath = ?)
 *         → location bounds check
 *
 * Security contract: only paths that exist in the `files` table AND are
 * contained within a registered location are accepted.  An attacker cannot
 * request an arbitrary filesystem path; they can only request paths that the
 * desktop app has already catalogued.
 *
 * This is intentionally less strict than the ID-based path — the client
 * already knows the absolutePath because the server served it via /api/files.
 * However, the server still validates containment in a registered location so
 * that a crafted request for a path outside locations (e.g. injected via a
 * modified DB entry) is rejected.
 *
 * @param db           - A read-only better-sqlite3 Database handle.
 * @param absolutePath - The absolute filesystem path from the client request.
 * @returns            `{ ok: true, absolutePath }` or `{ ok: false, status, message }`.
 */
export function resolveAbsolutePathSafe(
  db: Database.Database,
  absolutePath: string,
): { ok: true; absolutePath: string } | { ok: false; status: 404 | 403; message: string } {
  // Step 1: Confirm the path exists in the DB (it was catalogued by the desktop app).
  const fileRow = db
    .prepare<string, FileIdRow>('SELECT id FROM files WHERE absolutePath = ?')
    .get(absolutePath);

  if (!fileRow) {
    // Try case-insensitive match on Windows — paths stored in the DB may differ
    // in case from what the web SPA computed.
    if (process.platform === 'win32') {
      const normPath = absolutePath.toLowerCase();
      // SQLite's LOWER() is used for a case-insensitive match on the stored path.
      const caseRow = db
        .prepare<string, { absolutePath: string }>(
          'SELECT absolutePath FROM files WHERE LOWER(absolutePath) = ?',
        )
        .get(normPath);

      if (!caseRow) {
        return { ok: false, status: 404, message: 'Path not found in library' };
      }

      // Use the DB-stored path (canonical case) for the bounds check.
      absolutePath = caseRow.absolutePath;
    } else {
      return { ok: false, status: 404, message: 'Path not found in library' };
    }
  }

  // Step 2: Load all location roots from the DB.
  const locationRows = db.prepare<[], LocationPathRow>('SELECT path FROM locations').all();

  if (locationRows.length === 0) {
    return {
      ok: false,
      status: 403,
      message: 'Access denied: no library locations registered',
    };
  }

  // Step 3: Assert the path is inside at least one location.
  const normFile = normalisePath(absolutePath);
  const isInBounds = locationRows.some((loc) => isDescendant(normFile, normalisePath(loc.path)));

  if (!isInBounds) {
    return {
      ok: false,
      status: 403,
      message: 'Access denied: path is outside library locations',
    };
  }

  return { ok: true, absolutePath };
}
