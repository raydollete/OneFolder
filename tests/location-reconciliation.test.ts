/**
 * Map-indexed reconciliation matchers (task 2.1,
 * optimize-large-library-performance): created/missing/moved/renamed cases,
 * with semantics equivalent to the former nested-.find() implementation.
 */
import { FileDTO } from '../src/api/file';
import {
  areFilesIdenticalBesidesName,
  buildDbFilesByCreatedDate,
  matchMissingToCreated,
  matchMissingToDbDuplicates,
  recomputeAbsolutePaths,
} from '../src/frontend/stores/locationReconciliation';
// Task 2.2: LocationStore's suppression/ingest matching and relativePath prefix
// stripping all route through the shared platform path-identity seam. LocationStore
// itself cannot be imported here (a transitive `import.meta` in entities/Location.ts
// breaks ts-jest's CommonJS module target — which is why this suite already imports
// only the lightweight locationReconciliation module), so we exercise the SAME shared
// seam the consumer delegates to.
import { normalizePathIdentity } from '../src/frontend/platform';

let inoCounter = 0;
function makeDTO(overrides: Partial<FileDTO> = {}): FileDTO {
  const id = overrides.id ?? `f${++inoCounter}`;
  return {
    id,
    ino: `ino-${id}`,
    locationId: 'loc1',
    relativePath: `${id}.jpg`,
    absolutePath: `/photos/${id}.jpg`,
    name: `${id}.jpg`,
    extension: 'jpg',
    size: 1000,
    width: 640,
    height: 480,
    dateAdded: new Date(1000),
    dateModified: new Date(1000),
    dateCreated: new Date(1000),
    dateLastIndexed: new Date(1000),
    tags: [],
    annotations: '',
    ...overrides,
  } as FileDTO;
}

