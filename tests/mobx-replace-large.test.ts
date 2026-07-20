/**
 * Task 6.1 (optimize-large-library-performance): empirical repro of MobX #3189
 * on the pinned MobX 6.x — "observableArray.replace() broken for large lists".
 *
 * The historical failure mode was a RangeError (max call stack) from spreading
 * huge argument lists in spliceWithArray. This test documents whether the
 * PINNED MobX version still exhibits it. The codebase policy is decided by
 * this result (see design.md / removeFilesFromListInPlace):
 *
 *   - While clear()+push(...) is the unified policy, this test PROVES whether
 *     the ban is still load-bearing. If replace() works at 70k here, the ban
 *     is belt-and-braces (kept for one consistent policy); if it throws, the
 *     ban is mandatory.
 *
 * NOTE: push(...huge) also spreads arguments — this suite covers both, plus
 * the chunked-push shape actually used by the progressive loader.
 */
import { configure, observable, reaction, runInAction } from 'mobx';

configure({ enforceActions: 'never' });

const LARGE = 70_000;

describe('MobX large observable array operations (policy evidence for #3189)', () => {
  it('replace() with a 70k-element array works on the pinned MobX version', () => {
    const arr = observable<number>([]);
    const survivors = Array.from({ length: LARGE }, (_, i) => i);

    let reactionRuns = 0;
    const dispose = reaction(
      () => arr.length,
      () => reactionRuns++,
    );
    expect(() => runInAction(() => arr.replace(survivors))).not.toThrow();
    expect(arr.length).toBe(LARGE);
    expect(arr[0]).toBe(0);
    expect(arr[LARGE - 1]).toBe(LARGE - 1);
    expect(reactionRuns).toBe(1);
    dispose();
  });

  it('clear() + chunked push works at 70k (the unified policy shape)', () => {
    const arr = observable<number>([]);
    const items = Array.from({ length: LARGE }, (_, i) => i);
    arr.clear();
    // The progressive loader pushes in bounded chunks; a single spread-push of
    // 70k args risks its own stack limits, so chunked is the canonical shape.
    const CHUNK = 10_000;
    for (let i = 0; i < items.length; i += CHUNK) {
      arr.push(...items.slice(i, i + CHUNK));
    }
    expect(arr.length).toBe(LARGE);
    expect(arr[LARGE - 1]).toBe(LARGE - 1);
  });

  it('replace() on a filtered 70k survivor array (the removeFilesById shape)', () => {
    const arr = observable<number>(Array.from({ length: LARGE }, (_, i) => i));
    const toRemove = new Set(Array.from({ length: 100 }, (_, i) => i * 7));
    const survivors = arr.filter((v) => !toRemove.has(v));
    expect(() => arr.replace(survivors)).not.toThrow();
    expect(arr.length).toBe(LARGE - toRemove.size);
  });
});
