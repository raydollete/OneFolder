/**
 * Static packaging-contract tests for the Linux AppImage target.
 *
 * These assert the *declared* contract in package.json (and the git-tracked source
 * binaries it maps) WITHOUT running a full electron-builder build, so they belong in
 * `yarn test`. The heavy end-to-end proof — that an AppImage actually builds and its
 * extracted payload is well-formed — lives in `scripts/verify-appimage.js`
 * (`yarn verify:appimage`).
 *
 * Style mirrors tests/serve-mode.test.ts: plain jest, pure reads, no app bootstrap.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const linux = pkg.build.linux;

/** electron-builder allows target entries as a bare string or an object. */
function targetEntries(target: unknown): Array<{ target: string; arch?: string | string[] }> {
  if (!Array.isArray(target)) return [];
  return target.map((t) => (typeof t === 'string' ? { target: t } : t));
}

describe('build.linux AppImage target', () => {
  it('builds an AppImage explicitly scoped to x64', () => {
    const entries = targetEntries(linux.target);
    const appimage = entries.find((e) => e.target === 'AppImage');
    expect(appimage).toBeDefined();
    const arch = ([] as string[]).concat(appimage!.arch as string[]);
    expect(arch).toContain('x64');
  });

  it('produces a single versioned x86_64 artifact name', () => {
    const artifactName: string = linux.artifactName || pkg.build.appImage?.artifactName;
    expect(artifactName).toBeDefined();
    expect(artifactName).toContain('${version}');
    expect(artifactName).toContain('x86_64');
    expect(artifactName).toContain('${ext}');
  });
});

describe('build.linux extraResources', () => {
  const resources: unknown[] = linux.extraResources || [];
  const stringResources = resources.filter((r): r is string => typeof r === 'string');
  const mappedResources = resources.filter(
    (r): r is { from: string; to: string } => typeof r === 'object' && r !== null,
  );

  it('references the exiftool config with EXACT case (.ExifTool_config)', () => {
    const flat = JSON.stringify(resources);
    expect(flat).toContain('resources/exiftool/.ExifTool_config');
  });

  it('never references the misspelled .Exiftool_config (lowercase t)', () => {
    const flat = JSON.stringify(resources);
    expect(flat).not.toContain('.Exiftool_config');
  });

  it('ships exiftool.pl and lib on Linux', () => {
    expect(stringResources).toContain('resources/exiftool/exiftool.pl');
    expect(stringResources).toContain('resources/exiftool/lib');
  });

  it('maps the Linux ffmpeg binary to the runtime-expected path', () => {
    const m = mappedResources.find((r) => r.to === 'resources/ffmpeg/ffmpeg');
    expect(m).toBeDefined();
    expect(m!.from).toBe('resources/ffmpeg/linux/ffmpeg');
  });

  it('maps the Linux ffprobe binary to the runtime-expected path', () => {
    const m = mappedResources.find((r) => r.to === 'resources/ffmpeg/ffprobe');
    expect(m).toBeDefined();
    expect(m!.from).toBe('resources/ffmpeg/linux/ffprobe');
  });

  it('does NOT leak Windows PE helpers into the Linux payload', () => {
    const flat = JSON.stringify(resources);
    expect(flat).not.toContain('ffmpeg.exe');
    expect(flat).not.toContain('ffprobe.exe');
    expect(flat).not.toContain('exiftool.exe');
  });
});

describe('build.linux desktop identity', () => {
  it('sets a lowercase executableName', () => {
    expect(linux.executableName).toBe('onefolder');
  });

  it('sets StartupWMClass to match Electron runtime WM_CLASS (productName)', () => {
    // Electron's Linux WM_CLASS defaults to app.name, which is package.json productName
    // ("OneFolder") because no app.setName override exists in the main process.
    const wmClass = linux.desktop?.entry?.StartupWMClass;
    expect(wmClass).toBe('OneFolder');
    expect(wmClass).toBe(pkg.productName);
  });

  it('points the Linux icon at a generated icon set directory', () => {
    expect(linux.icon).toBeDefined();
    expect(String(linux.icon)).toMatch(/icons/);
  });
});

describe('build.asarUnpack native modules', () => {
  const unpack: string[] = pkg.build.asarUnpack || [];
  it.each([
    ['better-sqlite3', 'node_modules/better-sqlite3/**'],
    ['sharp', 'node_modules/sharp/**'],
    ['@img', 'node_modules/@img/**'],
  ])('still unpacks %s', (_name, glob) => {
    expect(unpack).toContain(glob);
  });
});

describe('Windows/mac targets stay byte-compatible', () => {
  it('keeps the Windows portable OneFolder identity', () => {
    expect(pkg.build.win.executableName).toBe('OneFolder');
    expect(pkg.build.portable.artifactName).toBe('OneFolder-${version}-x64.${ext}');
    expect(pkg.build.win.target).toEqual(['portable']);
  });

  it('keeps Windows PE helpers only on the Windows target', () => {
    const winResources = JSON.stringify(pkg.build.win.extraResources);
    expect(winResources).toContain('ffmpeg.exe');
    expect(winResources).toContain('ffprobe.exe');
    expect(winResources).toContain('exiftool.exe');
  });
});

describe('icon generation wiring', () => {
  it('runs prepare-icons.js before packaging the AppImage', () => {
    const scripts = pkg.scripts;
    const chain = [scripts['package:appimage'], scripts.logo, scripts.build].join(' ');
    expect(chain).toContain('prepare-icons.js');
  });

  it('exposes the verify:appimage script', () => {
    expect(pkg.scripts['verify:appimage']).toContain('verify-appimage.js');
  });
});

describe('git-tracked Linux source binaries', () => {
  function gitMode(relPath: string): string | null {
    try {
      const out = execFileSync('git', ['ls-files', '-s', relPath], {
        cwd: ROOT,
      }).toString();
      const m = /^(\d{6})\s/.exec(out.trim());
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  it('resources/exiftool/exiftool.pl exists and is git-tracked executable (100755)', () => {
    const rel = 'resources/exiftool/exiftool.pl';
    expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    expect(gitMode(rel)).toBe('100755');
  });

  // Over GitHub's 100 MB limit: downloaded before `yarn package:appimage` (README, Linux build).
  it.each([['resources/ffmpeg/linux/ffmpeg'], ['resources/ffmpeg/linux/ffprobe']])(
    '%s is not git-tracked',
    (rel) => {
      expect(gitMode(rel)).toBeNull();
    },
  );

  it('ships the exact-case exiftool config source file', () => {
    expect(fs.existsSync(path.join(ROOT, 'resources/exiftool/.ExifTool_config'))).toBe(true);
  });
});
