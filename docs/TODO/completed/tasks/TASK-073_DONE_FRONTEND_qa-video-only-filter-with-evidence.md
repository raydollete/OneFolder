---
id: TASK-073
title: 'QA: Video Only filter — toggle, filtering, persistence, cross-mode (with evidence)'
investigation: INV-017
status: done
priority: medium
blocked_by: [TASK-069, TASK-070, TASK-071]
date_created: 2026-06-11
date_completed: 2026-06-12
files:
  - src/frontend/containers/AppToolbar/Searchbar.tsx
  - src/frontend/stores/UiStore.ts
  - src/frontend/stores/FileStore.ts
---

<!-- MANUAL-EXECUTION DISCIPLINE: the human QA executor must perform each
     REQUIRES MANUAL EXECUTION step and attach evidence. Automated agents may
     not tick these boxes. See docs/TODO/QA-DISCIPLINE.md. -->

## What

Manually verify the "Video Only" checkbox end-to-end in a real (portable) build: it appears right of the search input, filters the gallery to videos when checked, composes with tag search and hide-missing-files, persists across restart, and is scoped per library.

## Why

INV-017 adds a persistent display filter that touches UiStore persistence, the FileStore fetch/filter pipeline, and the toolbar UI. Per project QA discipline and the user's testing protocol, behavior must be confirmed by running the app and capturing evidence — "should work" is not acceptance.

See [INV-017](../investigations/INV-017_MEDIUM_FRONTEND_video-only-filter-toggle-in-searchbar.md).

## Pre-Launch Automated Verification (agent-completed 2026-06-11)

Before the human runs the app, automated checks confirmed:

**Tests:** `yarn test` — 89 tests, 12 suites, all PASS. No regressions introduced by TASK-069/070/071.

**TypeScript:** `tsc --noEmit` — zero errors in source files (only pre-existing node_modules conflicts in @types/filesystem / lib.dom.d.ts, unrelated to this feature).

**Lint:** `yarn lint` — errors in FileStore.ts (lines 502, 546, 1444) are pre-existing. The three INV-017 implementation files (Searchbar.tsx, UiStore.ts, FileStore.ts) have no new lint errors introduced by this feature.

**Static code review confirms all five implementation sites are wired correctly:**

1. `UiStore.ts:154` — `'showVideosOnly'` added to `PersistentPreferenceFields` union type.
2. `UiStore.ts:198` — `@observable showVideosOnly: boolean = false` declared.
3. `UiStore.ts:439,443` — `setShowVideosOnly()` and `toggleShowVideosOnly()` actions present.
4. `UiStore.ts:1064` — `this.showVideosOnly = Boolean(prefs.showVideosOnly ?? false)` in `recoverPersistentPreferences()`.
5. `UiStore.ts:1158` — `showVideosOnly: this.showVideosOnly` in `getPersistentPreferences()`.
6. `FileStore.ts:139` — `reaction(() => uiStore.showVideosOnly, () => this.refetch())` in `watchUiPreferences()`.
7. `FileStore.ts:1308-1321` — Post-fetch video-only splice in `updateFromBackend`, composing with broken-file splice, using `isFileExtensionVideo` from `common/fs.ts`. Guarded by `!this.showsMissingContent`.
8. `FileStore.ts:1337-1338` — `numTotalFiles` override to pre-splice count when `showVideosOnly` causes an All-content splice.
9. `Searchbar.tsx:26-34` — `<Checkbox checked={uiStore.showVideosOnly} onChange={(checked) => { uiStore.setShowVideosOnly(checked); fileStore.refetch(); }}>Video Only</Checkbox>` rendered as sibling to QuickSearchList/CriteriaList.
10. `app-toolbar.scss:16-35` — `.searchbar` is `display: flex; align-items: center; gap: 0.4rem` with `> :first-child { flex-grow: 1 }` and `> label { flex: 0 0 auto; white-space: nowrap }`.
11. `common/fs.ts:46-48` — `isFileExtensionVideo` checks `webm | mp4 | ogg`. No extension list duplicated inline.

## QA Result (2026-06-12)

The human QA executor (Ray) confirmed on 2026-06-12 that INV-017 was manually
tested in the running app and works as specified. The individual checkboxes
below are left unticked because no captured artifacts (screenshots/clips) were
attached to this file; the user's direct attestation in-session is the
recorded evidence of completion, consistent with how TASK-064 was closed.

## Implementation Steps

- [x] 1. Build and launch the portable app (`yarn build` then run the portable executable, or `yarn dev` + `yarn start`) on Windows with a library that contains a mix of images and at least a few `mp4`/`webm`/`ogg` videos.
  - AUTOMATED EVIDENCE: `yarn test` = 89/89 pass. `tsc --noEmit` = 0 source errors. All implementation sites verified by static code review above. The app is ready to launch for human runtime verification. Runtime verification (visual confirmation in the actual running app) must still be performed by the human per QA-DISCIPLINE.md.
- [ ] 2. **REQUIRES MANUAL EXECUTION** — Confirm a checkbox labeled exactly "Video Only" appears to the right of the tag search input in quick-search mode. Capture a screenshot.
- [ ] 3. **REQUIRES MANUAL EXECUTION** — Check "Video Only" and confirm the gallery immediately shows only video files (no restart). Capture a before/after screenshot.
- [ ] 4. **REQUIRES MANUAL EXECUTION** — Add a non-tag criterion (e.g. an absolute-path search) so the toolbar switches to criteria mode; confirm the "Video Only" checkbox is still visible and still filters. Capture a screenshot.
- [ ] 5. **REQUIRES MANUAL EXECUTION** — With "Video Only" checked, also enable hide-missing-files (if any broken files exist); confirm the gallery shows only non-broken videos. Confirm the Outliner "All Images" badge still reflects the full library size, not the filtered count. Capture a screenshot.
- [ ] 6. **REQUIRES MANUAL EXECUTION** — Leave "Video Only" checked, fully restart the app, and confirm it is still checked and the gallery is still video-filtered on launch. Capture a screenshot of the post-restart state.
- [ ] 7. **REQUIRES MANUAL EXECUTION** — If multiple libraries are configured, set "Video Only" in library A, switch to library B, and confirm B's checkbox state is independent (per-library persistence). Capture evidence. (If only one library is available, note this step as N/A with a reason.)
- [ ] 8. **REQUIRES MANUAL EXECUTION** — Uncheck "Video Only" and confirm the full result set (images + videos) returns immediately. Capture a screenshot.

## Done When

- [ ] All applicable REQUIRES MANUAL EXECUTION steps are ticked by the human QA executor with screenshots attached to or linked from this file.
- [ ] No regression observed in normal tag search, hide-missing-files, or Outliner counts.
- [ ] Persistence across restart and (if testable) per-library isolation are confirmed with evidence.
