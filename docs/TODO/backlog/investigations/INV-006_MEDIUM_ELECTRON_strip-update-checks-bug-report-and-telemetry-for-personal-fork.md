---
id: INV-006
title: 'Strip update-check, bug-report, and telemetry surface area for personal fork'
reported_bug: 'This is a personal single-user fork. Features that only make sense for the public upstream distribution — automatic update checks (which can misbehave against a custom-built unsigned brave.exe that is not published on the upstream release channel), "Report a bug" / feedback UI that points at the upstream GitHub issues tracker and canny.io feedback portal, and the PostHog analytics capture that fires for every non-dev launch — should be removed. Keep informational "About" links to the upstream repo (reading them is fine); remove the runtime features that actively phone home, open upstream issue forms, or surface dead UI about an update channel this fork does not consume.'
date: 2026-04-23
status: active
superseded_by:
tasks_spawned: [TASK-029, TASK-030, TASK-031, TASK-032, TASK-033]
root_cause_category: architectural-shortcoming
affects:
  - 'Electron main process auto-update wiring (src/main.ts: import, startup check, event handlers, IPC handlers)'
  - 'electron-updater dev config (dev-app-update.yml)'
  - 'electron-builder publish config (package.json build.publish / top-level publish)'
  - 'Runtime dependencies (package.json: electron-updater, electron-google-analytics4, posthog-js)'
  - 'Preferences file shape (src/main.ts PreferencesFile.checkForUpdatesOnStartup)'
  - 'IPC message catalogue (src/ipc/messages.ts: CHECK_FOR_UPDATES, TOGGLE_CHECK_UPDATES_ON_STARTUP, IS_CHECK_UPDATES_ON_STARTUP_ENABLED)'
  - 'IPC main/renderer wiring (src/ipc/main.ts, src/ipc/renderer.ts)'
  - 'Renderer Settings panel (src/frontend/containers/Settings/StartupBehavior.tsx — already disabled from Tabs, still present as dead code)'
  - 'Renderer toolbar menu (src/frontend/containers/AppToolbar/SecondaryCommands.tsx: "check for updates" item, "💡ideas + 🐞bugs" canny.io link)'
  - 'Renderer uncaught-error paths (src/main.ts uncaughtException dialog; src/frontend/containers/ErrorBoundary.tsx Create Issue button)'
  - 'Bug-report body helper and upstream URL constant (common/config.ts: createBugReport, githubUrl)'
  - 'Inline canny.io feedback buttons in WIP panes (ImageTools, ImageDuplicates, MapView, FaceGallery)'
  - 'About dialog upstream links (src/frontend/containers/About.tsx — already unreachable UI but contains "Provide feedback and report bugs" copy)'
  - 'PostHog telemetry init and capture (src/frontend/stores/UiStore.ts constructor)'
  - 'yarn release git push script (package.json scripts.release — pushes to upstream repo, does not belong in a fork)'
  - 'docs/personal-fork-notes.md — new third fork deviation to document'
  - 'docs/index.md — pointer consistency'
---

## Bug Report

### Observed Behavior

This is a personal single-user fork of OneFolder shipped as a renamed `brave.exe` portable-only Windows build (per INV-005). The upstream public distribution ships a number of features — automatic update checks, a "Report a bug" flow that opens the upstream GitHub issues tracker, canny.io feedback links scattered through work-in-progress UI, and PostHog analytics — that are either meaningless, actively harmful, or privacy-surprising for this fork:

1. **electron-updater tries to check against the upstream GitHub release channel on every startup** by default (`src/main.ts:128-130`, gated on `preferences.checkForUpdatesOnStartup === true` which defaults to `true` when the preferences file is absent at line 126). In portable mode this is additionally gated (`!IS_PORTABLE_MODE`), so the startup check is already suppressed for this fork's portable build — but the rest of the wiring is still live: `autoUpdater.on('error'|'update-available'|'update-not-available'|'update-downloaded'|'download-progress', ...)` handlers at lines 467-544, the IPC-triggered `MainMessenger.onCheckForUpdates` at line 732-752 (which for portable mode opens a dialog offering to take the user to the upstream releases page), and the toolbar "check for updates" menu item in `src/frontend/containers/AppToolbar/SecondaryCommands.tsx:55-59` that invokes it. A user who clicks "check for updates" in a fork build sees a dialog steering them to download the upstream release — which would silently replace their `brave.exe` with `OneFolder.exe` and regress the VSR fix in INV-005.

