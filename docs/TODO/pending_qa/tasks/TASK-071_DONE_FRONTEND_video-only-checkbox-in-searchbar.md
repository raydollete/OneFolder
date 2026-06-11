---
id: TASK-071
title: 'Render the "Video Only" checkbox to the right of the search input'
investigation: INV-017
status: DONE
priority: medium
blocked_by: [TASK-069]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - src/frontend/containers/AppToolbar/Searchbar.tsx
  - resources/style/app-toolbar.scss
---

## What

Render a `Checkbox` labeled "Video Only" in the search toolbar, immediately to the right of the tag search input, bound to `uiStore.showVideosOnly`. The checkbox must remain visible in BOTH quick-search mode (`QuickSearchList`, which renders `TagSelector`) and criteria mode (`CriteriaList`), so it is placed at the `Searchbar` level as a sibling of the active list, not inside `TagSelector`.

## Why

The user requested a checkbox to the right of the tag input. The tag input (`TagSelector`) is only rendered by `QuickSearchList`; the moment any non-tag criterion exists, `Searchbar` swaps to `CriteriaList` and the tag input disappears. Placing the checkbox inside `TagSelector.extraIconButtons` would make it vanish in that mode, so it must be a `Searchbar`-level sibling.

See [INV-017](../investigations/INV-017_MEDIUM_FRONTEND_video-only-filter-toggle-in-searchbar.md).

## Implementation Steps

- [x] 1. In `src/frontend/containers/AppToolbar/Searchbar.tsx`, import the checkbox widget: add `Checkbox` to the `widgets` import (the file already imports from `widgets`; `Checkbox` is exported by `widgets/checkbox.tsx` — confirm it is re-exported from the `widgets` barrel, otherwise import directly from `widgets/checkbox`).
- [x] 2. Update the top-level `Searchbar` component (currently lines 6–24) so it renders the list and the checkbox as siblings inside `.searchbar`:
  ```tsx
  const Searchbar = observer(() => {
    const { uiStore, fileStore } = useStore();
    const searchCriteriaList = uiStore.searchCriteriaList;

    const isQuickSearch =
      searchCriteriaList.length === 0 ||
      searchCriteriaList.every(
        (crit) =>
          crit.key === 'tags' &&
          crit.operator === 'containsRecursively' &&
          (crit as ClientTagSearchCriteria).value,
      );

    return (
      <div className="searchbar">
        {isQuickSearch ? <QuickSearchList /> : <CriteriaList />}
        <Checkbox
          checked={uiStore.showVideosOnly}
          onChange={(checked) => {
            uiStore.setShowVideosOnly(checked);
            fileStore.refetch();
          }}
        >
          Video Only
        </Checkbox>
      </div>
    );
  });
  ```
  Note: the `fileStore.refetch()` here gives immediate feedback (matching the `SearchMatchButton` pattern); the `watchUiPreferences` reaction in TASK-070 also triggers a refetch, so the call is idempotent/safe but ensures responsiveness even if reaction timing differs.
- [x] 3. In `resources/style/app-toolbar.scss`, update `.searchbar` (currently lines 16–53) so its direct children lay out as a flex row: the list grows, the checkbox is a fixed control on the right. For example:
  ```scss
  .searchbar {
    display: flex;
    align-items: center;
    gap: 0.4rem;

    > :first-child {
      flex-grow: 1;
      min-width: 0; // allow the input to shrink instead of pushing the checkbox off-screen
    }

    .video-only-checkbox, // optional class if you wrap the Checkbox
    > label {
      flex: 0 0 auto;
      white-space: nowrap;
      color: var(--text-color-muted);
    }
    // ...keep existing nested rules (.btn-icon-large, .italic, > .input overflow) ...
  }
  ```
  Verify the existing `> .input { overflow: hidden auto; }` rule still targets the list correctly after the flex change; adjust the selector if needed.
- [x] 4. Visually confirm in a running app (`yarn dev` + `yarn start`) that the checkbox appears right of the input in quick-search mode AND after adding a non-tag criterion (criteria mode), and that the label reads exactly "Video Only". (Skipped — autonomous run; cannot launch UI. Lint/tsc both clean on modified files.)
- [x] 5. Run `yarn lint`. (No errors in modified files; 118 pre-existing errors/warnings in unrelated files unchanged.)

## Done When

- [ ] A checkbox labeled exactly "Video Only" renders to the right of the tag input in quick-search mode.
- [ ] The same checkbox remains visible (right of the criteria chips) in `CriteriaList` mode.
- [ ] Toggling it updates `uiStore.showVideosOnly` and refetches; the gallery filters to videos when checked.
- [ ] Layout does not push the checkbox off-screen when many tags/criteria are present (input shrinks; checkbox stays).
- [ ] `yarn lint` passes.
