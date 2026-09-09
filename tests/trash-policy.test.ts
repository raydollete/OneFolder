/**
 * Unit tests for src/trash-policy.ts.
 *
 * The policy is pure and platform-parameterized. It decides whether the volume
 * containing a path has a usable Recycle Bin, using an INJECTED filesystem probe
 * so the module never touches disk.
 *
 * These tests prove:
 *   - Windows: the `$Recycle.Bin` probe IS consulted; a root with it → recyclable,
 *     a root without it → not recyclable; the probe is called once per root (cache),
 *   - Linux & macOS: ALWAYS recyclable, and the probe is NEVER called (proving the
 *     `$Recycle.Bin` filesystem probe is unreachable off Windows — trashing is
 *     delegated to Electron),
 *   - the policy never itself performs a permanent deletion — it only returns a
 *     boolean and the module has no delete/remove call at all.
 *
 * Paths are built from the runner's own `path` module (like
 * tests/portable-launch-context.test.ts) so `path.parse(...).root` is non-empty
 * on both POSIX and Windows CI. `driveSupportsRecycleBin` parses the volume root
 * with the same `path` module the module under test uses, so the win32 probe
 * branch is exercised deterministically regardless of the host OS.
 */

import path from 'path';
import fs from 'fs';

import {
  shouldProbeRecycleBin,
  driveSupportsRecycleBin,
} from '../src/trash-policy';

// A real absolute path on this runner, so path.parse(...).root is non-empty and
// the win32 probe branch is reachable. All these paths share one root on POSIX
// ('/') and one drive root on Windows — which is exactly what lets us prove the
// per-root cache (probe consulted once, then served from cache).
const ROOT = path.parse(process.cwd()).root; // e.g. '/' or 'C:\'
const PATH_A = path.join(ROOT, 'Users', 'me', 'photos', 'img.jpg');
const PATH_B = path.join(ROOT, 'Archive', 'old', 'clip.mp4');

describe('shouldProbeRecycleBin', () => {
  it('is true only on win32', () => {
    expect(shouldProbeRecycleBin('win32')).toBe(true);
    expect(shouldProbeRecycleBin('linux')).toBe(false);
    expect(shouldProbeRecycleBin('darwin')).toBe(false);
    expect(shouldProbeRecycleBin('freebsd')).toBe(false);
  });
});

describe('driveSupportsRecycleBin — win32 (probe is consulted)', () => {
  it('reports recyclable for a root WITH $Recycle.Bin', () => {
    const probe = jest.fn().mockReturnValue(true);
    const cache = new Map<string, boolean>();
    expect(
      driveSupportsRecycleBin({ absolutePath: PATH_A, platform: 'win32', probe, cache }),
    ).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith(ROOT);
  });

  it('reports NOT recyclable for a root WITHOUT $Recycle.Bin', () => {
    const probe = jest.fn().mockReturnValue(false);
    const cache = new Map<string, boolean>();
    expect(
      driveSupportsRecycleBin({ absolutePath: PATH_B, platform: 'win32', probe, cache }),
    ).toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('caches per drive root — the probe is consulted once, then served from cache', () => {
    const probe = jest.fn().mockReturnValue(true);
    const cache = new Map<string, boolean>();

    // Two different files on the same volume → the probe runs once for the root.
    driveSupportsRecycleBin({ absolutePath: PATH_A, platform: 'win32', probe, cache });
    driveSupportsRecycleBin({ absolutePath: PATH_B, platform: 'win32', probe, cache });
    driveSupportsRecycleBin({ absolutePath: PATH_A, platform: 'win32', probe, cache });

    expect(probe).toHaveBeenCalledTimes(1); // once per distinct root, then cached
    expect(cache.get(ROOT)).toBe(true);
  });

  it('treats an unknown volume root ("") as recyclable without probing', () => {
    const probe = jest.fn();
    const cache = new Map<string, boolean>();
    // A relative path has no root — let shell.trashItem try.
    expect(
      driveSupportsRecycleBin({
        absolutePath: path.join('relative', 'no', 'root.jpg'),
        platform: 'win32',
        probe,
        cache,
      }),
    ).toBe(true);
    expect(probe).toHaveBeenCalledTimes(0);
  });

  it('treats a probe that throws as recyclable (does not block)', () => {
    const probe = jest.fn().mockImplementation(() => {
      throw new Error('probe blew up');
    });
    const cache = new Map<string, boolean>();
    expect(
      driveSupportsRecycleBin({ absolutePath: PATH_A, platform: 'win32', probe, cache }),
    ).toBe(true);
  });
});

describe('driveSupportsRecycleBin — linux & darwin (probe is unreachable)', () => {
  it.each(['linux', 'darwin'] as NodeJS.Platform[])(
    '%s: ALWAYS recyclable and NEVER calls the probe',
    (platform) => {
      const probe = jest.fn();
      const cache = new Map<string, boolean>();

      // Even a real absolute path (with a parseable root) must not trigger a probe.
      for (const absolutePath of [PATH_A, PATH_B]) {
        expect(driveSupportsRecycleBin({ absolutePath, platform, probe, cache })).toBe(true);
      }

      expect(probe).toHaveBeenCalledTimes(0); // $Recycle.Bin probe is unreachable off Windows
      expect(cache.size).toBe(0); // nothing cached, nothing probed
    },
  );
});

describe('trash policy never performs permanent deletion', () => {
  it('only returns a boolean — no filesystem delete side effect', () => {
    // Spy the delete primitives the real permanent-delete path would use and
    // prove the pure policy never reaches them.
    const rmSpy = jest.spyOn(fs, 'rmSync').mockImplementation(() => undefined);
    const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
    try {
      const cache = new Map<string, boolean>();
      driveSupportsRecycleBin({
        absolutePath: PATH_B,
        platform: 'win32',
        probe: () => false, // classified as NOT recyclable...
        cache,
      });
      // ...yet the policy itself deletes nothing; escalation to permanent delete
      // is the renderer's explicit-consent decision, not this function's.
      expect(rmSpy).not.toHaveBeenCalled();
      expect(unlinkSpy).not.toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  it('the pure module source contains no delete/remove call', () => {
    const src = fs.readFileSync(require.resolve('../src/trash-policy'), 'utf8');
    expect(src).not.toMatch(/\b(remove|rmSync|unlinkSync|rm|unlink|trashItem)\s*\(/);
  });
});
