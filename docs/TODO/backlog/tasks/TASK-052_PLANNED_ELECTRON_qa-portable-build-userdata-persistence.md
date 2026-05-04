---
id: TASK-052
title: 'QA: verify packaged portable build persists userData (libraries, SQLite, localStorage, thumbnails) across launches'
investigation: INV-012
status: PLANNED
priority: high
blocked_by: []
date_created: 2026-05-03
date_completed:
files:
  - 'dist/brave.exe'
  - 'src/main.ts'
  - 'common/library-registry.ts'
  - 'src/ipc/renderer.ts'
---

## What

Manual end-to-end QA: build the Windows portable artifact, run it from a clean directory outside the repo, verify that ALL user state (library registry, per-library SQLite database, Chromium localStorage, thumbnails, backups, themes, window state, global preferences) persists across a close-and-relaunch cycle, and confirm `%APPDATA%\OneFolder\` is NOT created at any point. This is the decisive empirical evidence for INV-012's hypothesis. If this passes, the portable-build persistence concern is closed-as-verified. If this fails, capture the specific failure mode and reopen the investigation with the actual evidence so a targeted fix task can be filed.

## Why

The user reported that the portable Windows build appears to behave like a fresh install on every launch. Source-code inspection (INV-012, §Diagnosis) shows the implementation in `src/main.ts:36-58` is correct: `app.setPath('userData', portableDataDir)` is called at module load (before `app.whenReady()`) when `PORTABLE_EXECUTABLE_DIR` is set by the portable wrapper, and that env var is unconditionally set by `node_modules/app-builder-lib/templates/nsis/portable.nsi:77`. The dev build (`yarn start`) demonstrably persists into `D:\Dev\OneFolder\data\` — verified by the on-disk presence of `data\Local Storage\leveldb\`, `data\libraries.json`, etc. The most likely explanation for the user's report is that their observation is from a stale build that predates TASK-013 (portable-mode bootstrap) and/or TASK-026 (brave.exe rename, which also confirmed the bootstrap still works post-rename). This task is the empirical step that turns "code looks right" into "verified working on the current packaged artifact."

See [INV-012](../investigations/INV-012_HIGH_ELECTRON_portable-build-not-persisting-userdata.md).

## Implementation Steps

This is a manual QA task. No code edits unless a failure surfaces in step 6, in which case capture the failure mode and file a follow-up task — do not attempt to fix in this task's scope.

- [ ] 1. **Build a fresh portable artifact.** From the repo root: `yarn package:portable`. Confirm `dist\brave.exe` is created (~107 MB based on the current build) and `dist\win-unpacked\brave.exe` exists alongside the runtime support files. Note the build timestamp.

- [ ] 2. **Set up a clean test directory.**
    - Create a directory OUTSIDE the repo, e.g. `C:\Temp\onefolder-portable-qa-INV012\`. The directory must NOT contain a `data/` folder or `portable.txt` file from any prior run, and it must NOT be inside `D:\Dev\OneFolder\` (the project root has its own dev `data/` that would confuse the test).
    - Copy `dist\brave.exe` into the test directory.
    - Confirm there is nothing else in the test directory: `ls C:\Temp\onefolder-portable-qa-INV012\` should show ONLY `brave.exe`.
    - Confirm `%APPDATA%\OneFolder\` does not exist before the test begins. If it exists from prior testing, RENAME it (do not delete — preserve any state in case it's needed for diagnosis) to e.g. `%APPDATA%\OneFolder.pre-inv012-qa\`. The test must verify that the portable run does not write into `%APPDATA%\OneFolder\`.

- [ ] 3. **First launch: confirm portable bootstrap.**
    - Double-click `C:\Temp\onefolder-portable-qa-INV012\brave.exe`.
    - The outer wrapper self-extracts to `%TEMP%\<random>\` and launches the inner `brave.exe`. Wait for the OneFolder UI to appear.
    - While the app is running (do NOT close it yet), in a separate file explorer window:
      - Confirm `C:\Temp\onefolder-portable-qa-INV012\data\` now exists.
      - Confirm `data\` contains at minimum: `libraries.json`, `active-library.json`, `libraries\<some-uuid>\onefolder.db`, `Local Storage\` (with `leveldb\` subdirectory), `thumbnails\`, `themes\`, `backups\`. Some of these may be empty pre-first-write but the directory entries should exist.
      - Confirm `%APPDATA%\OneFolder\` was NOT created by the launch.
      - Confirm the running process tree (Task Manager → Details) shows `brave.exe` for main, renderer, GPU, and utility processes. Note: this also incidentally re-validates TASK-027's brave.exe-rename concerns, but the persistence assertion is independent.
    - **Pass condition:** `data\` is created in the test directory; `%APPDATA%\OneFolder\` is NOT created. **Fail condition:** either inverse.

- [ ] 4. **Mutate user state.** Inside OneFolder (still in the same first-launch session):
    - Open Settings → Appearance. If the current theme is dark (the new INV-011 default), switch to light. If light, switch to dark. The point is to make a change away from whatever the field default is, so the next launch's recovery code path is exercised. **Record the chosen value.**
    - Close Settings.
    - Open the gallery sort menu. Pick a sort that is NOT the field default (e.g. if the default is random, pick "Date Added" or "Name"). **Record the chosen value.**
    - Add a location: Add Location → choose any folder with a few image files in it. Wait for the initial scan to complete (the file count in the bottom-left should stop incrementing).
    - In Settings → Advanced (if the multi-library UI exposes it) OR via the Library Selector (Switch Library): create a NEW library named "INV012 Test Library 2." Switch back to the original library. **Record the new library's name.**
    - Toggle the inspector panel open (right sidebar) — this exercises localStorage's per-library inspector-state preference.

- [ ] 5. **Close OneFolder cleanly.** File menu → Quit, or click the window's close button. Confirm via Task Manager that NO `brave.exe` processes remain running. Wait ~5 seconds to allow the portable wrapper's `RMDir /r $INSTDIR` (cleanup of the `%TEMP%\<random>\` extract dir per `portable.nsi:90`) to complete.

- [ ] 6. **Second launch: verify persistence.**
    - Double-click `C:\Temp\onefolder-portable-qa-INV012\brave.exe` again.
    - Wait for the OneFolder UI to appear.
    - Verify, IN ORDER:
      - **Theme** matches what was set in step 4. (CSS class on the `#layout-container` div, native window titlebar.)
      - **Sort order** matches what was set in step 4. (The Sort menu shows the chosen item as the checked radio.)
      - **Location** added in step 4 is still listed in the Location panel and contains the same image count.
      - **Second library** "INV012 Test Library 2" is listed in the Library Selector / Settings.
      - **Inspector panel** is still in the open state set in step 4.
    - **Pass condition:** all five items match the recorded values from step 4. **Fail condition:** any item reverted to a field-initializer default value.