describe('locationReconciliation matchers', () => {
  it('matches a moved file by ino', () => {
    const missing = [makeDTO({ id: 'old', ino: 'shared-ino' })];
    const created = [
      makeDTO({ id: 'other', ino: 'x', width: 1, height: 1 }),
      makeDTO({ id: 'moved', ino: 'shared-ino', width: 999, height: 999, dateCreated: new Date(5) }),
    ];
    const matches = matchMissingToCreated(missing, created);
    expect(matches[0]?.id).toBe('moved');
  });

  it('matches a renamed file by dimensions + creation date when ino differs', () => {
    const t = new Date(123456);
    const missing = [makeDTO({ id: 'old', ino: 'a', width: 800, height: 600, dateCreated: t })];
    const created = [
      makeDTO({ id: 'unrelated', ino: 'b', width: 100, height: 100, dateCreated: t }),
      makeDTO({ id: 'renamed', ino: 'c', width: 800, height: 600, dateCreated: t }),
    ];
    const matches = matchMissingToCreated(missing, created);
    expect(matches[0]?.id).toBe('renamed');
  });

  it('returns undefined for a genuinely deleted file', () => {
    const missing = [makeDTO({ id: 'gone', ino: 'z', width: 10, height: 10 })];
    const created = [makeDTO({ id: 'new', ino: 'y', width: 20, height: 20 })];
    expect(matchMissingToCreated(missing, created)[0]).toBeUndefined();
  });

  it('preserves first-in-created-order semantics when multiple candidates match', () => {
    const t = new Date(9);
    const missing = [makeDTO({ id: 'old', ino: 'nope', width: 5, height: 5, dateCreated: t })];
    // Both created files are identical besides name; the FIRST in array order wins,
    // exactly like the former createdFiles.find(...).
    const created = [
      makeDTO({ id: 'first', ino: 'c1', width: 5, height: 5, dateCreated: t }),
      makeDTO({ id: 'second', ino: 'c2', width: 5, height: 5, dateCreated: t }),
    ];
    expect(matchMissingToCreated(missing, created)[0]?.id).toBe('first');
  });

  it('equivalence with the brute-force nested .find on a randomized workload', () => {
    const dates = [new Date(1), new Date(2), new Date(3)];
    const rand = (n: number) => Math.floor(Math.random() * n);
    const missing = Array.from({ length: 60 }, (_, i) =>
      makeDTO({
        id: `m${i}`,
        ino: `mi${rand(20)}`,
        width: rand(4),
        height: rand(4),
        dateCreated: dates[rand(3)],
      }),
    );
    const created = Array.from({ length: 60 }, (_, i) =>
      makeDTO({
        id: `c${i}`,
        ino: `mi${rand(20)}`,
        width: rand(4),
        height: rand(4),
        dateCreated: dates[rand(3)],
      }),
    );
    const expected = missing.map((mf) =>
      created.find((cf) => areFilesIdenticalBesidesName(cf, mf)),
    );
    expect(matchMissingToCreated(missing, created)).toEqual(expected);
  });

  it('finds a db duplicate (renamed file already re-ingested) and skips created-matched files', () => {
    const t = new Date(55);
    const missingMatched = makeDTO({ id: 'matched', width: 1, height: 1, dateCreated: t });
    const missingDup = makeDTO({ id: 'dup-old', ino: 'q', width: 7, height: 7, dateCreated: t });
    const dbTwin = makeDTO({ id: 'dup-new', ino: 'r', width: 7, height: 7, dateCreated: t });

    const dbIndex = buildDbFilesByCreatedDate([missingMatched, missingDup, dbTwin]);
    const result = matchMissingToDbDuplicates(
      [missingMatched, missingDup],
      [makeDTO({ id: 'created-match' }), undefined],
      dbIndex,
    );
    expect(result[0]).toBe(false); // created-matched → skipped
    expect((result[1] as FileDTO)?.id).toBe('dup-new');
  });

  it('prefers the same-name db duplicate over a name-changed one', () => {
    const t = new Date(77);
    const missing = makeDTO({ id: 'old', name: 'holiday.jpg', width: 3, height: 3, dateCreated: t });
    const otherName = makeDTO({ id: 'twin-a', name: 'other.jpg', width: 3, height: 3, dateCreated: t });
    const sameName = makeDTO({ id: 'twin-b', name: 'holiday.jpg', width: 3, height: 3, dateCreated: t });

    const dbIndex = buildDbFilesByCreatedDate([missing, otherName, sameName]);
    const result = matchMissingToDbDuplicates([missing], [undefined], dbIndex);
    expect((result[0] as FileDTO)?.id).toBe('twin-b');
  });
});

// ---------------------------------------------------------------------------
// LocationStore path-identity policy (Task 2.2, add-portable-linux-appimage)
//
// LocationStore.normalizePath (suppress/unsuppress ingest keys), ingestFile's
// row-matching, and relativePathFromLocation's prefix stripping all route
// through platform.path.normalizePathIdentity, which delegates to the shared
// `normalizePathIdentity(p, foldCase)` helper exercised below with each policy.
// ---------------------------------------------------------------------------

