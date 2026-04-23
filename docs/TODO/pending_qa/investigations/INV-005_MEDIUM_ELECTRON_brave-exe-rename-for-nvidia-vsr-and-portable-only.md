---
id: INV-005
title: 'Rename Windows binary to brave.exe for NVIDIA VSR and simplify to portable-only'
reported_bug: 'Video playback in the single-user Windows fork should benefit from NVIDIA Video Super Resolution. NVIDIA''s driver-side allowlist engages VSR only for processes whose basename matches a hardcoded set (chrome.exe, msedge.exe, brave.exe, vivaldi.exe). Rename the Electron exe to brave.exe. Simultaneously drop the NSIS installer target — this is a portable-only single-user build.'
date: 2026-04-22
status: active
superseded_by:
tasks_spawned: [TASK-026, TASK-027, TASK-028]
root_cause_category: architectural-shortcoming
affects:
  - 'electron-builder win target configuration (package.json build.win)'
  - 'Electron binary filename on disk (renamed via framework step before target packaging)'
  - 'Windows portable wrapper inner-exe launch path (portable.nsi / APP_EXECUTABLE_FILENAME)'
  - 'Renderer GPU child process name (inherits parent basename on Windows)'
  - 'Portable mode detection in src/main.ts (process.execPath, PORTABLE_EXECUTABLE_DIR, PORTABLE_EXECUTABLE_FILE)'
  - 'forceRelaunch spawn target in src/main.ts'
  - 'Window titles, menu labels, dialog text (unrelated to exe name — confirming no leakage)'
  - 'auto-updater initialization (electron-updater; gated on !IS_PORTABLE_MODE for actual checks)'
---

## Bug Report

### Observed Behavior

Two related changes for a single-user personal Windows fork of OneFolder:

1. **NVIDIA VSR does not engage** for the plain HTML5 `<video>` element created in `src/frontend/containers/ContentView/SlideMode/index.tsx` lines 133, 145, 297. NVIDIA's Video Super Resolution is implemented in the driver and applies its enhancement path only when the running process' basename matches a small hardcoded allowlist: `chrome.exe`, `msedge.exe`, `brave.exe`, `vivaldi.exe`. The Electron binary for this build is currently `OneFolder.exe`, so VSR is inactive for all video content the user previews in slide mode.

2. **NSIS installer target is dead weight** for this fork. The user never uses the NSIS installer output — this is a single-user personal build distributed to exactly one machine, always in portable mode. The `nsis` target configuration and the `build.nsis` block add maintenance surface area with zero benefit.

The user has already made two edits to `package.json` in the working tree (unstaged):

- Added `build.win.executableName: "brave"` (line 56).
- Changed `build.portable.artifactName` from `"${productName}Portable.${version}.${ext}"` to `"brave.${ext}"` (line 74).

### Expected Behavior

After the changes:

