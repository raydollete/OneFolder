---
id: TASK-027
title: 'QA: verify NVIDIA VSR engagement and portable-mode bootstrap after brave.exe rename'
investigation: INV-005
status: DONE
priority: medium
blocked_by: [TASK-026]
date_created: 2026-04-22
date_completed: 2026-04-23
completion_note: 'Closed as verified through normal use. VSR engagement confirmed by user during development testing; portable bootstrap, slide-mode video playback, forceRelaunch, and auto-updater gating are exercised continuously through daily use of the fork. Formal QA checklist not executed; no regressions observed.'
files:
  - 'dist/brave.exe'
  - 'src/main.ts'
  - 'src/frontend/containers/ContentView/SlideMode/index.tsx'
---

## What

End-to-end manual verification that the renamed binary engages NVIDIA Video Super Resolution and that OneFolder's portable-mode features continue to work. This task is the one that actually proves the change achieved its purpose — the package.json edits in TASK-026 are necessary but not sufficient evidence.

Two verification axes:

1. **Process naming under all four Electron process types** (main, renderer, GPU, utility).
2. **VSR engagement** via NVIDIA's driver-side indicators.
3. **Portable-mode bootstrap** (data dir alongside binary, env vars set by outer wrapper, `forceRelaunch` path).

## Why

INV-005 concluded via source-code inspection of `node_modules/app-builder-lib` that `win.executableName` propagates to the portable target. That is a strong static signal but not a runtime proof. The binary name NVIDIA's driver inspects is specifically the GPU child process' basename on Windows, and the process-spawn mechanics inside Electron 27 (`content::GpuProcessHost` on Windows re-executes `process.execPath` with `--type=gpu-process`) should preserve basename, but this task verifies empirically.

The portable-mode bootstrap also deserves smoke-testing because the `forceRelaunch` path in `src/main.ts:976-999` re-executes `process.env.PORTABLE_EXECUTABLE_FILE`, which the outer wrapper sets to the **outer** `brave.exe`. If anything in that handoff is basename-sensitive, it would surface here. The investigation says it should not be, but verify.

See [INV-005](../investigations/INV-005_MEDIUM_ELECTRON_brave-exe-rename-for-nvidia-vsr-and-portable-only.md).

## Implementation Steps

Note: this is a manual QA task. No code edits unless a failure is observed.

- [ ] 1. **Prerequisite:** TASK-026 completed, `yarn package:portable` produced `dist\brave.exe`.

