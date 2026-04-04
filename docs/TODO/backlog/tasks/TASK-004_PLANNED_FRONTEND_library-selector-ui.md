---
id: TASK-004
title: 'Build Library Selector UI for choosing, creating, renaming, and deleting libraries'
investigation: INV-001
status: planned
priority: medium
blocked_by: [TASK-001, TASK-003]
date_created: 2026-04-04
date_completed:
files:
  - 'src/frontend/containers/LibrarySelector.tsx (new)'
  - 'src/frontend/containers/Settings/Advanced.tsx'
  - 'src/renderer.tsx'
  - 'src/frontend/App.tsx'
---

## What

Build a Library Selector UI that appears at launch (when multiple libraries exist) and is accessible from the Settings panel. The selector lists all known libraries and allows the user to open, create, rename, or delete libraries.

## Why

Without a UI for library management, the multi-library infrastructure (TASK-001 through TASK-003) is unusable. Users need a way to interact with their libraries.

See [INV-001](../investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md).

## Implementation Steps

- [ ] 1. **Create `src/frontend/containers/LibrarySelector.tsx`** — A React component that:
  - Fetches the library list via `RendererMessenger.getLibraries()`.
  - Displays each library as a card/row showing: name, last opened date, a small indicator for the currently active library.
  - **Open button**: Sets the active library and triggers a reload (via `RendererMessenger.setActiveLibrary(id)` followed by `RendererMessenger.reload()`). The reload will cause the app to restart with the new library ID.
  - **Create New button**: Shows an inline input for the library name. On confirm, calls `RendererMessenger.createLibrary(name)`, then sets it as active and reloads.
  - **Rename button** (per library): Inline edit of the name, calls `RendererMessenger.renameLibrary(id, newName)`.
  - **Delete button** (per library, not shown for active library): Confirmation dialog, then calls `RendererMessenger.deleteLibrary(id)`. Optionally offer to delete the associated IndexedDB database and thumbnail/backup directories.
  - Style with the existing widget library (`Button`, `ButtonGroup`, `IconSet` from `widgets`). Match the existing dark theme aesthetic.
  Verify: Component renders, lists libraries, and all CRUD operations work.

- [ ] 2. **Integrate into app startup (`src/renderer.tsx`)** — Before rendering `<App />`, check the library list:
  - If there is exactly one library and it is already active, skip the selector and proceed normally.
  - If there are multiple libraries, render `<LibrarySelector />` instead of `<App />`.
  - If there are zero libraries (should not happen after TASK-006 migration, but defensive), create a default library and proceed.
  - After the user selects a library, the app reloads with the new library ID in the URL, and normal initialization proceeds.
  Verify: On first launch (single library), no selector shown. After creating a second library, selector appears on next launch.

- [ ] 3. **Add "Switch Library" option to Settings** — In `src/frontend/containers/Settings/Advanced.tsx`, add a button labeled "Switch Library" or "Manage Libraries". Clicking it:
  - Saves current state (preferences are auto-saved via reactions, so this may be implicit).
  - Navigates to the Library Selector. This can be done by setting a state flag that causes `<App />` to unmount and `<LibrarySelector />` to mount, OR by triggering a reload that forces the selector to appear (e.g., by clearing the active library ID temporarily).
  Verify: Clicking "Switch Library" in settings shows the library selector.

- [ ] 4. **Handle edge cases**:
  - Library name validation: no empty names, reasonable length limit (e.g., 50 chars).
  - Deleting the last remaining library: either prevent it or auto-create a new default library.
  - Library with the same name as an existing one: allow it (IDs are unique, names are display-only).
  Verify: Edge cases do not crash the app or corrupt data.

## Done When

- [ ] Library Selector UI renders and lists all libraries with their names and last-opened dates.
- [ ] User can create a new library from the selector.
- [ ] User can rename an existing library.
- [ ] User can delete a non-active library (with confirmation).
- [ ] Selecting a library reloads the app with the chosen library's data.
- [ ] Settings panel has a "Switch Library" / "Manage Libraries" button.
- [ ] Single-library users see no change in their workflow (selector is skipped or shown briefly).
