# Verification — remediate-dependabot-alerts

Date: 2026-07-04
Tier: 2 — Moderate

## Verdict: PASS-WITH-FINDINGS

Fresh-context audit of the working-tree diff against the change artifacts. `radflow-lint --tier-check`
returned exit 0 (clean, no structural violations, tier envelope matches). Every checked box's
`evidence:` was re-derived against the actual working tree; no fabricated evidence found. Two manual
gates (live GUI runtime smoke test; post-push Dependabot reconciliation) remain genuinely outstanding
and are already tracked as `[~] REQUIRES MANUAL EXECUTION` — they are advisory, not blocking.

## Dimensions

- **Implemented: CONFIRMED.** All four blast-radius changes exist in the working tree:
  - `package-lock.json` deleted — staged as `D` in git (`git status` → `D  package-lock.json`), absent from the tree, no longer tracked.
  - `.github/dependabot.yml` present, `version: 2`, single `package-ecosystem: "npm"` at `directory: "/"`, weekly, `open-pull-requests-limit: 10`, `commit-message.prefix: "deps"` — matches tasks 2.1/2.2 verbatim.
  - `package.json:93` `resolutions` block present (19 single-major pins), `electron` still `41.7.2` at `package.json:130`.
  - `yarn.lock` regenerated. Every claimed patched version verified present by reading the resolved `version` field under each header:
    `@babel/traverse` 7.29.7 (critical cleared); `serialize-javascript` 7.0.7 (forced v6→v7); `braces` 3.0.3; `form-data` 4.0.6; `ws` 8.21.0; `cross-spawn` 7.0.6; and the seven collapse-prone multi-major packages each patched per major line with **no collapse**: `minimatch` 3.1.5 / 5.1.9 (+ 9.0.9, 10.2.5 untouched); `semver` 6.3.1 / 7.8.5 (+ 5.7.2, 7.5.4, 7.7.4, 7.8.4, all ≥ 5.7.2/6.3.1/7.5.2 floors); `undici` 6.27.0 / 7.28.0; `ajv` 6.15.0 / 8.20.0; `js-yaml` 3.15.0 / 4.3.0; `picomatch` 2.3.2 (+ 4.0.4 untouched); `brace-expansion` 1.1.15 / 2.1.1 (+ 5.0.6).
    `electron@41.7.2:` unmoved. `uuid@^8.3.2` (8.3.2) still present — the documented BLOCKED item (medium; needs v8→v11 major bump).
  - Note: the task 3.4 evidence line mentions scoped nested `undici` pins (`node-gyp/undici`, `@electron/get/undici`); the final approach documented in the Verification Notes instead re-resolves multi-major lines by regenerating the lock. The **final state is correct** (undici 6.27.0 + 7.28.0 present, no scoped keys in the resolutions block) — the task line is stale narrative, not a code discrepancy. Not blocking.

- **Reachable: CONFIRMED.** No application source changed — reachability for a dependency change means the bumped transitives are exercised by the toolchain. `yarn build` compiles the full renderer (1082 modules) against the new tree; `yarn test` executes `picomatch`, `micromatch`, `semver`, `cross-spawn` under jsdom. No orphaned or gated code. Runtime execution of the socket-path deps (`undici`, `ws`) in the packaged app is not reached by build or jest — see Findings.

- **Tested: CONFIRMED (agent-reachable portion).** Re-ran here, not trusted from artifacts:
  - `yarn install --frozen-lockfile` → `success Already up-to-date`, exit 0 (package.json resolutions ↔ yarn.lock coherent).
  - `yarn test` → **30 suites / 263 tests pass**, exit 0 (matches claim).
  - `yarn build` → `webpack 5.105.4 compiled with 1 warning` (baseline mapbox-gl warning), logo step ran, exit 0, ~37s (matches claim). The forced `serialize-javascript` 7.0.7 is exercised by terser at build and passed.
  - Manual gates 4.2 (live GUI smoke), 5.1/5.2 (post-push Dependabot) correctly remain `[~]` — not falsely checked.

- **Optimal (advisory): Sound.** Minimal-churn strategy (single-major `resolutions` + per-major re-resolution for collapse-prone packages) is idiomatic Yarn 1 and keeps webpack/`@types/node` byte-identical to the prior lock, avoiding the TS-4.9 toolchain drift the apply notes documented backing out of. External design review (Gemini) was performed and folded into D3/D5/task 3.6. Well-documented throughout.

## Findings

1. **[advisory / low] Live runtime verification of socket-path and glob-filter deps not yet performed.**
   `yarn build` resolves imports but never executes dependency code; jest covers the glob matchers
   (`picomatch`/`micromatch`) but not `undici` 6.27.0 / 7.28.0 or `ws` 8.21.0 on a live socket/dev-server
   path, nor the packaged Electron app's file-search/glob filtering. This is exactly the residual the
   external review flagged and is already captured in `tasks.md` task 4.2 as
   `REQUIRES MANUAL EXECUTION (user)`. Risk is low (versions stay within-range per major) but non-zero.
   No new follow-up task appended — already tracked.

2. **[advisory / low] Post-push Dependabot reconciliation is user-only and unclosed.**
   Tasks 5.1/5.2 (`[~]`): the 103 `package-lock.json` phantom alerts and the 55/56 `yarn.lock` alerts
   can only be confirmed cleared after the deletion + lock are pushed; the single `uuid` medium remains
   BLOCKED by design. Expected end state: package-lock.json 103→0, yarn.lock 56→1. Already tracked;
   no code action possible pre-push.

## Live UI pass

n/a — no UI surface. This change edits no application source (`src/`, `common/`, `widgets/`, `wasm/`
untouched); it is a dependency-tree + repo-config change. The residual runtime concern is recorded as
Finding 1 (manual GUI smoke test), not a UI regression in changed code.
