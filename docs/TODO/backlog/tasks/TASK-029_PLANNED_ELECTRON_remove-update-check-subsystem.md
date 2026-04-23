---
id: TASK-029
title: 'Remove auto-update subsystem (electron-updater wiring, IPC, UI, dev config)'
investigation: INV-006
status: PLANNED
priority: medium
blocked_by: []
date_created: 2026-04-23
date_completed:
files:
  - 'src/main.ts'
  - 'src/ipc/messages.ts'
  - 'src/ipc/main.ts'
  - 'src/ipc/renderer.ts'
  - 'src/frontend/containers/AppToolbar/SecondaryCommands.tsx'
  - 'src/frontend/containers/Settings/StartupBehavior.tsx'
  - 'src/frontend/containers/Settings/index.tsx'
  - 'dev-app-update.yml'
---

## What

Remove every reference to `electron-updater` / `autoUpdater` from the source, delete the accompanying IPC plumbing, the toolbar "check for updates" menu item, the (already-disabled) StartupBehavior settings tab, and the `dev-app-update.yml` dev-mode config file. Do NOT yet remove the `electron-updater` dependency from `package.json` — that is consolidated in TASK-032 so that a single `yarn install` regenerates the lockfile for all three dep removals.

After this task, the app has no code path that attempts to check, download, or dialog about updates. The fork user updates by rebuilding `brave.exe` from the local git checkout.

## Why

This fork is a personal single-user portable-only Windows build whose binary basename (`brave.exe`) diverges from the upstream release channel (per INV-005). Auto-updates against the upstream GitHub release channel are useless at best and actively harmful at worst — they would attempt to replace the VSR-renamed binary with an upstream `OneFolder.exe` and silently regress INV-005's rename. The startup check is already suppressed in portable mode, but the IPC-triggered "check for updates" menu item is still live and steers portable-mode users to a dialog offering to open the upstream releases page.

Removal (rather than a fork-local feature flag) matches the narrowest-hammer pattern established by INV-005: keeps fork maintenance surface small, makes upstream-rebase merge conflicts loud (so PostHog/update wiring cannot silently come back), and requires no new UI.

See [INV-006](../investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md) for the full blast-radius enumeration.

## Implementation Steps

- [ ] 1. **`src/main.ts`** — Remove the auto-update import at line 17:
  ```ts
  import { autoUpdater, UpdateInfo } from 'electron-updater';
  ```

- [ ] 2. **`src/main.ts`** — Remove the `PreferencesFile` type, the `preferences` variable, and the `updatePreferences` helper (currently lines 87-94). The only field in the type (`checkForUpdatesOnStartup`) is being removed and no other code writes or reads preferences.json. If a future fork-local preference ever appears, this subsystem can be re-added in that change. Do NOT delete the existing `preferences.json` file on disk in users' `userData/` — it becomes a dead file, harmless.

- [ ] 3. **`src/main.ts`** — In `initialize()` (currently lines 99-134), remove the try/catch block at lines 117-133 that loads preferences and triggers `autoUpdater.checkForUpdates()`. After removal, `initialize()` ends at the session `onHeadersReceived` + `createWindow()` + `createPreviewWindow()` calls.

- [ ] 4. **`src/main.ts`** — Remove the entire "Auto-updates" section (currently lines 456-544), starting with the comment banner `// Auto-updates: using electron-builders autoUpdater: ...` and including `autoUpdater.autoDownload = false;`, the `hasCheckedForUpdateOnStartup` flag, the `IS_DEV` `updateConfigPath` block, and all five event handlers (`error`, `update-available`, `update-not-available`, `update-downloaded`, `download-progress`).

- [ ] 5. **`src/main.ts`** — Remove the IPC handlers at lines 732-761:
  ```ts
  MainMessenger.onCheckForUpdates(async () => { ... });
  MainMessenger.onToggleCheckUpdatesOnStartup(() => { ... });
  MainMessenger.onIsCheckUpdatesOnStartupEnabled(() => preferences.checkForUpdatesOnStartup === true);
  ```

- [ ] 6. **`src/ipc/messages.ts`** — Remove the three constants at lines 112-114:
  ```ts
  export const CHECK_FOR_UPDATES = 'CHECK_FOR_UPDATES';
  export const TOGGLE_CHECK_UPDATES_ON_STARTUP = 'TOGGLE_CHECK_UPDATES_ON_STARTUP';
  export const IS_CHECK_UPDATES_ON_STARTUP_ENABLED = 'IS_CHECK_UPDATES_ON_STARTUP_ENABLED';
  ```
  Leave `GET_VERSION` (line 111) and `IS_PORTABLE_MODE` (line 115) — both still used.

