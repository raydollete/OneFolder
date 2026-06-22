/**
 * Image serving routes — INV-034 / TASK-129, extended TASK-131.
 *
 * Exposes three endpoints for the web SPA:
 *
 *   GET /api/original/:id
 *     Resolves the file ID to its absolute path via path-resolver, asserts the
 *     extension is a web-loadable format (jpg/jpeg/png/webp/gif/bmp), then
 *     streams the file with the correct Content-Type and CORP headers.
 *     Non-web formats (HEIC/PSD/TIFF/EXR/…) receive a 415 response pointing
 *     to /api/preview/:id.
 *
 *   GET /api/thumb/:id
 *     Resolves the file ID to its absolute path, computes the thumbnail cache
 *     path via getThumbnailPath, and either:
 *       a) Streams the cached thumbnail if it already exists on disk, or
 *       b) Generates it with Sharp (resize to SERVER_THUMBNAIL_MAX_SIZE, encode
 *          to SERVER_THUMBNAIL_FORMAT), persists to the cache path, then streams.
 *     For non-web formats (HEIC/PSD/TIFF/EXR — TASK-131), decodes first via
 *     decode.ts then resizes with Sharp.
 *
 *   GET /api/preview/:id   (TASK-131)
 *     Decodes a non-web format (HEIC/PSD/TIFF/EXR) server-side to webp and
 *     returns the full-size decoded image.  Decoded previews are cached on disk
 *     in a `previews/` directory sibling to the thumbnail cache.  Web formats
 *     are served directly (same as /original) since they don't require decoding.
 *
 * Security
 * --------
 * ALL endpoints are ID-based.  The client NEVER sends a filesystem path.
 * path-resolver.resolveFilePathSafe is the sole gatekeeper: it looks up the
 * absolutePath from the DB and asserts containment within a registered location
 * before returning it.  No raw filesystem path is ever accepted from the client.
 *
 * Headers
 * -------
 * All endpoints send:
 *   Cross-Origin-Resource-Policy: same-origin
 * This is required so images load under the page's COEP (require-corp).
 * The global coopCoepMiddleware in index.ts also sends CORP on every response,
 * but the explicit header here is belt-and-suspenders for the image endpoints.
 *
 * The caller (index.ts) mounts this router at '/api' so the effective paths are
 * /api/original/:id, /api/thumb/:id, and /api/preview/:id, matching the
 * encodeFilePath / encodePreviewPath emitted by platform.web.ts.
 */

import path from 'path';
import fse from 'fs-extra';
import { Router, Request, Response } from 'express';
import Database from 'better-sqlite3';

import { resolveFilePathSafe } from '../path-resolver';
import { getThumbnailPath } from '../../../common/fs';
import {
  generateThumbnail,
  getPreviewPath,
  SERVER_THUMBNAIL_FORMAT,
  SERVER_THUMBNAIL_MAX_SIZE,
} from '../thumbnails';
import { decodeToBuffer, isPreviewFormat } from '../decode';

// ---------------------------------------------------------------------------
// MIME type map for web-safe image formats
// ---------------------------------------------------------------------------

const WEB_FORMAT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
};

/**
 * Returns the MIME type for a web-safe image extension, or null if the
 * extension is not a browser-loadable raster format.
 */
