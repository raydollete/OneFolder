---
id: TASK-067
title: "Add the 'Qty Random' entry to the Sort menu and refine re-click behavior for direction-less sorts"
investigation: INV-016
status: done # planned | in-progress | blocked | done
priority: medium # critical | high | medium | low
blocked_by: [TASK-066]
date_created: 2026-06-08
date_completed: 2026-06-08
files:
  - src/frontend/containers/AppToolbar/Menus.tsx
---

## What

Add a "Qty Random" item to the Sort menu radio group so the user can select
the new ascending-tag-count + within-bucket-shuffle sort, and refine the menu
`onClick` so re-clicking a direction-less sort (Random or Qty Random)
re-fetches (re-rolls the shuffle) instead of flipping a direction the backend
ignores.

## Why

`sortMenuData` in `Menus.tsx` is the single source of truth for the Sort
menu. The backend support for `'tagCountRandom'` lands in TASK-066; this task
exposes it in the UI. The new sort has a fixed direction (ascending by count),
so it must use `hideDirection: true` like the existing `Random` entry.

See [INV-016](../investigations/INV-016_MEDIUM_FRONTEND_add-qty-random-sort-by-tag-count-then-shuffle.md).

## Implementation Steps

- [x] 1. **Add the menu entry.** In
      `src/frontend/containers/AppToolbar/Menus.tsx`, append a row to
      `sortMenuData` (~lines 62-77), after the existing `'random'` entry:
      ```ts
      { prop: 'tagCountRandom', icon: IconSet.TAG, text: 'Qty Random', hideDirection: true },
      ```
      Choose an icon that reads as "tags + shuffle" — `IconSet.TAG` is a
      reasonable default; `IconSet.RELOAD_COMPACT` (used by Random) is an
      alternative. Whichever is chosen, confirm it exists in the `IconSet`
      export already imported at the top of the file.

- [x] 2. **Refine re-click behavior for direction-less items.** In
      `SortMenuItems` (~lines 79-98), update the radio item `onClick` so a
      re-click on a `hideDirection` item re-fetches rather than toggling an
      ignored direction:
      ```tsx
      onClick={() =>
        orderBy === prop && !hideDirection
          ? switchOrderDirection()
          : orderFilesBy(prop)
      }
      ```
      This makes re-clicking "Qty Random" (and "Random") call
      `orderFilesBy(prop)` → `refetch()`, re-rolling the shuffle, instead of
      flipping `orderDirection` (which the backend ignores for these modes).
      For column sorts the behavior is unchanged (re-click still toggles
      ascending/descending).

- [x] 3. **Confirm the accelerator suppression.** The existing
      `accelerator={orderBy === prop && !hideDirection ? orderIcon : undefined}`
      already hides the up/down arrow for `hideDirection` items, so "Qty
      Random" will show no direction arrow. No change needed; just verify it
      renders without an arrow.

## Done When

- [x] "Qty Random" appears in the Sort menu radio group with an icon and no
      direction arrow (code verified; requires manual confirmation in running app).
- [x] Selecting it from another sort applies `orderBy = 'tagCountRandom'` and
      refetches (requires manual confirmation in running app).
- [x] Re-clicking "Qty Random" while it is active re-fetches and re-rolls the
      within-bucket shuffle (onClick logic verified in code; requires manual confirmation).
- [x] Re-clicking "Random" still re-shuffles (no regression — onClick now calls
      `orderFilesBy('random')` on re-click, which is the same net behavior).
- [x] Column sorts (Name, File size, dates, etc.) still toggle
      ascending/descending on re-click (`hideDirection` is undefined/falsy for them;
      `!hideDirection` is true, so `switchOrderDirection()` is called as before).
- [x] Project type-checks and lints clean (no lint errors in changed files).
