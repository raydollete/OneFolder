---
title: Personal Fork Notes
author: @rjdollete
last_updated: 2026-04-23
scope: fork
aliases: ["fork-notes", "brave-rename", "vsr-rename"]
---

# Personal Fork Notes

This is a personal, single-user fork of OneFolder. It is not intended for public distribution. Two intentional deviations from upstream are documented here so that future readers (including the author) can understand what looks unusual and why.

## Summary of deviations

1. On Windows, the Electron binary is named `brave.exe` instead of `OneFolder.exe`.
2. The NSIS installer target is disabled; only the portable target ships.
3. A second bundled binary is included alongside ExifTool: **ffmpeg + ffprobe**
   under `resources/ffmpeg/`, compiled with `--enable-gpl --enable-libx264`.
   This enables the inspector "Re-encode (x264)" tool.  The GPL licensing
   caveat applies — see [Re-encode (x264)](reencode-x264.md) and the
   [Licensing caveat](#ffmpeg--libx264-licensing-caveat) section below.

Both changes live entirely in `package.json` under the `build` key. No source code is modified.

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

- Investigation: [INV-005](TODO/pending_qa/investigations/INV-005_MEDIUM_ELECTRON_brave-exe-rename-for-nvidia-vsr-and-portable-only.md)
- Tasks: TASK-026 (package.json edits), TASK-027 (QA, verified through normal use), TASK-028 (this doc)
