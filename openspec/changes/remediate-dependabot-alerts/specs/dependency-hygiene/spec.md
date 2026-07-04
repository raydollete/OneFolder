## ADDED Requirements

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

The project SHALL NOT carry open critical- or high-severity Dependabot advisories that originate from `yarn.lock` without a remediation. Remediation of a vulnerable transitive dependency SHALL be a `resolutions` pin in `package.json` to at least the advisory's first patched version, reflected in a regenerated `yarn.lock`. A direct `electron` upgrade SHALL NOT be used as a remediation — `electron` is pinned at `41.7.2` (Electron 42 is blocked by better-sqlite3 V8 incompatibility).

#### Scenario: Vulnerable transitive dependency is pinned to a patched version

- **WHEN** a `yarn.lock`-sourced advisory reports a first patched version for a transitive dependency
- **THEN** `package.json` `resolutions` pins that dependency at or above the patched version, and `yarn.lock` resolves it accordingly

#### Scenario: Electron pin is preserved during remediation

- **WHEN** dependency remediation is applied
- **THEN** `package.json` still declares `"electron": "41.7.2"` and `yarn.lock` still resolves `electron@41.7.2`

### Requirement: Remediation preserves a working build

Dependency remediation SHALL NOT break the application build or launch. After `resolutions` pins are applied and `yarn.lock` is regenerated, a production build (`yarn build`) SHALL succeed and the packaged app SHALL start.

#### Scenario: Build and launch verified after remediation

- **WHEN** `resolutions` pins are applied and dependencies are reinstalled
- **THEN** `yarn build` completes without error and the app launches successfully
