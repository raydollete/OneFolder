---
id: TASK-056
title: 'Relax watchLocations 20s timeout to 60s, reframe toast as a calm progress note, drop the misleading Retry button, per-location toast key'
investigation: INV-013
status: planned
priority: medium
blocked_by: []
date_created: 2026-05-04
date_completed:
files:
  - src/frontend/stores/LocationStore.ts
---

## What

Replace the fixed 20-second `readyTimeout` toast `This appears to be taking longer than usual.` (with its misleading `Retry?` button that reloads the renderer and restarts the same scan) with a calmer, accurate progress note: `Scanning location "<name>"… this can take a while for large folders.`. Raise the threshold to 60 seconds. Drop the click action entirely. Use a per-location toast key so cascading slow locations do not overwrite each other.

## Why

The current toast fires on every cold start of any large or slow library and frames a normally-progressing operation as a problem. The `Retry?` action reloads the entire renderer, which restarts the same scan from scratch — strictly worse than waiting. The author admitted in inline `// TODO` and `// FIXME` comments (`LocationStore.ts:140-142`) that the 20s timer was a band-aid for an unidentified intermittent hang they could not reproduce; on real-world libraries the band-aid is wrong every launch. The threshold relaxation + copy reframing is the lower-effort fix that addresses the user's pain without touching the worker contract; a real progress signal (count `'add'` events) is a separate, larger task that can follow if needed.

See [INV-013](../investigations/INV-013_MEDIUM_FRONTEND_startup-empty-location-toast-and-fragile-watch-timeout.md) for the full root-cause analysis. The investigation explicitly recategorizes this as a UX/threshold problem rather than a hung-detection bug.

## Implementation Steps

- [ ] 1. **`src/frontend/stores/LocationStore.ts:140-155` — replace the `readyTimeout` block.**

  Before:
  ```ts
  // TODO: Add a maximum timeout for init: sometimes it's hanging for me. Could also be some of the following steps though
  // added a retry toast for now, can't figure out the cause, and it's hard to reproduce
  // FIXME: Toasts should not be abused for error handling. Create some error messaging mechanism.
  const readyTimeout = setTimeout(() => {
    AppToaster.show(
      {
        message: 'This appears to be taking longer than usual.',
        timeout: 0,
        clickAction: {
          onClick: RendererMessenger.reload,
          label: 'Retry?',
        },
      },
      'retry-init',
    );
  }, 20000);
  ```

  After:
  ```ts
  // Slow-scan progress note. Fires after 60s on a single location's initial scan
  // to reassure the user that the app is still working, not stuck. NO retry button —
  // reloading the renderer would just restart the same scan from scratch.
  // (Investigation: INV-013.)
  const readyTimeout = setTimeout(() => {
    AppToaster.show(
      {
        message: `Scanning location "${location.name}"… this can take a while for large folders.`,
        timeout: 0,
      },
      `retry-init-${location.id}`,
    );
  }, 60000);
  ```

  Verification: a) The threshold is now 60000 ms. b) The `clickAction` (Retry button) is gone. c) The toast message uses the location's name. d) The toast key is per-location.

- [ ] 2. **`src/frontend/stores/LocationStore.ts:163-164` — update the dismiss key.** The matching `AppToaster.dismiss('retry-init');` after the await must be updated to:

  ```ts
  clearTimeout(readyTimeout);
  AppToaster.dismiss(`retry-init-${location.id}`);
  ```

  Verification: the dismiss path uses the same per-location key as the show path.

- [ ] 3. **Remove the unused `RendererMessenger` import if no longer needed in this file.** Check whether `RendererMessenger` is still referenced elsewhere in `LocationStore.ts` (it is imported at the top of the file). If it is referenced for other reasons, leave the import. If the only reference was the `RendererMessenger.reload` call we just removed, drop the import to keep the file clean.

  Verification: `yarn lint` does not warn about an unused import.

- [ ] 4. **Sanity-check the per-location key behavior with a multi-location library.** With two slow locations, both should be allowed to show their own progress note simultaneously rather than one overwriting the other. (This is automatic now that the key is per-location, but worth eyeballing in QA.)

- [ ] 5. **Lint and typecheck.** Run `yarn lint` to confirm no new ESLint errors. Run `yarn build` (or `yarn dev`) to confirm TypeScript strict-mode compiles.

## Done When

- [ ] The 20-second threshold is now 60 seconds.
- [ ] The toast message reads `Scanning location "<name>"… this can take a while for large folders.` (interpolating the location's `name`, which now never resolves to empty thanks to TASK-055's fallback).
- [ ] The toast no longer has a `Retry?` button or any other click action.
- [ ] The toast key is `retry-init-${location.id}` and the matching `dismiss` call uses the same key.
- [ ] The misleading inline `// TODO` and `// FIXME` comments are replaced with an accurate explanation of the new design.
- [ ] Cold launch on a small library: no progress toast appears.
- [ ] Cold launch on a large library where one location's initial scan exceeds 60s: a calm, button-less progress toast appears, naming the slow location, and dismisses cleanly when the scan completes.
- [ ] Cold launch with multiple slow locations: each gets its own toast (per-location key); they do not overwrite each other.
- [ ] `yarn lint` passes; `yarn build` typecheck passes.
