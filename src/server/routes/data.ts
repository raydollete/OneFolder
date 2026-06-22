/**
 * DataStorage REST routes — INV-034 / TASK-128.
 *
 * Each route maps 1:1 to a DataStorage read method consumed by HttpBackend
 * (TASK-127).  The wire format uses ISO 8601 strings for all Date fields,
 * which HttpBackend's deserializers convert back to Date objects on the client.
 *
 * REST contract (authoritative reference: src/backend/http-backend.ts):
 *
 *   GET  /api/tags
 *     → { tags: TagWire[] }
 *
 *   GET  /api/files?order=<string>&direction=<asc|desc>
 *     → { files: FileWire[] }
 *
 *   POST /api/files/by-ids        body: { ids: string[] }
 *     → { files: FileWire[] }
 *
 *   POST /api/files/by-key        body: { key: string, value: string|number }
 *     → { files: FileWire[] }
 *
 *   GET  /api/locations
 *     → { locations: LocationWire[] }
 *
 *   GET  /api/searches
 *     → { searches: FileSearchDTO[] }   (no Date fields — passed through as-is)
 *
 *   POST /api/files/search        body: { criteria, order, direction, matchAny }
 *     → { files: FileWire[] }
 *
 *   GET  /api/files/count
 *     → { fileCount: number, untaggedFileCount: number }
 *
 *   GET  /api/dismissed-duplicate-groups
 *     → { groups: DismissedDuplicateGroupWire[] }
 *
 *   POST /api/visual-hashes/by-paths   body: { absolutePaths: string[] }
 *     → { hashes: VisualHashWire[] }
 *
 * Security: all routes are read-only (GET or POST-for-query).  No mutation
 * methods are exposed; any attempt to call a write method through this router
 * is a code defect and will throw via SQLiteBackend (it has no-op stubs for
 * them but we never call them here).
 */

import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';

import { OrderDirection } from '../../api/data-storage-search';
import { FileDTO } from '../../api/file';
import { TagDTO } from '../../api/tag';
import { LocationDTO } from '../../api/location';
import { DismissedDuplicateGroupDTO } from '../../api/dismissed-duplicate-group';
import { VisualHashDTO } from '../../api/visual-hash';
import SQLiteBackend from '../../backend/sqlite-backend';

// ---------------------------------------------------------------------------
// Wire serializers — converts Date objects to ISO strings for the wire
// ---------------------------------------------------------------------------

function fileToWire(dto: FileDTO) {
  return {
    ...dto,
    dateAdded: dto.dateAdded.toISOString(),
    dateModified: dto.dateModified.toISOString(),
    dateCreated: dto.dateCreated.toISOString(),
    dateLastIndexed: dto.dateLastIndexed.toISOString(),
  };
}

function tagToWire(dto: TagDTO) {
  return {
    ...dto,
    dateAdded: dto.dateAdded.toISOString(),
  };
}

function locationToWire(dto: LocationDTO) {
  return {
    ...dto,
    dateAdded: dto.dateAdded.toISOString(),
  };
}

function dismissedGroupToWire(dto: DismissedDuplicateGroupDTO) {
  return {
    ...dto,
    dismissedAt: dto.dismissedAt.toISOString(),
  };
}

