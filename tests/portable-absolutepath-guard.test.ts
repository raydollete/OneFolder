/**
 * Structural guard (change: portable-shared-library-caches, task 6.2).
 *
 * A shared library's per-OS absolutePath must NEVER be compared raw in the store
 * / reconciliation code — every path comparison must route through the path-
 * identity seam (`platform.path.normalizePathIdentity` / `LocationStore.
 * normalizePath`) or key on the portable `(locationId, relativePath)` identity.
 * A raw `absolutePath` `Set.has` / `===` / `LIKE` comparison silently breaks
 * cross-OS matching (Findings A/F). This test fails if one is reintroduced.
 *
 * The check is deliberately simple and line-oriented: any line that mentions a
 * raw absolutePath comparison AND does not go through the seam is a violation.
 */

import fs from 'fs';
import path from 'path';

const SCANNED_FILES = [
  'src/frontend/stores/LocationStore.ts',
  'src/frontend/stores/FileStore.ts',
];

// Forbidden raw-absolutePath comparison shapes (Set.has/Map.get, ===/!==, LIKE).
const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
  { label: 'raw absolutePath equality (x.absolutePath ===/!==)', re: /\.absolutePath\s*[!=]==/ },
  {
    label: 'raw absolutePath equality (=== x.absolutePath)',
    re: /[!=]==\s*[A-Za-z0-9_.[\]]*\.absolutePath\b/,
  },
  { label: 'raw absolutePath Set.has/Map.get/Map.has', re: /\.(has|get)\([^)]*\.absolutePath/ },
  {
    label: "absolutePath LIKE search (ClientStringSearchCriteria('absolutePath', ...))",
    re: /ClientStringSearchCriteria\(\s*['"]absolutePath['"]/,
  },
];

// A line that routes through the shared seam is allowed to mention absolutePath.
const SEAM = /normalizePath/;

function violationsIn(source: string): string[] {
  const out: string[] = [];
  source.split('\n').forEach((line, i) => {
    if (SEAM.test(line)) {
      return; // goes through the path-identity seam — allowed
    }
    for (const { label, re } of FORBIDDEN) {
      if (re.test(line)) {
        out.push(`${i + 1}: ${label} :: ${line.trim()}`);
      }
    }
  });
  return out;
}

describe('no raw absolutePath comparisons in store/reconciliation code', () => {
  for (const rel of SCANNED_FILES) {
    it(`${rel} routes every absolutePath comparison through the seam`, () => {
      const source = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
      expect(violationsIn(source)).toEqual([]);
    });
  }

  it('the guard actually catches a reintroduced raw comparison (positive control)', () => {
    const bad = [
      `if (file.absolutePath === other.absolutePath) return;`,
      `const set = new Set(files.map((f) => f.absolutePath)); set.has(g.absolutePath);`,
      `new ClientStringSearchCriteria('absolutePath', subLoc.path, 'startsWith');`,
    ].join('\n');
    const found = violationsIn(bad);
    // Each of the three lines trips at least one forbidden pattern.
    expect(found.length).toBeGreaterThanOrEqual(3);
  });

  it('the guard does NOT flag a seam-routed comparison (negative control)', () => {
    const good = [
      `const t = platform.path.normalizePathIdentity(path);`,
      `fileList.find((f) => platform.path.normalizePathIdentity(f.absolutePath) === t);`,
      `this.suppressedIngestPaths.has(LocationStore.normalizePath(fileStats.absolutePath));`,
    ].join('\n');
    expect(violationsIn(good)).toEqual([]);
  });
});