2. **The uncaught-exception dialog in `src/main.ts:547-586` offers a "File bug report" button** that encodes `error.stack` via `createBugReport()` (from `common/config.ts:34-56`) and opens the upstream GitHub issues form at `https://github.com/OneFolderApp/OneFolder/issues/new?body=...`. The same flow exists in the React `ErrorBoundary` component (`src/frontend/containers/ErrorBoundary.tsx:97-103` and its "Create Issue" button at line 129-134). These buttons steer a fork user into filing bugs about fork-local changes in the upstream maintainers' tracker — noise for the maintainers and confusion for the user.

3. **The toolbar `SecondaryCommands` popover** (`src/frontend/containers/AppToolbar/SecondaryCommands.tsx`) currently surfaces three items: Settings, "💡ideas + 🐞bugs" (opens `https://onefolder.canny.io/feedback`), "help center" (opens a Notion page), and "check for updates" (the IPC-triggered updater). Two of those — canny.io feedback and the update check — are upstream-community-oriented features the fork user does not need.

4. **Inline WIP "Let us know / vote on our roadmap" buttons** in four places (`src/frontend/components/ImageTools.tsx:24-26`, `src/frontend/components/ImageDuplicates.tsx:22-24`, `src/frontend/containers/ContentView/MapView.tsx:40-47`, `src/frontend/containers/ContentView/FaceGallery.tsx:55-62`) steer users to canny.io feedback threads for WIP features (find-duplicates, map-view, face-view, and general ideas). These are upstream-product-management UI, not personal-fork-appropriate.

5. **About dialog** (`src/frontend/containers/About.tsx`) reads "Provide feedback and report bugs" in its bullet list under the upstream GitHub link. The dialog is already unreachable in practice — `uiStore.toggleAbout` is only wired to a commented-out menu item in `SecondaryCommands.tsx:60` — but the component is still mounted by `App.tsx:64` so any future re-enablement would surface the upstream-community copy.

6. **PostHog analytics** is initialized on UiStore construction when `IS_DEV === false` (`src/frontend/stores/UiStore.ts:240-245`), pointed at `https://eu.posthog.com` with a hardcoded project key, and immediately fires a placeholder `posthog.capture('my event', { property: 'value' })`. This is unambiguously "phone home" behavior — every packaged build sends an event to an external service on startup.

7. **`electron-google-analytics4`** is listed in `package.json` dependencies but has zero source imports (verified by grep; already noted in INV-005 §14). Dead dependency that still downloads/packs bytes.

8. **`dev-app-update.yml`** at the repo root hardcodes `owner: OneFolderApp, repo: OneFolder, provider: github` for dev-mode update-check simulation. Once the update wiring is removed, this file becomes dead and its commit trail of "simulated the upstream update channel" is misleading for a fork.

9. **`package.json` `scripts.release`** is `git add . && git commit -m "v$npm_package_version" && git tag "v$npm_package_version" && git push && git push --tags` — a push to whatever `origin` is set to. If the user keeps upstream as a remote and runs `yarn release` with an origin typo, they push fork-local changes (brave rename included) upstream. Not exactly a "check for updates" feature, but in the same family of "upstream-distribution wiring that does not belong in a fork."

