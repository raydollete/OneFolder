Tier: 2 — Moderate: the edits are mechanical (delete one lockfile, add a config, add `resolutions` pins), but forced transitive upgrades carry real build-breakage risk against a hard electron `41.7.2` ceiling, so it needs a full build + app-launch verification gate. It touches no application source and has no code-defect cluster, so it does not warrant the heavier latent-defect treatment reserved for the top effort band.

Type: bug

## Why

GitHub Dependabot reports **159 open alerts** against this fork. Investigation shows they split into two very different populations, and the split is the whole story:

- **103 alerts (~65%) are phantoms** from a stale, orphaned `package-lock.json`. This fork uses Yarn (`packageManager: yarn@1.22.22`); the committed npm lockfile is a leftover from upstream and no longer reflects the real dependency tree. Proof: it reports `electron < 38.8.6` while `package.json` pins — and `yarn.lock` resolves — `electron@41.7.2`, and it flags `axios`, `electron-updater`, and `follow-redirects`, none of which exist in `yarn.lock` at all. These alerts describe packages the app does not actually ship.
- **56 alerts are real**, sourced from the authoritative `yarn.lock`: 1 critical (`@babel/traverse`), a cluster of high-severity transitive build/util deps, and a handful of runtime-scoped transitives. These are genuine and worth clearing.

Carrying a second, out-of-date lockfile permanently doubles Dependabot's noise and hides the real signal. Removing it plus remediating the genuine `yarn.lock` findings gets the project to a clean, trustworthy alert state and keeps it there.

## Root Cause

Category: **order-of-operations**.

The fork migrated from upstream OneFolder's npm workflow to Yarn (corepack, `yarn@1.22.22`), but the migration sequence skipped a cleanup step: upstream's committed `package-lock.json` was never removed, and no `.github/dependabot.yml` was added to scope scanning. The right ordering — adopt Yarn, delete the npm lockfile, scope Dependabot — was left half-done. Because Dependabot scans every lockfile it finds, the orphan keeps generating alerts against a dependency tree the app no longer installs, and nothing prevents recurrence. This is a repo-artifact/process sequencing gap, not a flaw in application architecture (no source code is involved). The 56 genuine `yarn.lock` findings are ordinary transitive-dependency drift — no direct dependency in `package.json` is itself vulnerable; the advisories are all several levels down the tree.

## What Changes

- **Delete the stale, orphaned `package-lock.json`** so Yarn's `yarn.lock` is the single source of truth. This alone resolves the 103 phantom alerts. **BREAKING** only for anyone relying on `npm install` in this repo (unsupported — the project is Yarn-only via corepack).
- **Add a Dependabot config** (`.github/dependabot.yml`) scoped to the `npm` ecosystem so future scanning tracks only `yarn.lock`, preventing a regenerated npm lockfile from reintroducing phantom noise.
- **Remediate the 56 real `yarn.lock` alerts** by adding a `resolutions` block to `package.json` pinning vulnerable transitive dependencies to their first patched versions, then regenerating `yarn.lock` via `yarn install`. Priority order: critical (`@babel/traverse`) → runtime-scoped highs (`braces`, `form-data`, `picomatch`, `semver`, `serialize-javascript`) → remaining highs → medium/low.
- **Verify** the app still builds and starts after the resolution pins (transitive upgrades can break build tooling; the electron `41.7.2` pin must not move — Electron 42 is blocked by better-sqlite3).

## Capabilities

### New Capabilities
- `dependency-hygiene`: Codifies how this fork manages dependencies and security alerts — Yarn as the single lockfile authority (no committed npm lockfile), Dependabot scoped accordingly, and a standing requirement that no open critical/high advisories persist unaddressed. Gives future dependency work a durable contract to verify against.

### Modified Capabilities
<!-- None. This change introduces no behavioral/runtime requirement changes to existing capabilities. -->

## Blast Radius

Confirmed by direct inspection of the two lockfiles, `package.json`, and the full Dependabot alert set (`gh api .../dependabot/alerts`):

1. **`package-lock.json:1` (delete)** — tracked by git (recoverable), 641 KB, last touched Apr 4; `yarn.lock` last touched Jun 22 (`ls -la` on the two files). Evidence it is stale/orphaned: `grep -n 'package-lock' .gitignore` → no match; `grep -c '^axios@' yarn.lock` → `0`, `grep '^electron-updater@' yarn.lock` → no entry, while `grep '^electron@' yarn.lock` → `electron@41.7.2:`. No script in `package.json` invokes `npm`. Deleting it removes all 103 `package-lock.json`-manifest alerts (of which axios/electron-updater/follow-redirects/old-electron/ejs/app-builder-lib are pure phantoms).
2. **`package.json:1` `resolutions` (add)** — additive field; touches no existing dependency declarations. `grep '"electron"' package.json` → `"electron": "41.7.2"` stays as-is; only transitive versions move.
3. **`yarn.lock:1` (regenerate)** — mechanically rewritten by `yarn install`; the set of top-level resolved versions (e.g. `yarn.lock:1` → `electron@41.7.2:`) is unchanged except for the pinned transitives.
4. **`.github/dependabot.yml:1` (add)** — new file (path does not yet exist: `ls .github/dependabot.yml` → not found); affects GitHub scanning only, no code or runtime impact.

Real `yarn.lock` advisories to clear (worst severity per package): **critical** — `@babel/traverse`. **high** — `@babel/plugin-transform-modules-systemjs`, `braces` (runtime), `cross-spawn`, `flatted`, `form-data` (runtime), `immutable`, `minimatch`, `picomatch` (runtime), `semver` (runtime+dev), `serialize-javascript` (runtime), `svgo`, `tmp`, `undici`, `ws`. **medium** — `@babel/helpers`, `@babel/runtime` (runtime), `ajv`, `js-yaml`, `micromatch` (runtime), `nanoid`, `postcss`, `protocol-buffers-schema` (runtime), `uuid` (runtime), `yaml` (runtime), `brace-expansion`. **low** — `@babel/core`. All are transitive; none is a direct dependency in `package.json`.

Bounding the radius: no application source files (`src/`, `common/`, `widgets/`, `wasm/`) are edited — this is a dependency-tree + repo-config change only. The only runtime-behavior risk is that a forced transitive bump breaks the Webpack/electron-builder build; that is the sole thing the verification gate must catch.

## Impact

- **Files**: delete `package-lock.json`; add `.github/dependabot.yml`; edit `package.json` (`resolutions`); regenerate `yarn.lock`.
- **Dependencies**: transitive-only upgrades via resolutions. No direct-dependency major bumps. `electron` stays pinned at `41.7.2` (hard ceiling — do not move).
- **Risk**: forced transitive upgrades can break Webpack/electron-builder tooling at build time; mitigated by a full `yarn build` + app-launch verification gate before the change is considered done.
- **CI/tooling**: anyone using `npm` in this repo loses the lockfile (already unsupported). No runtime app behavior changes.
