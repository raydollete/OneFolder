/**
 * Dimension delta tracking for the masonry WASM boundary.
 *
 * The layout engine keeps per-item dimensions in WASM linear memory, written
 * via one `set_dimension(index, w, h)` boundary call per item. The adapter
 * used to re-send EVERY item's dimensions on EVERY compute — O(N) boundary
 * crossings per file-list change. This mirror tracks what the WASM side
 * already has, so a compute only writes the indices that actually changed
 * (zero in the common refetch-same-items case, only the appended tail during
 * progressive loads).
 *
 * NOTE: the drafted design called for a bulk `set_dimensions(Float32Array)`
 * entry point in the Rust crate; no Rust/wasm toolchain exists on this
 * machine, so delta writes through the existing per-item API achieve the same
 * goal (boundary traffic proportional to what changed, not to N) without a
 * wasm rebuild. See design.md → Bomb-squad findings / Approach amendments.
 */

export interface ItemDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Compares `items` against the `mirror` (2 floats per item: w, h) and calls
 * `write(index, w, h)` for every changed index, updating the mirror in place.
 * Returns the number of writes performed.
 *
 * The mirror MUST be at least `2 * items.length` long (caller grows it).
 */
export function syncDimensions(
  mirror: Float32Array,
  items: readonly ItemDimensions[],
  write: (index: number, width: number, height: number) => void,
): number {
  let writes = 0;
  for (let i = 0; i < items.length; i++) {
    const w = items[i].width;
    const h = items[i].height;
    if (mirror[2 * i] !== w || mirror[2 * i + 1] !== h) {
      mirror[2 * i] = w;
      mirror[2 * i + 1] = h;
      write(i, w, h);
      writes++;
    }
  }
  return writes;
}

/**
 * Returns a mirror sized for `numItems`, reusing (and preserving) the previous
 * mirror when it is already large enough; grows geometrically otherwise.
 */
export function ensureMirrorCapacity(mirror: Float32Array | null, numItems: number): Float32Array {
  const required = 2 * numItems;
  if (mirror !== null && mirror.length >= required) {
    return mirror;
  }
  const grown = new Float32Array(
    Math.max(required, mirror === null ? required : mirror.length * 2),
  );
  if (mirror !== null) {
    grown.set(mirror);
  }
  return grown;
}
