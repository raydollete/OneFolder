/**
 * Round-trip tests for the LocationDTO portable anchor (change:
 * portable-shared-library-caches, task 1.3).
 *
 * The anchor segment must survive a serialize → persist → read cycle, and an
 * unanchored location must round-trip with no `portableRoot` at all.
 *
 * These go through the real persistence write path (the Dexie backend's
 * createLocation/saveLocation via fake-indexeddb, which stores the whole
 * LocationDTO object) and read back by primary key. Notes on why the seams are
 * what they are:
 *   - The ClientLocation entity's serialize()/constructor field mapping is
 *     type-checked by tsc but cannot be imported here: entities/Location.ts has
 *     a transitive `import.meta` that ts-jest's CommonJS target cannot parse
 *     (the same reason location-reconciliation.test.ts avoids importing it).
 *   - Backend.fetchLocations() uses orderBy('dateAdded'), whose index is not
 *     materialized under fake-indexeddb, so we read back by primary key.
 */

import Dexie from 'dexie';
import Backend from '../src/backend/backend';
import { dbInit } from '../src/backend/config';
import type { LocationDTO } from '../src/api/location';

let counter = 0;

async function makeBackendAndDb(): Promise<{ backend: Backend; db: Dexie }> {
  const db = dbInit(`Test_anchor_${counter++}`);
  const backend = await Backend.init(db, () => undefined);
  return { backend, db };
}

function readLocation(db: Dexie, id: string): Promise<LocationDTO | undefined> {
  return db.table('locations').get(id) as Promise<LocationDTO | undefined>;
}

function locationDTO(overrides: Partial<LocationDTO>): LocationDTO {
  return {
    id: 'loc1',
    path: '/mnt/shared/OneFolder/Photos',
    dateAdded: new Date(0),
    subLocations: [],
    index: 0,
    ...overrides,
  };
}

describe('LocationDTO portable anchor round-trip (persistence)', () => {
  it('persists and reads back the anchor segment', async () => {
    const { backend, db } = await makeBackendAndDb();
    await backend.createLocation(locationDTO({ id: 'anchored', portableRoot: 'Photos' }));

    const loc = await readLocation(db, 'anchored');
    expect(loc?.portableRoot).toBe('Photos');
  });

  it('preserves an empty-string segment (anchored at the portable root itself)', async () => {
    const { backend, db } = await makeBackendAndDb();
    await backend.createLocation(locationDTO({ id: 'root-anchored', portableRoot: '' }));

    const loc = await readLocation(db, 'root-anchored');
    expect(loc?.portableRoot).toBe('');
  });

  it('leaves unanchored locations without a portableRoot', async () => {
    const { backend, db } = await makeBackendAndDb();
    await backend.createLocation(locationDTO({ id: 'external', path: 'E:\\Archive' }));

    const loc = await readLocation(db, 'external');
    expect(loc).toBeDefined();
    expect(loc?.portableRoot).toBeUndefined();
  });

  it('round-trips the anchor through saveLocation (update) as well as create', async () => {
    const { backend, db } = await makeBackendAndDb();
    await backend.createLocation(locationDTO({ id: 'l', portableRoot: 'A' }));
    await backend.saveLocation(locationDTO({ id: 'l', portableRoot: 'A/B' }));

    const loc = await readLocation(db, 'l');
    expect(loc?.portableRoot).toBe('A/B');
  });
});