- [ ] 7. **Close OneFolder again.** Inspect `C:\Temp\onefolder-portable-qa-INV012\data\` after exit:
    - Confirm `Local Storage\leveldb\` contains at least one `.log` and one `.ldb` file (Chromium's localStorage backing store).
    - Confirm `libraries.json` contains the original library plus the second one created in step 4.
    - Confirm `libraries\<uuid>\onefolder.db` exists for at least the active library (the second library may not have a DB yet if it was never opened — that's fine).
    - Confirm `windowState.json` exists.
    - Confirm `%APPDATA%\OneFolder\` STILL does not exist.

- [ ] 8. **Negative test: confirm `data\` truly travels with the exe.** From an entirely separate directory:
    - Create `C:\Temp\onefolder-portable-qa-INV012-MOVED\`.
    - Copy BOTH `brave.exe` AND the entire `data\` directory from the original test dir to the new dir.
    - Launch `brave.exe` from the moved location.
    - Confirm the same theme, sort, location, and second library show up — proving "everything travels together."
    - Close. The original test dir (`C:\Temp\onefolder-portable-qa-INV012\`) is now stale; its `data\` is unmodified by the moved copy.

- [ ] 9. **Negative test: confirm a fresh exe-only copy creates a fresh `data\`.** From an entirely separate directory:
    - Create `C:\Temp\onefolder-portable-qa-INV012-FRESH\`.
    - Copy ONLY `brave.exe` (NOT `data/`) from `dist/` into the new dir.
    - Launch. Verify a fresh `data/` is created in this third location with a fresh "My Library" entry, light/dark per the INV-011 default, etc. The user state from steps 2–8 is NOT bleeding into this third launch — good.
    - Close.

- [ ] 10. **Cleanup.**
    - Delete the three test directories (`C:\Temp\onefolder-portable-qa-INV012\`, `-MOVED\`, `-FRESH\`).
    - Restore the renamed `%APPDATA%\OneFolder.pre-inv012-qa\` to its original location if it was renamed in step 2 (and confirm the verification did not need to write into it — it should not have).
    - Document results: append a short pass/fail note to this task before marking it DONE, including the build timestamp from step 1 and any anomalies observed.

## Done When

- [ ] Step 3 confirmed: portable bootstrap creates `data\` next to `brave.exe`; `%APPDATA%\OneFolder\` is NOT created.
- [ ] Step 6 confirmed: theme, sort, location, second-library name, and inspector state ALL persist across a close-and-relaunch cycle.
- [ ] Step 7 confirmed: the on-disk `data\` directory has the expected file layout (`libraries.json`, `Local Storage\leveldb\`, `libraries\<uuid>\onefolder.db`, `windowState.json`, etc.).
- [ ] Step 8 confirmed: copying both `brave.exe` and `data\` to a new directory carries the user state with them.
- [ ] Step 9 confirmed: copying only `brave.exe` (without `data\`) to a new directory creates an independent fresh `data\`.
- [ ] Results documented in this task's body before transition to DONE.
- [ ] If any step FAILED: a follow-up task (TASK-XXX with the specific failure mode) was filed and the failure evidence (screenshots, file listings, log captures) preserved for that task.