function webMimeType(filePath: string): string | null {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  // Cast through unknown to allow undefined lookup on a Record<string, string>.
  return (WEB_FORMAT_MIME as Record<string, string | undefined>)[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Apply required CORP header and optional cache control to a response. */
function setImageHeaders(res: Response, mimeType: string, options: { cache?: boolean } = {}): void {
  res.setHeader('Content-Type', mimeType);
  // Required under COEP=require-corp so cross-origin sub-resources load.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (options.cache) {
    // Cache thumbnails aggressively — they are content-addressed via file hash.
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  } else {
    // Originals: validate on each request.
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * @param db            - The read-only better-sqlite3 Database handle from index.ts.
 * @param thumbnailDir  - The absolute path to the thumbnail cache directory for
 *                         the active library.  Derived from getDefaultThumbnailDir
 *                         in index.ts; passed here so this module stays stateless.
 */
export function makeImagesRouter(db: Database.Database, thumbnailDir: string): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /original/:id
  //
  // Streams a web-format original file (jpg/jpeg/png/webp/gif/bmp).
  // Non-web formats return 415 with a hint to use /api/preview/:id (TASK-131).
  // -------------------------------------------------------------------------
  router.get('/original/:id', async (req: Request, res: Response) => {
    // Express types params as string | string[]; route params are always string.
    const id = req.params['id'] as string;

    const resolved = resolveFilePathSafe(db, id);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }

    const { absolutePath } = resolved;
    const mimeType = webMimeType(absolutePath);

    if (!mimeType) {
      // Non-web format — TASK-131 will handle these via /api/preview/:id.
      const ext = path.extname(absolutePath).replace(/^\./, '').toLowerCase();
      res.status(415).json({
        error: `Format "${ext}" cannot be served directly by the browser.`,
        hint: 'Use GET /api/preview/:id (TASK-131) for server-side decoded formats (HEIC, PSD, TIFF, EXR).',
      });
      return;
    }

    // Confirm the file exists before streaming.
    if (!(await fse.pathExists(absolutePath))) {
      res.status(404).json({ error: `File not found on disk: ${id}` });
      return;
    }

    setImageHeaders(res, mimeType);
    res.sendFile(absolutePath);
  });

  // -------------------------------------------------------------------------
  // GET /thumb/:id
  //
  // Serves the cached thumbnail, generating it with Sharp if absent.
  // For non-web formats (HEIC/PSD/TIFF/EXR — TASK-131), decodes via decode.ts
  // first, then resizes with Sharp using the raw-pixel Buffer path.
  // -------------------------------------------------------------------------
  router.get('/thumb/:id', async (req: Request, res: Response) => {
    // Express types params as string | string[]; route params are always string.
    const id = req.params['id'] as string;

    const resolved = resolveFilePathSafe(db, id);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }

    const { absolutePath } = resolved;

    // Confirm the source file exists on disk.
    if (!(await fse.pathExists(absolutePath))) {
      res.status(404).json({ error: `Source file not found on disk: ${id}` });
      return;
    }

    const thumbPath = getThumbnailPath(absolutePath, thumbnailDir);
    const thumbMime = 'image/' + SERVER_THUMBNAIL_FORMAT; // 'image/webp'

    // Fast path: cached thumbnail already exists.
    if (await fse.pathExists(thumbPath)) {
      setImageHeaders(res, thumbMime, { cache: true });
      res.sendFile(thumbPath);
      return;
    }

    const sourceExt = path.extname(absolutePath).replace(/^\./, '').toLowerCase();

    // ---
    // Non-web formats (HEIC/PSD/TIFF/EXR): decode to raw pixel buffer first,
    // then pass the buffer to generateThumbnail for resizing + webp encode.
    // ---
    if (isPreviewFormat(sourceExt)) {
      try {
        console.info(`[images/thumb] Decoding ${sourceExt} for thumbnail: ${id}`);
        const { buffer: decodedBuf } = await decodeToBuffer(absolutePath, 'webp');
        // decodedBuf is an encoded webp — pass it to Sharp for resize.
        // Sharp can decode its own webp output, so we don't need rawPixelMeta here.
        await generateThumbnail(
          decodedBuf,
          thumbPath,
          SERVER_THUMBNAIL_MAX_SIZE,
          SERVER_THUMBNAIL_FORMAT,
        );
      } catch (err) {
        console.error(`[images/thumb] Decode+thumbnail failed for ${id}:`, err);
        res.status(500).json({
          error: 'Thumbnail generation failed for non-web format.',
          detail: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      setImageHeaders(res, thumbMime, { cache: true });
      res.sendFile(thumbPath);
      return;
    }

    // ---
    // Web formats + Sharp-native formats: generate thumbnail directly.
    // ---
    const sharpNativeFormats = new Set([
      'jpg',
      'jpeg',
      'png',
      'webp',
      'gif',
      'bmp',
      'tiff',
      'tif',
      'avif',
      'heic',
      'heif',
      'svg',
    ]);

    if (!sharpNativeFormats.has(sourceExt)) {
      res.status(501).json({
        error: `Thumbnail generation for format "${sourceExt}" is not supported.`,
        hint: 'Use GET /api/preview/:id for decoded previews of known non-web formats.',
      });
      return;
    }

    try {
      await generateThumbnail(
        absolutePath,
        thumbPath,
        SERVER_THUMBNAIL_MAX_SIZE,
        SERVER_THUMBNAIL_FORMAT,
      );
    } catch (err) {
      console.error(`[images/thumb] Sharp thumbnail generation failed for ${id}:`, err);
      res.status(500).json({
        error: 'Thumbnail generation failed.',
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    setImageHeaders(res, thumbMime, { cache: true });
    res.sendFile(thumbPath);
  });

  // -------------------------------------------------------------------------
  // GET /preview/:id   (TASK-131)
  //
  // Full-size decoded preview for non-web formats (HEIC, PSD, TIFF, EXR).
  // Decodes server-side to webp via decode.ts (DOM-less Sharp + WASM path).
  // Decoded previews are cached on disk in a sibling previews/ directory.
  //
  // For web formats that don't need decoding, falls through to stream the
  // original directly (same as /original) so the viewer can use /preview
  // unconditionally without knowing the source format.
  // -------------------------------------------------------------------------
  router.get('/preview/:id', async (req: Request, res: Response) => {
    const id = req.params['id'] as string;

    const resolved = resolveFilePathSafe(db, id);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.message });
      return;
    }

    const { absolutePath } = resolved;

    if (!(await fse.pathExists(absolutePath))) {
      res.status(404).json({ error: `File not found on disk: ${id}` });
      return;
    }

    const sourceExt = path.extname(absolutePath).replace(/^\./, '').toLowerCase();

    // ---
    // Web formats — serve directly (no decode needed).
    // ---
    const webMime = webMimeType(absolutePath);
    if (webMime) {
      setImageHeaders(res, webMime);
      res.sendFile(absolutePath);
      return;
    }

    // ---
    // Non-web formats — decode to webp with caching.
    // ---
    if (!isPreviewFormat(sourceExt)) {
      res.status(415).json({
        error: `Format "${sourceExt}" is not supported by /api/preview.`,
        supportedFormats: ['heic', 'heif', 'tiff', 'tif', 'psd', 'psb', 'exr'],
      });
      return;
    }

    const previewPath = getPreviewPath(absolutePath, thumbnailDir);
    const previewMime = 'image/webp';

    // Fast path: cached decoded preview already exists.
    if (await fse.pathExists(previewPath)) {
      setImageHeaders(res, previewMime, { cache: true });
      res.sendFile(previewPath);
      return;
    }

    // Decode and cache.
    try {
      console.info(`[images/preview] Decoding ${sourceExt} → webp: ${id}`);
      const { buffer } = await decodeToBuffer(absolutePath, 'webp');
      // Ensure the previews directory exists before writing.
      await fse.ensureDir(path.dirname(previewPath));
      await fse.writeFile(previewPath, buffer);
      console.info(`[images/preview] Cached preview: ${previewPath}`);
    } catch (err) {
      console.error(`[images/preview] Decode failed for ${id}:`, err);
      res.status(500).json({
        error: 'Preview decode failed.',
        detail: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    setImageHeaders(res, previewMime, { cache: true });
    res.sendFile(previewPath);
  });

  return router;
}
