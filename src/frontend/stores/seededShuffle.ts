/**
 * Session-stable seeded ordering for the "random" sort modes.
 *
 * Instead of `ORDER BY RANDOM()` (an unindexed full-table sort in SQL that
 * reshuffles on every refetch), each file gets a deterministic pseudo-random
 * rank derived from (seed, file id). Sorting by that rank:
 * - is stable across refetches within a session (existing items keep their
 *   positions; new items insert at their own rank without displacing others),
 * - reshuffles only when the seed changes (explicit re-selection of random
 *   order, or a new session).
 *
 * See openspec/specs/large-library-performance (Requirement: Random ordering
 * is session-stable...).
 */

/** FNV-1a 32-bit hash of a string, mixed with a numeric seed and avalanched. */
export function seededRank(seed: number, id: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Final avalanche (murmur3 fmix32) so similar ids spread uniformly.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A fresh random 32-bit seed (used once per session / explicit reshuffle). */
export function newSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
}

/** Orders items with an `id` by seeded rank (ties broken by id for determinism). */
export function orderBySeededRank<T extends { id: string }>(
  items: readonly T[],
  seed: number,
): T[] {
  return items
    .map((item) => ({ item, rank: seededRank(seed, item.id) }))
    .sort((a, b) => a.rank - b.rank || (a.item.id < b.item.id ? -1 : 1))
    .map((e) => e.item);
}

/** Orders plain id strings by seeded rank (used by the id-projection fetch path). */
export function orderIdsBySeededRank(ids: readonly string[], seed: number): string[] {
  return ids
    .map((id) => ({ id, rank: seededRank(seed, id) }))
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : 1))
    .map((e) => e.id);
}

/**
 * "tagCountRandom" ordering: fewest tags first, seeded-random within equal
 * tag counts (replaces SQL `ORDER BY COUNT(tagId) ASC, RANDOM()`).
 */
export function orderByTagCountSeeded<T extends { id: string; tags: readonly unknown[] }>(
  items: readonly T[],
  seed: number,
): T[] {
  return items
    .map((item) => ({ item, rank: seededRank(seed, item.id) }))
    .sort(
      (a, b) =>
        a.item.tags.length - b.item.tags.length ||
        a.rank - b.rank ||
        (a.item.id < b.item.id ? -1 : 1),
    )
    .map((e) => e.item);
}
