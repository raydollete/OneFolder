## Context

Dependabot reports 159 open alerts. Direct inspection of the two committed lockfiles established that 103 originate from a stale, orphaned `package-lock.json` left over from upstream OneFolder's npm workflow — the fork now installs via Yarn 1 (`packageManager: yarn@1.22.22`, corepack). That lockfile no longer reflects the installed tree (it reports `electron < 38.8.6` against a real pin of `41.7.2`, and flags `axios`/`electron-updater`/`follow-redirects`, none present in `yarn.lock`). The remaining 56 alerts are genuine `yarn.lock` findings: 1 critical (`@babel/traverse`), a band of high-severity transitive build/util deps, and some runtime-scoped transitives.

Constraints: this is a Yarn 1.x project (no Yarn Berry `resolutions` protocol quirks, but also no `npm audit fix`). `electron` is a hard pin at `41.7.2` — Electron 42 is blocked by a better-sqlite3 V8 `ExternalPointerTypeTag` incompatibility, so no remediation may move it. The fork ships portable-only. No application source is touched; the entire change is dependency-tree + repo config.

## Goals / Non-Goals

**Goals:**
- Reduce Dependabot to a clean, trustworthy state: eliminate the 103 phantom alerts and remediate the 56 genuine `yarn.lock` alerts (critical + high first).
- Make the single-lockfile invariant durable so npm alerts cannot silently return.
- Prove the app still builds and launches after forced transitive upgrades.

**Non-Goals:**
- Upgrading any direct dependency's major version (React, MobX, Electron, TypeScript, Dexie, etc.). Only transitive versions move.
- Moving the `electron` pin off `41.7.2`.
- Touching application source, DTOs, specs of other capabilities, or runtime behavior.
- Migrating to Yarn Berry / PnP.

## Decisions

**D1 — Delete `package-lock.json` rather than update it.** The fork does not use npm; maintaining two lockfiles guarantees perpetual drift and doubled scan noise. *Alternative considered:* keep it in sync via `npm install`. Rejected — it would require running an unsupported package manager on every dependency change, and would keep scanning packages the app never installs. The file is git-tracked, so deletion is fully recoverable.

**D2 — Remediate transitive vulns via Yarn `resolutions` in `package.json`, not direct-dep bumps.** Every genuine advisory is several levels down the tree; no direct dependency is itself vulnerable. `resolutions` is Yarn 1's supported lever to force a transitive to a patched version without changing what `package.json` declares. *Alternative considered:* `yarn upgrade <pkg>` per package. Rejected — it can't reach deep transitives deterministically and mutates the lockfile less predictably than an explicit pin.

**D3 — Pin to the advisory's `first_patched_version`, floored at the current major.** For each vulnerable package, resolve to the lowest version that clears every advisory touching it (several packages have multiple overlapping advisories — take the max of their patched versions). Stay within the current major to avoid API breaks in build tooling. *Alternative considered:* pin to `latest`. Rejected — needlessly risks major-version breakage in Webpack/Babel/electron-builder plugins.

**D4 — Add `.github/dependabot.yml` scoped to `npm` at `/`.** Codifies the scanning surface so a stray regenerated `package-lock.json` (or a contributor running `npm install`) does not silently reintroduce phantom alerts, and gives us a weekly update cadence. *Alternative considered:* rely on alerts alone. Rejected — no guardrail against recurrence.

**D5 — Build + launch verification gate is mandatory and is the only real risk surface.** Since no source changes, the sole failure mode is a transitive bump breaking the build or the packaged app. `yarn build` + an app launch is the acceptance evidence. This is a `REQUIRES MANUAL EXECUTION` step for the launch portion (GUI), per the project's QA-discipline gate.

## Risks / Trade-offs

- **A forced transitive pin breaks the Webpack/Babel/electron-builder build** (e.g. a `@babel/*` or `svgo`/`postcss` bump changes an API a plugin relies on) → Apply resolutions incrementally by cluster (babel, then matchers, then the rest), run `yarn install` + `yarn build` after each cluster, and back out any single pin that breaks the build in favor of the next-lowest patched version.
- **A `resolutions` pin is incompatible with a dependency's declared range** (Yarn 1 will still force it, possibly producing a runtime mismatch) → Prefer the patched version within the same major as the currently-resolved one; verify at launch, not just at build.
- **Deleting `package-lock.json` surprises a contributor who runs `npm install`** → The added `.github/dependabot.yml` plus the existing `packageManager` field document Yarn as authoritative; optionally note it in the commit message. Low impact — the repo is already Yarn-only.
- **Electron pin accidentally moved by a transitive resolution** → No resolution targets `electron`; explicitly re-assert `electron@41.7.2` resolves after `yarn install`.

## Migration Plan

1. Delete `package-lock.json`; commit the single-lockfile state.
2. Add `resolutions` to `package.json` in clusters (critical `@babel/traverse` first; then runtime highs; then remaining highs; then medium/low), running `yarn install` after each cluster to regenerate `yarn.lock`.
3. Add `.github/dependabot.yml` (npm ecosystem, root, weekly).
4. Run `yarn build`; launch the packaged app; confirm `electron@41.7.2` still resolves.
5. Push; confirm Dependabot re-scan shows the phantom 103 gone and the genuine set cleared.

**Rollback:** `package-lock.json` is git-tracked (restore via `git checkout`); `resolutions` and the dependabot config are additive and revertible in a single commit; `yarn.lock` regenerates from `package.json`.

## Open Questions

- None blocking. If a specific transitive pin proves build-incompatible within its current major, that package's alert is marked BLOCKED with a documented note rather than forcing a risky major bump — to be decided per-package during apply if it arises.

## External Review

External design review performed via Gemini (round-trip on this design + proposal). The reviewer judged the overall approach sound — "delete `package-lock.json`: yes, absolutely" and "Yarn 1 `resolutions` forces deep transitives reliably" — but raised three concrete refinements, now folded into the decisions and tasks:

1. **Global single-major pins are dangerous (strengthens D3, rewrites task 3.6).** Forcing a package like `semver`, `undici`, or `minimatch` to one major across all consumers can compile fine but crash at runtime (`undici` v5→v6, `semver` v7 class changes, `minimatch` v5 glob-semantics changes). *Adopted:* for the six multi-major packages, **default to scoped per-major resolutions** (`"<parent>/<pkg>": "<patched>"` or per-major-line pins), patching each vulnerable version *within its own major line* — not a single global pin. Global pins are used only for single-major packages.
2. **`yarn build` is not enough — verification needs runtime coverage (strengthens D5, task 4.2).** The bundler resolves imports but never executes dependency code; a bad `ws`/`braces`/`minimatch` bump can pass build and fail at runtime. *Adopted:* the manual launch gate now runs feature smoke tests mapped to the updated deps — file-search/glob filtering (`minimatch`/`micromatch`/`braces`/`picomatch`), any socket/dev-server path (`ws`/`undici`), and a full build (`@babel/*`, `svgo`, `postcss`).
3. **Deleting the lockfile may not auto-close the alerts (adds task 5.1a).** Dependabot is slow to reconcile a removed manifest. *Adopted:* after pushing the deletion, trigger a re-scan and **manually dismiss any lingering `package-lock.json` alerts** as "no longer applicable," rather than assuming auto-closure. Also added `yarn why electron` to the verification to prove the `41.7.2` pin is undisturbed.

The reviewer confirmed resolutions cannot disturb the electron pin unless electron is explicitly targeted (it is not), with the caveat that bumping `electron-builder`/`app-builder-lib` transitives can break the *build* — which the build gate already catches.