10. **`package.json` `publish` block** (lines 84-89, pointing at `OneFolderApp/OneFolder`) is dormant today (no `--publish` flag on any script), but is the sibling of (9): if a future `yarn package --publish` ever runs it would try to upload a fork artifact to the upstream GitHub release page, which is wrong both technically (token won't exist) and organizationally.

### Expected Behavior

1. **No startup update check, no UI entry-point for checking updates, no update-event handlers, no preferences field for it.** The `electron-updater` dependency can be removed entirely. The fork user updates by rebuilding and replacing `brave.exe` manually (documented already in `docs/personal-fork-notes.md`).

2. **No bug-report buttons or upstream GitHub issues URL generation from inside the app.** The uncaught-exception dialog still shows the error and still offers restart/keep-running/quit, but no "File bug report" option. ErrorBoundary still shows the error and the Reload / DevTools / Clear Database buttons, but no "Create Issue" button. The `createBugReport` function and `githubUrl` constant in `common/config.ts` are removed.

3. **No canny.io feedback links in WIP panes or the toolbar.** Where a feature is WIP (MapView, FaceGallery, ImageDuplicates) the copy should say so without steering the user to the upstream feedback site. The "💡ideas + 🐞bugs" SecondaryCommands item is removed.

4. **No PostHog init or capture.** The dependency is removed.

5. **No `electron-google-analytics4` dependency** — dead code already.

6. **No `dev-app-update.yml`.**

7. **`package.json` `publish` block removed.** `scripts.release` removed (or neutered). This prevents a future accidental push-to-upstream.

8. **Informational upstream links in About.tsx are preserved** (the component is already unreachable from the UI, and the link to `github.com/OneFolderApp/OneFolder` is acceptable "where this came from" context, not primary bug-report UX). Tidy the bullet list copy to drop "Provide feedback and report bugs" since that route is no longer wired up — but keep the repo link itself.

9. **`docs/personal-fork-notes.md`** gains a third deviation section describing the strip-out, so a future reader (or the user six months from now) understands why electron-updater and PostHog are absent and the Settings tab has no "Check for updates on startup" toggle.

### Reproduction Context

Deterministic. Triggers:

1. Build and run the fork (`yarn package:portable` → `dist/brave.exe`, launch it).
2. Observe on startup: a single `posthog.capture('my event', ...)` network request to `https://eu.posthog.com`. (Gated on `!IS_DEV`, so `yarn start` against a webpack watch build will NOT reproduce — only packaged builds do.)
3. Open the three-dot "More" menu in the toolbar. Observe the "💡ideas + 🐞bugs" and "check for updates" items.
4. Click "check for updates" in a portable build → see the dialog suggesting to download the upstream release (which would regress the VSR rename from INV-005).
5. Force an uncaught exception (e.g., via DevTools console: `setTimeout(() => { throw new Error('test') }, 100)` from the main process — easier to reproduce by breaking the ErrorBoundary path in the renderer) → see the "File bug report" / "Create Issue" button.

Platform: any (the issues are cross-platform). Electron 27.1.2, electron-builder 23.6.0, posthog-js 1.96.1, electron-updater 6.1.7.

---

## Root Cause Analysis

**Category:** architectural-shortcoming

### Diagnosis

This is not a defect in any single module — it is a **distribution-model mismatch**. The upstream OneFolder codebase is designed for a public open-source release: it phones home to PostHog for product analytics, advertises canny.io as the feedback/roadmap portal, runs automatic update checks against the GitHub release channel, and offers one-click bug-report buttons that file in the upstream issue tracker. Every one of those features assumes the binary running on the user's machine is the same as the one the OneFolderApp org shipped.

This personal fork intentionally diverges:

- Ships a renamed `brave.exe` binary (INV-005).
- Ships portable-only with no NSIS installer (INV-005).
- Will be rebuilt from a local checkout whenever the user wants an update.

In that model, every upstream-distribution feature is at best dead wiring and at worst actively harmful:

- **Auto-update against the upstream channel** would attempt to replace a working `brave.exe` with an upstream `OneFolder.exe`, regressing VSR. Already gated off in portable mode by INV-005's prior mitigation (`src/main.ts:128`, `732-750`), but the wiring is still there and can fire if the user ever disables portable mode or runs a dev build.
- **"File bug report" buttons** file upstream under fork-local changes, wasting maintainer time.
- **PostHog telemetry** phones home without user consent — this was always questionable in the upstream and is unambiguously wrong for a personal fork where there is no product to measure.
- **Upstream publish/release scripts** risk accidental push of fork-local changes to the public repo.

Why "architectural-shortcoming" rather than another category:

- **Not a wrong mental model:** Each feature is coded correctly for the upstream distribution. The architecture assumption that the binary == the upstream release is the shortcoming.
- **Not a missing edge case:** Nothing is conditionally broken; the features work exactly as designed. They are just the wrong design for a fork.
- **Not silent failure:** No exceptions are swallowed. The wiring fires visibly — a PostHog request, a dialog button, a menu item.
- **Architectural shortcoming** is the right fit because the upstream codebase's distribution architecture (update channel, feedback portal, analytics backend, issue tracker) was never parameterized for "this is a private fork, disable the whole class of features." The fix is a surgical removal, not a feature flag (flags add surface area; the user's directive is to remove, not hide).

The INV-005 companion pattern applies: follow the narrowest-hammer principle. Remove the features, do not merely hide them behind a preference toggle. A fork-local preference toggle is ongoing maintenance cost (merge conflicts with upstream, UI surface); removal is a one-time edit that stays clean across rebases as long as the edits live in a small, well-known set of files.

### Diagnostic Questions Considered

- **Wrong mental model?** No — each subsystem is internally coherent; the mismatch is between the subsystems and the fork's distribution model.
- **Architectural shortcoming?** Yes — upstream-distribution wiring was never parameterized for a forked private build. Primary category.
- **Incorrect order of operations?** No — each feature fires at the correct lifecycle point for its intent.
- **Missing edge case?** No — there is no "fork mode" edge case to handle; the whole class of features is unwanted.
- **Wrong abstraction?** Partial — `createBugReport()` in `common/config.ts` models a GitHub-issue-body-formatter as a generic utility, but it is not actually generic; it is hardcoded to the upstream repo via `githubUrl`. Removing both together is cleaner than refactoring.
- **Silent failure?** No — everything works exactly as coded; the work is removal, not repair.