describe('LocationStore path-identity (shared seam policy)', () => {
  describe('POSIX / Linux policy (case-sensitive)', () => {
    it('folds separators so suppression keys survive a `/` vs `\\` mismatch', () => {
      // suppressIngest(win-style path) must match a folder-watcher `/` path.
      expect(normalizePathIdentity('X:\\live stream\\clip.mp4', false)).toBe(
        normalizePathIdentity('X:/live stream/clip.mp4', false),
      );
    });

    it('keeps case-distinct ingest paths DISTINCT (Clip.mp4 !== clip.mp4)', () => {
      expect(normalizePathIdentity('/library/Clip.mp4', false)).not.toBe(
        normalizePathIdentity('/library/clip.mp4', false),
      );
    });

    it('treats a location prefix as a real prefix (relativePath stripping) case-sensitively', () => {
      const loc = '/home/user/Photos';
      const file = '/home/user/Photos/2024/Clip.mp4';
      const locId = normalizePathIdentity(loc, false);
      const fileId = normalizePathIdentity(file, false);
      // Correct-case prefix matches → relativePath would be sliced from the original.
      expect(fileId.startsWith(locId + '/')).toBe(true);
      // A case-mismatched location is NOT a prefix on Linux → falls back to basename.
      expect(normalizePathIdentity(file, false).startsWith('/home/user/photos/')).toBe(false);
    });
  });

  describe('Windows policy (case-insensitive)', () => {
    it('matches case + separator variants for suppression/ingest keys', () => {
      expect(normalizePathIdentity('X:\\Live Stream\\Clip.mp4', true)).toBe(
        normalizePathIdentity('x:/live stream/clip.mp4', true),
      );
    });

    it('treats a case-mismatched location as a valid prefix', () => {
      const loc = 'C:\\Users\\Foo\\Photos';
      const file = 'C:/users/foo/photos/2024/clip.mp4';
      const locId = normalizePathIdentity(loc, true);
      const fileId = normalizePathIdentity(file, true);
      expect(fileId.startsWith(locId + '/')).toBe(true);
    });
  });
});

describe('recomputeAbsolutePaths (task 2.2 — derived per-OS absolutePath)', () => {
  // Emulate platform.path.join for POSIX and Windows resolved roots.
  const roots: Record<string, string> = {
    loc1: '/mnt/shared/OneFolder/Photos', // current OS (Linux)
  };
  const resolve = (locationId: string, relativePath: string): string | undefined => {
    const root = roots[locationId];
    return root ? `${root}/${relativePath}` : undefined;
  };

  it('rebases a stored other-OS absolutePath onto the resolved current-OS root', () => {
    // Row was written on Windows: absolutePath is a D:\ path, identity is loc1 / a/b.jpg.
    const stored = makeDTO({
      id: 'x',
      locationId: 'loc1',
      relativePath: 'a/b.jpg',
      absolutePath: 'D:\\OneFolder\\Photos\\a\\b.jpg',
    });
    const [out] = recomputeAbsolutePaths([stored], resolve);
    expect(out.absolutePath).toBe('/mnt/shared/OneFolder/Photos/a/b.jpg');
    // Identity fields are untouched.
    expect(out.relativePath).toBe('a/b.jpg');
    expect(out.locationId).toBe('loc1');
  });

  it('returns the same object reference when already consistent (no allocation churn)', () => {
    const stored = makeDTO({
      id: 'y',
      locationId: 'loc1',
      relativePath: 'a/b.jpg',
      absolutePath: '/mnt/shared/OneFolder/Photos/a/b.jpg',
    });
    const [out] = recomputeAbsolutePaths([stored], resolve);
    expect(out).toBe(stored);
  });

  it('leaves files of an unknown/unresolved location untouched', () => {
    const stored = makeDTO({ id: 'z', locationId: 'gone', absolutePath: 'D:\\x.jpg' });
    const [out] = recomputeAbsolutePaths([stored], resolve);
    expect(out).toBe(stored);
    expect(out.absolutePath).toBe('D:\\x.jpg');
  });
});

import {
  computeAnchorSegment,
  resolveAnchoredPath,
  fileIdentityKey,
} from '../src/frontend/stores/locationReconciliation';

