/**
 * Read-only metadata routes — INV-034 / TASK-132.
 *
 * Exposes ExifIO read paths over HTTP so the web SPA can obtain file dimensions,
 * tags, and arbitrary EXIF fields without spawning exiftool in the browser.
 *
 * All routes are DB-validated — the client supplies EITHER an opaque file UUID
 * (`:id`) OR the `absolutePath` query parameter.  In both cases the server
 * confirms the path is in the `files` table and inside a registered location
 * before serving.  No arbitrary filesystem path can be queried.
 *
 * REST contract (consumed by platform.web.ts's ExifIO shim):
 *
 *   The `:id` segments below are opaque file UUIDs.
 *   The optional `?absolutePath=<urlencoded>` query parameter is accepted on all
 *   routes as an alternative to `:id` — the server validates the path against the
 *   DB.  When `absolutePath` is supplied, `:id` in the URL may be omitted (use
 *   the paths without `:id` listed in the "by-path" section below).
 *
 *   ID-based:
 *     GET  /api/metadata/:id/dimensions
 *       → { width: number; height: number }
 *
 *     GET  /api/metadata/:id/dimensions-and-tags
 *       → { dimensions: { width: number; height: number }; tags: string[][] }
 *
 *     GET  /api/metadata/:id/tags
 *       → { tags: string[][] }
 *
 *     GET  /api/metadata/:id/faces
 *       → { regionInfo: MWGRegionInfo | null }
 *
 *     POST /api/metadata/:id/exif-tags      body: { tags: string[] }
 *       → { values: (string | undefined)[] }
 *
 *     GET  /api/metadata/:id/all-exif
 *       → { exif: Record<string, unknown> }
 *
 *     GET  /api/metadata/:id/description
 *       → { description: string | null }
 *
 *   Path-based (used by the web ExifIO shim — clients have absolutePath, not ID):
 *     GET  /api/metadata/by-path/dimensions?absolutePath=<encoded>
 *     GET  /api/metadata/by-path/dimensions-and-tags?absolutePath=<encoded>
 *     GET  /api/metadata/by-path/tags?absolutePath=<encoded>
 *     GET  /api/metadata/by-path/faces?absolutePath=<encoded>
 *     POST /api/metadata/by-path/exif-tags?absolutePath=<encoded>  body: { tags: string[] }
 *     GET  /api/metadata/by-path/all-exif?absolutePath=<encoded>
 *     GET  /api/metadata/by-path/description?absolutePath=<encoded>
 *
 * Security
 * --------
 * WRITE methods (writeTags, writeFacesAnnotations, writeData) are NEVER exposed.
 * There are no POST/PUT/PATCH endpoints that trigger any ExifTool write.
 * The underlying ExifIO instance is the shared server-side instance; it has the
 * full ExifIO API surface but only read calls are reachable via these routes.
 *
 * For path-based routes: only paths that exist in the `files` DB table AND are
 * inside a registered location are served.  An attacker cannot request an
 * arbitrary filesystem path.
 *
 * The caller (index.ts) mounts this router at '/api' so the effective paths are
 * /api/metadata/:id/* and /api/metadata/by-path/*, matching the fetch calls in
 * platform.web.ts's ExifIO shim.
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';
import ExifIO from '../../../common/ExifIO';
import { resolveFilePathSafe, resolveAbsolutePathSafe } from '../path-resolver';

// ---------------------------------------------------------------------------
// Router factory
//
// Accepts the pre-constructed (read-only) Database handle and an initialized
// ExifIO instance.  ExifIO is created once in index.ts and shared across all
// requests to avoid spawning multiple exiftool child processes.
//
// The ExifIO instance MUST be initialized (ep.open called) before the server
// starts accepting requests.  index.ts calls exifIO.initialize() before
// calling app.listen().
// ---------------------------------------------------------------------------

export function makeMetadataRouter(db: Database.Database, exifIO: ExifIO): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Helper: resolve file ID to a validated absolute path and send a 4xx
  // response if the ID is not found or is out of bounds.
  // Returns null and sends a response if resolution fails.
  // -------------------------------------------------------------------------
  function resolveByIdOrRespond(req: Request, res: Response): string | null {
    const id = req.params['id'] as string;
    const resolved = resolveFilePathSafe(db, id);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.message });
      return null;
    }
    return resolved.absolutePath;
  }

  // Helper: resolve by absolutePath query param.
  function resolveByPathOrRespond(req: Request, res: Response): string | null {
    const rawPath = req.query['absolutePath'];
    if (typeof rawPath !== 'string' || !rawPath) {
      res.status(400).json({ error: '`absolutePath` query parameter is required' });
      return null;
    }
    const resolved = resolveAbsolutePathSafe(db, rawPath);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.message });
      return null;
    }
    return resolved.absolutePath;
  }

  // =========================================================================
  // ID-based routes
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /metadata/:id/dimensions
  // -------------------------------------------------------------------------
  router.get('/metadata/:id/dimensions', async (req: Request, res: Response) => {
    const absolutePath = resolveByIdOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const dimensions = await exifIO.getDimensions(absolutePath);
      res.json(dimensions);
    } catch (err) {
      console.error(`[metadata] GET dimensions for ${req.params['id']} error:`, err);
      res.status(500).json({ error: 'Failed to read dimensions' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metadata/:id/dimensions-and-tags
  // -------------------------------------------------------------------------
  router.get('/metadata/:id/dimensions-and-tags', async (req: Request, res: Response) => {
    const absolutePath = resolveByIdOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const result = await exifIO.getDimensionsAndTags(absolutePath);
      res.json(result);
    } catch (err) {
      console.error(`[metadata] GET dimensions-and-tags for ${req.params['id']} error:`, err);
      res.status(500).json({ error: 'Failed to read dimensions and tags' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metadata/:id/tags
  // -------------------------------------------------------------------------
  router.get('/metadata/:id/tags', async (req: Request, res: Response) => {
    const absolutePath = resolveByIdOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const tags = await exifIO.readTags(absolutePath);
      res.json({ tags });
    } catch (err) {
      console.error(`[metadata] GET tags for ${req.params['id']} error:`, err);
      res.status(500).json({ error: 'Failed to read tags' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metadata/:id/faces
  // -------------------------------------------------------------------------
  router.get('/metadata/:id/faces', async (req: Request, res: Response) => {
    const absolutePath = resolveByIdOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const regionInfo = await exifIO.readFacesAnnotations(absolutePath);
      res.json({ regionInfo: regionInfo ?? null });
    } catch (err) {
      console.error(`[metadata] GET faces for ${req.params['id']} error:`, err);
      res.status(500).json({ error: 'Failed to read face annotations' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /metadata/:id/exif-tags     body: { tags: string[] }
  // -------------------------------------------------------------------------
  router.post('/metadata/:id/exif-tags', async (req: Request, res: Response) => {
    const absolutePath = resolveByIdOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    const { tags } = req.body as { tags?: string[] };
    if (!Array.isArray(tags) || tags.length === 0) {
      res.status(400).json({ error: '`tags` must be a non-empty array of EXIF tag names' });
      return;
    }

    try {
      const values = await exifIO.readExifTags(absolutePath, tags);
      res.json({ values });
    } catch (err) {
      console.error(`[metadata] POST exif-tags for ${req.params['id']} error:`, err);
      res.status(500).json({ error: 'Failed to read EXIF tags' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metadata/:id/all-exif
  // -------------------------------------------------------------------------
  router.get('/metadata/:id/all-exif', async (req: Request, res: Response) => {
    const absolutePath = resolveByIdOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const exif = await exifIO.readAllExifTags(absolutePath);
      res.json({ exif });
    } catch (err) {
      console.error(`[metadata] GET all-exif for ${req.params['id']} error:`, err);
      res.status(500).json({ error: 'Failed to read all EXIF tags' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metadata/:id/description
  // -------------------------------------------------------------------------
  router.get('/metadata/:id/description', async (req: Request, res: Response) => {
    const absolutePath = resolveByIdOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const description = await exifIO.readDescription(absolutePath);
      res.json({ description: description ?? null });
    } catch (err) {
      console.error(`[metadata] GET description for ${req.params['id']} error:`, err);
      res.status(500).json({ error: 'Failed to read description' });
    }
  });

  // =========================================================================
  // Path-based routes (/metadata/by-path/*)
  //
  // Used by the web ExifIO shim — the SPA has absolutePath strings (from the
  // files API) but not always the file UUID.  The server validates the path
  // against the DB (see resolveAbsolutePathSafe in path-resolver.ts) before
  // serving — only catalogued, location-contained paths are accepted.
  //
  // These routes MUST be registered before the `:id` routes to avoid Express
  // matching "by-path" as a literal file ID.  Because we mount the metadata
  // router after the data/images routers and register by-path first here,
  // the ordering is correct.
  // =========================================================================

  // -------------------------------------------------------------------------
  // GET /metadata/by-path/dimensions?absolutePath=<encoded>
  // -------------------------------------------------------------------------
  router.get('/metadata/by-path/dimensions', async (req: Request, res: Response) => {
    const absolutePath = resolveByPathOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const dimensions = await exifIO.getDimensions(absolutePath);
      res.json(dimensions);
    } catch (err) {
      console.error('[metadata] GET by-path/dimensions error:', err);
      res.status(500).json({ error: 'Failed to read dimensions' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metadata/by-path/dimensions-and-tags?absolutePath=<encoded>
  // -------------------------------------------------------------------------
  router.get('/metadata/by-path/dimensions-and-tags', async (req: Request, res: Response) => {
    const absolutePath = resolveByPathOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const result = await exifIO.getDimensionsAndTags(absolutePath);
      res.json(result);
    } catch (err) {
      console.error('[metadata] GET by-path/dimensions-and-tags error:', err);
      res.status(500).json({ error: 'Failed to read dimensions and tags' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metadata/by-path/tags?absolutePath=<encoded>
  // -------------------------------------------------------------------------
  router.get('/metadata/by-path/tags', async (req: Request, res: Response) => {
    const absolutePath = resolveByPathOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const tags = await exifIO.readTags(absolutePath);
      res.json({ tags });
    } catch (err) {
      console.error('[metadata] GET by-path/tags error:', err);
      res.status(500).json({ error: 'Failed to read tags' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metadata/by-path/faces?absolutePath=<encoded>
  // -------------------------------------------------------------------------
  router.get('/metadata/by-path/faces', async (req: Request, res: Response) => {
    const absolutePath = resolveByPathOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const regionInfo = await exifIO.readFacesAnnotations(absolutePath);
      res.json({ regionInfo: regionInfo ?? null });
    } catch (err) {
      console.error('[metadata] GET by-path/faces error:', err);
      res.status(500).json({ error: 'Failed to read face annotations' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /metadata/by-path/exif-tags?absolutePath=<encoded>  body: { tags: string[] }
  // -------------------------------------------------------------------------
  router.post('/metadata/by-path/exif-tags', async (req: Request, res: Response) => {
    const absolutePath = resolveByPathOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    const { tags } = req.body as { tags?: string[] };
    if (!Array.isArray(tags) || tags.length === 0) {
      res.status(400).json({ error: '`tags` must be a non-empty array of EXIF tag names' });
      return;
    }

    try {
      const values = await exifIO.readExifTags(absolutePath, tags);
      res.json({ values });
    } catch (err) {
      console.error('[metadata] POST by-path/exif-tags error:', err);
      res.status(500).json({ error: 'Failed to read EXIF tags' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metadata/by-path/all-exif?absolutePath=<encoded>
  // -------------------------------------------------------------------------
  router.get('/metadata/by-path/all-exif', async (req: Request, res: Response) => {
    const absolutePath = resolveByPathOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const exif = await exifIO.readAllExifTags(absolutePath);
      res.json({ exif });
    } catch (err) {
      console.error('[metadata] GET by-path/all-exif error:', err);
      res.status(500).json({ error: 'Failed to read all EXIF tags' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /metadata/by-path/description?absolutePath=<encoded>
  // -------------------------------------------------------------------------
  router.get('/metadata/by-path/description', async (req: Request, res: Response) => {
    const absolutePath = resolveByPathOrRespond(req, res);
    if (!absolutePath) {
      return;
    }

    try {
      const description = await exifIO.readDescription(absolutePath);
      res.json({ description: description ?? null });
    } catch (err) {
      console.error('[metadata] GET by-path/description error:', err);
      res.status(500).json({ error: 'Failed to read description' });
    }
  });

  return router;
}
