---
id: TASK-033
title: 'Document the update/bug-report/telemetry strip-out in personal-fork-notes.md'
investigation: INV-006
status: DONE
priority: low
blocked_by: [TASK-029, TASK-030, TASK-031, TASK-032]
date_created: 2026-04-23
date_completed: 2026-06-12
files:
  - 'docs/personal-fork-notes.md'
---

## What

Extend the existing `docs/personal-fork-notes.md` (created by TASK-028 for the `brave.exe` rename and NSIS drop) with a third "deviation" section covering the INV-006 strip-out. This gives future readers (including the user six months from now) a single consolidated reference for every intentional upstream-divergence in the fork.

No new doc file is created — `docs/index.md` already links to `personal-fork-notes.md`, and adding a section is cheaper to maintain than spawning a parallel doc.

## Why

Removing `electron-updater`, PostHog, the canny.io feedback links, and the GitHub-issues bug-report buttons is non-obvious when reading the source fresh: the imports are absent, but there's no inline comment explaining why. When rebasing onto a future upstream version that re-introduces any of those subsystems, the contributor needs a quick reference for "we deliberately stripped X, don't re-accept upstream's version of it."

Per CLAUDE.md, project docs live in `docs/` and are read before making changes. This task is defensive documentation.

See [INV-006](../investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md) for the full investigation.

## Implementation Steps

- [x] 1. Open `docs/personal-fork-notes.md`. The existing structure has:
  - Front matter
  - "Personal Fork Notes" heading + intro
  - "Summary of deviations" list (currently 2 items)
  - "Why `brave.exe`?" section
  - "How the rename propagates through electron-builder 23.6.0" section
  - "What the rename does NOT change" section
  - "Portable-only, no installer" section
  - "Antivirus / naming caveat" section
  - "Reference" section

- [x] 2. Update the `last_updated` front-matter date to the current date.

- [x] 3. Extend the "Summary of deviations" list from 2 items to 3 — append:
  > 3. Upstream-distribution features that do not make sense for a personal single-user fork have been removed: the `electron-updater` auto-update check, the PostHog analytics init, the "File bug report" / "Create Issue" buttons that opened upstream GitHub issues, and the canny.io "vote on our roadmap" feedback links.

- [x] 4. Add a new major section **after** "Portable-only, no installer" and **before** "Antivirus / naming caveat", titled something like **"Why are `electron-updater`, PostHog, and canny.io feedback absent?"**. The section should cover, in prose (not a bulleted wall of code):

  **Motivation.** This fork's binary (`brave.exe`) is not distributed through the upstream release channel. Automatic update checks against `github.com/OneFolderApp/OneFolder/releases/latest` would attempt to replace a working `brave.exe` with an upstream `OneFolder.exe` and regress the VSR rename documented above. Similarly, the fork user is the sole maintainer; "File bug report" buttons that open pre-filled upstream GitHub issues would be noise for upstream maintainers who cannot diagnose fork-local changes. PostHog analytics send events to a third-party service on every non-dev launch, which is privacy-surprising for a private single-user build where there is no product to measure.

  **What was removed.** Enumerate briefly (do not repeat the full blast radius from INV-006 — link to it):
  - `electron-updater` dependency + `autoUpdater` wiring in `src/main.ts` + the "check for updates" toolbar menu item + the `StartupBehavior.tsx` Settings tab + the `dev-app-update.yml` dev config.
  - `createBugReport` helper and `githubUrl` constant in `common/config.ts` + the "File bug report" button in the uncaughtException dialog in `src/main.ts` + the "Create Issue" button in `ErrorBoundary.tsx` + the "💡ideas + 🐞bugs" toolbar item.
  - `posthog-js` dependency + the `posthog.init` / `posthog.capture` calls in `UiStore` constructor.
  - `electron-google-analytics4` dependency (was never imported; dead code).
  - `package.json` top-level `publish` block (pointed at upstream GitHub releases).
  - `package.json` `scripts.release` entry (did `git push` — dangerous if `origin` ever points upstream).
  - Inline canny.io "vote on roadmap" buttons in `ImageTools`, `ImageDuplicates`, `MapView`, `FaceGallery`.

  **What was intentionally preserved.**
  - The `github.com/OneFolderApp/OneFolder` ExternalLink in `About.tsx` — provenance info, not primary bug-report UX.
  - `package.json` `repository` and `author` fields — standard npm metadata.
  - The HelpCenter's "About OneFolder" section — informational.
  - `README.md` — upstream-authored boilerplate, not fork-curated.

  **How to update this fork.** Since auto-updates are gone, the update workflow is:
  1. `cd` into the local fork repo.
  2. `git pull` (or cherry-pick from upstream as preferred).
  3. `yarn install` if `package.json` changed.
  4. `yarn package:portable`.
  5. Replace the running `brave.exe` with the newly built one (copy `dist/brave.exe` to the portable directory).

  **Upstream-rebase guidance.** When merging upstream changes, conflicts involving `autoUpdater`, `posthog`, `createBugReport`, `canny.io`, `dev-app-update.yml`, or the `publish` / `release` entries in `package.json` should be resolved in favor of the fork's removal — do not re-accept upstream's version of these features without re-reading INV-006.

- [x] 5. Update the "Reference" section at the bottom of the doc to add INV-006 and its tasks (TASK-029, TASK-030, TASK-031, TASK-032, TASK-033) as additional citations alongside the existing INV-005 reference.

- [x] 6. Verify the doc renders correctly in a Markdown preview. Internal links should resolve:
  - `[INV-006](../TODO/pending_qa/investigations/INV-006_MEDIUM_ELECTRON_strip-update-checks-bug-report-and-telemetry-for-personal-fork.md)` — note the path assumes the investigation has been moved to `pending_qa/` by the time this task lands. If INV-006 is still in `backlog/`, adjust the relative path accordingly.

- [x] 7. Verify `docs/index.md` still lists "Personal Fork Notes" (row 44 at time of writing). No change needed — the existing pointer covers the updated doc.

- [x] 8. Commit with a message like "Document INV-006 strip-out in personal-fork-notes.md".

## Done When

- [x] `docs/personal-fork-notes.md` has a new "Why are electron-updater, PostHog, and canny.io feedback absent?" section (or equivalent heading) covering motivation, enumerated removals, preserved items, update workflow, and rebase guidance.
- [x] The "Summary of deviations" list at the top is updated from 2 to 3 items.
- [x] The `last_updated` front-matter date is current.
- [x] The "Reference" section at the bottom cites INV-006 and TASK-029 through TASK-033.
- [x] Markdown renders cleanly; internal links resolve.
- [x] A reader landing on `personal-fork-notes.md` fresh can understand, without opening INV-006, (a) why the three subsystems were removed, (b) what was preserved and why, (c) how to update the fork now that auto-updates are gone.
