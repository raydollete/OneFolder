/**
 * Tests for the portable thumbnail/preview cache-rename planner
 * (change: portable-shared-library-caches, task 5.1).
 *
 * The planner moves existing cache entries from the legacy absolute-path key to
 * the portable key so an upgraded library is renamed, NOT regenerated. The SQL
 * schema migration itself runs against a real better-sqlite3 DB (not loadable in
 * jest — see tests/path-resolver.test.ts), so it is covered by tsc/build and the
 * manual dual-boot acceptance (task 7.1); the rename DECISION is pure and tested
 * here.
 */

import { getThumbnailPath, getPreviewPath, portableFileKey, hashString } from '../common/fs';
import { planCacheRenames } from '../src/frontend/stores/portableCacheMigration';

const thumbDir = '/data/thumbnails';

function file(locationId: string, relativePath: string, absolutePath: string) {
  return { locationId, relativePath, absolutePath };
}

describe('planCacheRenames', () => {
  it('renames an existing legacy-keyed thumbnail to its portable-key name (rename, not regenerate)', () => {
    const f = file('loc1', 'Photos/a.jpg', 'D:\\OneFolder\\Photos\\a.jpg');
    const legacyThumb = getThumbnailPath(f.absolutePath, thumbDir);
    const existing = new Set([legacyThumb]); // only the legacy entry is on disk

    const renames = planCacheRenames(
      [f],
      thumbDir,
      [getThumbnailPath, getPreviewPath],
      portableFileKey,
      (p) => existing.has(p),
    );

    const portableThumb = getThumbnailPath(portableFileKey('loc1', 'Photos/a.jpg'), thumbDir);
    expect(renames).toContainEqual({ from: legacyThumb, to: portableThumb });
    // The hash actually changes (absolutePath key → portable key).
    expect(legacyThumb).not.toBe(portableThumb);
  });

  it('is destination-exists-safe: does not clobber a portable-key entry the other OS already wrote', () => {
    const f = file('loc1', 'Photos/a.jpg', 'D:\\OneFolder\\Photos\\a.jpg');
    const legacyThumb = getThumbnailPath(f.absolutePath, thumbDir);
    const portableThumb = getThumbnailPath(portableFileKey('loc1', 'Photos/a.jpg'), thumbDir);
    // BOTH exist: the legacy one and the already-migrated portable one.
    const existing = new Set([legacyThumb, portableThumb]);

    const renames = planCacheRenames(
      [f],
      thumbDir,
      [getThumbnailPath],
      portableFileKey,
      (p) => existing.has(p),
    );
    expect(renames).toHaveLength(0);
  });

  it('is best-effort: leaves an entry whose legacy source is missing (regenerates lazily)', () => {
    const f = file('loc1', 'Photos/a.jpg', 'D:\\OneFolder\\Photos\\a.jpg');
    const renames = planCacheRenames(
      [f],
      thumbDir,
      [getThumbnailPath, getPreviewPath],
      portableFileKey,
      () => false, // nothing on disk
    );
    expect(renames).toHaveLength(0);
  });

  it('is idempotent: after a rename, re-running finds no legacy source and does nothing', () => {
    const f = file('loc1', 'Photos/a.jpg', 'D:\\OneFolder\\Photos\\a.jpg');
    const portableThumb = getThumbnailPath(portableFileKey('loc1', 'Photos/a.jpg'), thumbDir);
    // Post-migration state: only the portable-key entry exists.
    const existing = new Set([portableThumb]);
    const renames = planCacheRenames(
      [f],
      thumbDir,
      [getThumbnailPath],
      portableFileKey,
      (p) => existing.has(p),
    );
    expect(renames).toHaveLength(0);
  });

  it('plans both thumbnail and preview renames when both legacy entries exist', () => {
    const f = file('loc1', 'a.jpg', '/mnt/x/a.jpg');
    const legacyThumb = getThumbnailPath(f.absolutePath, thumbDir);
    const legacyPreview = getPreviewPath(f.absolutePath, thumbDir);
    const existing = new Set([legacyThumb, legacyPreview]);

    const renames = planCacheRenames(
      [f],
      thumbDir,
      [getThumbnailPath, getPreviewPath],
      portableFileKey,
      (p) => existing.has(p),
    );
    const key = portableFileKey('loc1', 'a.jpg');
    expect(renames).toContainEqual({ from: legacyThumb, to: getThumbnailPath(key, thumbDir) });
    expect(renames).toContainEqual({ from: legacyPreview, to: getPreviewPath(key, thumbDir) });
    expect(renames).toHaveLength(2);
  });

  it('skips a file whose legacy absolutePath already equals its portable key', () => {
    // Degenerate case: absolutePath already IS the portable key (no legacy cache to move).
    const key = portableFileKey('loc1', 'a.jpg');
    const f = file('loc1', 'a.jpg', key);
    const existing = new Set([getThumbnailPath(key, thumbDir)]);
    const renames = planCacheRenames(
      [f],
      thumbDir,
      [getThumbnailPath],
      portableFileKey,
      (p) => existing.has(p),
    );
    expect(renames).toHaveLength(0);
    // Sanity: the two keys are genuinely equal here.
    expect(hashString(f.absolutePath)).toBe(hashString(key));
  });
});
