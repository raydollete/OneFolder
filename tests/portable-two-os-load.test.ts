/**
 * Integration test (change: portable-shared-library-caches, task 6.1).
 *
 * Simulates opening ONE shared library under two different resolved location
 * roots — a Windows `D:\OneFolder\Photos` build opened on Linux at
 * `/mnt/shared/OneFolder/Photos` — and asserts the whole-change contract at the
 * seam the app actually uses (the pure identity/recompute/cache helpers):
 *   - reconciliation on the durable identity yields ZERO created and ZERO missing
 *     rows (whereas the old absolutePath keying would flag the entire library);
 *   - thumbnail/preview cache names are reused (identical) across the two roots;
 *   - case-distinct siblings stay distinct on a case-sensitive shared tree.
 *
 * The SQLite backend and the ClientLocation/File entities are not loadable under
 * jest (native better-sqlite3; a transitive `import.meta`), so this exercises the
 * same pure helpers those layers delegate to; the real end-to-end run is the
 * manual dual-boot acceptance (task 7.1).
 */

import type { FileDTO } from '../src/api/file';
import { normalizePathIdentity } from '../src/frontend/platform';
import { getThumbnailPath, getPreviewPath, portableFileKey } from '../common/fs';
import { recomputeAbsolutePaths, fileIdentityKey } from '../src/frontend/stores/locationReconciliation';

const LOC = 'loc1';
const WIN_ROOT = 'D:\\OneFolder\\Photos';
const LINUX_ROOT = '/mnt/shared/OneFolder/Photos';

// The photos in the shared location (relativePaths are OS-independent).
const RELATIVE_PATHS = ['a.jpg', 'sub/b.jpg', 'sub/deep/c.png'];

const winJoin = (root: string, rel: string) => `${root}\\${rel.replace(/\//g, '\\')}`;
const posixJoin = (root: string, rel: string) => `${root}/${rel}`;

function makeDTO(relativePath: string, absolutePath: string): FileDTO {
  return {
    id: `${LOC}:${relativePath}`,
    ino: `ino-${relativePath}`,
    locationId: LOC,
    relativePath,
    absolutePath,
    name: relativePath.split('/').pop() ?? relativePath,
    extension: 'jpg',
    size: 1,
    width: 1,
    height: 1,
    dateAdded: new Date(0),
    dateModified: new Date(0),
    dateCreated: new Date(0),
    dateLastIndexed: new Date(0),
    tags: [],
    annotations: '',
  } as FileDTO;
}

// Case-sensitive policy (Linux shared tree).
const norm = (p: string) => normalizePathIdentity(p, false);
const idKey = (locationId: string, relativePath: string) =>
  fileIdentityKey(locationId, relativePath, norm);

describe('opening one shared library under two resolved roots (task 6.1)', () => {
  // Rows as WRITTEN on Windows (stored absolutePath is a D:\ path).
  const storedWindows = RELATIVE_PATHS.map((rel) => makeDTO(rel, winJoin(WIN_ROOT, rel)));

  // On Linux the location resolves to LINUX_ROOT; hydration recomputes the
  // derived absolutePath from that resolved root.
  const onLinux = recomputeAbsolutePaths(storedWindows, (_loc, rel) => posixJoin(LINUX_ROOT, rel));

  // The files present on the Linux disk (same photos, Linux absolute paths).
  const diskOnLinux = RELATIVE_PATHS.map((rel) => posixJoin(LINUX_ROOT, rel));

  it('recomputes each absolutePath onto the current-OS resolved root', () => {
    expect(onLinux.map((f) => f.absolutePath)).toEqual([
      '/mnt/shared/OneFolder/Photos/a.jpg',
      '/mnt/shared/OneFolder/Photos/sub/b.jpg',
      '/mnt/shared/OneFolder/Photos/sub/deep/c.png',
    ]);
  });

  it('identity-keyed reconciliation reports ZERO created and ZERO missing across the OS switch', () => {
    const dbKeys = new Set(onLinux.map((f) => idKey(f.locationId, f.relativePath)));
    // Disk files keyed by the SAME identity (relativePath derived from the root).
    const diskKeys = diskOnLinux.map((abs) => idKey(LOC, abs.slice(LINUX_ROOT.length + 1)));

    const created = diskKeys.filter((k) => !dbKeys.has(k));
    const missing = [...dbKeys].filter((k) => !new Set(diskKeys).has(k));

    expect(created).toEqual([]);
    expect(missing).toEqual([]);
  });

  it('the OLD absolutePath keying WOULD have doubled the library (regression guard)', () => {
    // Demonstrates the defect the change fixes: keying on the stored (Windows)
    // absolutePath vs the Linux disk paths, everything mismatches.
    const dbAbs = new Set(storedWindows.map((f) => f.absolutePath));
    const createdUnderOldKeying = diskOnLinux.filter((abs) => !dbAbs.has(abs));
    expect(createdUnderOldKeying).toHaveLength(RELATIVE_PATHS.length); // all "created"
  });

  it('reuses thumbnail and preview cache names across both roots (no regeneration)', () => {
    for (const rel of RELATIVE_PATHS) {
      const key = portableFileKey(LOC, rel);
      // The cache name depends only on the portable key, not the resolved root,
      // so Windows and Linux compute the SAME file name → the cache is reused.
      const winFile = storedWindows.find((f) => f.relativePath === rel)!;
      const linuxFile = onLinux.find((f) => f.relativePath === rel)!;
      const winKey = portableFileKey(winFile.locationId, winFile.relativePath);
      const linuxKey = portableFileKey(linuxFile.locationId, linuxFile.relativePath);
      expect(winKey).toBe(key);
      expect(linuxKey).toBe(key);
      expect(getThumbnailPath(winKey, '/data/thumbnails')).toBe(
        getThumbnailPath(linuxKey, '/data/thumbnails'),
      );
      expect(getPreviewPath(winKey, '/data/thumbnails')).toBe(
        getPreviewPath(linuxKey, '/data/thumbnails'),
      );
    }
  });

  it('keeps case-distinct siblings distinct on a case-sensitive shared tree', () => {
    const upper = makeDTO('Holiday.jpg', winJoin(WIN_ROOT, 'Holiday.jpg'));
    const lower = makeDTO('holiday.jpg', winJoin(WIN_ROOT, 'holiday.jpg'));
    expect(idKey(upper.locationId, upper.relativePath)).not.toBe(
      idKey(lower.locationId, lower.relativePath),
    );
    // And their cache entries are distinct too.
    expect(getThumbnailPath(portableFileKey(LOC, 'Holiday.jpg'), '/t')).not.toBe(
      getThumbnailPath(portableFileKey(LOC, 'holiday.jpg'), '/t'),
    );
  });
});
