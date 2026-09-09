/**
 * Unit tests for ExifIO.initialize() — the shared, retryable initialization
 * promise that replaced the old `isOpening` boolean + uncleared `setInterval`
 * polling (design.md decision 5 / bomb-squad finding 6).
 *
 * The old code had two defects this suite guards against:
 *   1. If `_ep.open()` rejected, `isOpening` stayed `true` forever, so every
 *      later `initialize()` polled a `setInterval` that never resolved and was
 *      never cleared — a permanent hang with no retry.
 *   2. The `setInterval` leaked even on success (a live timer left behind).
 *
 * `@logion/node-exiftool` is mocked so `open()`/`close()` can be driven on
 * demand and `_open` reflects the child's state without spawning a process.
 */

// Self-contained mock: the ExiftoolProcess class lives entirely inside the
// factory (jest hoists jest.mock above imports, so it must not close over any
// not-yet-initialized module-scope binding). Created instances are exposed via
// a static array the tests read back through the mocked import.
jest.mock('@logion/node-exiftool', () => {
  class MockExiftoolProcess {
    static instances: MockExiftoolProcess[] = [];
    static reset(): void {
      MockExiftoolProcess.instances = [];
    }

    path?: string;
    _open = false;
    openCalls = 0;
    closeCalls = 0;

    // Default behaviour: open() succeeds synchronously-ish and marks _open.
    openImpl: () => Promise<number> = () => {
      this._open = true;
      return Promise.resolve(1234);
    };
    closeImpl: () => Promise<void> = () => {
      this._open = false;
      return Promise.resolve();
    };

    constructor(path?: string) {
      this.path = path;
      MockExiftoolProcess.instances.push(this);
    }

    open(): Promise<number> {
      this.openCalls++;
      return this.openImpl();
    }

    close(): Promise<void> {
      this.closeCalls++;
      return this.closeImpl();
    }

    /**
     * Make the next open() calls stay pending until the returned resolve/reject
     * is invoked. Resolving flips `_open` true, mirroring the real process.
     */
    deferOpen(): { resolve: () => void; reject: (err: unknown) => void } {
      let resolveFn: () => void = () => undefined;
      let rejectFn: (err: unknown) => void = () => undefined;
      this.openImpl = () =>
        new Promise<number>((res, rej) => {
          resolveFn = () => {
            this._open = true;
            res(4321);
          };
          rejectFn = (err: unknown) => rej(err);
        });
      return { resolve: () => resolveFn(), reject: (err) => rejectFn(err) };
    }
  }

  return { ExiftoolProcess: MockExiftoolProcess };
});

import ExifIO from '../common/ExifIO';
import exiftool from '@logion/node-exiftool';

// The mocked class, with the test-only helpers attached above.
type MockProc = {
  path?: string;
  _open: boolean;
  openCalls: number;
  closeCalls: number;
  openImpl: () => Promise<number>;
  closeImpl: () => Promise<void>;
  deferOpen: () => { resolve: () => void; reject: (err: unknown) => void };
};
const MockExiftoolProcess = (exiftool as unknown as {
  ExiftoolProcess: { instances: MockProc[]; reset: () => void };
}).ExiftoolProcess;

/** Construct an ExifIO with an explicit path so each test gets a fresh mock. */
function makeExifIO(): { io: ExifIO; proc: MockProc } {
  const io = new ExifIO('|', '/fake/exiftool');
  const proc = MockExiftoolProcess.instances[MockExiftoolProcess.instances.length - 1];
  return { io, proc };
}

beforeEach(() => {
  MockExiftoolProcess.reset();
});

describe('ExifIO.initialize() — shared retryable promise', () => {
  it('concurrent callers share one open() and all resolve', async () => {
    const { io, proc } = makeExifIO();
    const gate = proc.deferOpen();

    // Three overlapping callers while the first open is still pending.
    const p1 = io.initialize();
    const p2 = io.initialize();
    const p3 = io.initialize();

    // Exactly one underlying open() despite three initialize() calls.
    expect(proc.openCalls).toBe(1);

    gate.resolve();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    // Every caller gets the same ExifIO back and the process is open.
    expect(r1).toBe(io);
    expect(r2).toBe(io);
    expect(r3).toBe(io);
    expect(io.isOpen()).toBe(true);
    expect(proc.openCalls).toBe(1);
  });

  it('a second initialize() after open short-circuits without re-opening', async () => {
    const { io, proc } = makeExifIO();
    await io.initialize();
    expect(proc.openCalls).toBe(1);

    const again = await io.initialize();
    expect(again).toBe(io);
    // Already open → no additional open().
    expect(proc.openCalls).toBe(1);
  });

  it('rejection settles every concurrent caller and leaves no live timer', async () => {
    jest.useFakeTimers();
    try {
      const { io, proc } = makeExifIO();
      const gate = proc.deferOpen();

      const p1 = io.initialize();
      const p2 = io.initialize();
      expect(proc.openCalls).toBe(1);

      // Attach catch handlers before rejecting to avoid unhandled rejections.
      const caught1 = p1.then(
        () => 'resolved',
        (e) => (e as Error).message,
      );
      const caught2 = p2.then(
        () => 'resolved',
        (e) => (e as Error).message,
      );

      gate.reject(new Error('spawn failed'));

      expect(await caught1).toBe('spawn failed');
      expect(await caught2).toBe('spawn failed');

      // The whole point: the new code path installs NO timer. The old
      // setInterval-based implementation would have a pending timer here.
      expect(jest.getTimerCount()).toBe(0);
      expect(io.isOpen()).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries open() on a later attempt after a failed one', async () => {
    const { io, proc } = makeExifIO();

    // First attempt rejects.
    const gate = proc.deferOpen();
    const firstAttempt = io.initialize();
    const firstResult = firstAttempt.then(
      () => 'resolved',
      (e) => (e as Error).message,
    );
    gate.reject(new Error('first attempt failed'));
    expect(await firstResult).toBe('first attempt failed');
    expect(proc.openCalls).toBe(1);
    expect(io.isOpen()).toBe(false);

    // Correct the fault so the retry can succeed (deferOpen left open() pending).
    proc.openImpl = () => {
      proc._open = true;
      return Promise.resolve(4321);
    };

    // Corrected later attempt: open() succeeds now.
    const second = await io.initialize();
    expect(second).toBe(io);
    // open() was called AGAIN — the in-flight marker cleared on rejection.
    expect(proc.openCalls).toBe(2);
    expect(io.isOpen()).toBe(true);
  });

  it('close() closes the child when open, is a no-op when not, and reopen works', async () => {
    const { io, proc } = makeExifIO();

    // Safe to close before ever opening — no underlying close().
    await io.close();
    expect(proc.closeCalls).toBe(0);

    await io.initialize();
    expect(io.isOpen()).toBe(true);

    // Shutdown closes exactly once, leaving no orphan.
    await io.close();
    expect(proc.closeCalls).toBe(1);
    expect(io.isOpen()).toBe(false);

    // Idempotent: closing again when already closed does nothing.
    await io.close();
    expect(proc.closeCalls).toBe(1);

    // After shutdown a fresh initialize() can reopen the process.
    const reopened = await io.initialize();
    expect(reopened).toBe(io);
    expect(io.isOpen()).toBe(true);
    expect(proc.openCalls).toBe(2);
  });
});
