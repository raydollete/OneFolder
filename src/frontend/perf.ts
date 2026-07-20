import { IS_DEV } from 'common/process';

/**
 * The five view-load phases traced across the load pipeline
 * (see openspec/changes/optimize-large-library-performance):
 * - fetch:       backend query + row→DTO mapping
 * - materialize: DTO → ClientFile construction
 * - existence:   file-existence resolution (should be ~0 after the sweep removal)
 * - layout:      masonry layout computation (JS↔WASM)
 * - reconcile:   startup location reconciliation (watchLocations)
 */
export type LoadPhase = 'fetch' | 'materialize' | 'existence' | 'layout' | 'reconcile';

/**
 * Minimal load-phase tracer. Phases accumulate durations (a phase may run in
 * multiple slices, e.g. batched materialization); a summary of all phases is
 * printed once per view load — "once" being approximated as "when no phase has
 * started or ended for `flushDelayMs`". Disabled (no-op-cheap) outside dev builds.
 */
export class LoadPhaseTracer {
  private readonly durations = new Map<string, number>();
  private readonly sliceCounts = new Map<string, number>();
  private readonly starts = new Map<string, number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly enabled: boolean,
    private readonly now: () => number = () => performance.now(),
    private readonly print: (summary: Record<string, { ms: number; slices: number }>) => void = (
      summary,
    ) => console.info('[perf] view-load phases:', summary),
    private readonly flushDelayMs: number = 1000,
  ) {}

  startPhase(name: LoadPhase | string): void {
    if (!this.enabled) {
      return;
    }
    // Re-entrant start of an already-open phase keeps the earliest start.
    if (!this.starts.has(name)) {
      this.starts.set(name, this.now());
    }
    this.cancelFlush();
  }

  endPhase(name: LoadPhase | string): void {
    if (!this.enabled) {
      return;
    }
    const start = this.starts.get(name);
    if (start === undefined) {
      return; // endPhase without startPhase — ignore rather than pollute
    }
    this.starts.delete(name);
    this.durations.set(name, (this.durations.get(name) ?? 0) + (this.now() - start));
    this.sliceCounts.set(name, (this.sliceCounts.get(name) ?? 0) + 1);
    this.scheduleFlush();
  }

  /** Wraps a synchronous block in a phase slice. */
  measure<T>(name: LoadPhase | string, fn: () => T): T {
    this.startPhase(name);
    try {
      return fn();
    } finally {
      this.endPhase(name);
    }
  }

  /** Prints the accumulated summary (if any) and resets. Called automatically after a quiet period. */
  flush(): void {
    this.cancelFlush();
    if (this.durations.size === 0) {
      return;
    }
    const summary: Record<string, { ms: number; slices: number }> = {};
    for (const [name, ms] of this.durations) {
      summary[name] = { ms: Math.round(ms * 100) / 100, slices: this.sliceCounts.get(name) ?? 0 };
    }
    this.durations.clear();
    this.sliceCounts.clear();
    this.print(summary);
  }

  private scheduleFlush(): void {
    this.cancelFlush();
    this.flushTimer = setTimeout(() => this.flush(), this.flushDelayMs);
    // In Node-like environments (Jest), don't let a pending summary flush
    // keep the process alive; browsers return a number and skip this.
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  private cancelFlush(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

/** Singleton tracer used by the view-load pipeline. No-op outside dev builds. */
export const perf = new LoadPhaseTracer(IS_DEV);
