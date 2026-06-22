/**
 * On-demand rescan route — INV-034 / TASK-135.
 *
 * POST /api/rescan
 *
 * Re-queries files and locations from the read-only SQLite database so the
 * web client can refresh its view of the library without a live file watcher.
 *
 * The server DB is opened strictly READ-ONLY (see src/server/index.ts).  This
 * route never writes — it only reads and returns current counts so the caller
 * knows whether a client-side refetch of /api/files and /api/locations is
 * worthwhile.
 *
 * Response body:
 *   {
 *     ok: true,
 *     fileCount: number,      // total rows in the files table
 *     locationCount: number,  // total rows in the locations table
 *     scannedAt: string,      // ISO 8601 timestamp of when the scan ran
 *   }
 *
 * The web client (platform.web.ts) calls this endpoint and then triggers a
 * full store refresh via HttpBackend (refetch files + tags) so the gallery
 * reflects the current DB state.
 *
 * Security: same as all other /api routes — the DB is read-only and the
 * connection is scoped to the single active library opened at server start.
 * No client-supplied paths are accepted.
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates the rescan router.
 *
 * @param db  The read-only better-sqlite3 Database connection opened at
 *            server startup.  The route uses synchronous statement execution
 *            (better-sqlite3's default) since we only do two COUNT queries.
 */
export function makeRescanRouter(db: Database.Database): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /rescan
  //
  // No request body is needed — the endpoint unconditionally re-queries the DB.
  // POST is used rather than GET to make it explicit that this is an action
  // (trigger a scan), not a cacheable read.
  // -------------------------------------------------------------------------
  router.post('/rescan', (_req: Request, res: Response): void => {
    try {
      // Count files and locations in a single round-trip using two synchronous
      // prepared statements.  better-sqlite3 is synchronous by design and these
      // are trivial COUNT queries — no async overhead needed.
      const fileCount = (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n;
      const locationCount = (
        db.prepare('SELECT COUNT(*) AS n FROM locations').get() as { n: number }
      ).n;

      res.json({
        ok: true,
        fileCount,
        locationCount,
        scannedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[rescan] DB query failed:', err);
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  return router;
}
