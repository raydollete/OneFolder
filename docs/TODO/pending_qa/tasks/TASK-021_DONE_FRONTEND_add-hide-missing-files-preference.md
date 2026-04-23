---
id: TASK-021
title: 'Add hideMissingFilesInBrowsing preference to UiStore'
investigation: INV-004
status: done
priority: medium
blocked_by: []
date_created: 2026-04-22
date_completed: 2026-04-22
files:
  - src/frontend/stores/UiStore.ts
---

## What

Introduce a new library-scoped persistent boolean preference `hideMissingFilesInBrowsing` (default `true`) in `UiStore`. Add the observable, setter actions, and wire it into the persistent preferences recovery / serialization path so it survives app restarts and is namespaced per library via the existing `storageKeyPrefix` mechanism.

## Why

The investigation requires a single source of truth for the "hide vs. show missing tiles" toggle that is read by `FileStore.updateFromBackend` (TASK-022) and written by a new Settings checkbox (TASK-023). Default must be `true` (hide) per the user's stated requirement.

See [INV-004](../investigations/INV-004_MEDIUM_FRONTEND_hide-missing-files-by-default.md).

## Implementation Steps

- [x] 1. Open `src/frontend/stores/UiStore.ts`. In the `PersistentPreferenceFields` union (starts line 122), add `| 'hideMissingFilesInBrowsing'`.

- [x] 2. In the `UiStore` class observable block (near line 185-202, adjacent to the `isThumbnailTagOverlayEnabled` / `isThumbnailFilenameOverlayEnabled` cluster), add:
  ```ts
  /** When true (default), files whose absolutePath no longer resolves on disk are hidden from
   *  All / Untagged / Query / Duplicates / Calendar / List views. The dedicated Missing Files
   *  recovery view is unaffected. */
  @observable hideMissingFilesInBrowsing: boolean = true;
  ```

- [x] 3. Add a setter action near the other thumbnail-toggle setters (e.g. near `setThumbnailShape` around line 294) so callers can set it directly:
  ```ts
  @action.bound setHideMissingFilesInBrowsing(value: boolean): void {
    this.hideMissingFilesInBrowsing = value;
  }

  @action.bound toggleHideMissingFilesInBrowsing(): void {
    this.hideMissingFilesInBrowsing = !this.hideMissingFilesInBrowsing;
  }
  ```

- [x] 4. In `recoverPersistentPreferences` (line 979), add a line that restores the preference with a safe default of `true` (matching the established pattern for other booleans):
  ```ts
  this.hideMissingFilesInBrowsing = Boolean(prefs.hideMissingFilesInBrowsing ?? true);
  ```
  Place it adjacent to the other `Boolean(prefs.X ?? default)` lines (e.g. right after `isThumbnailResolutionOverlayEnabled` around line 1017).

- [x] 5. In `getPersistentPreferences` (line 1072), add `hideMissingFilesInBrowsing: this.hideMissingFilesInBrowsing,` to the `preferences` record (adjacent to `isThumbnailResolutionOverlayEnabled` around line 1100).

- [x] 6. Verify the TypeScript union is consistent: the `preferences` record is typed as `Record<PersistentPreferenceFields, unknown>`, so adding the field in step 5 without also adding the key in step 1 causes a type error — this verification is automatic via `yarn lint`.

- [x] 7. Run `yarn lint` to confirm no TypeScript errors.

## Done When

- [ ] `UiStore` exposes `hideMissingFilesInBrowsing` as an observable with default `true`.
- [ ] `setHideMissingFilesInBrowsing(boolean)` and `toggleHideMissingFilesInBrowsing()` actions exist and are `@action.bound`.
- [ ] The preference survives app restart within the same library (verified by running the app, toggling the value in the MobX devtools or a temporary button, closing, and re-opening).
- [ ] The preference is scoped per library — switching libraries reads its own stored value via `storageKeyPrefix`.
- [ ] `yarn lint` passes.
- [ ] `yarn test` (Jest) passes; add a unit test in `src/frontend/stores/__tests__/UiStore.test.ts` if one exists, otherwise skip — the preference is simple state.
