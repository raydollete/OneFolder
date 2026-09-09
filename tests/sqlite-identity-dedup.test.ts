/**
 * Tests for createFilesFromPath's identity-keyed dedup (change:
 * portable-shared-library-caches, task 2.1).
 *
 * The dedup decision is extracted into the pure `dedupeNewFilesByIdentity` so it
 * can be unit-tested: better-sqlite3 is a native module that does not load in
 * the jest environment (see tests/path-resolver.test.ts), so the SQL around it
 * is verified by tsc/build and the manual dual-boot acceptance (task 7.1).
 *
 * The property under test is the fix for the cross-boot duplication defect: dedup
 * must key on (locationId, relativePath), so files whose stored absolutePath is
 * from the "other OS" are recognized as already present and NOT re-inserted.
 */

import { dedupeNewFilesByIdentity } from '../src/backend/sqlite-backend';
import type { FileDTO } from '../src/api/file';

function file(locationId: string, relativePath: string, absolutePath: string): FileDTO {
  return {
    id: `${locationId}:${relativePath}`,
    ino: '0',
    locationId,
    relativePath,
    absolutePath,
    name: relativePath,
    extension: 'jpg',
    size: 1,
    width: 1,
    height: 1,
    dateAdded: new Date(0),
    dateModified: new Date(0),
    dateCreated: new Date(0),
    dateLastIndexed: new Date(0),
    annotations: '',
    tags: [],
  } as FileDTO;
}

describe('dedupeNewFilesByIdentity', () => {
  it('skips files whose (locationId, relativePath) is already present, ignoring per-OS absolutePath', () => {
    // Existing row was written on Windows: identity loc1 / Photos/a.jpg.
    const existing = new Set(['loc1/Photos/a.jpg']);
    // On Linux the same file arrives with a different absolutePath but the same identity.
    const incoming = [file('loc1', 'Photos/a.jpg', '/mnt/shared/OneFolder/Photos/a.jpg')];

    expect(dedupeNewFilesByIdentity(incoming, existing)).toHaveLength(0);
  });

  it('inserts files whose identity is new', () => {
    const existing = new Set(['loc1/Photos/a.jpg']);
    const incoming = [
      file('loc1', 'Photos/a.jpg', '/x/Photos/a.jpg'), // dup
      file('loc1', 'Photos/b.jpg', '/x/Photos/b.jpg'), // new
    ];
    const kept = dedupeNewFilesByIdentity(incoming, existing);
    expect(kept.map((f) => f.relativePath)).toEqual(['Photos/b.jpg']);
  });

  it('collapses duplicates within the same batch', () => {
    const incoming = [
      file('loc1', 'a.jpg', '/x/a.jpg'),
      file('loc1', 'a.jpg', '/y/a.jpg'), // same identity, different absolutePath
    ];
    expect(dedupeNewFilesByIdentity(incoming, new Set())).toHaveLength(1);
  });

  it('keeps same relativePath in different locations distinct', () => {
    const incoming = [file('loc1', 'a.jpg', '/l1/a.jpg'), file('loc2', 'a.jpg', '/l2/a.jpg')];
    expect(dedupeNewFilesByIdentity(incoming, new Set())).toHaveLength(2);
  });

  it('keeps case-distinct siblings distinct (no folding in the key)', () => {
    const incoming = [file('loc1', 'A.jpg', '/x/A.jpg'), file('loc1', 'a.jpg', '/x/a.jpg')];
    expect(dedupeNewFilesByIdentity(incoming, new Set())).toHaveLength(2);
  });
});
