---
title: Personal Fork Notes
author: @rjdollete
last_updated: 2026-06-12
scope: fork
aliases: ["fork-notes", "brave-rename", "vsr-rename"]
---

# Personal Fork Notes

This is a personal, single-user fork of OneFolder. It is not intended for public distribution. The intentional deviations from upstream are documented here so that future readers (including the author) can understand what looks unusual and why.

## Summary of deviations

1. On Windows, the Electron binary is named `brave.exe` instead of `OneFolder.exe`.
2. The NSIS installer target is disabled; only the portable target ships.
3. A second bundled binary is included alongside ExifTool: **ffmpeg + ffprobe**
   under `resources/ffmpeg/`, compiled with `--enable-gpl --enable-libx264`.
   This enables the inspector "Re-encode (x264)" tool.  The GPL licensing
   caveat applies — see [Re-encode (x264)](reencode-x264.md) and the
   [Licensing caveat](#ffmpeg--libx264-licensing-caveat) section below.
4. Upstream-distribution features that do not make sense for a personal single-user fork have been removed: the `electron-updater` auto-update check, the PostHog analytics init, the "File bug report" / "Create Issue" buttons that opened upstream GitHub issues, and the canny.io "vote on our roadmap" feedback links.

Items 1–3 live entirely in `package.json` under the `build` key and require no source code changes. Item 4 touches `src/main.ts`, `src/ipc/`, `src/frontend/`, `common/config.ts`, and `package.json` dependencies.

## Why `brave.exe`?

NVIDIA's Video Super Resolution (VSR) driver applies its upscaling / enhancement pass to HTML5 `<video>` decode output, but only for processes whose basename appears on a hardcoded allowlist: `chrome.exe`, `msedge.exe`, `brave.exe`, `vivaldi.exe`. Electron apps under their normal executable names are never allowlisted, so VSR never engages for them — even though Electron is literally Chromium and would be fully capable of benefiting.

OneFolder renders video in slide mode via plain HTML5 `<video>` elements (`src/frontend/containers/ContentView/SlideMode/index.tsx` lines 133, 145, 297). Chromium's GPU child process, which is the one the driver actually inspects, inherits its basename from the parent on Windows. Renaming the Electron binary to one of the allowlisted names is therefore sufficient to make VSR engage — no code change to the video element or renderer is needed.

`brave.exe` was chosen (over `chrome.exe`) because Brave is itself an open-source Chromium derivative, making the name collision marginally less confusing in Task Manager than impersonating Google Chrome would be.

## How the rename propagates through electron-builder 23.6.0

The single `build.win.executableName: "brave"` line in `package.json` flows through the entire packaging chain. Citations are to the pinned electron-builder 23.6.0 under `node_modules/app-builder-lib/`:

- `out/appInfo.js:53` — `win.executableName` is assigned to `appInfo.productFilename`.
- `out/electron/ElectronFramework.js:44-45` — the raw Electron binary on disk is renamed to `brave.exe` during the framework step, before any target-specific packaging runs.
- `out/targets/nsis/NsisTarget.js:155` — writes `PRODUCT_FILENAME: "brave"` into the NSIS script defines. The same `NsisTarget` class handles both the `nsis` and `portable` targets (see `isPortable` at line 101-103), so the portable wrapper picks up the renamed inner binary.
- `templates/nsis/common.nsh:13` — `!define APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"`.
- `templates/nsis/portable.nsi:86` — `ExecWait "$INSTDIR\${APP_EXECUTABLE_FILENAME} $R0"` launches the inner `brave.exe` after the portable wrapper self-extracts to `%TEMP%`.

## What the rename does NOT change

`productName` remains `"OneFolder"` in both the top-level and `build` sections. Consequently:

- The exe's Windows Properties dialog still shows `FileDescription: OneFolder` and `ProductName: OneFolder` (stamped by `winPackager.js:234,237` from `appInfo.productName`).
- `app.getName()` and all user-visible window titles still say "OneFolder".
- Portable data directory detection (`src/main.ts:36-43`) is basename-independent and continues to work.
- `forceRelaunch` at `src/main.ts:976-999` uses `PORTABLE_EXECUTABLE_FILE` (set by the outer wrapper), not the inner basename, and continues to work.

The rename is narrowly targeted at the OS-level process basename — the single string the NVIDIA driver inspects. Everything else retains its OneFolder identity.

## Portable-only, no installer

`build.win.target` is `["portable"]`. The `build.nsis` config block has been removed. `yarn package:portable` (and `yarn package` on Windows) produces a single artifact: `dist/brave.exe`, a self-extracting portable wrapper. There is no `OneFolder Setup *.exe`.

Portable mode is triggered by the presence of a `data/` directory or `portable.txt` alongside the launched binary, per `src/main.ts:40-43`. Auto-updates are gated off in portable mode at `src/main.ts:128`.

## Why are `electron-updater`, PostHog, and canny.io feedback absent?

See [INV-006](TODO/pending_qa/investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md) for the full investigation and blast-radius analysis. This section summarizes the rationale and the update workflow for day-to-day use.

### Motivation

This fork's binary (`brave.exe`) is not distributed through the upstream release channel. Automatic update checks against `github.com/OneFolderApp/OneFolder/releases/latest` would attempt to replace a working `brave.exe` with an upstream `OneFolder.exe`, regressing the VSR rename documented above. The "check for updates" toolbar item in a fork build would steer the user toward downloading the wrong binary.

The fork user is also the sole maintainer. "File bug report" and "Create Issue" buttons that open pre-filled upstream GitHub issues are noise for upstream maintainers who cannot diagnose fork-local changes. Similarly, the canny.io "vote on our roadmap" feedback links in WIP panes point at an upstream product-management portal that has no relevance to a private fork.

PostHog analytics were initialized on every non-dev launch with `posthog.init(...)` followed immediately by a `posthog.capture('my event', ...)`. This sent an event to `https://eu.posthog.com` on every startup — phone-home behavior that is unambiguously wrong for a private single-user build where there is no product to measure.

### What was removed

- `electron-updater` dependency; `autoUpdater` import, startup check, event handlers, and IPC handlers in `src/main.ts`; the three IPC message constants (`CHECK_FOR_UPDATES`, `TOGGLE_CHECK_UPDATES_ON_STARTUP`, `IS_CHECK_UPDATES_ON_STARTUP_ENABLED`) and their messenger methods; the "check for updates" toolbar menu item; `src/frontend/containers/Settings/StartupBehavior.tsx` (dead code, already commented out of the Settings Tabs); `dev-app-update.yml` dev config at the repo root.
- `createBugReport` helper and `githubUrl` constant from `common/config.ts`; the "File bug report" button from the uncaughtException dialog in `src/main.ts`; the "Create Issue" button from `ErrorBoundary.tsx`; the "💡ideas + 🐞bugs" toolbar item from `SecondaryCommands.tsx`.
- `posthog-js` dependency; the `posthog.init` / `posthog.capture` block from the `UiStore` constructor.
- `electron-google-analytics4` dependency (was never imported in any source file; dead code from the start).
- `package.json` top-level `publish` block (pointed at upstream GitHub releases via `OneFolderApp/OneFolder`).
- `package.json` `scripts.release` entry (`git add . && git commit ... && git push && git push --tags` — dangerous if `origin` ever points at the upstream repo).
- Inline canny.io "vote on our roadmap" buttons in `ImageTools.tsx`, `ImageDuplicates.tsx` (component removed entirely), `MapView.tsx`, and `FaceGallery.tsx`; replaced with neutral WIP copy or removed.

### What was intentionally preserved

- The `github.com/OneFolderApp/OneFolder` `ExternalLink` in `About.tsx` — provenance information ("this fork derives from upstream X"), not primary bug-report UX.
- `package.json` `repository` and `author` fields — standard npm metadata with no runtime effect.
- The HelpCenter "About OneFolder" section — purely informational content about what the app does.
- `README.md` — upstream-authored boilerplate. It still references canny.io and upstream feedback links, but it is not runtime code and the fork does not curate it.

### How to update this fork

Since auto-updates are gone, the update workflow is entirely manual:

1. In the local fork repo: `git pull` (or cherry-pick from upstream as needed).
2. If `package.json` changed: `yarn install`.
3. `yarn package:portable`.
4. Copy `dist/brave.exe` to the portable directory, replacing the running binary.

### Upstream-rebase guidance

When merging future upstream changes, any conflict involving `autoUpdater`, `posthog`, `createBugReport`, `canny.io`, `dev-app-update.yml`, or the `publish` / `release` entries in `package.json` should be resolved in favor of the fork's removal — do not re-accept upstream's version of these features without re-reading [INV-006](TODO/pending_qa/investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md).

## Antivirus / naming caveat

The shipped binary is an unsigned `brave.exe` that is not actually Brave. Windows Defender should accept it based on runtime behavior, but heuristic AV scanners may false-positive on the name/publisher mismatch. Since this fork is used on a single known machine, the practical fix is to add an exclusion for the portable directory if needed.

If this fork is ever to be distributed more widely, this deviation must be reverted — the rename is acceptable for single-user personal use only. Packaging a binary named after another vendor's product under a different publisher's signature is a trademark issue and a malware-heuristic trigger.

## ffmpeg / libx264 licensing caveat

The bundled `resources/ffmpeg/ffmpeg.exe` and `resources/ffmpeg/ffprobe.exe`
are compiled with `--enable-gpl --enable-libx264`.  libx264 is licensed under
the GPL v2+.  Distributing a GPL binary carries source-offer and attribution
obligations.

**This fork is a private, single-user build and is never distributed.**  The
bundled GPL binary is therefore acceptable under personal-use terms — the same
reasoning that applies to the `brave.exe` rename above.  If this fork is ever
distributed more widely, the ffmpeg GPL obligations must be satisfied before
distribution.

See [Re-encode (x264)](reencode-x264.md) for full documentation of the tool.

## FileStore mutation model: in-place splice on destructive ops, refetch on semantic changes

Destructive file mutations and user-initiated re-queries have different semantics in `FileStore`, and that distinction is intentional.

**In-place splice (no refetch):** `FileStore.deleteFiles` and `LocationStore.removeSublocationFiles` splice files out of `fileList` without issuing any backend re-query. The mutation primitive is `FileStore.removeFilesFromListInPlace` — model any new destructive code path on it, not on `refetch()`. Adding a `refetch()` call after a delete would re-introduce the reshuffle bug fixed in INV-015.

- In-place splice callers: `FileStore.deleteFiles`, `LocationStore.removeSublocationFiles` (and any future caller that removes a known set of specific files).

**Refetch (re-sample; may reshuffle under random sort):** `FileStore.fetchAllFiles`, `fetchUntaggedFiles`, `fetchFilesByQuery`, `fetchDuplicatesFiles`, `fetchMissingFiles` — invoked by content-mode switches, tag add/delete/merge, search criteria changes, location additions, sort-order or sort-direction flips, and the chokidar post-startup new-files discovery.

- Random reshuffles on every refetch by design (INV-011); this is the accepted behavior for all of the semantic-change triggers listed above.

The two behaviors are intentional and complementary: destructive splices preserve the user's browsing context (current SlideMode position and visible gallery order) across deletes; semantic changes re-sample the backend because the relevant file set may have genuinely changed.

Cross-references: INV-011 (random as default sort; "reshuffle on every fetch by design" accepted), INV-015 (delete reshuffle bug; introduced `removeFilesFromListInPlace` and rewrote `deleteFiles` to use it).

## Reference

### INV-005 — brave.exe rename and portable-only

- Investigation: [INV-005](TODO/pending_qa/investigations/INV-005_MEDIUM_ELECTRON_brave-exe-rename-for-nvidia-vsr-and-portable-only.md)
- Tasks: TASK-026 (package.json edits), TASK-027 (QA, verified through normal use), TASK-028 (this doc)

### INV-006 — strip update-check, bug-report, and telemetry

- Investigation: [INV-006](TODO/pending_qa/investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md)
- Tasks: TASK-029 (remove update-check subsystem), TASK-030 (remove bug-report and canny.io UX), TASK-031 (remove PostHog telemetry), TASK-032 (remove upstream-distribution package.json surface and dependencies), TASK-033 (this doc)
