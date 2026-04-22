---
id: TASK-020
title: 'Defer exit and scrub portable env in forceRelaunch to stabilize Windows portable restart'
investigation: INV-003
status: planned
priority: low
blocked_by: []
date_created: 2026-04-21
date_completed:
files:
  - 'src/main.ts'
---

## What

Harden `forceRelaunch()` in `src/main.ts:976-999` for the NSIS Windows portable target. Two changes:

1. Strip `PORTABLE_EXECUTABLE_FILE` and `PORTABLE_EXECUTABLE_DIR` from the env passed to the spawned child, so the new process re-bootstraps through the outer portable wrapper instead of inheriting the parent's (about-to-be-wiped) NSIS extraction paths.
2. Defer `app.exit(0)` until Electron has released its own handles — either `app.quit()` followed by `app.once('will-quit', (e) => { e.preventDefault(); app.exit(0); })`, or move the `spawn` call inside a `will-quit` handler so the child is launched only once Electron is genuinely ready to go.

Do **not** remove or replace `forceRelaunch`. Its choice over `app.relaunch()` is deliberate and documented in the existing code comment.

## Why

On the Windows portable target, `spawn(...).unref()` followed by synchronous `app.exit(0)` is a race: the parent NSIS wrapper wipes its temp dir on exit, and whether the spawned child has detached far enough to survive is non-deterministic. Losses of that race present as "app got killed and never came back." Additionally, inheriting `PORTABLE_EXECUTABLE_*` in the child's env can confuse the outer wrapper's bootstrap logic because those vars still point at the parent's soon-to-be-gone extraction.

See [INV-003](../investigations/INV-003_LOW_BACKEND_database-restore-intermittent-failures.md).

## Implementation Steps

- [ ] 1. In `src/main.ts`, locate `forceRelaunch()` (around line 976). Build the child env by starting from `{ ...process.env }` and deleting `PORTABLE_EXECUTABLE_FILE` and `PORTABLE_EXECUTABLE_DIR`. Pass this sanitized env to `spawn` instead of `process.env`.

- [ ] 2. Replace the synchronous `app.exit(0)` with deferred exit. Preferred shape:

  ```ts
  app.once('will-quit', (event) => {
    event.preventDefault();
    spawn(exe, args, { detached: true, stdio: 'ignore', env: childEnv, windowsHide: true }).unref();
    app.exit(0);
  });
  app.quit();
  ```

  The `spawn` moves inside `will-quit` so Electron has already released window/file handles before the child starts. `windowsHide: true` prevents a transient console window flash on Windows. Keep the existing `detached`, `stdio`, and `unref()` semantics.

- [ ] 3. Preserve the existing comment block above the function (it documents why `app.relaunch()` is not used). Extend the comment to note the new `will-quit` deferral and the env scrub, so the next reader understands both choices.

- [ ] 4. Grep `src/main.ts` and `src/` for any existing `app.on('will-quit', ...)` / `app.once('will-quit', ...)` registrations. There should be none today; if any are added later they will coexist with this handler, which is fine — `will-quit` can have multiple listeners — but confirming keeps the risk assessment honest.

- [ ] 5. Verify dev workflow still works: `yarn dev` + `yarn start`, trigger a restart via the menu Restart item (`src/main.ts:276`) or the restore flow, confirm the app relaunches. The non-portable path uses `process.execPath` + `[process.argv[1]]` and the env scrub is a no-op there (those env vars are unset), so dev should be unaffected.

- [ ] 6. Manual verification on the portable target (this is the only meaningful verification for the race itself):
  - `yarn package` with the Windows portable target.
  - Copy the resulting portable `.exe` to a fresh empty directory.
  - Launch it, create or open a library, create some state.
  - Trigger a restore from Settings > ImportExport using a backup `.db`.
  - Confirm the app relaunches once (no "just quit" symptom) and the restored data is visible.
  - Repeat 3-5 times to confirm the intermittent failure is gone. (It is intermittent, so a single success is not sufficient evidence.)

## Done When

- [ ] `forceRelaunch` scrubs `PORTABLE_EXECUTABLE_FILE` and `PORTABLE_EXECUTABLE_DIR` from the child env.
- [ ] Exit is deferred via `will-quit` (spawn happens inside the handler, `app.exit(0)` follows).
- [ ] The existing rationale comment is preserved and extended to describe the new behaviour.
- [ ] Dev workflow (`yarn dev` / `yarn start`) relaunch still works.
- [ ] Manual verification on a packaged Windows portable build copied to a fresh directory: at least 3 consecutive restore attempts complete cleanly (no "just quit", no blank data — the blank-data path is covered by TASK-019).
