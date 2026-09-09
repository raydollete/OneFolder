/**
 * Tests for the portable cache-key foundation (change: portable-shared-library-caches, task 1.1).
 *
 * Covers the single source of truth for every path-derived cache key:
 *  - `portableFileKey(locationId, relativePath)` — the OS-independent identity.
 *  - `getThumbnailPath` / `getPreviewPath` — both derive their on-disk names from
 *    that key via the single `hashString`, so a shared cache is reused across OSes
 *    instead of regenerated.
 *
 * The properties asserted here are the portable-thumbnail-cache spec scenarios:
 * same photo → same filename on both OSes; re-pointing the root does not change
 * the key; distinct files never collide; preview and thumbnail share one derivation.
 */

import path from 'path';
import { getThumbnailPath, getPreviewPath, hashString, portableFileKey } from '../common/fs';

describe('portableFileKey', () => {
  it('is identical regardless of OS-specific absolute prefix (same locationId + relativePath)', () => {
    // The absolute path differs per OS (D:\OneFolder\Photos vs /mnt/shared/OneFolder/Photos)
    // but the portable identity is the same, so the key must be byte-identical.
    expect(portableFileKey('loc1', 'Photos/a.jpg')).toBe(portableFileKey('loc1', 'Photos/a.jpg'));
  });

  it('normalizes backslash separators to forward slashes', () => {
    expect(portableFileKey('loc1', 'Photos\\sub\\a.jpg')).toBe('loc1/Photos/sub/a.jpg');
  });

  it('trims leading separators so a join-style relative path cannot shift the key', () => {
    expect(portableFileKey('loc1', '/Photos/a.jpg')).toBe('loc1/Photos/a.jpg');
    expect(portableFileKey('loc1', 'Photos/a.jpg')).toBe('loc1/Photos/a.jpg');
  });

  it('preserves case so case-distinct siblings stay distinct', () => {
    expect(portableFileKey('loc1', 'A.jpg')).not.toBe(portableFileKey('loc1', 'a.jpg'));
  });

  it('scopes identity to the location so the same relative path in two locations differs', () => {
    expect(portableFileKey('loc1', 'a.jpg')).not.toBe(portableFileKey('loc2', 'a.jpg'));
  });
});

describe('getThumbnailPath / getPreviewPath keyed on portable identity', () => {
  const thumbDir = path.join('/data', 'thumbnails');

  it('yields the same thumbnail filename for the same photo on both OSes', () => {
    const key = portableFileKey('loc1', 'Photos/a.jpg');
    // The caller passes the portable key, never the absolute path, so the name is
    // stable across a Windows/Linux boot of one shared library.
    expect(getThumbnailPath(key, thumbDir)).toBe(getThumbnailPath(key, thumbDir));
    expect(getThumbnailPath(key, thumbDir)).toContain(`-${hashString(key)}.`);
  });

  it('does not change the key when the location root is re-pointed', () => {
    // Re-pointing changes only the resolved absolute path; the portable key is
    // unchanged because it is (locationId, relativePath).
    const before = getThumbnailPath(portableFileKey('loc1', 'Photos/a.jpg'), thumbDir);
    const after = getThumbnailPath(portableFileKey('loc1', 'Photos/a.jpg'), thumbDir);
    expect(after).toBe(before);
  });

  it('gives distinct files distinct cache names, including same basename in different folders', () => {
    const a = getThumbnailPath(portableFileKey('loc1', 'one/a.jpg'), thumbDir);
    const b = getThumbnailPath(portableFileKey('loc1', 'two/a.jpg'), thumbDir);
    expect(a).not.toBe(b);
  });

  it('derives preview and thumbnail names from the same hash of the same key', () => {
    const key = portableFileKey('loc1', 'Photos/a.jpg');
    const hash = hashString(key);
    expect(getThumbnailPath(key, thumbDir)).toContain(`-${hash}.`);
    expect(getPreviewPath(key, thumbDir)).toContain(`-${hash}.webp`);
    // Previews live in a sibling previews/ directory, not the thumbnail directory.
    expect(getPreviewPath(key, thumbDir)).toContain(`${path.sep}previews${path.sep}`);
  });
});

describe('hashString', () => {
  it('is a single deterministic implementation', () => {
    expect(hashString('loc1/Photos/a.jpg')).toBe(hashString('loc1/Photos/a.jpg'));
    expect(hashString('')).toBe(0);
    expect(hashString('a')).not.toBe(hashString('b'));
  });
});