---

## Blast Radius

Each of the following is a site where the removal must touch. Grouped by concern so the task breakdown in §Holistic Solution can map cleanly.

### Update-check surface area

1. **`src/main.ts:17`** — `import { autoUpdater, UpdateInfo } from 'electron-updater';` Remove.

2. **`src/main.ts:87-94`** — `PreferencesFile.checkForUpdatesOnStartup` field, `updatePreferences` helper. The preferences file loading logic (`initialize()` lines 117-133) can be simplified: the only field in `PreferencesFile` today is `checkForUpdatesOnStartup`, so once removed the file becomes empty-object-only. Options: (a) remove the entire `preferences` subsystem; (b) keep it as a stub for future per-fork preferences. Recommended: remove entirely — the preferences.json file in `userData` becomes a dead file on disk but harmless (can be ignored). Don't delete the existing file on upgrade; just stop reading or writing it.

3. **`src/main.ts:126-130`** — `preferences = { checkForUpdatesOnStartup: true }; if (preferences.checkForUpdatesOnStartup && !IS_PORTABLE_MODE) { autoUpdater.checkForUpdates(); }`. Remove the entire try/catch preferences-init block if taking option (a).

4. **`src/main.ts:456-544`** — Entire "Auto-updates" section: comment banner, `autoUpdater.autoDownload`, `hasCheckedForUpdateOnStartup` flag, IS_DEV `updateConfigPath`, and all five event handlers (`error`, `update-available`, `update-not-available`, `update-downloaded`, `download-progress`). Remove en bloc.

5. **`src/main.ts:732-761`** — `MainMessenger.onCheckForUpdates`, `onToggleCheckUpdatesOnStartup`, `onIsCheckUpdatesOnStartupEnabled` IPC handlers. Remove.

6. **`src/ipc/messages.ts:112-114`** — `CHECK_FOR_UPDATES`, `TOGGLE_CHECK_UPDATES_ON_STARTUP`, `IS_CHECK_UPDATES_ON_STARTUP_ENABLED` constants. Remove.

7. **`src/ipc/main.ts:4, 20, 44, 183-189`** — Import references, and the `onCheckForUpdates` / `onToggleCheckUpdatesOnStartup` / `onIsCheckUpdatesOnStartupEnabled` static methods. Remove.

8. **`src/ipc/renderer.ts:4, 20, 44, 170-176`** — Import references, and the `checkForUpdates` / `isCheckUpdatesOnStartupEnabled` / `toggleCheckUpdatesOnStartup` static methods. Remove.

9. **`src/frontend/containers/AppToolbar/SecondaryCommands.tsx:55-59`** — "check for updates" MenuItem. Remove.

