# dependency-hygiene

## Purpose

Codifies how this OneFolder fork manages its dependency tree and security alerts: Yarn is the single lockfile authority (no committed npm lockfile), Dependabot scanning is scoped accordingly, no open critical/high advisories persist unaddressed, and remediation must never break the build or move the `electron` pin. This gives dependency work a durable, verifiable contract.

## Requirements

### Requirement: Yarn is the single lockfile authority

The project SHALL maintain exactly one dependency lockfile — `yarn.lock` — as the authoritative record of the installed dependency tree. No npm lockfile (`package-lock.json`) SHALL be committed to the repository, because this fork installs exclusively via Yarn (`packageManager: yarn@1.22.22`) and a second lockfile both drifts out of sync with the real tree and duplicates security scanning against packages the app does not ship.

#### Scenario: Repository contains no npm lockfile

- **WHEN** the repository working tree is inspected (`git ls-files`)
- **THEN** no `package-lock.json` is tracked at any path

#### Scenario: yarn.lock is the resolved tree of record

- **WHEN** a dependency's installed version must be determined
- **THEN** it is read from `yarn.lock`, which resolves the same versions `package.json` pins (e.g. `electron@41.7.2`)

### Requirement: Dependabot scanning is scoped to the Yarn ecosystem

The repository SHALL provide a `.github/dependabot.yml` configuration that scopes automated scanning to the `npm` ecosystem at the repository root, so alerts track only `yarn.lock` and a regenerated npm lockfile cannot silently reintroduce phantom alerts.

#### Scenario: Dependabot config exists and targets the npm ecosystem

- **WHEN** `.github/dependabot.yml` is read
- **THEN** it declares a version-2 config with a `package-ecosystem: "npm"` entry rooted at `/`

### Requirement: No unaddressed critical or high advisories

The project SHALL NOT carry open critical- or high-severity Dependabot advisories that originate from `yarn.lock` without a remediation. Remediation SHALL ensure `yarn.lock` resolves the vulnerable transitive dependency at or above the advisory's first patched version — normally via a `resolutions` pin in `package.json`, or, where Yarn 1 classic cannot express a safe per-major pin (a bare-global pin collapses every major of a package to a single version and breaks API-incompatible consumers), by re-resolving that package's stale lockfile entry to its patched latest-in-range version. A direct `electron` upgrade SHALL NOT be used as a remediation — `electron` is pinned at `41.7.2` (Electron 42 is blocked by better-sqlite3 V8 incompatibility). An advisory that cannot be cleared without a major-version bump of a runtime transitive MAY be recorded as a documented BLOCKED exception rather than forced.

#### Scenario: Vulnerable transitive dependency is resolved to a patched version

- **WHEN** a `yarn.lock`-sourced advisory reports a first patched version for a transitive dependency
- **THEN** `yarn.lock` resolves that dependency at or above the patched version — via a `package.json` `resolutions` pin, or via lockfile re-resolution for multi-major packages that cannot be safely pinned

#### Scenario: Multi-major package keeps each major on its own line

- **WHEN** a package is present at multiple incompatible major versions and only some are vulnerable
- **THEN** remediation patches each vulnerable major line to its own patched floor without collapsing all consumers onto a single major

#### Scenario: Electron pin is preserved during remediation

- **WHEN** dependency remediation is applied
- **THEN** `package.json` still declares `"electron": "41.7.2"` and `yarn.lock` still resolves `electron@41.7.2`

#### Scenario: Unpatchable advisory is recorded as a documented exception

- **WHEN** an advisory can only be cleared by a major-version bump of a runtime transitive whose behavior cannot be safely verified
- **THEN** it is recorded as a BLOCKED exception with a rationale rather than forced

### Requirement: Remediation preserves a working build

Dependency remediation SHALL NOT break the application build or launch. After remediation is applied and `yarn.lock` is regenerated, a production build (`yarn build`) SHALL succeed and the packaged app SHALL start. Remediation SHALL NOT drift the build toolchain (e.g. `webpack`, `@types/node`) beyond what the security patches require.

#### Scenario: Build and launch verified after remediation

- **WHEN** remediation is applied and dependencies are reinstalled
- **THEN** `yarn build` completes without error and the app launches successfully
