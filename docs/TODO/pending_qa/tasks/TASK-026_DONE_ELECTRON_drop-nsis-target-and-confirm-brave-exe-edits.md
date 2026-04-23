---
id: TASK-026
title: 'Drop NSIS installer target from package.json and confirm brave.exe build-config edits'
investigation: INV-005
status: DONE
priority: medium
blocked_by: []
date_created: 2026-04-22
date_completed: 2026-04-23
files:
  - 'package.json'
---

## What

Three coordinated edits to `package.json`:

1. Remove `"nsis"` from `build.win.target` so only `"portable"` remains.
2. Delete the entire `build.nsis` block (`oneClick`, `allowToChangeInstallationDirectory`) since the target is no longer built.
3. Confirm the two already-present edits in the working tree survive:
   - `build.win.executableName: "brave"` (line ~56 today).
   - `build.portable.artifactName: "brave.${ext}"` (line ~74 today).

No source code changes. No `app.setName()` calls. No `productName` rename. Per the INV-005 investigation into the `node_modules/app-builder-lib` source, `win.executableName` fully propagates to the portable target's inner exe name, so the narrower-hammer approach (executableName only, not productName) is sufficient.

## Why

The user's fork is portable-only on a single Windows machine; the NSIS installer target is dead configuration. Dropping it reduces maintenance surface and simplifies `yarn package` output on Windows to just the portable artifact. The `executableName` and `artifactName` edits enable NVIDIA Video Super Resolution for video playback in slide mode by renaming the binary basename to `brave.exe`, which matches NVIDIA's driver-side VSR allowlist.

See [INV-005](../investigations/INV-005_MEDIUM_ELECTRON_brave-exe-rename-for-nvidia-vsr-and-portable-only.md) for the electron-builder 23.6.0 source citations confirming that `executableName` propagates through `appInfo.productFilename` to both the framework-level binary rename (`ElectronFramework.js:44-45`) and the portable NSIS wrapper's inner-exe launch (`portable.nsi:86` via `APP_EXECUTABLE_FILENAME` in `common.nsh:13`).

## Implementation Steps

- [ ] 1. Open `package.json` and locate `build.win.target` (currently lines 57-60). Change its value from `["nsis", "portable"]` to `["portable"]`. A one-element array is still valid.

- [ ] 2. Still in `package.json`, delete the entire `build.nsis` block (currently lines 69-72):
  ```json
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true
  },
  ```
  Also delete the trailing comma from the preceding block if it becomes a trailing-comma-before-next-key situation. (The preceding block is `"win": {...}`, which already has a comma; the next block after `"nsis"` is `"portable": {...}`. Simply removing the `"nsis": {...},` line is sufficient — the comma is on the `"nsis"` entry itself.)

- [ ] 3. Verify that `build.win.executableName` is set to `"brave"` (currently line 56). If it was removed during rebasing, re-add it:
  ```json
  "win": {
    "executableName": "brave",
    "target": ["portable"],
    ...
  }
  ```

- [ ] 4. Verify that `build.portable.artifactName` is set to `"brave.${ext}"`. If it was reset during rebasing, re-add:
  ```json
  "portable": {
    "artifactName": "brave.${ext}",
    "requestExecutionLevel": "user"
  }
  ```

- [ ] 5. Run `yarn install` if `package.json` indentation/formatting was touched (in case there's a `package-lock.json` / `yarn.lock` drift concern — should be none for this change, but run it once to confirm). Expect no lockfile changes.

- [ ] 6. Run `yarn build` to produce the webpack output in `dist/` (this is a prerequisite for packaging; see the `build` script on line 17 of package.json).

- [ ] 7. Run `yarn package:portable` and observe the electron-builder output. Success criteria:
  - Output ends with a line referencing `dist\brave.exe` (the outer portable wrapper).
  - No `dist\OneFolder Setup *.exe` file is produced (NSIS target is gone).
  - `dist\win-unpacked\brave.exe` exists — this is the **inner** renamed Electron binary that NVIDIA's driver will inspect.

- [ ] 8. Sanity-check the inner binary: right-click `dist\win-unpacked\brave.exe` → Properties → Details tab. Expect `FileDescription` = `OneFolder` and `ProductName` = `OneFolder` (these are stamped from `appInfo.productName`, which remains `"OneFolder"` in `build.productName`). If the file is named `brave.exe` AND the metadata still says OneFolder, the change is working as designed: NVIDIA sees `brave.exe` by basename, Windows still identifies the app as OneFolder by metadata.

- [ ] 9. Commit the `package.json` change with a message along the lines of "Drop NSIS target; confirm win.executableName=brave for VSR spoofing".

## Done When

- [ ] `package.json` `build.win.target` is `["portable"]`.
- [ ] `package.json` has no `build.nsis` block.
- [ ] `package.json` `build.win.executableName` is `"brave"`.
- [ ] `package.json` `build.portable.artifactName` is `"brave.${ext}"`.
- [ ] `yarn package:portable` produces `dist\brave.exe` (outer wrapper) and `dist\win-unpacked\brave.exe` (inner binary).
- [ ] No NSIS installer artifact is produced by `yarn package:portable` or `yarn package`.
- [ ] Inner `brave.exe` Properties dialog shows `FileDescription` and `ProductName` as `OneFolder`.
