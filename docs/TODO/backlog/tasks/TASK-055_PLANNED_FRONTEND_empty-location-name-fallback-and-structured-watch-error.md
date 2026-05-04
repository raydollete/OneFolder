---
id: TASK-055
title: 'Empty-location-name fallback, isReady wiring, structured chokidar error payload, and per-location error toast'
investigation: INV-013
status: planned
priority: medium
blocked_by: []
date_created: 2026-05-04
date_completed:
files:
  - src/frontend/entities/Location.ts
  - src/frontend/workers/folderWatcher.worker.ts
  - src/frontend/stores/LocationStore.ts
---

## What

Fix the `An error has occurred while initializing location ""` startup toast at its three root causes: (1) `ClientLocation.name` falls through to a non-empty fallback when `path.basename` returns empty (drive roots, UNC roots, POSIX `/`); (2) `ClientLocation.isReady` is actually set to `true` after the initial chokidar scan resolves so the watch-vs-initialize distinction works; (3) the chokidar `error` channel from `folderWatcher.worker` posts a structured `{ message, code?, path? }` payload that the receiver consumes to render a useful toast; (4) error toasts during initial scan are suppressed (they are noise from system-protected subdirectories like `System Volume Information`, `$RECYCLE.BIN`); (5) the `'location-error'` toast key becomes per-location so concurrent errors do not overwrite each other; (6) `LocationStore.create()` and `LocationStore.init()` reject / filter empty-path rows.

## Why