- `yarn package:portable` produces a single artifact at `dist/brave.exe`.
- When the artifact is launched, it self-extracts to `%TEMP%\<hash>\` and runs an **inner** `brave.exe` from that temp directory. The **inner** exe's basename is what NVIDIA's driver sees, so VSR activates for HTML5 video playback in slide mode.
- The `nsis` target is no longer produced; `yarn package` on Windows produces only the portable artifact.
- All OneFolder-specific behavior (window titles, menu labels, auto-updater portable gating, portable data dir under `%APPDATA%\OneFolder\` or sibling `data/`) continues to function correctly even though the binary is named `brave.exe`.

No public distribution concerns apply (no trademark, no code-signing, no masquerading complaints to address) — this is a single-user personal fork running on the user's own Windows 11 machine.

### Reproduction Context

Deterministic once built. The user will:

1. Run `yarn package:portable` after the changes land.
2. Copy the resulting `dist/brave.exe` to a working directory alongside a `portable.txt` sentinel (or `data/` subdir).
3. Launch it. Open slide mode on a video file. Observe VSR engagement via NVIDIA Control Panel indicators or a video that visibly benefits from VSR upscaling.
4. Confirm via Task Manager that the main process and GPU child process are both named `brave.exe`.

Platform: Windows 11 Pro 10.0.26200. Electron 27.1.2. electron-builder 23.6.0.

---

## Root Cause Analysis

**Category:** architectural-shortcoming

### Diagnosis

This is not a defect in OneFolder's code — it is an **externally imposed, undocumented policy** in the NVIDIA graphics driver: VSR post-processing is gated on the running process' basename matching a hardcoded allowlist. The OneFolder codebase has no hook to influence this because the check is performed by the GPU driver, outside the app's control surface. The only intervention point is to rename the OS-level binary so that when the renderer's GPU helper child process is spawned, Windows reports the basename NVIDIA is looking for.

Renaming the top-level `.exe` on Windows is sufficient because Electron's GPU process is a child of the main process and, on Windows, inherits the parent's executable file for its own process image (it re-spawns the same exe with the `--type=gpu-process` switch set). NVIDIA's driver reads the process name of the GPU process when deciding whether to apply VSR to a `<video>` element's decoded frames.

Why "architectural-shortcoming" rather than another category:

- **Not a wrong mental model:** The code correctly uses HTML5 `<video>`; the driver decision is outside the code's reach.
- **Not a missing edge case:** Nothing in OneFolder's logic is conditionally broken; the entire app works correctly. The driver simply declines to offer an optional enhancement.
- **Not silent failure:** Nothing fails. VSR is a best-effort driver feature that is a no-op when not allowlisted.
- **Architectural shortcoming** is the right fit because the app's **distribution architecture** (binary naming baked in by electron-builder's `productName` default) was not designed to accommodate an external allowlist gate. The fix is a build-config change, not a code change.

The second half of the change — dropping NSIS — is a deliberate simplification. The NSIS target exists in the upstream OneFolder for public distribution with an installer. This fork is portable-only, so the NSIS target and its config block are dead code that add maintenance cost (every electron-builder version bump, every NSIS template change upstream) without benefit.

### The critical electron-builder 23.6.0 question: does `win.executableName` actually propagate to the portable target's inner exe?

**Yes.** Verified by reading the pinned `node_modules/app-builder-lib` source:

1. **`node_modules/app-builder-lib/out/appInfo.js:53`:**
   ```js
   this.productFilename = platformSpecificOptions?.executableName != null
       ? sanitizeFileName(platformSpecificOptions.executableName)
       : this.sanitizedProductName;
   ```
   When `win.executableName` is set, `appInfo.productFilename = "brave"`.

2. **`node_modules/app-builder-lib/out/electron/ElectronFramework.js:44-45`:**
   ```js
   const executable = path.join(appOutDir, `${packager.appInfo.productFilename}.exe`);
   await rename(path.join(appOutDir, `${electronBranding.projectName}.exe`), executable);
   ```
   The renamed binary on disk is `brave.exe`, produced during the **framework** step that runs **before** target-specific packaging. Both the nsis and portable targets receive an `appOutDir` already containing `brave.exe` — not `OneFolder.exe`.

3. **`node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:155`:**
   ```js
   PRODUCT_FILENAME: appInfo.productFilename,
   ```
   Written as an NSIS define into the script used for BOTH the nsis setup and the portable wrapper (the portable target uses the same `NsisTarget` class with `isPortable === true`, see lines 101-103).

4. **`node_modules/app-builder-lib/templates/nsis/common.nsh:13`:**
   ```nsi
   !define APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"
   ```

5. **`node_modules/app-builder-lib/templates/nsis/portable.nsi:86`:**
   ```nsi
   ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0" $0
   ```
   The portable wrapper launches `$INSTDIR\brave.exe` — the basename NVIDIA's driver inspects when the GPU process is spawned.

6. **`node_modules/app-builder-lib/templates/nsis/portable.nsi:79`:** The wrapper also sets `PORTABLE_EXECUTABLE_APP_FILENAME` = `${APP_FILENAME}` — which is derived from `targetUtil.getWindowsInstallationDirName(appInfo, ...)` (NsisTarget.js:156). That helper (`targetUtil.js:38-40`) **prefers `productFilename`** when it matches a safe charset, so `PORTABLE_EXECUTABLE_APP_FILENAME` will also become `"brave"`. This is informational; OneFolder doesn't read that env var.

**Conclusion: the two edits already in the working tree are sufficient on the electron-builder side.** No `productName` rename or `app.setName()` call is required. The fallback plan described in the user's prompt is **not needed** — `win.executableName` fully propagates through the portable target in electron-builder 23.6.0.

### Side-effect of `executableName` vs `productName`: what it does NOT change

Because `productName` remains `"OneFolder"`:

- `appInfo.productName` — remains `"OneFolder"`. Used in Windows exe metadata (`signAndEditResources` in `winPackager.js:234,237` stamps it as `FileDescription` and `ProductName`). So Windows' Properties dialog and Task Manager "Name" column will still say "OneFolder" even though the filename on disk is `brave.exe`. This is actually ideal — process basename is `brave.exe` (NVIDIA happy) but file identity is still OneFolder.
- `app.getName()` (used by Electron for default `userData` path, etc.) — unchanged, returns the `name` field `"onefolder"` from `package.json`, not `productName`.
- Window titles hardcoded in `src/main.ts:155,195,247,400` as `'OneFolder'` — unchanged.
- Portable data dir layout (`common/library-registry.ts:196` path segment `'OneFolder'` under temp) — unchanged.
- Dialog copy ("Restart OneFolder", "Updates downloaded, OneFolder will restart...", etc.) — unchanged.

No `app.setName('OneFolder')` call is required to prevent leakage, because `productName` rename is not happening.

### Diagnostic Questions Considered

- **Wrong mental model?** No — `executableName` is documented in electron-builder's `PlatformSpecificBuildOptions` and the source confirms it flows through to both installer and portable targets via `appInfo.productFilename`.
- **Architectural shortcoming?** Yes — the upstream OneFolder build was designed for public distribution (installer + portable), and its binary name was never parameterized for per-fork customization. The fix is a config-only change, no source edits required.
- **Incorrect order of operations?** No — the framework rename step in electron-builder runs before target packaging, so both targets see the renamed binary consistently.
- **Missing edge case?** No — the change applies uniformly. Linux/Mac targets already have their own `executableName` handling (untouched here).
- **Wrong abstraction?** No — `productName` (display name) and `executableName` (binary basename) are intentionally separated by electron-builder. Using them for their intended purposes.
- **Silent failure?** No — VSR not engaging is externally observable via NVIDIA Control Panel and `nvidia-smi`; nothing fails silently at the app level.

---

## Blast Radius

This is a build-config change, so the "radius" is the set of places where the binary name could leak into behavior. Each item below was checked and is either automatically handled or requires no code change.

1. **`package.json` `build.win.target`** — Currently `["nsis", "portable"]`. Must drop `"nsis"` to fulfill the portable-only simplification. Also delete the `build.nsis` block (lines 69-72) since it is dead once the nsis target is gone. The top-level `package:portable` script (line 14) already targets `--win portable`, so no script change needed. The bare `yarn package` / `yarn dist` scripts that don't specify a target will then build just the portable artifact on Windows.

2. **`package.json` `build.win.executableName`** — Already added (line 56). Verified via electron-builder source that this propagates to both installer and portable outputs. No change beyond confirming its presence.

3. **`package.json` `build.portable.artifactName`** — Already changed to `"brave.${ext}"` (line 74). The output wrapper file will be `dist/brave.exe` instead of `OneFolder Portable 1.1.2.exe`. Acceptable — the user only builds one portable per version and doesn't need the version in the filename (git tags + `app.getVersion()` cover version tracking).

4. **`src/main.ts:36-43` portable mode detection** — Reads `process.env.PORTABLE_EXECUTABLE_DIR` (set by the outer `brave.exe` wrapper) and `path.dirname(process.execPath)` (path of the **inner** `brave.exe` inside `$PLUGINSDIR\app`). Neither cares about the basename. Still works exactly the same.

5. **`src/main.ts:989` `forceRelaunch`** — `const exe = process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath;`. The portable wrapper sets `PORTABLE_EXECUTABLE_FILE` to `$EXEPATH` — the **outer** `brave.exe` on disk (line 78 of `portable.nsi`). So relaunching spawns the outer wrapper, which re-extracts and launches the inner `brave.exe`. Works identically under the new name. In dev (`app.isPackaged === false`), `process.execPath` is `electron.exe` (or `.../node_modules/electron/dist/electron.exe`), which is also unchanged.

6. **Renderer GPU child process** — On Windows, Electron's GPU process is a child of the main process that re-executes the same binary with `--type=gpu-process` passed on the command line. Basename inheritance is automatic; no code change in the renderer or main process is needed. This is the exact path that causes NVIDIA's driver to see `brave.exe` when inspecting the process that decoded the video frame.

7. **Slide mode HTML5 `<video>` element** — `src/frontend/containers/ContentView/SlideMode/index.tsx:133,145,297` creates a plain `document.createElement('video')`. The decoded frames flow through Chromium's media pipeline into the GPU process for compositing. VSR inspects the GPU process name. No renderer change needed.

8. **Window titles** (`src/main.ts:155,195,247,400`) — All hardcoded as literal `'OneFolder'`. No derivation from `process.execPath` or `app.getName()` — so none of them leak "brave" into user-visible UI. Confirmed.

9. **Dialog copy** (`src/main.ts:425,506,532,561,745`) — All literal `'OneFolder'` strings. Not derived from the binary. No leakage.

10. **`autoUpdater` initialization** (`src/main.ts:17` import, `461` `autoDownload = false`, `463-465` dev config path, `467-544` event handlers, `128-130` startup check) — Initialized unconditionally in main process. The actual `autoUpdater.checkForUpdates()` call at line 129 is already gated by `!IS_PORTABLE_MODE`, and the IPC-triggered check at line 732-750 early-returns for portable. So electron-updater never actually does an update lookup in this fork. The library does still read `app.getVersion()` and `process.execPath` for internal state, but neither operation cares about the binary's basename. **No code change required**, but the test plan should confirm no error is thrown on startup in the portable build.

11. **`scripts/notarize.js`** — Mac-only (early returns when `process.platform !== 'darwin'`). Windows portable build never calls it. No change needed, but note that it reads `params.packager.appInfo.productFilename` at line 13, which on macOS would become `"brave.app"` if Mac builds were also produced. **Not relevant here** (Windows-only fork use), and even if it were, the Mac app is built via a different target.

12. **`common/library-registry.ts:196`** — Hardcodes the string `'OneFolder'` as a path segment under temp (`path.join(tempPath, 'OneFolder', libraryId, 'thumbnails')`). In portable mode this branch is not hit (line 192 returns `path.join(basePath, 'thumbnails', libraryId)` instead). Unaffected.

13. **posthog analytics** (`src/frontend/stores/UiStore.ts:241-244`) — Initialized with hardcoded API key; does not read `process.execPath` or exe name. PostHog captures a generic "my event" (looks like placeholder code, not real telemetry). No contamination of analytics from the rename.

14. **electron-google-analytics4** — In `package.json` dependencies but grep across `src/` shows no import or usage anywhere in the source. It's an unused dependency. No effect.

15. **Electron exe metadata stamping** (`winPackager.js` `signAndEditResources` lines 227-237) — Stamps `FileDescription` = `appInfo.productName` = `"OneFolder"` and `ProductName` = `"OneFolder"` into the renamed `brave.exe`. **This is ideal**: NVIDIA's driver reads the filename basename (`brave.exe` ✓), but Windows' Properties dialog and the user's mental model still see "OneFolder" everywhere else.

16. **Signing** — No signing is configured for Windows in this project (`package.json` has no `build.win.certificateFile` or similar). electron-builder skips signing when no cert is configured. The `forceCodeSigning` option is not set. Unaffected.

17. **`publish` block in `package.json`** (lines 89-94) — Configured for GitHub releases against `OneFolderApp/OneFolder`. This fork isn't being published to GitHub under that repo. The `publish` block is effectively ignored because the `package:portable` script doesn't pass `--publish`. No-op, but worth noting in case the user ever runs `yarn release` (which would try to push to a public repo — mentally park this but don't change it in this investigation).

18. **`build.files` and `build.asarUnpack`** (lines 77-84) — Reference `build/**/*`, `package.json`, and `node_modules/better-sqlite3/**`. None depend on `productName` or the binary name. Unaffected.

---

## UX / Requirements Specification

### Purpose

Two related changes:

1. Enable NVIDIA Video Super Resolution for video playback in slide mode by renaming the Windows binary basename to `brave.exe`.
2. Remove the NSIS installer target and its config block to simplify the build surface for this portable-only fork.

### User-Stated Design Decisions

1. **Rename to `brave.exe` specifically** — The user identified `brave.exe` from NVIDIA's driver-side VSR allowlist (the other options are `chrome.exe`, `msedge.exe`, `vivaldi.exe`). Since this is a personal fork, pick one and stick with it. Rationale: match an allowlisted name so the GPU driver's VSR post-processing engages.

2. **No public distribution concerns** — The user explicitly noted this is a personal fork, single-machine, never released publicly. Normal objections about trademark / code-signing / masquerading do not apply. Rationale: the user has authority to name their own private binary whatever they want.

3. **Drop the NSIS installer target** — The user's only distribution path is portable mode on their own machine. Keeping the NSIS target adds maintenance (config, template churn across electron-builder versions) with zero benefit. Rationale: simplify by removing dead code paths.

4. **Prefer `win.executableName` over `productName` rename** — The user's two edits to `package.json` (`win.executableName: "brave"` and `portable.artifactName: "brave.${ext}"`) follow this approach. The rationale is that `executableName` is the narrower hammer: it changes only the binary filename, not the display name, not Windows exe metadata, not dialog text. The fallback (`productName: "brave"` + `app.setName('OneFolder')` in main.ts) is only needed if `executableName` doesn't propagate to the portable target, which the investigation confirms it **does**.

5. **Do not modify `src/` for this change** — The user called out that no code change to the video element is needed (GPU child process inherits parent basename on Windows). Rationale: minimize surface area; the change is purely build-config.

### Behavioral Specifications

1. After `yarn package:portable`, a single artifact exists at `dist/brave.exe` (the outer NSIS-self-extractor wrapper).
2. Launching `dist/brave.exe` extracts to `%TEMP%\<hash>\` or (with `unpackDirName` set) `%TEMP%\<unpackDirName>\`, and runs the inner `brave.exe` from that directory.
3. In Task Manager (Details tab, "Name" column), the running process appears as `brave.exe`. Multiple `brave.exe` entries appear — one per Electron process (main, renderer, GPU, utility). All four are named `brave.exe`.
4. Windows Properties dialog on either the outer or inner `brave.exe` shows `FileDescription` = `OneFolder` and `ProductName` = `OneFolder` (stamped from `appInfo.productName`).
5. In slide mode, opening a video file triggers NVIDIA VSR if the driver + GPU support it and it is enabled in NVIDIA Control Panel. (The driver's decision is private; verification is via NVIDIA's tools, not OneFolder's UI.)
6. `yarn package` (no target flag) on Windows produces only the portable artifact — no `dist\OneFolder Setup 1.1.2.exe` NSIS installer file.
7. Portable mode detection continues to work: `process.env.PORTABLE_EXECUTABLE_DIR` is set by the outer wrapper, which triggers the portable branch in `src/main.ts:40-55`.
8. `forceRelaunch` continues to work: it spawns `process.env.PORTABLE_EXECUTABLE_FILE` (the outer `brave.exe`), which re-enters the portable boot path.

### Explicit Rejections

- **Do not set `productName: "brave"` in the `build` block.** Per the electron-builder source investigation, `executableName` is sufficient. Changing `productName` would also change Windows exe metadata (`FileDescription`, `ProductName` stamped into the exe) and various downstream places, none of which are desired.
- **Do not call `app.setName('OneFolder')` in `src/main.ts`.** Only needed if `productName` were renamed, which it isn't.
- **Do not modify `src/frontend/containers/ContentView/SlideMode/index.tsx`.** The `<video>` element is correct as-is; GPU child process basename inheritance is automatic on Windows.
- **Do not remove the `publish` block in `package.json`.** It is dormant (no `--publish` flag is used). Leaving it intact avoids surprise if upstream merges are ever considered.
- **Do not remove electron-updater from dependencies.** The library is still imported in `src/main.ts:17` and its event handlers are wired up. Actual update checks are gated by `!IS_PORTABLE_MODE`, so the library is effectively a no-op in portable builds; removing the import would be a separate cleanup outside the scope of this investigation.
- **Do not rename `productName` in the top-level `package.json` field** (line 3). That value feeds Electron's defaults (e.g., crash reporter product name) and also the `build.productName` fallback. Leaving it as `"OneFolder"` is correct.

### Uncertainty resolution

The user's prompt flagged uncertainty about whether electron-builder 23.6.0 honors `win.executableName` for the portable target specifically. Resolved by reading the pinned installed source:

- `node_modules/app-builder-lib/out/appInfo.js:53` — `executableName` feeds `productFilename`.
- `node_modules/app-builder-lib/out/electron/ElectronFramework.js:44-45` — `productFilename` renames the Electron binary on disk, before target packaging.
- `node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:155` and `:101-103` — the **same** NsisTarget class handles both `nsis` and `portable`; `PRODUCT_FILENAME` is written for both.
- `node_modules/app-builder-lib/templates/nsis/common.nsh:13` and `portable.nsi:86` — portable wrapper launches `$INSTDIR\${PRODUCT_FILENAME}.exe`.

**Conclusion: confirmed honored. The fallback plan is not needed. Remove the conditional from the task list.**

---

## Holistic Solution

### Approach

Three tasks, ordered by dependency:

1. **TASK-026 — `package.json` cleanup.** Drop the `"nsis"` entry from `build.win.target`; delete the `build.nsis` block; keep the already-added `build.win.executableName: "brave"` and `build.portable.artifactName: "brave.${ext}"` edits. Verify with `npx electron-builder --win portable` (or `yarn package:portable`) that the build completes and produces `dist/brave.exe`. Inspect that the `dist/win-unpacked/brave.exe` inner binary exists and is the renamed Electron binary.

2. **TASK-027 — Manual build-and-run verification (VSR engagement).** Build the portable artifact, copy to a fresh directory on a machine with a VSR-capable NVIDIA GPU, launch, open a video in slide mode. Verify via Task Manager that all Electron processes are named `brave.exe`. Verify via NVIDIA's tools (Control Panel indicators, or `nvidia-smi --query-gpu=...`, or visible upscaling on a low-resolution video) that VSR engages. Also verify portable mode bootstrapping: `%APPDATA%\OneFolder\` is NOT created when the portable build runs alongside a `data/` sibling; the data directory IS created alongside the binary.

3. **TASK-028 — Document the rename and the portable-only decision.** Add a short `docs/personal-fork-notes.md` (or similar — name at writer's discretion, do NOT call it a README) capturing: (a) why the Windows binary is `brave.exe`, (b) the citation chain in `node_modules/app-builder-lib` proving `executableName` propagates to the portable target, (c) the decision to drop the NSIS target. Link from `docs/index.md`. This is defensive documentation so the next contributor (or the user six months from now) understands the non-obvious naming.

### Conditional task (NOT created because investigation concluded it is unneeded)

Per the user's prompt, a fallback task for `app.setName('OneFolder')` + `productName: "brave"` was suggested **only if** `executableName` does not propagate to the portable target. The electron-builder 23.6.0 source investigation proves it does propagate, so this fallback is explicitly **not** created. If QA in TASK-027 surprises by finding the inner exe is still `OneFolder.exe`, re-open this investigation and add the fallback task then.

### Expected Outcomes

- `dist/brave.exe` produced by `yarn package:portable` (outer wrapper).
- Inner `brave.exe` inside the self-extraction temp dir (Task Manager shows `brave.exe` for main, renderer, GPU, and utility processes).
- NVIDIA VSR engages for HTML5 `<video>` elements in slide mode on supported hardware.
- No NSIS installer is produced.
- Portable mode detection, `forceRelaunch`, auto-updater gating, window titles, and all OneFolder-specific behavior continue to work unchanged.
- `package.json` is ~10 lines shorter (NSIS target entry + `build.nsis` block removed).

### Risks and Tradeoffs

- **If NVIDIA changes the allowlist** (adds more names, removes `brave.exe`, or changes the policy to include a signature check), the rename stops working. Mitigation: document the rationale in the fork notes so the next investigator understands where to look if VSR stops engaging. This is low risk — NVIDIA has kept the allowlist stable for years and the check is process-name only (no signature).
- **Fingerprinting confusion:** If the user ever runs any monitoring tool that keys off process name (task dashboards, parental controls, antivirus heuristics), they may see "brave.exe" and be confused. Acceptable — this is a single-user personal machine.
- **Upstream merges:** If the user ever rebases onto upstream OneFolder and merges in new `package.json` content, the `executableName` + `artifactName` edits may merge-conflict. Acceptable; resolve at merge time. The fork notes doc helps the future user remember why the edits exist.
- **Antivirus false positives:** A freshly built unsigned `brave.exe` that isn't **actually** Brave may trip heuristic antivirus. Mitigation: Windows Defender should be fine (no signature check, behavior-based). If third-party AV causes issues, add an exclusion. Acceptable risk for a single-user machine.
- **Auto-updater errors in portable:** Already gated (`!IS_PORTABLE_MODE` around `autoUpdater.checkForUpdates()`), but the `autoUpdater.on('error', ...)` handler at `src/main.ts:467` may fire during initialization if any pre-check runs. Verify during QA that no spurious error dialog appears. (Already a pre-existing behavior, not introduced by this change.)

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: a new `docs/personal-fork-notes.md` (or equivalent name chosen by the task writer) will be created as part of TASK-028 describing the rename rationale and the portable-only decision. `docs/index.md` gets a pointer to it.
