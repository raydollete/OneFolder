## 1. Remove the orphaned npm lockfile

- [ ] 1.1 Confirm `package-lock.json` is git-tracked (`git ls-files package-lock.json`) so deletion is recoverable, and re-confirm it is orphaned: `grep -c '^axios@' yarn.lock` → `0`, `grep '^electron@' yarn.lock` → `electron@41.7.2:`.
- [ ] 1.2 Delete `package-lock.json` (`git rm package-lock.json`).
- [ ] 1.3 Verify no script or config references it: `grep -rn 'package-lock' package.json .github .gitignore` returns nothing meaningful; no `npm`-invoking script remains in `package.json`.

## 2. Scope Dependabot to the Yarn ecosystem

- [ ] 2.1 Create `.github/dependabot.yml` (version 2) with a single `package-ecosystem: "npm"` entry rooted at `/`, weekly `schedule.interval`. This makes GitHub scan only `yarn.lock`.
- [ ] 2.2 (Optional) Add `open-pull-requests-limit` and a commit-message prefix; keep config minimal and valid.

## 3. Remediate genuine yarn.lock transitive vulnerabilities via resolutions

Add a `resolutions` block to `package.json`, pinning each vulnerable transitive to at least its first patched version. Apply in clusters and run `yarn install` after each cluster to catch build-tooling breakage early (design D3/D5). All are transitive — do **not** change any direct dependency; do **not** touch `electron`.

- [ ] 3.1 **Critical first** — pin `@babel/traverse` → `7.23.2`. Run `yarn install`, then `yarn build` smoke to confirm Babel tooling still works.
- [ ] 3.2 **Babel cluster** — `@babel/core` → `7.29.6`, `@babel/helpers` → `7.26.10`, `@babel/runtime` → `7.26.10`, `@babel/plugin-transform-modules-systemjs` → `7.29.4`. `yarn install`.
- [ ] 3.3 **Runtime-scoped highs** (ship in the app) — `braces` → `3.0.3`, `form-data` → `4.0.6`, `picomatch` → `2.3.2`, `serialize-javascript` → `7.0.5`, `semver` → `7.5.2`. `yarn install`.
- [ ] 3.4 **Remaining dev/build highs** — `cross-spawn` → `7.0.5`, `flatted` → `3.4.2`, `immutable` → `4.3.8`, `svgo` → `2.8.1`, `tmp` → `0.2.6`, `undici` → `7.28.0`, `ws` → `8.21.0`, `minimatch` → `5.1.8`. `yarn install`.
- [ ] 3.5 **Medium/low** — `ajv` → `8.18.0`, `micromatch` → `4.0.8`, `nanoid` → `3.3.8`, `postcss` → `8.5.10`, `protocol-buffers-schema` → `3.6.1`, `uuid` → `11.1.1`, `yaml` → `1.10.3`, `js-yaml` → `4.1.1`, `brace-expansion` → `2.0.3`, `@babel/core` low advisory already covered. `yarn install`.
- [ ] 3.6 **Multi-major packages — pin within-major by default (per external review).** For `ajv` (v6 dev + v8 runtime), `brace-expansion` (v1 + v2), `js-yaml` (v3 + v4), `minimatch` (v3 + v5), `semver` (v6 + v7), `undici` (v6 + v7): do NOT use a single global pin — forcing all copies to one major can pass build yet crash at runtime (undici v5→v6, semver v7 API changes, minimatch v5 glob semantics). Instead patch each vulnerable major line to its own patched floor via scoped resolutions (`"<parent>/<pkg>": "<patched>"`), keeping every consumer on the major it already resolves. If a line cannot be patched without a major bump, mark that one advisory BLOCKED with a documented note (design "Open Questions") rather than forcing it.
- [ ] 3.7 Re-assert `electron` unmoved: `yarn why electron` and `grep '^electron@' yarn.lock` → `electron@41.7.2:`, and `package.json` still declares `"electron": "41.7.2"`.

## 4. Verification gate — REQUIRES MANUAL EXECUTION (build + GUI launch)

- [ ] 4.1 Run `yarn install` clean, then `yarn build` (production). Capture output; it MUST complete without error.
- [ ] 4.2 **MANUAL — runtime smoke tests mapped to updated deps (per external review):** launch the packaged/portable app and exercise the features that actually execute the bumped transitives — file-search / glob filtering (`minimatch`, `micromatch`, `braces`, `picomatch`), any socket/dev-server path (`ws`, `undici`), plus core flows (library open, gallery render, viewer). A green `yarn build` is necessary but not sufficient — the bundler never runs dependency code. Record concrete evidence per the QA-discipline gate (`docs/TODO/QA-DISCIPLINE.md`).
- [ ] 4.3 If build or launch fails, bisect to the offending resolution pin, back it out to the next-lowest patched version within the same major (or scope it), and re-run 4.1–4.2.

## 5. Confirm the resulting alert state

- [ ] 5.1 After push, trigger/await a Dependabot re-scan; confirm the 103 `package-lock.json` alerts are gone. Dependabot is slow to reconcile a deleted manifest (per external review), so **manually dismiss any lingering `package-lock.json` alerts** as "no longer applicable" rather than assuming auto-closure.
- [ ] 5.2 Confirm the genuine `yarn.lock` alerts are resolved: `gh api repos/raydollete/OneFolder/dependabot/alerts --paginate -q '.[] | select(.state=="open")'` shows no remaining critical/high from `yarn.lock` (or only entries explicitly marked BLOCKED with a documented note from 3.6).
- [ ] 5.3 Update the change's verification notes with the final open-alert count and any BLOCKED items.
