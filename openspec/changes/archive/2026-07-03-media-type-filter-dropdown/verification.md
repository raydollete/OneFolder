# Verification — media-type-filter-dropdown

Date: 2026-07-03
Tier: 2

## Verdict: PASS

One regression was found during this pass and fixed in-session (see Findings #1); the
lint exit-2 evidence-line blocker was repaired. No blocking issues remain.

## Mechanical lint

`radflow-lint media-type-filter-dropdown --tier-check`:
- Initial run: **exit 2** — every checked box lacked an `evidence:` line (structural violation, blocking).
  Repaired by adding file:line / command evidence to all checked boxes and rewording a
  `deferred`/`Deferred` token the status parser rejected.
- Re-run: **clean — no violations** (exit 0). No tier-envelope warning.

## Dimensions

- **Implemented: PASS.** Every checked box's evidence points at code that actually contains the
  claimed change (opened and read each):
  - `common/fs.ts:52` (`MediaTypeFilter`), `:57-66` (`mediaTypeMatches`, switch over `isFileExtensionVideo`).
  - `UiStore.ts:197` (`mediaTypeFilter` observable, default `'all'`), `:151` (persist field), `:473-475`
    (`setMediaTypeFilter`), `:1245` (save), `:1151-1157` (recover with strict whitelist → legacy
    `showVideosOnly` → `'all'`).
  - `FileStore.ts:1652-1658` (upstream gate on raw `FileDTO[]` before `filesFromBackend`; captures
    `preGateFetchedCount`), `:1747-1750` (post-fetch splice removed, replaced by a NOTE), `:1782`
    (`numTotalFiles = preGateFetchedCount`, guarded by `showsAllContent && (broken || mediaFilterActive)`),
    `:139` (reaction re-keyed to `mediaTypeFilter`), `:11` (import). `grep isFileExtensionVideo
    src/frontend/stores/FileStore.ts` → none (splice fully gone).
  - `Searchbar.tsx:26-38` (native `<select>`, three options, onChange → setter + refetch), `:54` (import);
    `grep Checkbox Searchbar.tsx` → none.
  - `resources/style/app-toolbar.scss:31` (`.media-type-filter`; referenced CSS vars confirmed to exist).
  - `grep showVideosOnly src` → only the intentional legacy-migration read at `UiStore.ts:1157`.

- **Reachable: PASS.** The `mediaTypeFilter` observable is read by the gate (`FileStore.ts:1653`) and the
  reaction (`:139`); the reaction is wired by `RootStore` after store construction
  (`RootStore.ts:66` → `fileStore.watchUiPreferences()`); the observable is written by
  `setMediaTypeFilter`, called from the Searchbar `<select>` `onChange`; it is persisted in
  `get`/`recoverPersistentPreferences`. `mediaTypeMatches` is called at `FileStore.ts:1656` and in
  tests. Nothing orphaned.

- **Tested: PASS.** `yarn jest` on the change's suites and neighbours: **16/16 pass** —
  `tests/media-type-filter.test.ts` (classifier ×3 + gate ×3: asserts `fileList` is the correct media
  type only and All-view `numTotalFiles===4` with 2 visible), `tests/ui-store-media-type-migration.test.ts`
  (×6 migration cases), `tests/file-store-ui-preferences.test.ts` (reaction wiring),
  `tests/file-store-generation-gate.test.ts` (INV-009, after fix). Project-source `tsc --noEmit` clean;
  `eslint` clean on all changed files. Manual GUI QA (tasks 7.2/7.3) remains — the human-observation
  gate for the flash behaviour and per-library persistence.

- **Optimal (advisory):** The gate mirrors the adjacent hidden-tags filter (idiomatic, single hook,
  reuses the authoritative extension list) and is now fail-safe (only `'images'`/`'video'` activate it;
  any other value shows all media). Known tradeoff, already documented in design + docs: the full file
  set is still fetched from the backend and trimmed in the renderer (a query-level gate is a possible
  future optimization). No error-handling or performance gap beyond that.

## Findings

1. **[FIXED in-session] Fail-open gate regression.** `FileStore.updateFromBackend` originally computed
   `mediaFilterActive = mediaFilter !== 'all'`. An unexpected/`undefined` `mediaTypeFilter` (which cannot
   occur via the store's `'all'` default but did via an incomplete test mock) made the gate active and
   `mediaTypeMatches(undefined, …)` return `undefined`, filtering **every** file out → blank gallery.
   `tests/file-store-generation-gate.test.ts` caught this (fileList length 0, expected 1). Fixed at
   `FileStore.ts:1657-1658` to activate only on `'images'`/`'video'` (fail-safe to showing all media).
   Re-ran: generation-gate + all change suites green.

## Environmental note (not a finding against this change)

`tests/ui-store-video-spacebar.test.ts` fails in the shared working tree, but the failure is caused by a
**separate concurrent in-flight change**, `video-viewer-index-lock` (untracked
`openspec/changes/video-viewer-index-lock/`, plus uncommitted edits to `SlideMode/index.tsx`,
`MediaQueueStore.ts`, and `UiStore.ts`). That change adds `slideFileId`-identity resolution to the
`slideFile` computed (`HEAD` has 0 occurrences of `slideFileId`; the working tree has 9, none from this
change), so `slideFile` now resolves via `rootStore.fileStore.get(slideFileId)` and the test's mock
`fileStore` (no `get`) returns `undefined`. `media-type-filter-dropdown` touches no `slideFile`/
`slideFileId`/`processGlobalShortCuts` code, so this failure is out of scope here and belongs to
`video-viewer-index-lock`.

## Live UI pass

n/a — Electron desktop UI, not a playwright-drivable web server, and the working tree currently carries
another change's incomplete edits. The user-facing behaviour (flash-free filtering, per-library
persistence) is the explicit manual-QA gate in tasks 7.2/7.3.
