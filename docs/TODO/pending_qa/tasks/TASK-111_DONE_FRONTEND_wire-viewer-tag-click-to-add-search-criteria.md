---
id: TASK-111
title: 'Wire viewer assigned-tag click to add the tag to the current search filters'
investigation: INV-029
status: done # planned | in-progress | blocked | done
priority: low # critical | high | medium | low
blocked_by: []
date_created: 2026-06-18
date_completed: 2026-06-18
files:
  - src/frontend/components/FileTag.tsx
---

## What

In the viewer (SlideMode) Inspector, make clicking an assigned tag's label add that tag
to the current search filters. Pass an `onTagClick` callback to the existing
`<TagSelector>` in `src/frontend/components/FileTag.tsx` that calls
`uiStore.addSearchCriteria(new ClientTagSearchCriteria('tags', tag.id))`, guarded against
adding a duplicate criterion for the same tag.

## Why

`TagSelector` already exposes an `onTagClick` prop wired end-to-end to the `Tag` widget's
`onClick`, but `FileTag.tsx` never passes it, so clicking an assigned tag in the viewer is
a dead affordance. The canonical add-to-filter path already exists and is used by the Tags
Panel. This connects the viewer chip to that path.

See [INV-029](../investigations/INV-029_LOW_FRONTEND_viewer-click-assigned-tag-adds-to-filter.md).

## Implementation Steps

- [x] 1. In `src/frontend/components/FileTag.tsx`, pull `uiStore` from `useStore()`
      alongside the existing `tagStore` (change `const { tagStore } = useStore();` to
      `const { tagStore, uiStore } = useStore();`).
- [x] 2. Import `ClientTagSearchCriteria` from `../entities/SearchCriteria`.
- [x] 3. Add a memoized `handleTagClick` callback (via `useCallback`) that:
      - Checks whether `uiStore.searchCriteriaList` already contains a
        `ClientTagSearchCriteria` whose `key === 'tags'` and `value === tag.id`; if so,
        return without adding (dedupe — avoids a duplicate row in the search bar).
      - Otherwise calls
        `uiStore.addSearchCriteria(new ClientTagSearchCriteria('tags', tag.id))`.
      Depend on `[uiStore]`.
- [x] 4. Pass `onTagClick={handleTagClick}` to the `<TagSelector>` element (alongside the
      existing `selection`, `onClear`, `onDeselect`, `onSelect`, `showTagContextMenu`,
      `multiline` props). Do NOT change `onDeselect`/`onClear` — the remove "X" must still
      unassign the tag from the file.
- [x] 5. Verify the remove "X" button still removes the tag from the file (not the filter)
      and right-click still opens the assigned-tag context menu — both are independent of
      `onClick` because the `Tag` widget's remove button calls `e.stopPropagation()`
      (`widgets/tag.tsx:42-44`) and `onContextMenu` is a separate handler.

## Done When

- [x] Clicking an assigned tag's label in the viewer Inspector appends a
      `ClientTagSearchCriteria('tags', tag.id)` to `uiStore.searchCriteriaList` and the
      search bar shows the new criterion.
- [x] Clicking the same already-filtered tag again does not add a duplicate criterion.
- [x] The remove "X" still unassigns the tag from the file; right-click still opens the
      context menu; no other `TagSelector` consumer (Searchbar, AdvancedSearch,
      FileTagEditor) is affected.
- [x] `yarn lint` and `yarn build` pass.