10. **`src/frontend/containers/Settings/StartupBehavior.tsx`** — Entire file. Already commented out of `Settings/index.tsx` Tabs at lines 12, 52-55. Delete the file (no longer imported anywhere once StartupBehavior's import line at `Settings/index.tsx:12` is also cleaned).

11. **`dev-app-update.yml`** (repo root) — Dev-mode update-check config. Delete.

12. **`package.json` dependencies** — Remove `"electron-updater": "^6.1.7"` (line 148). Will require a `yarn install` to regenerate the lockfile.

### Bug-report surface area

13. **`src/main.ts:20`** — `import { createBugReport, githubUrl } from '../common/config';` Remove.

14. **`src/main.ts:547-586`** — Uncaught-exception dialog: currently offers "Try to keep running", "File bug report", "Restart OneFolder", "Quit OneFolder". Change to three buttons: "Try to keep running", "Restart OneFolder", "Quit OneFolder". Drop the "File bug report" branch (the `createBugReport` encoding + `shell.openExternal(url)` at lines 567-571). Adjust the error message copy: "Please file a bug report if you think this needs fixing!" (line 550) → "An unexpected error occurred." (drop the call-to-action sentence). Renumber the dialog button response branches accordingly.

15. **`src/main.ts:506`** — Inside the `update-available` handler's "Open release page" branch. This whole handler is removed in §Update-check #4, so this line goes with it.

16. **`src/main.ts:745`** — Inside `onCheckForUpdates` → `IS_PORTABLE_MODE` branch, the `shell.openExternal('.../releases/latest')`. Whole handler removed in §Update-check #5.

17. **`src/frontend/containers/ErrorBoundary.tsx:1-145`** — Specifically: remove the `shell` and `createBugReport` and `githubUrl` imports (lines 2, 6); remove the `openIssueURL` method (lines 71, 97-103); remove the `<Button ... text="Create Issue" />` (lines 129-134). The `ClearDbButton` component and the render path remain. The "contact the maintainers" copy at line 114 should also be softened — the ErrorBoundary UI is a renderer-crash fallback and users have no maintainers to contact in a fork, so change to "You can try one of the following options." or similar.

18. **`common/config.ts:6, 29-56`** — `githubUrl` constant and `createBugReport` helper function. Remove both. The file's remaining exports (`SERVER_PORT`, `chromeExtensionUrl`, `firefoxExtensionUrl`, `RECURSIVE_DIR_WATCH_DEPTH`, `MAX_TAG_DEPTH`, `thumbnailFormat`, `thumbnailMaxSize`, `maxNumberOfExternalFilesBeforeWarning`) are unrelated and stay. The `import os from 'os'` at line 1 becomes unused once `createBugReport` is removed — also delete.

19. **`src/frontend/containers/AppToolbar/SecondaryCommands.tsx:38-44`** — "💡ideas + 🐞bugs" MenuItem. Remove.

20. **`src/frontend/components/ImageTools.tsx:20-30`** — The "Ideas on what we should add? … Let us know" text and canny.io button. Rewrite the "Tools" inspector section to either (a) drop the feedback block entirely (keeping only the disabled tool buttons as a "coming later" visual stub), or (b) replace with a neutral note that the tools are not yet implemented. Option (a) preferred for minimal surface area.

21. **`src/frontend/components/ImageDuplicates.tsx:18-29`** — "Learn more here" button linking to canny. This component is imported in `Inspector/index.tsx:9` but the `InspectorToggleSection` that mounts it (lines 70-76) is currently commented out, so the component is not rendered in practice. Still, for a clean sweep: replace the canny button with a neutral "This feature is not ready yet." paragraph, or simply remove the component file if nothing else imports it (Inspector import can go with it). Recommended: remove the component file and its import in Inspector/index.tsx, since the InspectorToggleSection is already commented out. Smaller source tree.

22. **`src/frontend/containers/ContentView/MapView.tsx:34-52`** — The canny.io "vote on our roadmap" button. This is a WIP placeholder shown while the Map feature is not implemented. Replace with neutral copy: "The map view is not yet implemented." Remove the `shell` import and `button` element.

23. **`src/frontend/containers/ContentView/FaceGallery.tsx:48-67`** — Same pattern as MapView: canny.io "vote on our roadmap" button inside the WIP container. Replace with neutral copy and remove the `shell` import.

24. **`src/frontend/containers/ContentView/Placeholder.tsx:182-188`** — `BugReport` placeholder component. This is a catch-all fallback shown when the Content mode decision tree falls through (see Placeholder.tsx:26). It does not open a URL; it just displays "You encountered a bug! Please report this bug to the maintainers!" The copy is misleading in a fork (there are no maintainers to report to). Soften the copy: title "Something went wrong", body "Try selecting a different view from the sidebar." The component name can stay as `BugReport` for minimal diff, or rename to `UnexpectedState`. Low priority.

25. **`src/frontend/containers/About.tsx:38-41`** — "🐛 Provide feedback and report bugs" bullet. The About dialog is currently unreachable (the one call site at `SecondaryCommands.tsx:60` is commented out), so this is cosmetic. But the user explicitly listed the About copy as worth tidying. Remove the feedback bullet; keep the "🤓 View the source code" and "👥 Learn about contributing" bullets, or drop all three and keep just the repo link. Minimal removal: drop only the feedback bullet.

### Telemetry surface area

26. **`src/frontend/stores/UiStore.ts:17`** — `import posthog from 'posthog-js';` Remove.

27. **`src/frontend/stores/UiStore.ts:240-245`** — The `if (!IS_DEV) { posthog.init(...); posthog.capture('my event', ...); }` block inside the UiStore constructor. Remove. The `IS_DEV` import at line 4 is used elsewhere in the file (grep to confirm before removing it).

28. **`package.json` dependencies** — Remove `"posthog-js": "^1.96.1"` (line 156) and `"electron-google-analytics4": "^1.1.1"` (line 147). Will require a `yarn install` to regenerate the lockfile.

### Upstream-publish surface area

29. **`package.json` top-level `publish` block** (lines 84-89) — Remove. Prevents accidental upload to upstream's GitHub releases if any future electron-builder command ever runs with `--publish`.

30. **`package.json` `scripts.release`** (line 23) — `"git add . && git commit -m ... && git push && git push --tags"`. This script is upstream-oriented (pushes to whatever `origin` is). For a fork, either:
    - Remove the script entirely (preferred).
    - Replace it with a fork-local version that commits and tags without `git push`, so the user can review before pushing anywhere.

    Recommended: remove. The user can run `git commit` + `git tag` + `git push <fork-remote>` manually when they want to version the fork.

### Documentation surface area

31. **`docs/personal-fork-notes.md`** — Add a third section ("Why are electron-updater, PostHog, and canny.io feedback absent?") summarizing the strip-out and linking back to INV-006. Keeps the fork-notes doc as the single source of truth for all intentional deviations.

32. **`docs/index.md`** — The existing pointer to `docs/personal-fork-notes.md` already exists (row 44). No change needed unless the user wants a separate doc for the strip-out (not recommended — one consolidated fork-notes doc is better for maintenance).

33. **`README.md`** — Lines 7 and 55 reference the canny.io roadmap and "feedback and suggestion on design" respectively. This file is upstream-authored and the user has deprioritized docs in their prompt. Leave as-is (the README is not part of the runtime), and note in fork-notes that the README is upstream boilerplate.

### Non-changes (intentionally left alone)

- **`About.tsx` `github.com/OneFolderApp/OneFolder` ExternalLink** (line 34) — Keep. This is provenance information ("this fork derives from upstream X"), not primary bug-report UX. The user explicitly distinguished these in the prompt.
- **`onefolder.app/` ExternalLink** in About.tsx (line 28) — Keep. Marketing site for the upstream project, informational.
- **`package.json` top-level `repository` field** (line 83) — Keep. Standard npm metadata; removing it has no runtime effect and is a larger diff than the rest.
- **`package.json` `author` field** (`"OneFolder"`) — Keep. Embedded into the packaged exe's company metadata; changing it is unrelated to the strip-out and would be a separate fork-identity decision.
- **HelpCenter `About OneFolder` section** (`src/frontend/containers/HelpCenter.tsx:193-219`) — Keep. Informational content about what the app does, no upstream-community wiring.

---

## UX / Requirements Specification

### Purpose

Strip every runtime feature that (a) phones home to an upstream service (update check, analytics), (b) steers the user to the upstream community (canny.io feedback, GitHub issues), or (c) advertises upstream-release behavior that this fork does not honor. Keep informational provenance links.

### User-Stated Design Decisions

1. **Remove, do not flag-disable.** The user's directive was "remove them," not "add a toggle to hide them." Matching INV-005's narrowest-hammer pattern, removal keeps the fork maintenance surface small (no new preferences, no new toggles) and is robust across upstream rebases (a removed import will merge-conflict loudly; a hidden feature silently re-enables itself).

2. **Distinguish "About" provenance from "primary bug-report UX."** The user explicitly noted that About-info links (e.g. the upstream repo URL) are fine to keep, but the primary bug-report and feedback UX must go. Cleanly split the two: About.tsx keeps its repo link, loses the "Provide feedback and report bugs" bullet; SecondaryCommands loses both the canny.io item and the check-for-updates item.

3. **Do not break existing features.** ErrorBoundary and the uncaught-exception dialog must still catch errors and offer a way to restart or quit; they just lose the "Create Issue / File bug report" button. PostHog removal must not break UiStore construction. ImageTools still renders as an Inspector section, just without the feedback button. MapView / FaceGallery still render as WIP placeholders, just without the canny.io link.

4. **Docs priority is low** per user prompt. Update `docs/personal-fork-notes.md` because that is the single source of truth for fork deviations and a future reader will need it. Do NOT crawl `docs/metadata-sync-implementation.md`, `docs/location-loading.md`, etc. for casual "feedback" word mentions — those are internal docs, not user-facing, and the word "feedback" in them refers to UX (toast notifications, progress indicators) not to the upstream feedback portal.

5. **Remove unused dependencies** even where they have no runtime effect (`electron-google-analytics4`) — they bloat install time and `node_modules` size with no benefit. One clean sweep is cheaper than two.

### Behavioral Specifications

1. **Packaged portable build (`brave.exe`) makes no outbound HTTP request on launch.** Verification: wireshark or Chromium's DevTools Network tab (if the user re-enables it on a packaged build) should show zero external requests from the main process or renderer on cold start. PostHog, electron-updater, GA — all gone.

2. **Toolbar "More" (three-dots) menu shows exactly: Settings + Help center.** No "check for updates", no "💡ideas + 🐞bugs". Possibly also drop "help center" if the user wants — it links to a Notion page that is upstream-authored — but the user's prompt did not explicitly list it, so leave it alone for this investigation. (If the user wants it gone, trivially add to a future task.)

3. **Uncaught exception dialog offers three buttons: Try to keep running, Restart OneFolder, Quit OneFolder.** Error message copy drops the "Please file a bug report if you think this needs fixing!" line.

4. **ErrorBoundary fallback offers: Reload, Toggle DevTools, Clear Database.** No "Create Issue" button. Copy drops "contact the maintainers".

5. **Inspector "Tools" section** shows the four disabled tool buttons (HEIC → JPEG, Optimize JPEG, Fix red eyes, Colorize) and either nothing or a neutral "not yet implemented" caption below. No "Ideas on what we should add? Let us know" CTA.

6. **Map view and Face view** still display their WIP messages ("The map is not ready yet" / "Face view is not done yet") and their placeholder content. The canny.io "vote on our roadmap" button is replaced with a plain sentence or removed entirely.

7. **About dialog** (unreachable today; preserved-but-tidied for any future re-enablement) shows the two ExternalLinks (`onefolder.app`, `github.com/OneFolderApp/OneFolder`) with a "🤓 View the source code" bullet under the latter. No "Provide feedback and report bugs" bullet.

8. **Settings panel** is unchanged in visible surface area: StartupBehavior was already commented out. This investigation additionally **deletes the StartupBehavior.tsx file** so the dead code is actually gone from the tree.

9. **`yarn install` after the dependency removals** succeeds and produces a smaller `node_modules/` with electron-updater, posthog-js, and electron-google-analytics4 absent.

10. **`yarn build` and `yarn package:portable` succeed** after the code removals with no compile errors (the IPC message constant deletions, the import deletions, the type field deletions must all be consistent).

### Explicit Rejections

- **Do not add a "fork mode" feature flag.** The user wants removal, not a toggle. Adding a flag creates upstream-merge surface area and UI complexity.
- **Do not remove the About dialog component.** It is currently unreachable but harmless, and leaving it (with tidied copy) means a future "add an About menu item" change does not require re-implementing the dialog.
- **Do not remove all upstream repo references from the source.** The `About.tsx` ExternalLink and the `package.json` `repository` field are provenance, not bug-report UX.
- **Do not sweep docs for every "feedback" word.** The term is overloaded (UX feedback vs. community feedback portal). Focus the docs pass on `docs/personal-fork-notes.md` only.
- **Do not alter `README.md`.** Upstream boilerplate, not runtime. Note in fork-notes that the README is upstream-authored and not fork-curated.
- **Do not remove `electron.crashReporter`.** It is not enabled anywhere in this codebase (verified by grep — zero matches). There is no telemetry-bearing crash reporter to remove; Electron's default is off. No change needed.
- **Do not alter the `repository` field in `package.json`.** Standard npm metadata; unrelated to the runtime phone-home surface.

### Uncertainty resolution

- **Is `electron.crashReporter` initialized anywhere?** Grep for `crashReporter`, `submitURL`, `process.crashReporter` returned zero matches. Not initialized, no removal needed. Resolved.
- **Is there a preload-script or main-process hook that fires analytics?** Grep for `posthog|mixpanel|Sentry|analytics|telemetry|google-analytics` — only the UiStore constructor and the `electron-google-analytics4` unused dependency turn up. Resolved.
- **Does removing `electron-updater` break `autoUpdater` references at startup?** After the code removal in §Blast Radius #1-#4, there are zero references to `autoUpdater` or `electron-updater` in `src/`. Safe to drop the dependency.
- **Does removing `posthog-js` break `UiStore` construction?** After §Blast Radius #26-#27, there are zero references to `posthog` in `src/`. Safe to drop the dependency.
- **Is the preferences.json file (`userData/preferences.json`) consumed elsewhere?** Grep for `preferencesFilePath` — only the `updatePreferences` helper and the initialize block in `src/main.ts` write or read it. No other consumers. Safe to remove the preferences subsystem.
- **Does removing `dev-app-update.yml` break anything?** It is only referenced at `src/main.ts:464` inside the `IS_DEV` block of the autoUpdater setup, which is itself being removed. Safe to delete.

---

## Holistic Solution

### Approach

Five tasks, grouped by concern, ordered so that code-removal tasks finish before dependency-removal and docs-update tasks:

1. **TASK-029 — Remove update-check subsystem end-to-end.** Covers Blast Radius items 1-11: `src/main.ts` (import, preferences field, startup-init, event handlers, IPC handlers), IPC message constants, main/renderer messenger static methods, `SecondaryCommands.tsx` "check for updates" menu item, `StartupBehavior.tsx` file deletion, `dev-app-update.yml` deletion. Do not remove the dependency from `package.json` yet — dependency removal is consolidated in TASK-032.

2. **TASK-030 — Remove bug-report and upstream-issues-tracker UX.** Covers items 13-25: uncaught-exception dialog button change in `src/main.ts`, `ErrorBoundary.tsx` Create Issue button + imports, `common/config.ts` `createBugReport` + `githubUrl` + `os` import, `SecondaryCommands.tsx` ideas+bugs menu item, `ImageTools.tsx` feedback button, `ImageDuplicates.tsx` component removal, `MapView.tsx` and `FaceGallery.tsx` canny.io button removal, `Placeholder.tsx` BugReport copy softening, `About.tsx` feedback bullet removal.

3. **TASK-031 — Remove PostHog telemetry.** Covers items 26-27: `UiStore.ts` import and constructor init+capture block.

4. **TASK-032 — Remove upstream-distribution package.json surface and dependencies.** Covers items 12, 28, 29, 30: drop `electron-updater`, `posthog-js`, `electron-google-analytics4` from `dependencies`; drop the top-level `publish` block; remove (or neuter) the `scripts.release` entry. Run `yarn install` to regenerate the lockfile and verify the build still succeeds.

5. **TASK-033 — Document the strip-out.** Covers items 31-32: extend `docs/personal-fork-notes.md` with a new section enumerating the removals and why. Cross-link INV-006. Update `docs/index.md` only if a new doc file is created (not expected — everything fits into fork-notes.md).

The task order is dependency-safe: TASK-029 removes the `electron-updater` imports, TASK-030 removes the `createBugReport` imports, TASK-031 removes the `posthog` imports. TASK-032 can then safely drop the three dependencies from `package.json` without leaving orphan references. TASK-033 is docs-only and can run last.

Each task enumerates the exact file set it touches in its `files:` frontmatter so a developer implementing one task does not need to read the others.

### Expected Outcomes

- Packaged `brave.exe` makes zero outbound HTTP requests on startup (no PostHog, no GitHub update check, no dev-update-check poll).
- Toolbar three-dots menu contains Settings and help center only.
- Uncaught-exception dialog has no "File bug report" button. ErrorBoundary has no "Create Issue" button.
- Inspector Tools, MapView, FaceGallery, and ImageDuplicates WIP panes no longer offer canny.io links.
- `node_modules/` is smaller by roughly the union of `electron-updater`, `posthog-js`, and `electron-google-analytics4` and their transitive deps.
- `yarn build` and `yarn package:portable` succeed with no compile errors.
- `docs/personal-fork-notes.md` documents this as the third intentional fork deviation alongside the `brave.exe` rename and the NSIS drop.

### Risks and Tradeoffs

- **Upstream merges:** When rebasing onto upstream, the removed imports, menu items, and IPC constants will merge-conflict against any upstream changes to those files. This is deliberate — a silent merge that re-introduces PostHog or the update check would defeat the purpose. Document in fork-notes that any merge conflict involving `autoUpdater`, `posthog`, `createBugReport`, or `canny.io` should be resolved in favor of the fork's removal.
- **Loss of update notification:** The fork user gives up automatic notification when upstream releases a new version. Mitigation: the user runs the fork from a local git checkout, so `git pull` is their update mechanism. Already documented obliquely in INV-005's fork-notes; make explicit in the INV-006 addition.
- **Loss of crash triage:** The ErrorBoundary "Create Issue" button was a poor-man's crash reporter. Removal means the user must read the error message on-screen and debug locally. Acceptable — the user is both the dev and the only user.
- **PostHog removal removes a placeholder capture call** (`posthog.capture('my event', { property: 'value' })`). This looks like dev-test code that was never replaced with real analytics in the upstream, so removal has zero impact.
- **Deleting `StartupBehavior.tsx` is a small risk** if the user ever wants to re-add a "remember-last-search" toggle (which is the only OTHER toggle in that file besides the update one). Mitigation: the toggle already lives on `uiStore.isRememberSearchEnabled` / `uiStore.toggleRememberSearchQuery`, so resurrecting a single-toggle settings tab is trivial (~10 lines). Delete the file for now; re-add if ever needed.
- **Deleting `ImageDuplicates.tsx` component** (only one import, in a commented-out Inspector section) risks breaking the Inspector render if the user ever un-comments that section. Mitigation: leave the import commented alongside the InspectorToggleSection it used to mount, so un-commenting is a one-step operation (re-create the component). Acceptable.
- **`preferences.json` on existing user data dirs** will become a dead file once the preferences subsystem is removed. Not cleaned up — harmless stale file. If the user cares, they can delete it manually; a migration is more code than it's worth for a single-user fork.
- **No `electron.crashReporter` was ever enabled**, so there is no startup-error-handling regression from this strip-out. The `process.on('uncaughtException', ...)` handler in `src/main.ts:547` continues to catch errors (minus the bug-report button).

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: `docs/personal-fork-notes.md` gets a new section covering the strip-out (authored in TASK-033). `docs/index.md` requires no change — the existing pointer to `personal-fork-notes.md` is sufficient.
