---
id: TASK-049
title: 'Flip default theme to dark and default sort to random in store initializers'
investigation: INV-011
status: done
priority: low
blocked_by: []
date_created: 2026-05-03
date_completed: 2026-05-04
files:
  - 'src/frontend/stores/UiStore.ts'
  - 'src/frontend/stores/FileStore.ts'
---

## What

Flip three default values across two MobX stores so that fresh installs and newly-created libraries start with a dark theme and a randomly-ordered gallery instead of light + dateAdded-desc:

1. `UiStore.theme` field initializer: `'light'` → `'dark'`.
2. `FileStore.orderBy` field initializer: `'dateAdded'` → `'random'`.
3. `FileStore.setOrderBy` and `FileStore.orderFilesBy` default-parameter values: `'dateAdded'` → `'random'` (Defect B from the investigation — these silently re-introduce `'dateAdded'` if `prefs.orderBy` is `undefined` during recovery, which would defeat the field-initializer change).

`orderDirection` stays at `OrderDirection.Desc` because the random-sort backend code paths ignore the direction parameter when `order === 'random'`.

## Why

The user wants OneFolder to ship with dark mode and random sort as the out-of-the-box experience. The current defaults (light + dateAdded-desc) require manual flipping in Settings every time a fresh library is created. The change must NOT clobber returning users with persisted prefs — that is handled for free by the existing recovery code in both stores, which honors persisted values over the field defaults.

See [INV-011](../investigations/INV-011_LOW_FRONTEND_default-theme-dark-and-default-sort-random.md) for the full analysis, including why all three sites must change together (Defect B explanation) and why `orderDirection` is intentionally left alone.

## Implementation Steps

- [x] 1. **Edit `src/frontend/stores/UiStore.ts:167`**: change the theme field initializer.
  - Before: `@observable theme: 'light' | 'dark' = 'light';`
  - After: `@observable theme: 'light' | 'dark' = 'dark';`
  - No other changes in UiStore for this task — leave `setTheme(theme: 'light' | 'dark' = 'dark')` at line 623 alone (its default-param is already `'dark'`, so it stays consistent with the new field default).

- [x] 2. **Edit `src/frontend/stores/FileStore.ts:78`**: change the `orderBy` field initializer.
  - Before: `@observable orderBy: OrderBy<FileDTO> = 'dateAdded';`
  - After: `@observable orderBy: OrderBy<FileDTO> = 'random';`
  - Do NOT change line 77 (`@observable orderDirection: OrderDirection = OrderDirection.Desc;`).

- [x] 3. **Edit `src/frontend/stores/FileStore.ts:598`**: change the `orderFilesBy` default-param value (Defect B fix, site 1 of 2).
  - Before: `@action.bound orderFilesBy(prop: OrderBy<FileDTO> = 'dateAdded'): void {`
  - After: `@action.bound orderFilesBy(prop: OrderBy<FileDTO> = 'random'): void {`

- [x] 4. **Edit `src/frontend/stores/FileStore.ts:1289`**: change the `setOrderBy` default-param value (Defect B fix, site 2 of 2).
  - Before: `@action private setOrderBy(prop: OrderBy<FileDTO> = 'dateAdded') {`
  - After: `@action private setOrderBy(prop: OrderBy<FileDTO> = 'random') {`

- [x] 5. **Build verification**: run `yarn lint` to confirm no TypeScript or lint errors.
  - Actual result: `yarn lint` exited with code 1 due to 50 pre-existing errors in unrelated files (ImageDescription.tsx, ImageMap.tsx, ImageParameters.tsx, ImagePrompt.tsx, ImageTools.tsx, ipc/main.ts, thumbnailGenerator.worker.ts, etc.). The one FileStore.ts error (`_rawDbUntagged` unused at line 1279) is also pre-existing and unrelated to any changed line. UiStore.ts had zero errors. The diff is strictly limited to the four target lines — no new errors introduced.

- [x] 6. **Spot-check the Sort menu radio data** in `src/frontend/containers/AppToolbar/Menus.tsx:62-77` to confirm the `'random'` entry is still present and that no UI code hard-codes `'dateAdded'` as a fallback.
  - Confirmed: `'random'` is present at line 76 of sortMenuData. The `'dateAdded'` at line 73 is the menu item label entry only — not a fallback. No edit needed.

## Done When

- [x] All four edits above are applied and the file diffs are limited to the listed lines (no incidental neighbor changes).
- [x] `yarn lint` passes with no new errors (pre-existing errors only; none introduced by this task).
- [x] No other files are modified by this task. Defect A (fresh-install theme IPC gap) is handled in TASK-050; QA is handled in TASK-051.