describe('fileIdentityKey (task 3.2 — portable reconciliation identity)', () => {
  const posix = (p: string) => normalizePathIdentity(p, false); // case-sensitive
  const win = (p: string) => normalizePathIdentity(p, true); // case-insensitive

  it('is identical across OSes for the same (locationId, relativePath), regardless of absolutePath', () => {
    // The two rows below would have DIFFERENT absolutePath per OS; the identity
    // key must be the same so neither is flagged created or missing.
    expect(fileIdentityKey('loc1', '/Photos/a.jpg', posix)).toBe(
      fileIdentityKey('loc1', 'Photos/a.jpg', posix),
    );
  });

  it('distinguishes different relativePaths and different locations', () => {
    expect(fileIdentityKey('loc1', 'a.jpg', posix)).not.toBe(fileIdentityKey('loc1', 'b.jpg', posix));
    expect(fileIdentityKey('loc1', 'a.jpg', posix)).not.toBe(fileIdentityKey('loc2', 'a.jpg', posix));
  });

  it('keeps case-distinct siblings distinct on a case-sensitive filesystem', () => {
    expect(fileIdentityKey('loc1', 'A.jpg', posix)).not.toBe(fileIdentityKey('loc1', 'a.jpg', posix));
  });

  it('folds case on a case-insensitive filesystem (Windows policy)', () => {
    expect(fileIdentityKey('loc1', 'Photos/A.jpg', win)).toBe(
      fileIdentityKey('loc1', 'photos/a.jpg', win),
    );
  });
});

describe('computeAnchorSegment (task 3.1 — auto-anchor under the portable dir)', () => {
  const posix = (p: string) => normalizePathIdentity(p, false); // case-sensitive
  const win = (p: string) => normalizePathIdentity(p, true); // case-insensitive

  it('returns the root-relative segment for a path under the portable dir (POSIX)', () => {
    expect(computeAnchorSegment('/mnt/shared/OneFolder', '/mnt/shared/OneFolder/Photos', posix)).toBe(
      'Photos',
    );
    expect(
      computeAnchorSegment('/mnt/shared/OneFolder', '/mnt/shared/OneFolder/a/b/c', posix),
    ).toBe('a/b/c');
  });

  it('preserves real on-disk case in the segment even when the prefix matches case-insensitively (Windows)', () => {
    // portable dir cased differently from the actual path; Windows folds case for
    // the prefix test, but the returned segment keeps the true case for resolution.
    expect(computeAnchorSegment('D:\\OneFolder', 'd:\\onefolder\\Photos', win)).toBe('Photos');
  });

  it('returns empty string when the path IS the portable dir', () => {
    expect(computeAnchorSegment('/mnt/shared/OneFolder', '/mnt/shared/OneFolder', posix)).toBe('');
  });

  it('returns undefined for a path outside the portable dir (external drive)', () => {
    expect(computeAnchorSegment('/mnt/shared/OneFolder', '/media/usb/Archive', posix)).toBeUndefined();
    // Case-sensitive: a case-mismatched prefix is NOT under the portable dir on POSIX.
    expect(
      computeAnchorSegment('/mnt/shared/OneFolder', '/mnt/shared/onefolder/Photos', posix),
    ).toBeUndefined();
  });
});

describe('resolveAnchoredPath (task 3.1 — per-OS root resolution)', () => {
  const join = (...s: string[]) => s.join('/');

  it('joins the portable dir with the segment when anchored', () => {
    expect(resolveAnchoredPath('/mnt/shared/OneFolder', 'D:\\OneFolder\\Photos', 'Photos', join)).toBe(
      '/mnt/shared/OneFolder/Photos',
    );
  });

  it('returns the portable dir itself for an empty segment', () => {
    expect(resolveAnchoredPath('/mnt/shared/OneFolder', 'ignored', '', join)).toBe(
      '/mnt/shared/OneFolder',
    );
  });

  it('keeps the stored absolute path when unanchored (no segment)', () => {
    expect(resolveAnchoredPath('/mnt/shared/OneFolder', '/media/usb/Archive', undefined, join)).toBe(
      '/media/usb/Archive',
    );
  });

  it('keeps the stored absolute path when the portable dir is unknown', () => {
    expect(resolveAnchoredPath(undefined, 'D:\\OneFolder\\Photos', 'Photos', join)).toBe(
      'D:\\OneFolder\\Photos',
    );
  });
});
