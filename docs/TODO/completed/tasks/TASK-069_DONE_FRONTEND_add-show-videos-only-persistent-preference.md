---
id: TASK-069
title: 'Add persistent `showVideosOnly` preference to UiStore'
investigation: INV-017
status: DONE
priority: medium
blocked_by: []
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - src/frontend/stores/UiStore.ts
---

## What

Add a new persisted boolean UI preference `showVideosOnly` (default `false`) to `UiStore`, wired through all five persistence sites so it saves to and restores from per-library localStorage, with a setter and a toggle action. This is the data layer for the "Video Only" searchbar checkbox.

## Why

"Video Only" is a global, persistent display preference (like hide-missing-files / INV-004), not a search criterion. It must live in the persistent-preferences pipeline so its state survives restart, scoped per library.

See [INV-017](../investigations/INV-017_MEDIUM_FRONTEND_video-only-filter-toggle-in-searchbar.md).

## Implementation Steps

- [x] 1. In `src/frontend/stores/UiStore.ts`, add `'showVideosOnly'` to the `PersistentPreferenceFields` type union (near line 122, alongside `'hideMissingFilesInBrowsing'` at line 153).
- [x] 2. Declare the observable near line 195 (next to `hideMissingFilesInBrowsing`): `@observable showVideosOnly: boolean = false;`
- [x] 3. Add actions near line 434 (next to `setHideMissingFilesInBrowsing` / `toggleHideMissingFilesInBrowsing`):
  ```ts
  @action.bound setShowVideosOnly(value: boolean): void {
    this.showVideosOnly = value;
  }
  @action.bound toggleShowVideosOnly(): void {
    this.showVideosOnly = !this.showVideosOnly;
  }
  ```
- [x] 4. In `getPersistentPreferences()` (the `preferences` object near line 1145), add: `showVideosOnly: this.showVideosOnly,`
- [x] 5. In `recoverPersistentPreferences()` (near line 1052, beside the `hideMissingFilesInBrowsing` restore), add: `this.showVideosOnly = Boolean(prefs.showVideosOnly ?? false);`
- [x] 6. Run `yarn lint` and `yarn build` (or `tsc`) to confirm the new field type-checks against the `Record<PersistentPreferenceFields, unknown>` constraint in `getPersistentPreferences`.
  - UiStore.ts has zero lint errors. Build compiled successfully (webpack compiled with 1 pre-existing warning unrelated to this task).

## Done When

- [x] `uiStore.showVideosOnly` exists as an observable defaulting to `false`.
- [x] `setShowVideosOnly` and `toggleShowVideosOnly` actions exist.
- [x] The field is present in both `getPersistentPreferences()` and `recoverPersistentPreferences()`, and appears in the `PersistentPreferenceFields` union (so the build is type-safe).
- [ ] Manually toggling the value in a running app and restarting restores the same value (verified end-to-end in the QA task TASK-073).