- [ ] 7. **`src/ipc/main.ts`** — Remove the three imports at lines 4, 20, 44:
  - `CHECK_FOR_UPDATES`
  - `IS_CHECK_UPDATES_ON_STARTUP_ENABLED`
  - `TOGGLE_CHECK_UPDATES_ON_STARTUP`
  Also remove the three static methods at lines 183-189:
  ```ts
  static onCheckForUpdates = (cb: () => void) => ipcMain.handle(CHECK_FOR_UPDATES, cb);
  static onToggleCheckUpdatesOnStartup = (cb: () => void) => ipcMain.on(TOGGLE_CHECK_UPDATES_ON_STARTUP, cb);
  static onIsCheckUpdatesOnStartupEnabled = (cb: () => boolean) => ipcMain.on(IS_CHECK_UPDATES_ON_STARTUP_ENABLED, (e) => (e.returnValue = cb()));
  ```

- [ ] 8. **`src/ipc/renderer.ts`** — Remove the three imports at lines 4, 20, 44 (same three names as step 7). Also remove the three static methods at lines 170-176:
  ```ts
  static checkForUpdates = async () => ipcRenderer.invoke(CHECK_FOR_UPDATES);
  static isCheckUpdatesOnStartupEnabled = (): boolean => ipcRenderer.sendSync(IS_CHECK_UPDATES_ON_STARTUP_ENABLED);
  static toggleCheckUpdatesOnStartup = (): void => ipcRenderer.send(TOGGLE_CHECK_UPDATES_ON_STARTUP);
  ```

- [ ] 9. **`src/frontend/containers/AppToolbar/SecondaryCommands.tsx`** — Remove the "check for updates" MenuItem at lines 55-59:
  ```tsx
  <MenuItem
    icon={IconSet.RELOAD}
    onClick={RendererMessenger.checkForUpdates}
    text="check for updates"
  />
  ```
  The `MenuItem` and `RendererMessenger` imports remain (other items still use them — Settings, ideas+bugs [which TASK-030 removes], help center).

- [ ] 10. **`src/frontend/containers/Settings/StartupBehavior.tsx`** — Delete the file entirely. It is already commented out of the Settings Tabs list in `Settings/index.tsx` (lines 12, 52-55). After deletion, also clean up the commented-out import and tab entry in `src/frontend/containers/Settings/index.tsx`:
  - Remove line 12: `// import { StartupBehavior } from './StartupBehavior';`
  - Remove lines 52-55 (the commented-out `{ label: 'Startup Behavior', content: StartupBehavior, },` block).

- [ ] 11. **`dev-app-update.yml`** (repo root) — Delete the file. It was used by `autoUpdater.updateConfigPath` in the IS_DEV branch that step 4 removed.

- [ ] 12. **Verify compilation.** Run `yarn build`. Expect no TypeScript errors. If any remain, they are unreferenced imports of the removed names — remove them.

- [ ] 13. **Verify startup.** Run `yarn start` against the watch-mode build. The app must launch without errors. Expect no console warnings about `autoUpdater` or `electron-updater`.

- [ ] 14. **Verify package build.** Run `yarn package:portable`. Expect `dist/brave.exe` to be produced. No update-related warnings.

- [ ] 15. Commit with a message like "Remove auto-update subsystem for personal fork (INV-006)".

## Done When

- [ ] `src/main.ts` has zero references to `autoUpdater`, `electron-updater`, `UpdateInfo`, `checkForUpdatesOnStartup`, `preferences`, `updatePreferences`, or `preferencesFilePath` (verify with grep).
- [ ] `src/ipc/messages.ts`, `src/ipc/main.ts`, and `src/ipc/renderer.ts` contain no `CHECK_FOR_UPDATES`, `TOGGLE_CHECK_UPDATES_ON_STARTUP`, or `IS_CHECK_UPDATES_ON_STARTUP_ENABLED` references.
- [ ] `src/frontend/containers/AppToolbar/SecondaryCommands.tsx` has no "check for updates" menu item.
- [ ] `src/frontend/containers/Settings/StartupBehavior.tsx` is deleted. `Settings/index.tsx` contains no commented-out `StartupBehavior` references.
- [ ] `dev-app-update.yml` is deleted.
- [ ] `yarn build` succeeds with zero TypeScript errors.
- [ ] `yarn start` launches the app successfully.
- [ ] `yarn package:portable` produces `dist/brave.exe` without error.
- [ ] Launching the packaged build and opening the toolbar "More" (three-dots) menu shows no "check for updates" item.
