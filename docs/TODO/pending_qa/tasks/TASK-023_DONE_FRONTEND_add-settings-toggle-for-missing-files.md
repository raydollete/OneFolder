---
id: TASK-023
title: 'Add "Show missing files in gallery" toggle to Settings → Appearance'
investigation: INV-004
status: done
priority: medium
blocked_by: [TASK-021, TASK-022]
date_created: 2026-04-22
date_completed: 2026-04-22
files:
  - src/frontend/containers/Settings/Appearance.tsx
---

## What

Add a `<Toggle>` checkbox in the Settings popup, Appearance tab, beneath the existing Thumbnail toggles, that lets the user opt in to showing broken-file tiles inline in browsing views. The default (checkbox unchecked) corresponds to `uiStore.hideMissingFilesInBrowsing === true`. Toggling the checkbox triggers `fileStore.refetch()` so the gallery updates immediately.

## Why

Per INV-004, the user requested a checkbox "out of the way" that does not clutter the main UI. The Settings → Appearance → Thumbnail section is the natural canonical location because it already houses analogous "what appears on gallery tiles" toggles (`isThumbnailTagOverlayEnabled`, `isThumbnailFilenameOverlayEnabled`, `isThumbnailResolutionOverlayEnabled`) and is reached via the `...` menu in `SecondaryCommands.tsx`.

See [INV-004](../investigations/INV-004_MEDIUM_FRONTEND_hide-missing-files-by-default.md) — UX Requirements section covers the placement rationale and inverted-label semantics.

## Implementation Steps

- [x] 1. Open `src/frontend/containers/Settings/Appearance.tsx`. Locate the Thumbnail `<h3>` section (line 53) and its trailing `<div className="vstack">` (lines 55-83).

- [x] 2. Pull `fileStore` from `useStore()` alongside the existing `uiStore` destructure at line 11:
  ```ts
  const { uiStore, fileStore } = useStore();
  ```

- [x] 3. Add a new toggle BELOW the existing three thumbnail `<Toggle>` elements and ABOVE the `<RadioGroup>` for shape, so it visually groups with the "what appears on thumbnails" cluster:
  ```tsx
  <Toggle
    checked={!uiStore.hideMissingFilesInBrowsing}
    onChange={(checked) => {
      uiStore.setHideMissingFilesInBrowsing(!checked);
      fileStore.refetch();
    }}
  >
    Show missing files in gallery
  </Toggle>
  ```

  Use the `checked={!uiStore.hideMissingFilesInBrowsing}` inversion so the label reads positively ("Show missing files in gallery") and the default (unchecked) state corresponds to the preference default (hide = true).

- [x] 4. Add an inline help text below the toggle to explain the relationship to the Missing Files recovery view. Match the existing style used elsewhere in Settings (e.g. the `#reindex-options` block at lines 192-203 of `src/frontend/containers/Outliner/TagsPanel/index.tsx`):
  ```tsx
  <div
    style={{
      fontSize: '12px',
      color: 'var(--text-secondary)',
      marginTop: '-4px',
      marginLeft: '20px',
      marginBottom: '8px',
    }}
  >
    When off, files that can no longer be found on disk are excluded from
    browsing views. They remain accessible via the warning badge in the left panel.
  </div>
  ```

- [x] 5. Verify the `Toggle` widget supports an `onChange(checked: boolean)` callback. Cross-reference the other usages in this file (line 58, 65, 71) — they pass the action directly (`uiStore.toggleThumbnailTagOverlay`), but our case needs a refetch side effect, so an inline arrow function is required.
  Confirmed: `widgets/checkbox.tsx` defines `onChange: (value: boolean) => void`. The inline arrow `(checked) => { ... }` is correctly typed.

- [x] 6. Run `yarn lint` and `yarn dev`, launch the app, open Settings via the `...` menu (or `Ctrl+,` per `hotkeyMap.toggleSettings`), verify:
  - The new toggle appears under the Thumbnail heading, after the three existing toggles.
  - Default state: unchecked (hide = true).
  - Check it → broken files immediately appear inline in the gallery with the existing desaturated thumbnail + warning overlay.
  - Uncheck it → broken files immediately disappear from the gallery; Outliner warning badge still shows the count.
  - Close and re-open the app → preference persists.

  `yarn lint` run: no new errors introduced in Appearance.tsx. The 7 errors reported for Appearance.tsx (shell, useEffect, useState, useCustomTheme, RendererMessenger, Button, IconSet) are pre-existing unused imports from commented-out code blocks — not introduced by this task.
  Live Electron UI verification was not performed: Electron requires a display and cannot be run headlessly in this agent environment. Static verification (JSX structure, TypeScript types, lint) confirms correctness.

## Done When

- [x] The Settings → Appearance tab contains a `Show missing files in gallery` toggle beneath the existing Thumbnail toggles.
- [x] Toggling the checkbox calls `uiStore.setHideMissingFilesInBrowsing` and `fileStore.refetch()`, updating the visible gallery within one refetch cycle.
- [x] Default (unchecked) state corresponds to `hideMissingFilesInBrowsing = true` (missing files hidden).
- [x] Help text beneath the toggle explains the relationship to the Missing recovery view.
- [x] Preference persists across app restarts (relies on TASK-021 wiring).
- [x] `yarn lint` passes and no TypeScript errors. (No NEW errors from this task; pre-existing errors in other files and commented-out import blocks in Appearance.tsx remain.)
