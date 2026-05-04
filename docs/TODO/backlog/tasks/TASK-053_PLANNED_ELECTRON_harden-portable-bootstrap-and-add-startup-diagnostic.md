---
id: TASK-053
title: 'Harden portable-mode bootstrap with try/catch around ensureDirSync and add startup diagnostic logging'
investigation: INV-012
status: PLANNED
priority: medium
blocked_by: [TASK-052]
date_created: 2026-05-03
date_completed:
files:
  - 'src/main.ts'
---

## What

Add defensive error handling around the portable-mode bootstrap in `src/main.ts:36-58` and a structured startup diagnostic that makes it visible — to both the developer console and (optionally) Settings → Advanced — exactly which `userData` path the app resolved, and whether portable mode was triggered. This task is a purely additive change: no behavior change to the happy path, only failure-mode visibility and observability of the resolved persistence location. The trigger to do this is INV-012's "silent-failure" diagnosis: today, if portable redirection ever fails (e.g., the data dir cannot be created on a read-only mount), there is no audit trail telling the user or a future maintainer what went wrong.

## Why

Per INV-012's root-cause analysis, the portable-mode bootstrap is correct in design but has no observability surface. If a future regression causes `userData` to silently land somewhere other than `<exe-dir>/data/` — whether due to an electron-builder change, a Windows policy issue, or a path-resolution edge case — the only symptom the user sees is "preferences don't persist," with no way to confirm or diagnose. This task closes that gap.

The defensive wrapping around `fse.ensureDirSync` also addresses INV-012 §Diagnosis Scenario 3a: if `<outer-exe-dir>` is not writable for the current user (read-only mount, locked-down corporate Windows policy, antivirus hold), today the unhandled synchronous throw propagates out of module load and Electron crashes with a generic startup error. A try/catch with a clear error dialog is much better.

This task is blocked by TASK-052 because if TASK-052 surprises by finding an actual bug, the fix for that bug should come first and this hardening might need to be re-scoped against it.

See [INV-012](../investigations/INV-012_HIGH_ELECTRON_portable-build-not-persisting-userdata.md).

## Implementation Steps