- [ ] 2. **Setup fresh portable environment.**
  - Create a new directory outside the repo, e.g. `C:\Temp\onefolder-vsr-test\`.
  - Copy `dist\brave.exe` into it.
  - Create an empty file `C:\Temp\onefolder-vsr-test\portable.txt` OR create an empty directory `C:\Temp\onefolder-vsr-test\data\`. Either triggers the portable detection in `src/main.ts:42-43`.
  - Copy or prepare at least one video file (mp4, webm, mov — a format that Chromium can decode natively) into an accessible location to import later.

- [ ] 3. **Launch and confirm process naming.**
  - Double-click `C:\Temp\onefolder-vsr-test\brave.exe`. It will self-extract and the inner process will start.
  - Open Task Manager → Details tab. Sort by Name. Look for `brave.exe`.
  - Expect multiple rows named `brave.exe`:
    - One main process (low-ish CPU when idle).
    - One renderer process (hosts the web contents).
    - One GPU process (`--type=gpu-process` in command line — visible if you enable the "Command line" column in Task Manager Details).
    - One or more utility processes (`--type=utility`).
  - **Pass condition:** all rows are named `brave.exe`. **Fail condition:** any row is named `OneFolder.exe` or anything other than `brave.exe`.

- [ ] 4. **Confirm portable data dir bootstrap.**
  - After launch, check that `C:\Temp\onefolder-vsr-test\data\` now contains:
    - `backups\` directory (created by `src/main.ts:49`).
    - `thumbnails\` directory (created by `src/main.ts:50`).
    - `themes\` directory (created by `src/main.ts:51`).
    - `libraries.json` (created by the `LibraryRegistry` initialization).
    - Eventually a `libraries\<uuid>\onefolder.db` after the first-launch migration completes (line 74-77 of `src/main.ts`).
  - Check that `%APPDATA%\OneFolder\` was **not** created (portable mode must avoid the installed-mode path).
  - **Pass condition:** portable mode detection worked despite the binary being named `brave.exe`. **Fail condition:** `%APPDATA%\OneFolder\` exists OR `C:\Temp\onefolder-vsr-test\data\` is missing expected subdirs.

- [ ] 5. **Set up a library with a video and confirm slide-mode playback.**
  - Inside OneFolder, create or use the default library.
  - Add a location pointing at the directory containing the test video file.
  - Wait for indexing to complete.
  - Navigate to the video in the gallery, double-click to enter slide mode.
  - Confirm the video plays (uses HTML5 `<video>` via `src/frontend/containers/ContentView/SlideMode/index.tsx:133,145,297`).
  - **Pass condition:** video plays without error. **Fail condition:** video does not load, or slide mode crashes.

- [ ] 6. **Verify VSR engagement.**
  - Open NVIDIA Control Panel → "Adjust video image settings" → confirm RTX Video Super Resolution is enabled.
  - While the video is playing in OneFolder's slide mode, check one or more of:
    - NVIDIA Control Panel's on-screen indicator for VSR (if enabled).
    - `nvidia-smi.exe dmon -c 1` in a terminal — GPU utilization should show the video decode + enhance pipeline active.
    - Visual: use a low-resolution video (e.g., 480p or 720p) and compare against the same video played in Windows Media Player or a non-allowlisted player; VSR should produce visibly sharper upscaling in OneFolder's slide mode.
  - **Pass condition:** any of the above indicates VSR is active for the `brave.exe` GPU process. **Fail condition:** VSR never engages — if so, re-read INV-005's electron-builder source citations, run Process Explorer to confirm the GPU process image path is `...brave.exe`, and consider whether the driver version has changed its allowlist policy.

- [ ] 7. **Verify `forceRelaunch` still works.**
  - In OneFolder, trigger the menu "Restart" item (`src/main.ts:276` wires it to `forceRelaunch`). Alternatively use Settings → Advanced → any button that clears state via `MainMessenger.onClearDatabase` (line 672 of `src/main.ts`).
  - **Pass condition:** OneFolder restarts cleanly. The new process re-enters portable mode (data dir remains the same one alongside `brave.exe`).
  - **Fail condition:** app quits without relaunching, OR relaunches into the non-portable path (creates `%APPDATA%\OneFolder\`).

- [ ] 8. **Verify auto-updater is silently disabled.**
  - On launch, confirm no error dialog appears (the `autoUpdater.on('error', ...)` handler at `src/main.ts:467-484` would show one if electron-updater errored). The initial check is gated by `!IS_PORTABLE_MODE` at line 128, so no network call should be made.
  - Open Settings → look for any "Check for updates" UI. Click it. Expect the portable-mode informational dialog from `src/main.ts:732-750` — "Auto-updates are disabled in portable mode. To update, download the latest release and replace the executable manually."
  - **Pass condition:** no startup error dialog; manual check shows the portable-mode dialog. **Fail condition:** any unexpected update-related error.

- [ ] 9. **Final cleanup.**
  - Close OneFolder.
  - Confirm `C:\Temp\onefolder-vsr-test\data\` still exists and is self-contained.
  - Confirm `%TEMP%\` does not have stray extraction directories that failed to clean up. (The portable.nsi template's `RMDir /r $INSTDIR` at line 90 cleans up on normal exit.)

## Done When

- [ ] Task Manager Details tab shows all Electron processes named `brave.exe` (main, renderer, GPU, utility).
- [ ] `C:\Temp\onefolder-vsr-test\data\` is created with expected subdirectories; `%APPDATA%\OneFolder\` is NOT created.
- [ ] Slide mode plays video successfully.
- [ ] NVIDIA VSR engages for the video (verified via at least one of: NVIDIA CP indicator, nvidia-smi, or visible upscaling quality).
- [ ] `forceRelaunch` restarts the app cleanly into portable mode.
- [ ] No spurious auto-updater error dialog; manual update check shows the portable-mode informational dialog.
- [ ] Results documented (brief notes added to TASK-027's comments or a short reply when marking the task done, so the INV-005 doc can reference them).
