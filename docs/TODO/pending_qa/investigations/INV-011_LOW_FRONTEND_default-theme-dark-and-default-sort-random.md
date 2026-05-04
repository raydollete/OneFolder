---
id: INV-011
title: 'Default theme to dark and default sort to random for new installs / new libraries'
reported_bug: 'Two out-of-the-box defaults should change for fresh installs and newly-created libraries: (1) the application theme should default to dark instead of light, and (2) the gallery sort should default to random instead of dateAdded-descending. Existing libraries with already-persisted preferences must NOT be clobbered — a returning user keeps whatever theme/sort they previously chose.'
date: 2026-05-03
status: pending_qa
superseded_by:
tasks_spawned: [TASK-049, TASK-050, TASK-051]
root_cause_category: missing-edge-case
affects:
  - 'UiStore theme field initializer (src/frontend/stores/UiStore.ts:167)'
  - 'UiStore.setTheme default-parameter value (src/frontend/stores/UiStore.ts:623)'
  - 'UiStore.recoverPersistentPreferences fresh-install IPC path (src/frontend/stores/UiStore.ts:1011-1091) — RendererMessenger.setTheme is only sent inside the `if (prefsString)` branch, so a fresh install never tells the main process its theme; this becomes a visible regression once the default flips to dark on a system whose nativeTheme is light'
  - 'FileStore orderBy / orderDirection field initializers (src/frontend/stores/FileStore.ts:77-78)'
  - 'FileStore.setOrderBy / FileStore.orderFilesBy default-parameter values (src/frontend/stores/FileStore.ts:598, 1289) — both fall back to `dateAdded`, so even after flipping the field initializer these default-param sites would silently re-introduce dateAdded if called with undefined (e.g. from recoverPersistentPreferences when prefs.orderBy is missing)'
  - 'Calendar view sort override (src/frontend/stores/UiStore.ts:370-373 — setMethodCalendar forces orderFilesBy("dateCreated")) — informational; existing intentional behavior, not changed but worth flagging because users on the new random default will see their sort silently change when entering Calendar view'
  - 'Random sort backend semantics (src/backend/sqlite-backend.ts:466-470, 532-540 — `ORDER BY RANDOM()`; src/backend/backend.ts:144-145, 190-191 — Dexie shuffleArray). Each fetch reshuffles, so refetch / location-watch / content-mode-switch will reorder the gallery — informational, kept by design'
---

## Bug Report

### Observed Behavior

OneFolder ships with two out-of-the-box defaults that the user wants changed for this personal fork:

1. **Theme defaults to light.** `UiStore.theme` is declared `@observable theme: 'light' | 'dark' = 'light'` at `src/frontend/stores/UiStore.ts:167`. On a fresh install (no `{libraryId}:preferences` localStorage entry) and on every newly-created library (each gets a fresh per-library localStorage namespace per `docs/multi-library.md` lines 56-66), the theme starts as `'light'`. The user must manually flip it to dark in Settings > Appearance every time.

2. **Gallery sort defaults to dateAdded-descending.** `FileStore.orderBy` is declared `@observable orderBy: OrderBy<FileDTO> = 'dateAdded'` at `src/frontend/stores/FileStore.ts:78` and `@observable orderDirection: OrderDirection = OrderDirection.Desc` at line 77. On a fresh install and on every newly-created library, the gallery starts ordered by date-added descending. The user wants random as the out-of-the-box default so a fresh library shows a varied sample of photos rather than the most-recently-imported batch.

Both observations are confirmed by reading the source: the field initializers are the sole providers of the default value when no persisted preference exists.

### Expected Behavior

For new installs and newly-created libraries:

