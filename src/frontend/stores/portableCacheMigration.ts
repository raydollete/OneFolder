/**
 * Pure planner for the one-time thumbnail/preview cache rename
 * (change: portable-shared-library-caches, task 5.1).
 *
 * Existing cache entries were named from the legacy per-OS absolute-path key.
 * This computes the rename operations to move each to its new portable-key name
 * so an existing library of thousands of entries is NOT regenerated — it is
 * renamed in place. The plan is:
 *   - best-effort: an entry whose legacy file is gone (source missing) is left
 *     for lazy regeneration rather than touched;
 *   - destination-exists-safe: if the portable-key name already exists (e.g. the
 *     other OS of a shared `data/` already renamed it), the legacy entry is left
 *     alone rather than clobbering the destination;
 *   - idempotent: once renamed, a re-run finds no legacy source and does nothing.
 *
 * Kept free of the platform layer (all filesystem/path/key operations are
 * injected) so it is unit-testable without a real filesystem.
 */

export interface CacheRenameSourceFile {
  locationId: string;
  relativePath: string;
  /**
   * The file's LEGACY stored absolutePath — the key the existing cache entry was
   * named from (the OS that created the row/thumbnail). NOT the current-OS
   * recomputed path.
   */
  absolutePath: string;
}

export interface CacheRename {
  from: string;
  to: string;
}

/**
 * Compute the set of cache-file renames (thumbnails and previews) needed to move
 * every file's cache entry from its legacy absolute-path-keyed name to its
 * portable-key name.
 *
 * @param files          Files with their legacy absolutePath and portable identity.
 * @param thumbnailDir   The active thumbnail cache directory.
 * @param cachePathFns   Name builders (getThumbnailPath, getPreviewPath) — each
 *                       maps (cacheKey, thumbnailDir) → on-disk path.
 * @param portableKeyOf  portableFileKey(locationId, relativePath).
 * @param exists         Synchronous existence check for a cache path.
 */
export function planCacheRenames(
  files: readonly CacheRenameSourceFile[],
  thumbnailDir: string,
  cachePathFns: ReadonlyArray<(cacheKey: string, thumbnailDir: string) => string>,
  portableKeyOf: (locationId: string, relativePath: string) => string,
  exists: (path: string) => boolean,
): CacheRename[] {
  const renames: CacheRename[] = [];
  for (const f of files) {
    const newKey = portableKeyOf(f.locationId, f.relativePath);
    // If the legacy key already equals the portable key there is nothing to move.
    if (f.absolutePath === newKey) {
      continue;
    }
    for (const cachePath of cachePathFns) {
      const from = cachePath(f.absolutePath, thumbnailDir);
      const to = cachePath(newKey, thumbnailDir);
      if (from === to) {
        continue;
      }
      if (exists(from) && !exists(to)) {
        renames.push({ from, to });
      }
    }
  }
  return renames;
}
