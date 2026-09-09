/**
 * Pure, platform-parameterized recyclable-volume policy.
 *
 * Background: `shell.trashItem` fails with a generic "Failed to perform delete
 * operation" (no error code) on Windows volumes that lack a `$Recycle.Bin` —
 * e.g. some archive drives, network shares and removable media (INV-014). To
 * warn the user before a permanent delete, `src/main.ts` probes each drive root
 * for `$Recycle.Bin` and, when absent, routes the delete to the explicit-consent
 * permanent-delete path.
 *
 * That `$Recycle.Bin` probe is a WINDOWS concept. On Linux and macOS there is no
 * `$Recycle.Bin`, trashing is delegated to Electron's `shell.trashItem` (which
 * uses the freedesktop / macOS trash), and a real trash failure continues
 * through the existing `trashWithRetry` error path — it is NOT auto-escalated to
 * permanent deletion. So off Windows this policy ALWAYS reports a path as
 * recyclable and never consults the probe.
 *
 * This module is deliberately PURE and side-effect-free:
 *   - the `$Recycle.Bin` filesystem probe is INJECTED (`probe(root)`), so
 *     `main.ts` passes the real `fse.pathExistsSync`-based probe and tests pass
 *     a fake,
 *   - it MUST NOT import 'electron', 'fs'/'fs-extra', or call `app.*`,
 *   - it NEVER deletes anything — it only returns a boolean. Permanent deletion
 *     remains the renderer's explicit-consent path.
 *
 * Keeping it pure and platform-parameterized is what makes the
 * Windows-only-probe / off-Windows-delegation contract unit-testable.
 */

import path from 'path';

/**
 * Whether the `$Recycle.Bin` probe should be consulted at all on this platform.
 * Only Windows has a `$Recycle.Bin`; every other platform delegates trashing to
 * Electron and therefore treats every volume as recyclable.
 */
export function shouldProbeRecycleBin(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

export interface DriveSupportsRecycleBinInput {
  /** The absolute path whose containing volume is being classified. */
  absolutePath: string;
  /** The current platform (typically `process.platform`). */
  platform: NodeJS.Platform;
  /**
   * Injected filesystem probe: returns true when `root` has a usable
   * `$Recycle.Bin`. Only ever called on Windows. `main.ts` passes an
   * `fse.pathExistsSync(join(root, '$Recycle.Bin'))`-based probe; tests inject a
   * fake so the module stays pure.
   */
  probe: (root: string) => boolean;
  /**
   * Per-drive-root memoization map (Recycle Bin availability does not change
   * mid-session). Callers own the map so the cache survives across calls.
   */
  cache: Map<string, boolean>;
}

/**
 * Decide whether the volume containing `absolutePath` has a usable Recycle Bin.
 *
 * Off Windows: ALWAYS true, WITHOUT calling `probe` — trashing is delegated to
 * Electron's `shell.trashItem`; the `$Recycle.Bin` probe is unreachable.
 *
 * On Windows: keeps the exact legacy probe+cache semantics —
 *   - an unknown root (`''`) is treated as recyclable (let `shell.trashItem`
 *     try),
 *   - the probe is consulted once per drive root and memoized,
 *   - a probe that throws is treated as recyclable (don't block on a failed
 *     probe).
 *
 * This function NEVER deletes anything; it only returns a boolean.
 */
export function driveSupportsRecycleBin(input: DriveSupportsRecycleBinInput): boolean {
  const { absolutePath, platform, probe, cache } = input;

  // Off Windows: delegate to Electron; the $Recycle.Bin probe is unreachable.
  if (!shouldProbeRecycleBin(platform)) {
    return true;
  }

  const root = path.parse(absolutePath).root;
  if (root === '') {
    return true; // can't determine the volume — let shell.trashItem try
  }
  const cached = cache.get(root);
  if (cached !== undefined) {
    return cached;
  }
  let supported: boolean;
  try {
    supported = probe(root);
  } catch {
    supported = true; // probe failed — don't block, let shell.trashItem try
  }
  cache.set(root, supported);
  return supported;
}