A persisted location whose `path` is a Windows drive root (`D:\`) or UNC root produces an empty `name` because `SysPath.basename('D:\\')` returns `''`. During the initial chokidar scan, drive roots reliably emit permission errors on system-protected subdirectories, which the worker forwards to the renderer as an `error` event. The renderer renders a generic toast `An error has occurred while initializing location ""` — empty quotes because of the empty `name`, no actionable detail because the error payload is mistyped as `string` while the worker actually sends an `Error` object. The toast is therefore both incorrectly named and information-free, on every startup.

See [INV-013](../investigations/INV-013_MEDIUM_FRONTEND_startup-empty-location-toast-and-fragile-watch-timeout.md) for the full root-cause and blast-radius analysis.

## Implementation Steps

- [ ] 1. **`src/frontend/entities/Location.ts:130-132` — empty-name fallback.** Replace the `name` getter body with:

  ```ts
  get name(): string {
    const base = SysPath.basename(this.path);
    return base || this.path || '(unnamed)';
  }
  ```

  Verification: in DevTools console after launch, `rootStore.locationStore.locationList[i].name` returns a non-empty string for every location, including any drive-root location.

- [ ] 2. **`src/frontend/entities/Location.ts:75 + ~317` — wire `isReady`.** Find the `isReady` field declaration (line 75, currently `private isReady = false`) and confirm the field exists. Then in `watch(directory)` (around line 317), AFTER `const initialFiles = await this.worker.watch(directory, this.extensions);` resolves, add:

  ```ts
  this.isReady = true;
  ```

  Place it BEFORE the `return initialFiles.filter(...)` line so the assignment is visible to subsequent worker error events. Verification: trigger a watch-time error (e.g., disconnect an external drive mid-session) and confirm the toast says "watching location" rather than "initializing location".

- [ ] 3. **`src/frontend/workers/folderWatcher.worker.ts:132-135` — structured error payload.** Replace the `.on('error', ...)` body with:

  ```ts
  .on('error', (error) => {
    const errnoErr = error as NodeJS.ErrnoException;
    console.error('Error fired in watcher', directory, error);
    ctx.postMessage({
      type: 'error',
      value: {
        message: error.message,
        code: errnoErr.code,
        path: errnoErr.path,
      },
    });
  });
  ```

  Verification: TypeScript compiles in strict mode; `code` and `path` are optional so a non-`ErrnoException` error still serializes its `message`.

- [ ] 4. **`src/frontend/entities/Location.ts:278-312` — receiver type union and structured consumption.** Update the `worker.onmessage` handler's type union from:

  ```ts
  data: { type: 'remove' | 'error'; value: string } | { type: 'add'; value: FileStats };
  ```
  to:
  ```ts
  data:
    | { type: 'remove'; value: string }
    | { type: 'add'; value: FileStats }
    | { type: 'error'; value: { message: string; code?: string; path?: string } };
  ```

  Then in the `data.type === 'error'` branch, do:

  - If `!this.isReady` → log only:
    ```ts
    console.warn('Suppressed initial-scan error from location', this.name, value);
    return;
    ```
  - If `this.isReady` → toast with the new copy and per-location key:
    ```ts
    const detail = value.code
      ? `${value.code}${value.path ? ' ' + value.path : ''}`
      : value.message;
    AppToaster.show(
      {
        message: `Could not access "${this.name}": ${detail}`,
        timeout: 0,
      },
      `location-error-${this.id}`,
    );
    ```

  Note the new toast copy fixes the "occured" → "occurred" typo as a side effect. Verification: post-startup, disconnecting an external drive yields a toast naming the drive (e.g., `D:\`) and showing a real error code/path.

- [ ] 5. **`src/frontend/stores/LocationStore.ts:365-378` (`create`) — reject empty paths.** At the top of the function, before the `new ClientLocation(...)` call:

  ```ts
  const trimmed = path.trim();
  if (trimmed === '') {
    throw new Error('Cannot create a location with an empty path');
  }
  ```

  Verification: in a dev console, calling `rootStore.locationStore.create('')` throws synchronously.

- [ ] 6. **`src/frontend/stores/LocationStore.ts:62-97` (`init`) — filter empty-path rows on load.** After `const dirs = await this.backend.fetchLocations();` and before the `dirs.sort(...)` call, add:

  ```ts
  const validDirs = dirs.filter((dir) => {
    if (!dir.path || dir.path.trim() === '') {
      console.warn('Skipping malformed location row with empty path', dir.id);
      return false;
    }
    return true;
  });
  ```

  Then change the subsequent `dirs.sort` and `dirs.map` to operate on `validDirs`. Verification: insert a row with `path=''` directly via SQLite (`UPDATE locations SET path='' WHERE id='...'`), launch, observe the console warning and confirm the row does not appear in the sidebar.

- [ ] 7. **Lint and typecheck.** Run `yarn lint` to confirm no new ESLint errors. Run `yarn build` (or `yarn dev`) to confirm TypeScript strict-mode compiles after the type union widening.

## Done When

- [ ] `ClientLocation.name` never returns the empty string for any non-empty `path`.
- [ ] `ClientLocation.isReady` is set to `true` after the initial chokidar scan resolves; the toast `isReady ? 'watching' : 'initializing'` ternary picks the right branch post-startup.
- [ ] `folderWatcher.worker.ts` posts a structured `{ message, code?, path? }` payload for chokidar errors.
- [ ] The renderer's worker `onmessage` receiver consumes the structured payload and includes the code/path in the user-facing toast.
- [ ] Chokidar errors during initial scan (`!isReady`) are logged to console but do NOT raise a toast.
- [ ] The toast key for chokidar errors is per-location (`location-error-${id}`), not the shared `'location-error'`.
- [ ] `LocationStore.create()` throws if `path` is empty or whitespace.
- [ ] `LocationStore.init()` filters out rows with empty `path` and logs a warning per skipped row.
- [ ] Cold launch with a drive-root location (e.g., `D:\`) produces NO startup error toast and renders the location's label as `D:\` (or its full path) in the sidebar — never as an empty string.
- [ ] Disconnecting an external drive mid-session while a location on it is being watched produces a toast like `Could not access "D:\": EBUSY <path>` (or whatever the chokidar error reports), with a per-location key.
- [ ] `yarn lint` passes; `yarn build` typecheck passes.
