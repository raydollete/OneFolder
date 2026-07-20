import { runInAction } from 'mobx';

import { ClientFile } from '../../../entities/File';
// Force Webpack to include worker and WASM file in the build folder!
import { MasonryType, MasonryWorker, default as init } from 'wasm/packages/masonry';
import { perf } from '../../../perf';
import { ensureMirrorCapacity, syncDimensions } from './dimensionDiff';
import { ITransform, Layouter } from './layout-helpers';

export interface MasonryOptions {
  type: MasonryType;
  thumbSize: number;
  padding: number;
}

const defaultOpts: MasonryOptions = {
  type: MasonryType.Vertical,
  thumbSize: 300,
  padding: 8,
};

export class MasonryWorkerAdapter implements Layouter {
  private worker?: MasonryWorker;
  private memory?: WebAssembly.Memory;

  private prevNumImgs: number = 0;
  /** JS mirror of the dimensions already sent to WASM — only deltas cross the boundary. */
  private dimensionMirror: Float32Array | null = null;
  /** Cache key + height of the last computed layout, for skipping no-op recomputes. */
  private lastComputeKey: string | null = null;
  private lastHeight: number | undefined = undefined;

  async initialize(numItems: number) {
    this.prevNumImgs = numItems;

    if (this.memory !== undefined && this.worker !== undefined) {
      return;
    }

    console.debug('initializing masonry worker...');
    const wasm = await init();
    this.memory = wasm.memory;

    const worker = new Worker(new URL('wasm/packages/masonry/worker.js', import.meta.url), {
      type: 'module',
    });
    worker.postMessage(this.memory);
    this.worker = new MasonryWorker(numItems);
  }

  async compute(
    imgs: ClientFile[],
    numImgs: number,
    containerWidth: number,
    opts: Partial<MasonryOptions>,
  ): Promise<number | undefined> {
    const worker = this.worker;
    if (worker === undefined) {
      return Promise.reject('Worker is uninitialized.');
    }

    const numChanged = this.prevNumImgs !== numImgs;
    if (numChanged) {
      worker.resize(numImgs);
    }
    this.prevNumImgs = numImgs;

    // Delta-write dimensions: only indices whose (w, h) differ from what the
    // WASM side already holds cross the boundary — zero on a refetch of the
    // same items, only the appended tail during progressive loads. (WASM-side
    // memory is never deallocated by resize(), so the mirror stays valid.)
    perf.startPhase('layout');
    this.dimensionMirror = ensureMirrorCapacity(this.dimensionMirror, numImgs);
    const mirror = this.dimensionMirror;
    const dimensionWrites = runInAction(() =>
      syncDimensions(mirror, imgs.slice(0, numImgs), (i, w, h) => worker.set_dimension(i, w, h)),
    );

    // Skip the layout computation entirely when nothing that affects it
    // changed (same item count, same dimensions, same container/options).
    const computeKey = `${numImgs}|${containerWidth}|${opts.type ?? defaultOpts.type}|${
      opts.thumbSize ?? defaultOpts.thumbSize
    }|${opts.padding ?? defaultOpts.padding}`;
    if (
      dimensionWrites === 0 &&
      !numChanged &&
      computeKey === this.lastComputeKey &&
      this.lastHeight !== undefined
    ) {
      perf.endPhase('layout');
      return this.lastHeight;
    }

    await worker.compute(
      containerWidth,
      opts.type || defaultOpts.type,
      opts.thumbSize || defaultOpts.thumbSize,
      opts.padding || defaultOpts.padding,
    );
    const height = worker.get_height();
    this.lastComputeKey = computeKey;
    this.lastHeight = height;
    perf.endPhase('layout');
    return height;
  }

  async recompute(
    containerWidth: number,
    opts: Partial<MasonryOptions>,
  ): Promise<number | undefined> {
    if (this.worker === undefined) {
      return Promise.reject('Worker is uninitialized.');
    }
    await this.worker.compute(
      containerWidth,
      opts.type || defaultOpts.type,
      opts.thumbSize || defaultOpts.thumbSize,
      opts.padding || defaultOpts.padding,
    );
    const height = this.worker.get_height();
    // Keep the skip-cache coherent with what the WASM side last computed.
    this.lastComputeKey = `${this.prevNumImgs}|${containerWidth}|${opts.type ?? defaultOpts.type}|${
      opts.thumbSize ?? defaultOpts.thumbSize
    }|${opts.padding ?? defaultOpts.padding}`;
    this.lastHeight = height;
    return height;
  }

  // This method will be available in the custom VirtualizedRenderer component as layout.getItemLayout
  getTransform(index: number): ITransform {
    if (this.worker === undefined || this.memory === undefined) {
      throw new Error('Worker is uninitialized.');
    }
    const ptr = this.worker.get_transform(index);
    return new Uint32Array(this.memory.buffer, ptr, 4) as unknown as ITransform;
  }
}
