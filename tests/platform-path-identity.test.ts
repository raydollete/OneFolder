/**
 * Path-identity seam formatter (Task 2.2, add-portable-linux-appimage).
 *
 * The frontend platform seam exposes ONE shared path-identity formatter
 * (`platform.path.normalizePathIdentity`) backed by ONE pure implementation
 * (`normalizePathIdentity(p, foldCase)`). Both the electron and web seam members
 * delegate to it, differing only in the `foldCase` flag:
 *   - electron: folds case only on Windows (case-insensitive filesystem)
 *   - web:      never folds case (POSIX/URL semantics)
 *
 * These tests exercise BOTH policies directly (the pure helper), and confirm the
 * seam members wire the correct flag. Because the electron impl reads `IS_WIN`
 * from `common/process` at build time, the Windows-policy seam case is exercised
 * by re-requiring the seam with a mocked `common/process`.
 */

// Pure helper + electron seam (default export) — resolved via the webpack alias
// target in tests (index.ts → platform.electron.ts).
import platform, {
  normalizePathIdentity,
  probeFilesystemCaseSensitive,
  setPathIdentityFoldCase,
  resetPathIdentityFoldCase,
  getPathIdentityFoldCase,
} from '../src/frontend/platform';
// Web seam implementation — POSIX policy regardless of the host platform.
import webPlatform from '../src/frontend/platform/platform.web';

describe('normalizePathIdentity — pure policy helper', () => {
  describe('POSIX policy (foldCase = false)', () => {
    it('folds backslashes to forward slashes', () => {
      expect(normalizePathIdentity('C:\\Users\\foo\\bar.mp4', false)).toBe('C:/Users/foo/bar.mp4');
    });

    it('preserves case so case-distinct paths stay DISTINCT', () => {
      const a = normalizePathIdentity('/photos/Clip.mp4', false);
      const b = normalizePathIdentity('/photos/clip.mp4', false);
      expect(a).toBe('/photos/Clip.mp4');
      expect(a).not.toBe(b);
    });

    it('does not touch the encodeFilePath "?" query contract (no special handling)', () => {
      // normalizePathIdentity is separator + case folding only — it must NOT
      // implement encodeFilePath's ambiguous `?` behaviour.
      expect(normalizePathIdentity('a\\b?x=1', false)).toBe('a/b?x=1');
    });
  });

  describe('Windows policy (foldCase = true)', () => {
    it('folds backslashes AND lower-cases', () => {
      expect(normalizePathIdentity('C:\\Users\\Foo\\Bar.MP4', true)).toBe('c:/users/foo/bar.mp4');
    });

    it('makes case/separator variants of the same path MATCH', () => {
      const a = normalizePathIdentity('C:\\Videos\\Clip.mp4', true);
      const b = normalizePathIdentity('c:/videos/clip.mp4', true);
      expect(a).toBe(b);
    });
  });
});

