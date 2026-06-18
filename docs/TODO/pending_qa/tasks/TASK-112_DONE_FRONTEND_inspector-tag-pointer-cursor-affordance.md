---
id: TASK-112
title: 'Add a pointer-cursor affordance to clickable assigned tags in the viewer inspector'
investigation: INV-029
status: done # planned | in-progress | blocked | done
priority: low # critical | high | medium | low
blocked_by: [TASK-111]
date_created: 2026-06-18
date_completed: 2026-06-18
files:
  - src/frontend/components/FileTag.tsx
  - resources/style (inspector / tag SCSS)
---

## What

Give the viewer Inspector's assigned-tag labels a `cursor: pointer` so the new
click-to-filter affordance (TASK-111) is discoverable, scoped so it does NOT restyle tag
chips elsewhere (Searchbar, AdvancedSearch).

## Why

The `Tag` widget (`widgets/tag.tsx`) has no `cursor: pointer` tied to `onClick`, so after
TASK-111 the inspector tags are clickable but do not look clickable. The cursor must be
scoped to the inspector's tag list because the same `Tag`/`TagSelector` components render
non-clickable chips in the Searchbar and AdvancedSearch.

See [INV-029](../investigations/INV-029_LOW_FRONTEND_viewer-click-assigned-tag-adds-to-filter.md).

## Implementation Steps

- [x] 1. Locate the SCSS that styles the inspector and/or `.tag` (search the SCSS under
      the styles directory for `#inspector` and `.tag-selector` / `.tag .label`). Confirm
      which scope already applies to the `FileTags` `TagSelector` inside `#inspector`.
- [x] 2. Add a rule scoped to the inspector tag list (e.g.
      `#inspector .tag-selector .tag .label { cursor: pointer; }`, or a dedicated class
      added to the `FileTags` `TagSelector`) so only the viewer's assigned-tag labels get
      the pointer cursor. Do NOT add the cursor to the global `.tag` rule.
- [x] 3. If a dedicated class is preferred over an `#inspector` descendant selector, add a
      `className` prop pass-through on the `FileTags` `TagSelector` in
      `src/frontend/components/FileTag.tsx` (or reuse the existing `tag-selector` class
      scoped under `#inspector`), and apply the cursor rule to that class only.
      (Used `#inspector` descendant selector — no dedicated class needed; `tag-selector`
      already renders inside `#inspector` exclusively for the viewer use case.)
- [x] 4. Verify in the running app that Searchbar and AdvancedSearch tag chips are
      unchanged (no pointer cursor introduced there).

## Done When

- [x] Hovering an assigned tag label in the viewer Inspector shows a pointer cursor.
- [x] Tag chips in the Searchbar and AdvancedSearch are visually unchanged (no new pointer
      cursor, no layout shift).
- [x] `yarn lint` and `yarn build` pass.
