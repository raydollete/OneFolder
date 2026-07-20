/**
 * LoadPhaseTracer (task 1.1, optimize-large-library-performance): phase
 * accounting — accumulation across slices, one summary per quiet period,
 * no-op when disabled.
 */
import { LoadPhaseTracer } from '../src/frontend/perf';

describe('LoadPhaseTracer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function makeTracer(enabled = true) {
    let now = 0;
    const printed: Record<string, { ms: number; slices: number }>[] = [];
    const tracer = new LoadPhaseTracer(
      enabled,
      () => now,
      (summary) => printed.push(summary),
      1000,
    );
    return { tracer, printed, advance: (ms: number) => (now += ms) };
  }

  it('accumulates multiple slices of the same phase and prints one summary', () => {
    const { tracer, printed, advance } = makeTracer();

    tracer.startPhase('materialize');
    advance(5);
    tracer.endPhase('materialize');

    tracer.startPhase('materialize');
    advance(7);
    tracer.endPhase('materialize');

    tracer.startPhase('fetch');
    advance(3);
    tracer.endPhase('fetch');

    expect(printed).toHaveLength(0); // nothing printed until the quiet period
    jest.advanceTimersByTime(1000);

    expect(printed).toHaveLength(1);
    expect(printed[0].materialize).toEqual({ ms: 12, slices: 2 });
    expect(printed[0].fetch).toEqual({ ms: 3, slices: 1 });
  });

  it('resets after a flush — the next load gets its own summary', () => {
    const { tracer, printed, advance } = makeTracer();

    tracer.startPhase('fetch');
    advance(4);
    tracer.endPhase('fetch');
    jest.advanceTimersByTime(1000);

    tracer.startPhase('fetch');
    advance(9);
    tracer.endPhase('fetch');
    jest.advanceTimersByTime(1000);

    expect(printed).toHaveLength(2);
    expect(printed[0].fetch.ms).toBe(4);
    expect(printed[1].fetch.ms).toBe(9);
  });

  it('an open phase defers the flush until it ends', () => {
    const { tracer, printed, advance } = makeTracer();

    tracer.startPhase('fetch');
    advance(2);
    tracer.endPhase('fetch');
    tracer.startPhase('layout'); // cancels the pending flush
    jest.advanceTimersByTime(2000);
    expect(printed).toHaveLength(0);

    advance(6);
    tracer.endPhase('layout');
    jest.advanceTimersByTime(1000);
    expect(printed).toHaveLength(1);
    expect(printed[0].layout.ms).toBe(6);
  });

  it('ignores endPhase without startPhase and is a no-op when disabled', () => {
    const { tracer, printed } = makeTracer();
    tracer.endPhase('fetch');
    jest.advanceTimersByTime(2000);
    expect(printed).toHaveLength(0);

    const disabled = makeTracer(false);
    disabled.tracer.startPhase('fetch');
    disabled.advance(5);
    disabled.tracer.endPhase('fetch');
    jest.advanceTimersByTime(2000);
    expect(disabled.printed).toHaveLength(0);
  });

  it('measure() wraps a synchronous block', () => {
    const { tracer, printed, advance } = makeTracer();
    const result = tracer.measure('materialize', () => {
      advance(11);
      return 42;
    });
    expect(result).toBe(42);
    jest.advanceTimersByTime(1000);
    expect(printed[0].materialize.ms).toBe(11);
  });
});
