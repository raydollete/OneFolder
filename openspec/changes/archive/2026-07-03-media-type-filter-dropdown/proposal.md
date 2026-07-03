Tier: 2 — Standard behavior change with a bounded blast radius: relocate one existing renderer-side filter upstream and evolve one preference from boolean to tri-state, touching UiStore persistence, one FileStore hook, and one toolbar component. No backend/DTO/API changes and no cross-cutting refactor.

Type: feature

## Why

The current "Video Only" checkbox filters the gallery with a **post-fetch splice**: every file — images included — is fetched, turned into a `ClientFile`, pushed into `fileList`, rendered, and starts loading a thumbnail, and only *then* are the non-video files removed. The user visibly sees images flash into the grid and disappear a moment later, and the app wastes work generating thumbnails for files it is about to hide. The filter needs to be an **upstream gate** so non-matching files never enter the render/thumbnail pipeline. While reworking it, the binary checkbox should become a three-way selector so the same gate can also show images only.

## What Changes

- Replace the post-fetch `showVideosOnly` splice in `FileStore.updateFromBackend` with an **upstream media-type gate** that filters the fetched `FileDTO[]` *before* any `ClientFile` is constructed, so hidden files never render or trigger thumbnail generation.
- **BREAKING (preference shape):** Replace the boolean `showVideosOnly` preference with a tri-state `mediaTypeFilter` preference: `all` | `images` | `video` (default `all`). A back-compat read maps a persisted legacy `showVideosOnly: true` to `video` so existing libraries are not disrupted.
- Replace the "Video Only" `Checkbox` in the Search toolbar with a dropdown offering **Show All Media**, **Images Only**, and **Video Only**.
- Keep the filter a display-only preference (not a search criterion): it does not add a removable chip, does not affect AND/OR search semantics, is per-library, and persists across restarts — the established behavior of the existing filter.
- Preserve existing guard behavior: the gate is bypassed in the Missing-files view (which is always unfiltered), composes with the hide-missing-files filter, and keeps the Outliner "All Images" total badge accurate.

## Capabilities

### New Capabilities
- `media-type-filter`: A per-library display filter that restricts the gallery to a chosen media type (all media, images only, or video only) via an upstream gate applied before files are materialized into the view, controlled by a dropdown in the Search toolbar.

### Modified Capabilities
<!-- None: no existing spec covers gallery display filtering; this is the first spec for it. -->

## Blast Radius

1. `src/frontend/stores/FileStore.ts:1729-1778` — the current post-fetch `showVideosOnly` splice, the `numTotalFiles` count-override, and the `filesFromBackend` call site inside `updateFromBackend`; the primary relocation site (gate must move to the `FileDTO[]` boundary, ahead of `ClientFile` construction).
2. `src/frontend/stores/FileStore.ts:129-139` — the `watchUiPreferences` reaction currently keyed on `uiStore.showVideosOnly` (line 139); must re-key on `mediaTypeFilter`.
3. `src/frontend/stores/UiStore.ts:151,195,453-457,1121,1217` — `PersistentPreferenceFields` entry (line 151), the `showVideosOnly` observable (line 195), setter/toggle (lines 453-457), `recoverPersistentPreferences` read (line 1121, needs the legacy `showVideosOnly → 'video'` migration), and `getPersistentPreferences` write (line 1217).
4. `src/frontend/containers/AppToolbar/Searchbar.tsx:26-34` — the "Video Only" `Checkbox` to be replaced by the dropdown; `resources/style/app-toolbar.scss` for the control's styling.
5. `common/fs.ts:46-48` — `isFileExtensionVideo`, the single authoritative video-extension classifier reused by the gate (images = its complement).
6. Searches bounding the radius: `grep -rn showVideosOnly src` → `UiStore.ts`, `FileStore.ts`, `Searchbar.tsx` only (plus the built `dist-web` bundle, not source). `grep -rn isFileExtensionVideo src common` → the FileStore splice is the only consumer in the fetch path. No other component reads the filter preference.

## Impact

- **Preference / state:** `UiStore` — replace `showVideosOnly` observable, setter, and `PersistentPreferenceFields` entry with `mediaTypeFilter`; update `getPersistentPreferences` / `recoverPersistentPreferences` (with legacy migration).
- **Fetch pipeline:** `FileStore.updateFromBackend` (`src/frontend/stores/FileStore.ts`) — move the extension filter upstream to the `FileDTO[]` boundary; update the `watchUiPreferences` reaction and the `numTotalFiles` count-override logic.
- **UI:** `src/frontend/containers/AppToolbar/Searchbar.tsx` — swap Checkbox for a dropdown; `resources/style/app-toolbar.scss` for styling.
- **Shared classifier:** `common/fs.ts` — reuse `isFileExtensionVideo`; add an "images only" predicate as the complement.
- **Docs:** `docs/video-only-filter.md` updated/superseded to describe the tri-state upstream gate.
- No backend/DTO API changes; the gate operates on the already-fetched `FileDTO[]` in the renderer.
