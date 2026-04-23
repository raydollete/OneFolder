---
id: TASK-032
title: 'Drop electron-updater / posthog-js / electron-google-analytics4 deps, remove publish config and yarn release script'
investigation: INV-006
status: PLANNED
priority: medium
blocked_by: [TASK-029, TASK-030, TASK-031]
date_created: 2026-04-23
date_completed:
files:
  - 'package.json'
  - 'package-lock.json'
  - 'yarn.lock'
---

## What

Consolidated dependency and build-config cleanup that runs after the three source-code strip-outs (TASK-029 removes the `electron-updater` imports, TASK-030 removes the `createBugReport` / `githubUrl` imports, TASK-031 removes the `posthog-js` import). With no remaining code references, this task:

1. Drops `electron-updater` from `dependencies`.
2. Drops `posthog-js` from `dependencies`.
3. Drops `electron-google-analytics4` from `dependencies` (it was never imported — confirmed by grep in INV-005 §14 and re-verified in INV-006).
4. Removes the top-level `publish` block (lines 84-89) that points at `OneFolderApp/OneFolder` GitHub releases.
5. Removes the `scripts.release` entry (line 23) that pushes to `origin` — dangerous if `origin` ever points to the upstream repo.
6. Runs `yarn install` to regenerate `yarn.lock` and `package-lock.json` with the transitive deps of the three removed packages cleaned up.

## Why

These dependencies and config blocks are upstream-distribution surface area with no fork-local use. Leaving them installed bloats `node_modules/` (electron-updater in particular pulls in `lazy-val`, `builder-util-runtime`, `js-yaml`, `semver`, `lru-cache` and others), wastes install and package time, and leaves a dormant `publish` config that could accidentally upload fork artifacts to the public GitHub release page if any future electron-builder command ever runs with `--publish`.

`scripts.release` is particularly risky: it does `git add . && git commit && git push && git push --tags` against whatever `origin` is set to. A user who keeps the upstream as `origin` (or typos a remote) would push fork-local changes (including the `brave.exe` rename) to the public repo on a single `yarn release` invocation.

This task is sequenced LAST among the code-removal tasks because deleting a dependency while imports still exist would break the build. After TASK-029/030/031 land, all three dep imports are gone, and this task is a safe subtraction.

See [INV-006](../investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md) §Blast Radius items 12, 28, 29, 30.

## Implementation Steps

- [ ] 1. **Confirm prerequisite tasks are merged.** Run:
  ```
  grep -rn "electron-updater\|autoUpdater\|posthog\|googleAnalytics\|ga4" src/ common/ --include="*.ts" --include="*.tsx"
  ```
  Expect zero matches. If any match exists, that prerequisite task is not yet complete — do NOT proceed with dep removal.

- [ ] 2. **Edit `package.json` `dependencies`:**
  - Remove line 147: `"electron-google-analytics4": "^1.1.1",`
  - Remove line 148: `"electron-updater": "^6.1.7",`
  - Remove line 156: `"posthog-js": "^1.96.1",`

  Be careful with trailing commas. After the three removals, `dependencies` should be syntactically valid JSON (the line that follows each removal becomes the new "line before a comma" if applicable).

- [ ] 3. **Edit `package.json` — remove the top-level `publish` block** (currently lines 84-89):
  ```json
  "publish": {
    "provider": "github",
    "owner": "OneFolderApp",
    "repo": "OneFolder",
    "releaseType": "release"
  },
  ```
  Remove the entire block including its trailing comma. The preceding key is `"repository"` (line 83) — keep its trailing comma IF a key follows it (which there will be — `"author"` at line 90). Result: `"repository": ...,` then blank line(s) then `"author": "OneFolder",`.

- [ ] 4. **Edit `package.json` — remove `scripts.release`** (currently line 23):
  ```json
  "release": "git add . && git commit -m \"v$npm_package_version\" && git tag \"v$npm_package_version\" && git push && git push --tags"
  ```
  Remove the line. Adjust the preceding line's trailing comma: `scripts.release` is the last entry in the `scripts` object (verify — `"build:exr"` is line 22), so after removal the `"build:exr"` line needs its trailing comma removed so the `scripts` object still closes cleanly.

- [ ] 5. **Run `yarn install`.** Expect:
  - `yarn.lock` to be regenerated (the three removed packages and their unique transitive deps should be absent).
  - `package-lock.json` to be regenerated if present (this project uses Yarn, so `package-lock.json` may be stale or a remnant — verify; if it exists, running `npm install` separately would re-sync it, but this project's workflow is yarn-only, so `package-lock.json` may be ignored in practice. Update it only if the team maintains both; otherwise leave it to drift.)
  - `node_modules/electron-updater`, `node_modules/posthog-js`, and `node_modules/electron-google-analytics4` to be removed from the tree.

- [ ] 6. **Verify lockfile diff.** `git diff yarn.lock` should show only removals (no additions). If additions appear, a transitive dep was previously deduped under one of the removed packages and is now re-resolved to a different version — usually harmless, but worth a glance.

- [ ] 7. **Run `yarn build`.** Expect no TypeScript errors. If any "Cannot find module 'electron-updater'" or similar errors appear, a stale import slipped through the prerequisite tasks — fix it (should not happen given step 1's grep, but belt and suspenders).

- [ ] 8. **Run `yarn start`.** The app should launch successfully with no runtime errors. No missing-module warnings in the console.

- [ ] 9. **Run `yarn package:portable`.** The build should succeed. The resulting `dist/brave.exe` should be marginally smaller than before (the three dropped packages and their transitive deps are no longer bundled). Approximate size delta: a few MB (electron-updater + its deps are ~1-2 MB; posthog-js is ~1 MB; electron-google-analytics4 plus its deps including core-js is ~2-3 MB). Not a QA-blocker, just informational.

- [ ] 10. **Verify no `yarn release` foot-gun.** Run `yarn release` — it should print `error Command "release" not found.` (because the script was removed in step 4). If it instead executes a git command, step 4 did not complete; re-check the edit.

- [ ] 11. **Verify no accidental `--publish` surprise.** Run `npx electron-builder --help | grep -i publish` (or read the electron-builder docs). Confirm that without the `publish` block in package.json, running `yarn package` without `--publish` does NOT upload anywhere. (This has always been the default; step 3 is belt-and-suspenders against a future explicit `--publish never` setting being overridden.)

- [ ] 12. Commit with a message like "Drop electron-updater, posthog-js, GA4 deps and publish config (INV-006)".

## Done When

- [ ] `package.json` `dependencies` contains no `electron-updater`, `posthog-js`, or `electron-google-analytics4`.
- [ ] `package.json` has no top-level `publish` block.
- [ ] `package.json` `scripts` has no `release` entry.
- [ ] `yarn install` completes without error.
- [ ] `yarn.lock` no longer contains entries for the three removed packages.
- [ ] `node_modules/electron-updater`, `node_modules/posthog-js`, and `node_modules/electron-google-analytics4` do not exist after `yarn install`.
- [ ] `yarn build` succeeds with zero TypeScript errors.
- [ ] `yarn start` launches the app without error.
- [ ] `yarn package:portable` produces `dist/brave.exe` successfully.
- [ ] `yarn release` prints a "Command not found" error (confirming the script is gone).
