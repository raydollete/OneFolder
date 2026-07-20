/**
 * Masonry dimension delta tracking (tasks 5.1/5.2,
 * optimize-large-library-performance): only changed dimensions cross the
 * JS↔WASM boundary; unchanged inputs produce zero writes.
 */
import {
  ensureMirrorCapacity,
  syncDimensions,
} from '../src/frontend/containers/ContentView/Masonry/dimensionDiff';

function dims(n: number, w = 100, h = 200) {
  return Array.from({ length: n }, () => ({ width: w, height: h }));
}

describe('syncDimensions', () => {
  it('writes every item on first population, zero on an identical second pass', () => {
    const items = dims(50);
    const mirror = ensureMirrorCapacity(null, items.length);
    const writes: number[] = [];

    const first = syncDimensions(mirror, items, (i) => writes.push(i));
    expect(first).toBe(50);
    expect(writes).toHaveLength(50);

    const second = syncDimensions(mirror, items, (i) => writes.push(i));
    expect(second).toBe(0); // refetch of the same items: no boundary traffic
    expect(writes).toHaveLength(50);
  });

  it('writes only the appended tail during a progressive load', () => {
    const firstBatch = dims(30);
    let mirror = ensureMirrorCapacity(null, 30);
    syncDimensions(mirror, firstBatch, () => {});

    const full = [...firstBatch, ...dims(20, 300, 400)];
    mirror = ensureMirrorCapacity(mirror, full.length);
    const written: number[] = [];
    const count = syncDimensions(mirror, full, (i) => written.push(i));

    expect(count).toBe(20);
    expect(Math.min(...written)).toBe(30); // only the tail indices
  });

  it('writes only indices whose dimensions actually changed (e.g. a re-sort)', () => {
    const items = [
      { width: 1, height: 1 },
      { width: 2, height: 2 },
      { width: 3, height: 3 },
    ];
    const mirror = ensureMirrorCapacity(null, 3);
    syncDimensions(mirror, items, () => {});

    // Swap items 0 and 2 (sort change) — item 1 is untouched.
    const swapped = [items[2], items[1], items[0]];
    const written: number[] = [];
    const count = syncDimensions(mirror, swapped, (i) => written.push(i));
    expect(count).toBe(2);
    expect(written).toEqual([0, 2]);
  });
});

describe('ensureMirrorCapacity', () => {
  it('reuses a sufficient mirror and preserves contents on growth', () => {
    const m1 = ensureMirrorCapacity(null, 10);
    expect(m1.length).toBeGreaterThanOrEqual(20);
    m1[0] = 42;

    expect(ensureMirrorCapacity(m1, 5)).toBe(m1); // shrink: reuse

    const grown = ensureMirrorCapacity(m1, 1000);
    expect(grown).not.toBe(m1);
    expect(grown.length).toBeGreaterThanOrEqual(2000);
    expect(grown[0]).toBe(42); // contents preserved
  });
});