- [ ] 1. **Wrap the portable-mode `ensureDirSync` calls in a try/catch.** In `src/main.ts:45-55`, replace the bare `fse.ensureDirSync(...)` calls with:

    ```ts
    if (IS_PORTABLE_MODE) {
      const portableDataDir = path.join(_portableAppDir, 'data');
      try {
        fse.ensureDirSync(portableDataDir);
        fse.ensureDirSync(path.join(portableDataDir, 'backups'));
        fse.ensureDirSync(path.join(portableDataDir, 'thumbnails'));
        fse.ensureDirSync(path.join(portableDataDir, 'themes'));
        app.setPath('userData', portableDataDir);
        app.setPath('temp', portableDataDir);
      } catch (e) {
        // The portable data directory could not be created — most likely
        // <outer-exe-dir> is read-only, or AV/policy is blocking writes.
        // Falling back to Electron's default userData path silently would
        // produce the exact "fresh install every launch" symptom INV-012
        // documents. Surface a fatal dialog instead.
        const msg = `OneFolder is running in portable mode but could not create its data directory at:\n\n${portableDataDir}\n\nReason: ${e instanceof Error ? e.message : String(e)}\n\nMove brave.exe to a directory you can write to (e.g. your Documents folder, the Desktop, or a USB drive), or remove portable mode by deleting any 'data' folder or 'portable.txt' file next to the executable.`;
        // app.whenReady() has not fired yet, so showErrorBox is the only
        // dialog API guaranteed to work at this stage.
        const { dialog } = require('electron');
        dialog.showErrorBox('OneFolder: portable data directory error', msg);
        app.exit(1);
      }
    }
    ```

    Verify by mentally walking through the cases:
    - Happy path (data dir creatable): no behavior change.
    - Read-only mount: dialog shown, `app.exit(1)` — user sees a clear message instead of a generic Electron crash.
    - Permission denied (e.g., user dropped `brave.exe` into `Program Files\` without elevation): same handling.
    - The `require('electron')` inside the catch is necessary because `dialog` is not at the top of the file as a module-scoped import — `src/main.ts:7` only imports `dialog` as part of the named imports list, so it's already available. **Refinement:** if `dialog` is already imported (it is — `src/main.ts:6`), use the imported binding directly instead of re-`require`ing it. Verify by reading `src/main.ts:1-13`.

- [ ] 2. **Add a structured startup diagnostic log line.** Immediately after `setPortableMode(IS_PORTABLE_MODE)` at `src/main.ts:58`, before the `const basePath = app.getPath('userData')` line at `src/main.ts:60`, add:

    ```ts
    // INV-012: visible audit trail for the resolved userData path.
    // Persists in console output (DevTools, terminal in dev, Windows Event Viewer
    // for crash-redirect cases) so any future regression in portable persistence
    // is diagnosable without re-doing the source-code analysis.
    {
      const resolvedUserData = app.getPath('userData');
      console.info(
        `[startup] portable=${IS_PORTABLE_MODE}, ` +
          `userData=${resolvedUserData}, ` +
          `_portableAppDir=${_portableAppDir}, ` +
          `PORTABLE_EXECUTABLE_DIR=${process.env.PORTABLE_EXECUTABLE_DIR ?? '(unset)'}`,
      );
    }
    ```

    Confirm the line fires on `yarn start` by watching the dev console; it should print something like `[startup] portable=true, userData=D:\Dev\OneFolder\data, _portableAppDir=D:\Dev\OneFolder, PORTABLE_EXECUTABLE_DIR=(unset)`.

- [ ] 3. **(Optional) Surface the resolved path in Settings → Advanced as a read-only diagnostic.** This step is genuinely optional — the core deliverable is steps 1 and 2. If the reviewer prefers to keep the Settings panel narrow, skip this step.
    - Add a new IPC method `MainMessenger.onGetUserDataPath` returning `app.getPath('userData')`. It exists already as `onGetPath` (`src/main.ts:686`), so use that with the `'userData'` argument from the renderer; no new IPC method is required.
    - In `src/frontend/containers/Settings/Advanced.tsx` (or the appropriate Advanced panel file — locate via the existing `Switch Library` button which lives in Advanced per `docs/multi-library.md:88`), add a small `<div>` showing:
      ```
      Portable mode: {IS_PORTABLE ? 'Yes' : 'No'}
      Data directory: {userDataPath}
      ```
    - Style with the existing `info` / `diagnostic` widget pattern in the Settings panels — do NOT add new styles unless none exist.
    - Verify: open Settings → Advanced in dev. Expect to see the path and the portable flag.

- [ ] 4. **Smoke test the changes.**
    - Run `yarn lint` — no new lint errors.
    - Run `yarn dev` and `yarn start` in two terminals. Confirm the app launches, the new startup log line appears, and Settings → Advanced (if step 3 was done) shows the data directory.
    - Run `yarn package:portable`. Copy `dist\brave.exe` to a fresh test dir (use the same approach as TASK-052 step 2). Launch. Confirm the startup log is visible (open DevTools or run with `--enable-logging` to capture stdout).
    - Run `yarn package:portable`. Copy `dist\brave.exe` to a directory the current user CANNOT write to (e.g. `C:\Program Files\OneFolderTest\` if available, or change ACLs on a temp dir to remove write access). Launch. Confirm the new error dialog from step 1 fires. Confirm `app.exit(1)` happens and no `data\` is silently created elsewhere.

- [ ] 5. **Lint and test pass.** `yarn lint` clean. Existing tests pass (`yarn test`). No new tests required for this task — the failure mode is environmental and not unit-testable without significant fixture machinery; the manual checks in step 4 cover it.

## Done When

- [ ] Step 1: `fse.ensureDirSync` calls in the portable bootstrap are wrapped in try/catch with a user-facing error dialog and `app.exit(1)` on failure.
- [ ] Step 2: a `console.info` line at startup logs the resolved `userData` path, the portable-mode flag, the `_portableAppDir` value, and whether `PORTABLE_EXECUTABLE_DIR` was set. The line appears in dev mode and in packaged mode (via DevTools).
- [ ] Step 3 (optional): Settings → Advanced shows the data directory and the portable flag.
- [ ] Step 4: smoke tests pass — happy path unchanged; read-only-dir path shows the dialog; startup log visible.
- [ ] Step 5: `yarn lint` clean; `yarn test` passes.
