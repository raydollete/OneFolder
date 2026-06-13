---
id: TASK-031
title: 'Remove PostHog analytics init and capture from UiStore'
investigation: INV-006
status: DONE
priority: medium
blocked_by: []
date_created: 2026-04-23
date_completed: 2026-06-12
files:
  - 'src/frontend/stores/UiStore.ts'
---

## What

Remove the PostHog analytics import and the `if (!IS_DEV) { posthog.init(...); posthog.capture('my event', ...); }` block in the `UiStore` constructor. This eliminates the only outbound analytics call in the entire codebase (verified by grep across `src/` for `posthog`, `analytics`, `telemetry`, `mixpanel`, `Sentry`, `crashReporter`).

Do NOT remove the `posthog-js` dependency from `package.json` here — that is consolidated in TASK-032 together with `electron-updater` and `electron-google-analytics4` so a single `yarn install` regenerates the lockfile for all three.

## Why

The fork is a personal single-user build. Sending product analytics events to a third-party service on every non-dev launch is privacy-surprising behavior the user wants gone. The upstream project's hardcoded PostHog key and the placeholder `posthog.capture('my event', { property: 'value' })` call suggest this was never real analytics — it was starter code the upstream never replaced with meaningful events. Removal has zero impact on the upstream mental model that it was implementing, and eliminates the only "phone home" request (besides the now-removed update check) from the packaged build.

See [INV-006](../investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md) for the full context, including the verification that no other telemetry (Sentry, Google Analytics via `electron-google-analytics4`, Electron's built-in `crashReporter`) is wired up — PostHog is the complete telemetry surface to remove.

## Implementation Steps

- [x] 1. **`src/frontend/stores/UiStore.ts`** — Remove the import at line 17:
  ```ts
  import posthog from 'posthog-js';
  ```

- [x] 2. **`src/frontend/stores/UiStore.ts`** — In the `UiStore` constructor (currently lines 239-249), remove the `if (!IS_DEV) { ... }` block at lines 240-245:
  ```ts
  if (!IS_DEV) {
    posthog.init('phc_i7z5MEt8qhw2FfaTV0DH1B52Wwr9gFsFP8vsG5W8M8s', {
      api_host: 'https://eu.posthog.com',
    });
    posthog.capture('my event', { property: 'value' });
  }
  ```
  The constructor should then read approximately:
  ```ts
  constructor(rootStore: RootStore, storageKeyPrefix = '') {
    this.rootStore = rootStore;
    this.storageKeyPrefix = storageKeyPrefix;
    makeObservable(this);
  }
  ```

- [x] 3. **Verify `IS_DEV` is still imported and used elsewhere.** Grep confirmed `IS_DEV` appeared only twice in the file: the import and the PostHog gate. No other references remain after removal — `IS_DEV` import was also removed.

- [x] 4. **Verify no other file in `src/` imports `posthog-js`.** Grep for "posthog" across `src/**/*.{ts,tsx}` returned zero matches.

- [ ] 5. **Verify `yarn build` succeeds** with no TypeScript errors. (Deferred — batched build at investigation end per project memory.)

- [ ] 6. **Verify runtime:** run `yarn start` against the watch build. (Deferred — batched verification at investigation end.)

- [ ] 7. **Verify packaged build:** run `yarn package:portable`, launch `dist/brave.exe`. (Deferred — batched at investigation end.)

- [ ] 8. Commit with a message like "Remove PostHog analytics for personal fork (INV-006)". (Deferred — batched at investigation end.)

## Done When

- [ ] `src/frontend/stores/UiStore.ts` contains no `import posthog` statement and no `posthog.init` / `posthog.capture` calls.
- [ ] `grep -rn "posthog" src/ --include="*.ts" --include="*.tsx"` returns zero matches.
- [ ] `yarn build` succeeds.
- [ ] `yarn start` launches without error; the UiStore constructs cleanly.
- [ ] Packaged `brave.exe` makes no outbound request to `eu.posthog.com` (verified by network monitor or DevTools).
- [ ] If `IS_DEV` was imported solely for the PostHog gate, its import is also removed. Otherwise the import stays.
