/**
 * Seeded session-stable random ordering (task 2.4,
 * optimize-large-library-performance): stability across refetches, per-item
 * position stability when files are added, reshuffle only on reseed, and
 * fewest-tags-first ordering for tagCountRandom.
 */
import {
  newSeed,
  orderBySeededRank,
  orderByTagCountSeeded,
  orderIdsBySeededRank,
  seededRank,
} from '../src/frontend/stores/seededShuffle';

function makeItems(n: number): { id: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `file-${i}` }));
}

describe('seeded shuffle', () => {
  it('is deterministic for a given seed (stable across refetches)', () => {
    const items = makeItems(500);
    const seed = 12345;
    const a = orderBySeededRank(items, seed).map((f) => f.id);
    const b = orderBySeededRank([...items].reverse(), seed).map((f) => f.id);
    expect(a).toEqual(b); // input order does not matter, only (seed, id)
  });

  it('reshuffles under a different seed', () => {
    const items = makeItems(500);
    const a = orderBySeededRank(items, 1).map((f) => f.id);
    const b = orderBySeededRank(items, 2).map((f) => f.id);
    expect(a).not.toEqual(b);
  });

  it('actually shuffles (not identity order)', () => {
    const items = makeItems(500);
    const shuffled = orderBySeededRank(items, newSeed()).map((f) => f.id);
    expect(shuffled).not.toEqual(items.map((f) => f.id));
    expect([...shuffled].sort()).toEqual(items.map((f) => f.id).sort());
  });

  it('existing items keep their relative positions when new files are added (watcher refetch)', () => {
    const items = makeItems(300);
    const seed = 777;
    const before = orderBySeededRank(items, seed).map((f) => f.id);

    const withNew = [...items, { id: 'new-a' }, { id: 'new-b' }];
    const after = orderBySeededRank(withNew, seed).map((f) => f.id);

    // Removing the new items from the new ordering must yield the old ordering
    // exactly — inserts never displace existing items relative to each other.
    expect(after.filter((id) => !id.startsWith('new-'))).toEqual(before);
  });

  it('orderIdsBySeededRank agrees with orderBySeededRank (id-projection path parity)', () => {
    const items = makeItems(200);
    const seed = 42;
    expect(orderIdsBySeededRank(items.map((f) => f.id), seed)).toEqual(
      orderBySeededRank(items, seed).map((f) => f.id),
    );
  });

  it('tagCountRandom orders by fewest tags first, seeded within equal counts', () => {
    const seed = 9;
    const items = [
      { id: 'a', tags: [1, 2] },
      { id: 'b', tags: [] },
      { id: 'c', tags: [1] },
      { id: 'd', tags: [] },
      { id: 'e', tags: [1, 2, 3] },
    ];
    const ordered = orderByTagCountSeeded(items, seed);
    expect(ordered.map((f) => f.tags.length)).toEqual([0, 0, 1, 2, 3]);
    // Within the equal-count bucket the order follows the seeded rank.
    const zeroBucket = ordered.slice(0, 2).map((f) => f.id);
    const expected = ['b', 'd'].sort((x, y) => seededRank(seed, x) - seededRank(seed, y));
    expect(zeroBucket).toEqual(expected);
  });

  it('ranks are uniform-ish: no catastrophic clustering on sequential ids', () => {
    const ranks = makeItems(1000).map((f) => seededRank(123, f.id));
    const unique = new Set(ranks);
    expect(unique.size).toBe(1000); // no collisions on this input
  });
});
