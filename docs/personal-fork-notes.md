---
title: Personal Fork Notes
author: @rjdollete
last_updated: 2026-06-12
scope: fork
aliases: ["fork-notes", "windows-exe-name", "vsr-rename"]
---

# Personal Fork Notes

This is a personal fork of OneFolder, published under the same GPL-3.0 license as upstream. It is maintained for a single user's needs rather than as a general-purpose release. The intentional deviations from upstream are documented here so that future readers (including the author) can understand what looks unusual and why.

## Summary of deviations

1. The NSIS installer target is disabled; only the portable target ships.
2. A second bundled binary is included alongside ExifTool: **ffmpeg + ffprobe**
   under `resources/ffmpeg/`, compiled with `--enable-gpl --enable-libx264`.
   This enables the inspector "Re-encode (x264)" tool.  The GPL licensing
   caveat applies — see [Re-encode (x264)](reencode-x264.md) and the
   [Licensing caveat](#ffmpeg--libx264-licensing-caveat) section below.
3. Upstream-distribution features that do not make sense for a personal single-user fork have been removed: the `electron-updater` auto-update check, the PostHog analytics init, the "File bug report" / "Create Issue" buttons that opened upstream GitHub issues, and the canny.io "vote on our roadmap" feedback links.

Items 1–2 live entirely in `package.json` under the `build` key and require no source code changes. Item 3 touches `src/main.ts`, `src/ipc/`, `src/frontend/`, `common/config.ts`, and `package.json` dependencies.

## Windows executable name

From INV-005 until the `restore-onefolder-exe-name` change, the Windows binary was named `brave.exe`. NVIDIA's Video Super Resolution (VSR) driver only enhances HTML5 `<video>` output in processes whose basename is on a hardcoded browser allowlist (`chrome.exe`, `msedge.exe`, `brave.exe`, `vivaldi.exe`), and the rename made VSR engage for in-app video.

For public release the binary was renamed back: the inner executable is `OneFolder.exe` (`build.win.executableName`) and the portable artifact is `OneFolder-<version>-x64.exe` (`build.portable.artifactName`). A binary named after another vendor's product is a trademark problem and a malware-heuristic trigger. As a consequence, **NVIDIA VSR no longer engages for in-app video playback**. This is accepted, not a regression.

Portable data detection uses the wrapper's `PORTABLE_EXECUTABLE_DIR`, not the basename, so an existing `data/` keeps working after the rename.

## Portable-only, no installer

`build.win.target` is `["portable"]`. The `build.nsis` config block has been removed. `yarn package:portable` (and `yarn package` on Windows) produces a single artifact: `dist/OneFolder-<version>-x64.exe`, a self-extracting portable wrapper. There is no `OneFolder Setup *.exe`.

Portable mode is entered when the packaging format is portable (the Windows portable wrapper or a Linux AppImage), or when a `portable.txt` or an existing `data/` directory sits beside the launched binary (`src/main.ts:118-125`, resolved by `src/portable-launch-context.ts`). There are no auto-updates in any mode (see below).

## Why are `electron-updater`, PostHog, and canny.io feedback absent?

See [INV-006](TODO/pending_qa/investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md) for the full investigation and blast-radius analysis. This section summarizes the rationale and the update workflow for day-to-day use.

### Motivation

This fork's binary is not distributed through the upstream release channel. Automatic update checks against `github.com/OneFolderApp/OneFolder/releases/latest` would attempt to replace the fork's portable build with an upstream release, dropping every fork deviation documented here. The "check for updates" toolbar item in a fork build would steer the user toward downloading the wrong binary.

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
4. Close the app, remove the previous `.exe` from the portable directory, and copy in `dist/OneFolder-<version>-x64.exe`. Keep `data/`.

### Upstream-rebase guidance

When merging future upstream changes, any conflict involving `autoUpdater`, `posthog`, `createBugReport`, `canny.io`, `dev-app-update.yml`, or the `publish` / `release` entries in `package.json` should be resolved in favor of the fork's removal — do not re-accept upstream's version of these features without re-reading [INV-006](TODO/pending_qa/investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md).

## ffmpeg / libx264 licensing caveat

The bundled `resources/ffmpeg/ffmpeg.exe` and `resources/ffmpeg/ffprobe.exe`
are an unmodified gyan.dev FFmpeg 8.1.1 build compiled with `--enable-gpl
--enable-version3 --enable-libx264`, so they are licensed GPLv3.  Because this
repository is public, committing them distributes them, which carries license-notice
and source-availability obligations.

Those obligations are met by [`resources/THIRD_PARTY.md`](../resources/THIRD_PARTY.md),
which names the exact build, its license, and where to get the Corresponding
Source.  If the binaries are replaced, update that record in the same commit.

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

### INV-005 — brave.exe rename and portable-only (rename reverted by restore-onefolder-exe-name)

- Investigation: [INV-005](TODO/pending_qa/investigations/INV-005_MEDIUM_ELECTRON_brave-exe-rename-for-nvidia-vsr-and-portable-only.md)
- Tasks: TASK-026 (package.json edits), TASK-027 (QA, verified through normal use), TASK-028 (this doc)

### INV-006 — strip update-check, bug-report, and telemetry

- Investigation: [INV-006](TODO/pending_qa/investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md)
- Tasks: TASK-029 (remove update-check subsystem), TASK-030 (remove bug-report and canny.io UX), TASK-031 (remove PostHog telemetry), TASK-032 (remove upstream-distribution package.json surface and dependencies), TASK-033 (this doc)