1. **Theme defaults to dark.** The CSS class on the `#layout-container` div (`App.tsx:53`), the Preview window root (`Preview.tsx:40`), the Overlay (`Overlay.tsx:10`), the Settings panel (`Settings/index.tsx:28`), and the HelpCenter dialog (`HelpCenter.tsx:29`) — all of which read `uiStore.theme` directly — should render in dark mode on first launch. The native window chrome (Windows titlebar / frame, drawn by Electron's `nativeTheme.themeSource`) should also be dark from first launch, not just after the user opens Settings and re-clicks Dark.

2. **Gallery sort defaults to random.** The FileStore `orderBy` is `'random'` and the gallery shows files in `ORDER BY RANDOM()` order (the SQLite path at `sqlite-backend.ts:466-470`) on first launch. The Sort menu radio group (`Menus.tsx:79-98`) shows "Random" as the checked item.

For returning users with already-persisted preferences (the personal-fork user has both): the persisted `prefs.theme` and `prefs.orderBy` MUST be honored — the change is a default-flip only, NOT a forced migration. A user who explicitly chose Light or Date Added keeps that choice across the upgrade.

### Reproduction Context

Deterministic. Triggers:

1. Delete (or never create) the `{libraryId}:preferences` and `{libraryId}:OneFolder_File` localStorage keys for an active library. Launch the app. Observe theme = light, sort = dateAdded-desc. — This is what every fresh install and every newly-created library experiences today.

2. Same setup but with the field initializers flipped to `'dark'` and `'random'`. Launch. Observe theme = dark, sort = random. — This is what the change should produce.

3. Launch with existing `{libraryId}:preferences` containing `{theme: 'light', ...}` and `{libraryId}:OneFolder_File` containing `{orderBy: 'dateAdded', orderDirection: 1, ...}`. Observe that theme stays light and sort stays dateAdded-desc, regardless of what the field initializers say. — This is the "do not clobber returning users" guarantee that comes for free from the existing recovery code at `UiStore.ts:1018` (`if (prefs.theme) this.setTheme(prefs.theme)`) and `FileStore.ts:1041` (`this.setOrderBy(prefs.orderBy)` — but see Defect B below).

---

## Root Cause Analysis

**Category:** missing-edge-case

This is not a bug in the traditional sense — it is a deliberate-but-stale product decision. The defaults were chosen at some earlier point in the project's life and have never been revisited. For a personal fork whose user has explicitly stated the defaults he wants, "the value the field initializer was set to long ago" is the missing edge-case: nothing wrong with the code path, just the wrong constant.

That said, the investigation surfaced **two real defects** that materialize once the defaults flip and that would not have been visible under the old defaults:

### Diagnosis

**Defect A (theme — fresh-install IPC gap):** `UiStore.recoverPersistentPreferences` at `src/frontend/stores/UiStore.ts:1011-1091` only sends `RendererMessenger.setTheme({ theme: ... })` to the main process *inside* the `if (prefsString) { ... }` branch (line 1090). On a fresh install with no localStorage prefs, `prefsString` is `null` and the entire block is skipped. The CSS class on `<div className={uiStore.theme}>` correctly reflects the field-default value because it reads the observable directly, but the main-process `nativeTheme.themeSource` is never told and remains at its Electron default (which on Windows tracks the OS setting). Today this is invisible because the field default is `'light'` — and Electron's default already produces a light titlebar on most systems. Once the field default flips to `'dark'`, a fresh install on a system whose OS theme is light will render a dark React app inside a light Windows titlebar / frame for the entire first session, until the user touches the Settings toggle (which DOES go through `setTheme(...)` → `RendererMessenger.setTheme(...)`). That is a visible mismatch the moment the default changes.

**Fix:** move the `RendererMessenger.setTheme({ theme: ... })` call to the unconditional tail of `recoverPersistentPreferences` so it fires on every recovery, not just when persisted prefs exist. The IPC handler at `src/main.ts:617` (`MainMessenger.onSetTheme((msg) => (nativeTheme.themeSource = msg.theme))`) is idempotent — sending it on every startup is harmless when it matches the current value.

**Defect B (sort — `setOrderBy` default-param fallback):** `FileStore.setOrderBy` at `src/frontend/stores/FileStore.ts:1289` is declared `setOrderBy(prop: OrderBy<FileDTO> = 'dateAdded')`. `FileStore.orderFilesBy` at line 598 has the same default-param: `orderFilesBy(prop: OrderBy<FileDTO> = 'dateAdded')`. `recoverPersistentPreferences` at line 1041 calls `this.setOrderBy(prefs.orderBy)` with no fallback — so when `prefs.orderBy` is `undefined` (a returning user whose persisted blob predates the orderBy field, or a corrupt blob), the default-param activates and silently snaps the user back to `'dateAdded'`. Today this is invisible because the field initializer is also `'dateAdded'` — both paths agree. Once the field initializer flips to `'random'`, the two defaults disagree, and the recovery path will quietly downgrade users with stale prefs to `dateAdded` regardless of the field default.

**Fix:** flip both default-param values (`setOrderBy` and `orderFilesBy`) to `'random'` so all four "sources of truth" for the default agree. This also keeps the contract that "the default is whatever the field initializer says."

### Diagnostic Questions Considered

- **Wrong mental model?** Partially — the original developer wrote `setOrderBy(prop: OrderBy<FileDTO> = 'dateAdded')` assuming the default-param would never disagree with the field initializer. That assumption holds only as long as nobody changes the default in one place without changing it in the other.
- **Architectural shortcoming?** Mild — the default value is duplicated across (a) the field initializer, (b) the setter's default-param, (c) `orderFilesBy`'s default-param, (d) the recovery code's read path. A single `DEFAULT_ORDER_BY = 'random' as const` constant would have prevented Defect B. Out of scope for this task; flagged for future cleanup.
- **Incorrect order of operations?** No — recovery runs once, after store construction, before the first fetch. Order is correct.
- **Missing edge case?** Yes — the fresh-install no-prefs path does not send the theme IPC (Defect A), and the no-orderBy-in-prefs path silently overrides the field default (Defect B). Both go unnoticed today because of accidental agreement with the existing defaults.
- **Wrong abstraction?** No — UiStore vs FileStore split is correct.
- **Silent failure?** Defect B is exactly this — a default-param silently overrides the intended new default without any error or warning.

---

## Blast Radius

1. **`src/frontend/stores/UiStore.ts:167`** — Theme field initializer. Direct change: `'light'` → `'dark'`.

2. **`src/frontend/stores/UiStore.ts:623`** — `setTheme(theme: 'light' | 'dark' = 'dark')`. The default-param is already `'dark'`, accidentally agreeing with the new direction. No change needed but worth verifying it stays consistent.

3. **`src/frontend/stores/UiStore.ts:1011-1091`** — `recoverPersistentPreferences`. Defect A: lift the `RendererMessenger.setTheme(...)` call out of the `if (prefsString)` branch so the main process always learns the current theme on startup, including on fresh installs.

4. **`src/frontend/stores/FileStore.ts:77-78`** — `orderBy` and `orderDirection` field initializers. Direct change: `orderBy = 'dateAdded'` → `orderBy = 'random'`. `orderDirection` stays at `OrderDirection.Desc` because the random-sort backend code paths in `sqlite-backend.ts:466-470, 532-540` ignore the direction parameter when `order === 'random'` — direction is irrelevant for shuffled output. Leaving orderDirection alone keeps the value benign for any future non-random sort the user picks.

5. **`src/frontend/stores/FileStore.ts:598`** — `orderFilesBy(prop: OrderBy<FileDTO> = 'dateAdded')`. Defect B: change default-param to `'random'`.

6. **`src/frontend/stores/FileStore.ts:1289`** — `setOrderBy(prop: OrderBy<FileDTO> = 'dateAdded')`. Defect B: change default-param to `'random'`.

7. **CSS / Sass styles** — No change required. The `dark` class is already wired throughout the stylesheet; flipping which class is the default does not require any style edits.

8. **Settings > Appearance UI** (`src/frontend/containers/Settings/Appearance.tsx:22-31`) — No change required. The Radio group binds `value={uiStore.theme}` so it auto-reflects whatever the current value is. After the default flips, opening the Appearance panel on a fresh install will show "Dark" pre-selected, which is the desired UX.

9. **Sort menu UI** (`src/frontend/containers/AppToolbar/Menus.tsx:62-98`) — No change required. The `MenuRadioItem` `checked={orderBy === prop}` binding auto-reflects the current orderBy. After the default flips, opening the Sort menu on a fresh install will show "Random" as the checked item.

10. **Per-library new-library flow** — No change required. The library-registry (`common/library-registry.ts`) does not store theme or sort defaults; new libraries get a fresh `{libraryId}:preferences` and `{libraryId}:OneFolder_File` localStorage namespace, so the field initializer defaults apply automatically. This is the multi-library design documented in `docs/multi-library.md` lines 56-66.

11. **Returning user persisted prefs** — No change required and no migration needed. The recovery code at `UiStore.ts:1018-1019` (`if (prefs.theme) this.setTheme(prefs.theme)`) honors any persisted theme value, so a user who chose Light in a previous session keeps Light. After Defect B is fixed, the same is true for sort: a user with `prefs.orderBy === 'dateAdded'` keeps dateAdded; only a user with no persisted orderBy (or whose persisted orderBy is `undefined` / missing) sees the new `'random'` default.

12. **Calendar view sort override** (`src/frontend/stores/UiStore.ts:370-373`) — Existing intentional behavior, NOT changed. `setMethodCalendar` calls `this.rootStore.fileStore.orderFilesBy('dateCreated')` to force a date-creation-ordered grouping that the calendar view requires. With random as the new default, a user switching to Calendar view will see their effective sort change to dateCreated. Switching back to Grid will leave it on dateCreated, not snap back to random — same as today's behavior with dateAdded. This is correct as-is; flagged here so reviewers don't think it's a regression.

13. **Random-sort reshuffle on every refetch** — Existing intentional behavior, NOT changed. Each call to `backend.fetchFiles(...)` with `order === 'random'` issues a fresh `ORDER BY RANDOM()` query (sqlite-backend.ts:468), so the gallery reshuffles on app launch, location-watcher new-files refetch (RootStore.ts:144-148), content-mode switch (Untagged ↔ All ↔ Query), sort-direction toggle, and tag-edit-driven refetch. With random as the default, this means every restart shows a different sample of files. The user explicitly raised this in the prompt and accepts it as the intended UX ("decide whether that's the intended UX" — answer: yes, the user wants random-as-default precisely so every launch surfaces a different slice of the library).

---

## UX / Requirements Specification

### Purpose

Change the out-of-the-box defaults for fresh installs and newly-created libraries to match the personal-fork user's preferred starting point. Returning users with persisted preferences are unaffected.

### User-Stated Design Decisions

1. **Theme default → dark.** The user said "Theme default → dark. Currently the app likely defaults to light mode (or follows system). The user wants the out-of-the-box default for new installs / new libraries to be dark mode." Verified against code: the app does NOT follow system; it has a hard binary `'light' | 'dark'` value at `UiStore.ts:167` that defaults to `'light'`. There is no `prefers-color-scheme` integration anywhere in the codebase. The new default is therefore a literal hard `'dark'`, not "dark unless system says light" — matching what the user said and what the existing code shape supports.

2. **Sort default → random.** The user said "Sort mode default → random. Currently the gallery defaults to sorting by some attribute (probably name or date). The user wants the out-of-the-box default to be the random sort." Verified: current default is `'dateAdded'` desc at `FileStore.ts:77-78`, and `'random'` is a first-class `OrderBy<T>` value (`src/api/data-storage-search.ts:5`) with full SQLite and Dexie backend support. The Sort menu already exposes Random as a selectable option (`Menus.tsx:76`), so flipping the default is a clean change with no missing UI plumbing.

3. **Do not clobber returning users.** The user said "we don't want to clobber returning users' chosen theme or sort." Verified: `UiStore.recoverPersistentPreferences` at line 1018 reads `prefs.theme` and only applies it `if (prefs.theme)` — so existing persisted values win over the field default. `FileStore.recoverPersistentPreferences` at line 1041 reads `prefs.orderBy` and applies it via `setOrderBy(prefs.orderBy)`. Both paths preserve persisted values for a returning user. The change is a default-flip only, NOT a migration.

4. **Per-library scoping.** Confirmed: `docs/multi-library.md` documents that `{libraryId}:preferences` and `{libraryId}:OneFolder_File` are per-library localStorage keys. Each newly-created library starts with no entries for those keys, so the field-initializer defaults apply for each new library independently. A user who has a "Personal" library set to dark + random and creates a new "Client Work" library will see Client Work also default to dark + random — which matches the user's stated intent ("default for new libraries / first-run").

5. **Random reshuffle behavior.** The user explicitly asked "make sure random-as-default doesn't reshuffle on every app launch in a confusing way; or, if it does, decide whether that's the intended UX." Decision: random WILL reshuffle on every app launch (and on every refetch — see Blast Radius #13). This is treated as the intended UX for the personal fork because the user's stated motivation for random-as-default is precisely "see a different slice of the library each time." If a future user wants stable random (same shuffle within a session), that requires a separate seedable-random feature, which is out of scope here.

### Behavioral Specifications

- **Fresh install, first launch (no `{libraryId}:preferences` key, no `{libraryId}:OneFolder_File` key):** App opens with dark theme applied to both the React UI (CSS class `dark` on `#layout-container`) AND the native Windows titlebar / frame (`nativeTheme.themeSource = 'dark'`). Gallery shows files in random order. Sort menu shows "Random" as the checked item. Settings > Appearance shows "Dark" as the checked Radio.

- **New library created via the Library Selector (returning user clicks "Create"):** Same as fresh-install — the new library has no localStorage entries under `{newLibraryId}:`, so the field-initializer defaults apply. Theme = dark, sort = random for the new library.

- **Returning user with persisted prefs (theme = 'light', orderBy = 'dateAdded'):** App opens with light theme and dateAdded-desc sort. Defaults are NOT applied because `prefs.theme === 'light'` and `prefs.orderBy === 'dateAdded'` are truthy and override the field initializers.

- **Switch to a different library that has persisted prefs:** Same per-library behavior — each library independently honors its own persisted prefs or falls back to the new defaults.

- **Calendar view (existing behavior):** When the user clicks Calendar, sort becomes `dateCreated` regardless of the previous sort. When they switch back to Grid, sort stays `dateCreated`. Not changed by this work. The user can re-select Random from the Sort menu to get back to random.

- **Random reshuffle:** Every app launch, every location-watcher new-files refetch, and every content-mode switch (Untagged ↔ All ↔ Query) triggers a `backend.fetchFiles` call which re-issues `ORDER BY RANDOM()`. The gallery contents are the same, but the order changes. Accepted as intended.

### Explicit Rejections

- **Do NOT honor `prefers-color-scheme` for the new theme default.** The user said "Interpret this as a literal hard default (not following system) unless evidence in the code suggests system-following was a deliberate prior choice." There is no system-following code anywhere — the existing code stores a hard `'light' | 'dark'`. The new default is therefore a literal hard `'dark'`. No matchMedia listener, no `nativeTheme.shouldUseDarkColors` read, no system-following. (If the user later wants system-following, that is a separate larger feature: a third value `'system'` in the union, a matchMedia listener, settings UI for it, etc. Out of scope.)

- **Do NOT migrate existing persisted prefs.** No code that scans existing `{libraryId}:preferences` or `{libraryId}:OneFolder_File` blobs to flip stale `prefs.theme === 'light'` or `prefs.orderBy === 'dateAdded'` values. The defaults change only takes effect when the value is absent.

- **Do NOT add a "reset to defaults" flow as part of this work.** The user did not ask for it. If they want to reset their existing prefs to pick up the new defaults, they can clear localStorage manually or delete the persisted blob.

- **Do NOT add a stable-shuffle / seedable-random feature.** Random reshuffles on every fetch — that is the existing backend behavior and the user's stated intent. A stable random (same shuffle for an entire session) is a separate feature.

- **Do NOT change the `orderDirection` default.** It stays at `OrderDirection.Desc`. Random sort ignores direction in both backends, and keeping `Desc` keeps the value benign for any non-random sort the user later picks.

---

## Holistic Solution

### Approach

Three small surgical edits in two stores plus a fresh-install IPC fix:

1. **Flip theme default to dark** in `UiStore.ts:167`. Verify `setTheme(theme: 'light' | 'dark' = 'dark')` at line 623 already has `'dark'` as its default-param (it does — leave as-is).

2. **Flip sort defaults in FileStore.ts**: change `orderBy = 'dateAdded'` to `orderBy = 'random'` at line 78. Change `setOrderBy(prop: OrderBy<FileDTO> = 'dateAdded')` to `= 'random'` at line 1289 (Defect B fix). Change `orderFilesBy(prop: OrderBy<FileDTO> = 'dateAdded')` to `= 'random'` at line 598 (Defect B fix, second site). Leave `orderDirection = OrderDirection.Desc` unchanged at line 77.

3. **Fix fresh-install theme IPC gap (Defect A)**: in `UiStore.recoverPersistentPreferences` at lines 1011-1091, move the `RendererMessenger.setTheme({ theme: ... })` call out of the `if (prefsString)` branch and place it after the if/else (and before the thumbnail-directory block). This ensures the main-process `nativeTheme.themeSource` is set on every startup, not just when persisted prefs exist.

All three edits are in two files (`UiStore.ts`, `FileStore.ts`). No new tests required — the existing recovery semantics already handle the persisted-prefs case correctly; the change is just to the default values and to ensuring the IPC always fires.

### Expected Outcomes

- Fresh install: theme = dark (React + native), sort = random, gallery reshuffles on every launch.
- New library created from Library Selector: theme = dark, sort = random, same as fresh install.
- Returning user (personal fork, current author): unaffected — persisted `prefs.theme` and `prefs.orderBy` win, his existing setup keeps his current settings.
- Sort menu and Appearance settings panel both reflect the new defaults automatically without any UI code change.
- Calendar view behavior unchanged (still forces dateCreated; not regressed).

### Risks and Tradeoffs

- **Related observation (OUT OF SCOPE for this investigation, flag for follow-up):** the user reports that **settings do not appear to be saving in the portable Windows build** (`yarn package:portable`, single-file `brave.exe` self-extracting to `%TEMP%\<random>\` per `package.json` build config). If true, every portable launch behaves like a fresh install — meaning portable users will hit the new defaults every time and never accumulate persisted preferences. This may be a localStorage path issue (Electron's portable-mode userData defaults can be ephemeral if not pinned), an asar/extra-resources issue, or a preferences-write failure. It does NOT block this work — the new defaults flip is exactly what portable users would want every launch anyway — but it is a separate latent bug worth its own investigation. Recommend filing a new INV-XXX dedicated to "portable build does not persist user preferences across launches." If confirmed, the fix likely lives in `src/main.ts` (window/userData path setup) or in how the portable-builder config in `package.json` handles `userData` for the self-extracting target.

- **Risk: native window chrome mismatch on first launch.** Without the Defect A fix, a fresh install on a Windows machine whose OS theme is light would render a dark React app inside a light titlebar. The fix in the holistic solution addresses this so it does not ship as a regression.

- **Risk: returning user loses their persisted choice.** Mitigated by the existing recovery code, which prioritizes persisted values over the field default. Verified by reading `UiStore.ts:1018-1019` and `FileStore.ts:1041`.

- **Risk: random-sort reshuffle confuses a user expecting stability.** The user explicitly accepted this as the intended UX. If reconsidered later, a stable-random feature is a clean follow-up (seedable PRNG keyed off library + session).

- **Risk: Calendar view silently overrides random.** Existing behavior preserved. Could be addressed in a future task by remembering "the user's preferred non-Calendar sort" and restoring it on switch-back, but that is out of scope.

- **Tradeoff (defect-fix scope):** Could fix Defect B more thoroughly by introducing a `DEFAULT_ORDER_BY = 'random' as const` constant and referencing it from all four sites (field initializer, two setter default-params, recovery path). Chose instead to just flip all four duplicated values consistently — keeps the diff small and matches the existing project style. The DRY refactor is a good follow-up but not required to ship the requested feature.

---

## Game Documentation Updates

- [x] No updates needed
- [ ] Updated:

(Rationale: `docs/multi-library.md` already describes per-library localStorage namespacing, which is the mechanism by which new libraries pick up the new defaults. No subsystem-level documentation describes the theme or sort defaults specifically — they live entirely in code. The user's preferences for this fork could be noted in `docs/personal-fork-notes.md`, but doing so muddles "fork-level packaging deviations" with "default-value preferences," and the user did not ask for that in this task. If they want a fork-notes section later, it is a one-line follow-up.)
