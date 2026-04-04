---
id: TASK-013
title: 'Implement portable mode detection and path override system'
investigation: INV-002
status: planned
priority: medium
blocked_by: [TASK-012]
date_created: 2026-04-04
date_completed:
files:
  - 'common/process.ts'
  - 'src/main.ts'
  - 'src/ipc/renderer.ts'
---

## What

Add portable mode detection that checks for a `portable.txt` marker file or `data/` directory next to the application executable. When portable mode is detected, override `app.setPath('userData')` to redirect all application data (database, preferences, thumbnails, backups, themes) to a `data/` directory next to the executable. Disable auto-updates in portable mode.

## Why

The app currently stores all data in the system user directory (`app.getPath('userData')`), which ties it to a specific machine and user account. Portable mode enables running from a USB drive with all data stored alongside the executable, aligning with the "Your files, your folder, forever" philosophy. The `src/main.ts:24` TODO explicitly calls for this.

See [INV-002](../investigations/INV-002_HIGH_BACKEND_sqlite-migration-and-portable-mode.md).

## Implementation Steps

- [ ] 1. In `common/process.ts`, add portable mode detection. This must work in both the main process and renderer process:

    ```typescript
    import path from 'path';
    import fse from 'fs-extra';

    function detectPortableMode(): boolean {
      // In packaged app, process.resourcesPath points to the resources dir inside the app bundle
      // The app directory is one level up from resources
      const appDir = app.isPackaged
        ? path.dirname(process.execPath)
        : path.resolve(__dirname, '..');

      // Check for portable.txt marker file or data/ directory
      return (
        fse.pathExistsSync(path.join(appDir, 'portable.txt')) ||
        fse.pathExistsSync(path.join(appDir, 'data'))
      );
    }
    ```

    However, `common/process.ts` is shared between main and renderer, and `app` is only available in the main process. The detection should be done in `src/main.ts` at module load time and communicated to the renderer via IPC or a shared constant. Export a placeholder `IS_PORTABLE` from `common/process.ts` that gets set at startup.

    Practical approach: Add `IS_PORTABLE` as a let-exported variable in `common/process.ts`, and have `src/main.ts` set it at module load time. For the renderer, expose it via an IPC call or environment variable.

- [ ] 2. In `src/main.ts`, add portable mode detection and path override BEFORE `app.getPath('userData')` is used (currently at line 25). This must run at module scope, before `initialize()`:

    ```typescript
    // Portable mode detection - must run before any getPath calls
    const appDir = app.isPackaged
      ? path.dirname(process.execPath)
      : path.resolve(__dirname, '..');

    const IS_PORTABLE_MODE =
      fse.pathExistsSync(path.join(appDir, 'portable.txt')) ||
      fse.pathExistsSync(path.join(appDir, 'data'));

    if (IS_PORTABLE_MODE) {
      const portableDataDir = path.join(appDir, 'data');
      fse.ensureDirSync(portableDataDir);
      app.setPath('userData', portableDataDir);
      // Also redirect temp to portable location for thumbnails
      app.setPath('temp', portableDataDir);
    }

    const basePath = app.getPath('userData');
    ```

    This ensures `basePath` (line 25) and all subsequent `app.getPath()` calls return the portable directory.

- [ ] 3. Disable auto-updates in portable mode. In the `initialize()` function in `src/main.ts`, wrap the auto-update check:

    ```typescript
    if (preferences.checkForUpdatesOnStartup && !IS_PORTABLE_MODE) {
      autoUpdater.checkForUpdates();
    }
    ```

    Also update `onCheckForUpdates` handler to warn the user if they manually trigger an update check in portable mode.

- [ ] 4. Update `src/ipc/renderer.ts` path helpers. Since `app.setPath('userData')` is called before any windows are created, the existing `RendererMessenger.getPath('userData')` and `RendererMessenger.getPath('temp')` calls will automatically return the portable paths. Verify that:
    - `getDefaultThumbnailDirectory()` (line 165-168): uses `getPath('temp')` -- if temp is overridden, this works. If not, explicitly create a thumbnails dir inside the portable data dir.
    - `getDefaultBackupDirectory()` (line 170-173): uses `getPath('userData')` -- correctly returns portable path.
    - `getThemesDirectory()` (line 175-178): uses `getPath('userData')` -- correctly returns portable path.

    If `app.setPath('temp')` does not reliably redirect on all platforms, override `getDefaultThumbnailDirectory` to explicitly use `path.join(portableDataDir, 'thumbnails')` in portable mode.

- [ ] 5. Add a new IPC message to expose portable mode status to the renderer:
    - In `src/ipc/messages.ts`, add `IS_PORTABLE_MODE` constant
    - In `src/ipc/main.ts`, add handler: `MainMessenger.onIsPortableMode(() => IS_PORTABLE_MODE)`
    - In `src/ipc/renderer.ts`, add: `static isPortableMode = (): boolean => ipcRenderer.sendSync(IS_PORTABLE_MODE)`

    This allows the renderer (e.g., settings UI) to show portable mode status and hide the auto-update toggle.

- [ ] 6. Ensure single-instance lock (`requestSingleInstanceLock()` at line 369) still works in portable mode. The lock is process-level, not path-level, so it should work. However, if two different portable instances are run from different USB drives simultaneously, they should each get their own lock. Verify this behavior.

- [ ] 7. Create the `data/` directory structure on first portable launch:
    ```
    data/
      onefolder.db        (SQLite database, from TASK-008)
      backups/            (backup files)
      thumbnails/         (thumbnail cache)
      themes/             (custom themes)
      preferences.json    (window state, update prefs)
      windowState.json    (window position/size)
    ```

## Done When

- [ ] Placing a `portable.txt` file next to the executable causes the app to store all data in `./data/`
- [ ] Placing a `data/` directory next to the executable has the same effect
- [ ] `app.getPath('userData')` returns the portable data directory
- [ ] Thumbnails, backups, themes, preferences, and window state are all in the portable directory
- [ ] Auto-updates are disabled in portable mode
- [ ] Settings UI can detect and display portable mode status
- [ ] Single-instance lock works correctly in portable mode
- [ ] The app functions identically in portable and installed mode
