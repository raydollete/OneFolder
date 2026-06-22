/**
 * Server-side thumbnail generation — INV-034 / TASK-129, extended TASK-131.
 *
 * Wraps Sharp to generate and persist thumbnail images so that:
 *  - TASK-129 can call it for web-format originals (jpg/png/webp/gif/bmp).
 *  - TASK-131 extends it for decoded formats (HEIC/PSD/TIFF/EXR → webp).
 *
 * Also provides getPreviewPath() so image routes can locate the on-disk cache
 * for full-size decoded previews (TASK-131 /api/preview/:id endpoint).
 *
 * Sharp is the same native image library referenced throughout the codebase's
 * investigation notes. It handles resizing without a DOM/Canvas so it works
 * cleanly in a Node server process with no Electron runtime.
 *
 * The output format and max-dimension mirror the desktop build's settings
 * from `common/config.ts` (`thumbnailFormat = 'webp'`, `thumbnailMaxSize = 600`).
 * We hard-code the server-side defaults here rather than importing `config.ts`
 * directly, because `config.ts` reads `process.type` (an Electron-only global)
 * to determine HiDPI pixel ratio — that would throw in a plain Node process.
 */

import path from 'path';
import fse from 'fs-extra';
import sharp from 'sharp';
import type { Sharp as SharpPipeline } from 'sharp';

// ---------------------------------------------------------------------------
// Server-side thumbnail defaults (mirrors common/config.ts desktop values)
// ---------------------------------------------------------------------------

/**
 * Maximum dimension (width or height) for generated thumbnails, in pixels.
 * Mirrors the 96 DPI / non-HiDPI branch in common/config.ts: thumbnailMaxSize = 600.
 */
export const SERVER_THUMBNAIL_MAX_SIZE = 600;

/**
 * Output format for generated thumbnails.
 * Mirrors common/config.ts: thumbnailFormat = 'webp'.
 */
export const SERVER_THUMBNAIL_FORMAT = 'webp' as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a thumbnail from `sourcePath`, write it to `destPath`, and return
 * the number of bytes written.
 *
 * Uses Sharp to resize (fit: inside, no enlargement) and encode to the given
 * `format` ('webp' by default).  The destination directory is created if it
 * does not exist.
 *
 * Callers MUST have already validated that `sourcePath` is inside a registered
 * library location (via path-resolver) before calling this function.
 *
 * TASK-131 can pass a pre-decoded raw-pixel `Buffer` as `sourcePathOrBuffer`
 * instead of a file path so that HEIC/PSD/TIFF/EXR sources — which Sharp may
 * not read natively — can be handled by a specialist decoder whose output is
 * then handed off here for resizing and encoding.
 *
 * @param sourcePathOrBuffer  Absolute path to the source image OR a raw-pixel
 *                             Buffer (for use by TASK-131's specialist decoders).
 * @param destPath            Absolute path where the thumbnail should be written.
 * @param maxSize             Maximum dimension in pixels (default: SERVER_THUMBNAIL_MAX_SIZE).
 * @param format              Output format (default: SERVER_THUMBNAIL_FORMAT).
 * @param rawPixelMeta        When `sourcePathOrBuffer` is a raw-pixel Buffer,
 *                             supply { width, height, channels } so Sharp can
 *                             interpret the bytes correctly.
 * @returns                   The number of bytes written.
 */
export async function generateThumbnail(
  sourcePathOrBuffer: string | Buffer,
  destPath: string,
  maxSize: number = SERVER_THUMBNAIL_MAX_SIZE,
  format: 'webp' | 'jpeg' | 'png' = SERVER_THUMBNAIL_FORMAT,
  rawPixelMeta?: { width: number; height: number; channels: 1 | 2 | 3 | 4 },
): Promise<number> {
  // Ensure the destination directory exists before writing.
  await fse.ensureDir(path.dirname(destPath));

  let pipeline: SharpPipeline;

  if (Buffer.isBuffer(sourcePathOrBuffer)) {
    if (rawPixelMeta) {
      // Raw-pixel input: interpret the buffer as uncompressed RGBA pixels.
      pipeline = sharp(sourcePathOrBuffer, {
        raw: {
          width: rawPixelMeta.width,
          height: rawPixelMeta.height,
          channels: rawPixelMeta.channels,
        },
      });
    } else {
      // Encoded input (e.g. a decoded webp buffer from decodeToBuffer) — pass
      // directly to Sharp which can decode webp/jpeg/png from a Buffer.
      pipeline = sharp(sourcePathOrBuffer);
    }
  } else {
    pipeline = sharp(sourcePathOrBuffer);
  }

  // Resize to fit within maxSize × maxSize, never enlarge smaller images.
  pipeline = pipeline.resize(maxSize, maxSize, {
    fit: 'inside',
    withoutEnlargement: true,
  });

  // Encode to the requested format.
  switch (format) {
    case 'webp':
      pipeline = pipeline.webp({ quality: 80 });
      break;
    case 'jpeg':
      pipeline = pipeline.jpeg({ quality: 85 });
      break;
    case 'png':
      pipeline = pipeline.png({ compressionLevel: 6 });
      break;
  }

  const { size } = await pipeline.toFile(destPath);
  return size;
}

/**
 * Returns true if Sharp can decode the given file extension natively.
 *
 * Sharp / libvips supports: jpeg, png, webp, gif, tiff, avif, heif/heic, svg.
 * This list covers the web formats (TASK-129) and most Phase B formats (TASK-131).
 * EXR is not natively supported by Sharp and requires the WASM decoder path.
 *
 * Note: the extension must be lowercase, without the leading dot.
 */
export function isSharpNativeFormat(ext: string): boolean {
  return [
    'jpg',
    'jpeg',
    'png',
    'webp',
    'gif',
    'tiff',
    'tif',
    'avif',
    'heic',
    'heif',
    'svg',
  ].includes(ext.toLowerCase());
}

// ---------------------------------------------------------------------------
// Preview path helpers (TASK-131)
// ---------------------------------------------------------------------------

/**
 * Returns the on-disk cache path for a full-size decoded preview of `filePath`.
 *
 * Previews are stored in a `previews/` subdirectory alongside the thumbnail
 * directory.  The filename scheme mirrors getThumbnailPath (basename + hash),
 * but uses the '.webp' extension since previews are always encoded as webp.
 *
 * @param filePath      Absolute path to the source image.
 * @param thumbnailDir  Absolute path to the thumbnail cache directory for the
 *                       active library.  The previews/ dir is derived from this
 *                       by replacing the last segment with 'previews'.
 */
export function getPreviewPath(filePath: string, thumbnailDir: string): string {
  const baseFilename = path.basename(filePath, path.extname(filePath));
  const hash = hashFilePath(filePath);
  const previewDir = path.join(path.dirname(thumbnailDir), 'previews');
  return path.join(previewDir, `${baseFilename}-${hash}.webp`);
}

/**
 * Deterministic hash of a file path for use in cache filenames.
 * Mirrors the hashString() function in common/fs.ts so that the preview cache
 * key is consistent with the thumbnail cache key.
 */
function hashFilePath(s: string): number {
  let hash = 0;
  if (s.length === 0) {
    return hash;
  }
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    // eslint-disable-next-line no-bitwise
    hash = ((hash << 5) - hash + chr) | 0;
  }
  return hash;
}