describe('electron seam member — platform.path.normalizePathIdentity', () => {
  // The Jest runner is Linux (process.platform === 'linux'), so IS_WIN === false
  // and the electron seam applies the POSIX (case-sensitive) policy.
  it('folds separators but preserves case on non-Windows', () => {
    expect(platform.path.normalizePathIdentity('C:\\A\\Clip.mp4')).toBe('C:/A/Clip.mp4');
  });

  it('keeps case-distinct paths distinct on non-Windows', () => {
    expect(platform.path.normalizePathIdentity('/p/Clip.mp4')).not.toBe(
      platform.path.normalizePathIdentity('/p/clip.mp4'),
    );
  });

  it('folds case when running under the Windows policy (IS_WIN = true)', () => {
    jest.resetModules();
    jest.doMock('common/process', () => ({
      ...jest.requireActual('common/process'),
      IS_WIN: true,
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const winPlatform = require('../src/frontend/platform').default as typeof platform;
    expect(winPlatform.path.normalizePathIdentity('C:\\Videos\\Clip.mp4')).toBe(
      winPlatform.path.normalizePathIdentity('c:/videos/clip.mp4'),
    );
    expect(winPlatform.path.normalizePathIdentity('C:\\Videos\\Clip.mp4')).toBe(
      'c:/videos/clip.mp4',
    );
    jest.dontMock('common/process');
    jest.resetModules();
  });
});

describe('filesystem case-sensitivity probe (change: portable-shared-library-caches, task 1.2)', () => {
  // A minimal in-memory fs mock: writeFile records the exact-cased name; existsSync
  // resolves against that set either case-sensitively or case-insensitively,
  // simulating the two kinds of filesystem.
  function makeFsMock(caseSensitive: boolean) {
    const files = new Set<string>();
    return {
      created: files,
      ops: {
        ensureDir: async () => undefined,
        writeFile: async (p: string) => {
          files.add(p);
        },
        existsSync: (p: string) => {
          if (caseSensitive) {
            return files.has(p);
          }
          const lower = p.toLowerCase();
          return [...files].some((f) => f.toLowerCase() === lower);
        },
        remove: async (p: string) => {
          files.delete(p);
        },
      },
    };
  }

  const join = (...segments: string[]) => segments.join('/');

  it('reports case-SENSITIVE when the flipped-case name does not resolve', async () => {
    const fs = makeFsMock(true);
    await expect(probeFilesystemCaseSensitive('/data', fs.ops, join)).resolves.toBe(true);
    // Probe file is cleaned up.
    expect(fs.created.size).toBe(0);
  });

  it('reports case-INSENSITIVE when the flipped-case name resolves to the same file', async () => {
    const fs = makeFsMock(false);
    await expect(probeFilesystemCaseSensitive('/data', fs.ops, join)).resolves.toBe(false);
    expect(fs.created.size).toBe(0);
  });
});

describe('runtime case-fold policy overrides the OS default (task 1.2)', () => {
  afterEach(() => resetPathIdentityFoldCase());

  it('getPathIdentityFoldCase returns the OS default until overridden', () => {
    expect(getPathIdentityFoldCase(false)).toBe(false);
    expect(getPathIdentityFoldCase(true)).toBe(true);
  });

  it('a probed override wins over the OS default, in both directions', () => {
    setPathIdentityFoldCase(true);
    expect(getPathIdentityFoldCase(false)).toBe(true);
    setPathIdentityFoldCase(false);
    expect(getPathIdentityFoldCase(true)).toBe(false);
    resetPathIdentityFoldCase();
    expect(getPathIdentityFoldCase(true)).toBe(true);
  });

  it('the electron seam folds/does-not-fold per the probe, not IS_WIN (host is Linux → IS_WIN false)', () => {
    // Forcing a case-INSENSITIVE probe result makes case-distinct siblings collide
    // even though the running OS (Linux test host) is case-sensitive.
    setPathIdentityFoldCase(true);
    expect(platform.path.normalizePathIdentity('/p/A.jpg')).toBe(
      platform.path.normalizePathIdentity('/p/a.jpg'),
    );

    // Forcing a case-SENSITIVE probe result keeps them distinct.
    setPathIdentityFoldCase(false);
    expect(platform.path.normalizePathIdentity('/p/A.jpg')).not.toBe(
      platform.path.normalizePathIdentity('/p/a.jpg'),
    );
  });
});

describe('web seam member — POSIX policy (never folds case)', () => {
  it('folds separators but preserves case', () => {
    expect(webPlatform.path.normalizePathIdentity('C:\\A\\Clip.mp4')).toBe('C:/A/Clip.mp4');
  });

  it('keeps case-distinct paths distinct', () => {
    expect(webPlatform.path.normalizePathIdentity('/p/Clip.mp4')).not.toBe(
      webPlatform.path.normalizePathIdentity('/p/clip.mp4'),
    );
  });
});