function visualHashToWire(dto: VisualHashDTO) {
  return {
    ...dto,
    dateModified: dto.dateModified.toISOString(),
    dateComputed: dto.dateComputed.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Router factory
//
// Accepts the pre-constructed (read-only) SQLiteBackend and the raw Database
// handle.  The DB handle is passed through to path-resolver (TASK-129/131).
// ---------------------------------------------------------------------------

// The `db` parameter is retained for API consistency (index.ts passes it to both
// makeDataRouter and makeImagesRouter) but is not used inside this file — image
// routes (TASK-129) consume it in routes/images.ts via makeImagesRouter.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function makeDataRouter(backend: SQLiteBackend, _db: Database.Database): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/tags
  // -------------------------------------------------------------------------
  router.get('/tags', async (_req: Request, res: Response) => {
    try {
      const tags = await backend.fetchTags();
      res.json({ tags: tags.map(tagToWire) });
    } catch (err) {
      console.error('[data] GET /tags error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/files?order=<key|random|tagCountRandom>&direction=<asc|desc>
  // -------------------------------------------------------------------------
  router.get('/files', async (req: Request, res: Response) => {
    try {
      // `count` sub-path is handled below — skip it here to avoid an ambiguous match.
      // Express 5 routes are matched in definition order, but we register /files/count
      // before the wildcard GET /files handler to be safe.
      const order = (req.query.order as string) || 'dateAdded';
      const directionParam = req.query.direction as string;
      const fileOrder = directionParam === 'desc' ? OrderDirection.Desc : OrderDirection.Asc;

      const files = await backend.fetchFiles(order as keyof FileDTO, fileOrder);
      res.json({ files: files.map(fileToWire) });
    } catch (err) {
      console.error('[data] GET /files error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/files/count
  // Registered before the POST /files/* routes so Express resolves it correctly.
  // -------------------------------------------------------------------------
  router.get('/files/count', async (_req: Request, res: Response) => {
    try {
      const [fileCount, untaggedFileCount] = await backend.countFiles();
      res.json({ fileCount, untaggedFileCount });
    } catch (err) {
      console.error('[data] GET /files/count error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/files/by-ids    body: { ids: string[] }
  // -------------------------------------------------------------------------
  router.post('/files/by-ids', async (req: Request, res: Response) => {
    try {
      const { ids } = req.body as { ids: string[] };
      if (!Array.isArray(ids)) {
        res.status(400).json({ error: '`ids` must be an array' });
        return;
      }
      const files = await backend.fetchFilesByID(ids);
      res.json({ files: files.map(fileToWire) });
    } catch (err) {
      console.error('[data] POST /files/by-ids error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/files/by-key    body: { key: string, value: string|number }
  // -------------------------------------------------------------------------
  router.post('/files/by-key', async (req: Request, res: Response) => {
    try {
      // key typed as optional so the !key guard below is not an unnecessary condition.
      const { key, value } = req.body as { key?: keyof FileDTO; value: string | number };
      if (!key) {
        res.status(400).json({ error: '`key` is required' });
        return;
      }
      const files = await backend.fetchFilesByKey(key, value);
      res.json({ files: files.map(fileToWire) });
    } catch (err) {
      console.error('[data] POST /files/by-key error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/files/search
  // body: { criteria: ConditionDTO[], order: string, direction: 'asc'|'desc', matchAny: boolean }
  // -------------------------------------------------------------------------
  router.post('/files/search', async (req: Request, res: Response) => {
    try {
      // Use optional types in the destructure so runtime-falsy values from a
      // partial/malformed body are handled safely without triggering the
      // @typescript-eslint/no-unnecessary-condition rule.
      const { criteria, order, direction, matchAny } = req.body as {
        criteria: unknown[];
        order?: string;
        direction?: string;
        matchAny?: boolean;
      };

      if (!Array.isArray(criteria) || criteria.length === 0) {
        res.status(400).json({ error: '`criteria` must be a non-empty array' });
        return;
      }

      const fileOrder = direction === 'desc' ? OrderDirection.Desc : OrderDirection.Asc;

      // criteria is passed through as-is — SQLiteBackend validates internally.
      const effectiveOrder = (order ?? 'dateAdded') as keyof FileDTO;
      const files = await backend.searchFiles(
        criteria as Parameters<SQLiteBackend['searchFiles']>[0],
        effectiveOrder,
        fileOrder,
        matchAny ?? false,
      );
      res.json({ files: files.map(fileToWire) });
    } catch (err) {
      console.error('[data] POST /files/search error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/locations
  // -------------------------------------------------------------------------
  router.get('/locations', async (_req: Request, res: Response) => {
    try {
      const locations = await backend.fetchLocations();
      res.json({ locations: locations.map(locationToWire) });
    } catch (err) {
      console.error('[data] GET /locations error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/searches
  // -------------------------------------------------------------------------
  router.get('/searches', async (_req: Request, res: Response) => {
    try {
      const searches = await backend.fetchSearches();
      // FileSearchDTO has no Date fields — pass through unchanged.
      res.json({ searches });
    } catch (err) {
      console.error('[data] GET /searches error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/dismissed-duplicate-groups
  // -------------------------------------------------------------------------
  router.get('/dismissed-duplicate-groups', async (_req: Request, res: Response) => {
    try {
      const groups = await backend.fetchDismissedDuplicateGroups();
      res.json({ groups: groups.map(dismissedGroupToWire) });
    } catch (err) {
      console.error('[data] GET /dismissed-duplicate-groups error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/visual-hashes/by-paths    body: { absolutePaths: string[] }
  // -------------------------------------------------------------------------
  router.post('/visual-hashes/by-paths', async (req: Request, res: Response) => {
    try {
      const { absolutePaths } = req.body as { absolutePaths: string[] };
      if (!Array.isArray(absolutePaths)) {
        res.status(400).json({ error: '`absolutePaths` must be an array' });
        return;
      }
      const hashes = await backend.fetchVisualHashes(absolutePaths);
      res.json({ hashes: hashes.map(visualHashToWire) });
    } catch (err) {
      console.error('[data] POST /visual-hashes/by-paths error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
