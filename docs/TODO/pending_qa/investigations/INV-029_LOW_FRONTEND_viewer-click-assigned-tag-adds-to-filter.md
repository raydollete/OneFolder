---
id: INV-029
title: 'Clicking an assigned tag label in the viewer should add it to the current tag filters'
reported_bug: 'In the viewer, clicking on an assigned tag''s label name does nothing; it should add that tag to the current search/tag filters.'
date: 2026-06-18
status: active # active | tasks-created | superseded
superseded_by:
tasks_spawned: [TASK-111, TASK-112]
root_cause_category: architectural-shortcoming # dead affordance: the click hook exists but is never wired
affects:
  - Inspector tag list (viewer / SlideMode)
  - TagSelector component
  - UiStore search criteria
  - SlideMode content/refetch behavior
---

## Bug Report

### Observed Behavior

In the viewer (SlideMode), the Inspector panel's "Tags" section lists the currently
selected image's assigned tags. Clicking on an assigned tag's **label name** does
nothing useful: the click bubbles up to the combobox container
(`TagSelector` root `onClick={handleBackgroundClick}`), which merely focuses the
hidden text input. There is no way to click a visible assigned tag to filter the
library by it.

### Expected Behavior

Clicking an assigned tag's label name in the viewer should **add that tag to the
current search/tag filters** — i.e. append a `ClientTagSearchCriteria('tags', tag.id)`
to `uiStore.searchCriteriaList`, the same canonical operation used by the Tags Panel
"Add to Search" context-menu action and the Tags Tree click-to-search behavior.

### Reproduction Context

Deterministic. Open any image in the viewer (SlideMode), open the Inspector ("eye"
toggle), expand the "Tags" section, and click the text of any assigned tag. Nothing
happens. Independent of image format.

---

## Root Cause Analysis

**Category:** architectural-shortcoming (dead affordance — the hook point exists but is never wired)

### Diagnosis

The viewer's tag list is rendered by:

- `src/frontend/containers/ContentView/SlideMode/index.tsx` → renders `<Inspector />`
- `src/frontend/containers/Inspector/index.tsx:52` → renders `<FileTags file={first} />`
- `src/frontend/components/FileTag.tsx:53-62` → renders `<TagSelector ... />`
- `src/frontend/components/TagSelector.tsx` → maps `selection` to `<SelectedTag>` which
  renders the `Tag` widget (`widgets/tag.tsx`).

`TagSelector` **already exposes** an optional `onTagClick?: (tag: ClientTag) => void`
prop (`TagSelector.tsx:24`). It is threaded to `SelectedTag` and attached to the `Tag`
widget's `onClick` only when defined (`TagSelector.tsx:147`, `:199`). But `FileTag.tsx`
never passes `onTagClick`, so `Tag` receives `onClick={undefined}`. The click then
bubbles to the combobox root `onClick={handleBackgroundClick}` (`TagSelector.tsx:132`),
which only focuses the input. The affordance is dead — the wiring exists end-to-end
except for the one call site.

The canonical "add a tag to the filter" operation already exists:
`uiStore.addSearchCriteria(new ClientTagSearchCriteria('tags', tag.id))`
(`UiStore.ts:960-963`), used at `Outliner/TagsPanel/ContextMenu.tsx:130` and
`Outliner/TagsPanel/TagsTree.tsx:121`. There is no missing infrastructure — only the
connection from the viewer's assigned-tag click to that call.

### Diagnostic Questions Considered

- **Wrong mental model?** Partly — the `TagSelector` was built primarily as an *editor*
  (add/remove tags), so clicking a chip was treated as a no-op rather than a filter
  affordance. The viewer use case (click to filter) was never wired.
- **Architectural shortcoming?** Yes — this is the core: a designed-in extension point
  (`onTagClick`) was left unconnected at the `FileTag.tsx` call site.
- **Incorrect order of operations?** No.
- **Missing edge case?** No — it is a missing wiring, not a missed branch.
- **Wrong abstraction?** No — `onTagClick` is the right abstraction; it just is not used here.
- **Silent failure?** Mildly — the click "succeeds" (focuses input) so nothing errors,
  which is why the dead affordance went unnoticed.

---

## Blast Radius

Verified by bomb-squad. The change is well-isolated; each `TagSelector` consumer passes
(or omits) its own `onTagClick`, so there is zero cross-consumer leakage.

1. **`src/frontend/components/FileTag.tsx`** — the edit site. Today passes no
   `onTagClick`. Adding one affects only this component instance.

2. **`src/frontend/containers/Inspector/index.tsx`** — sole mount of `FileTags`.
   `Inspector` is itself mounted only by `SlideMode/index.tsx`, and its body keys off
   `uiStore.slideFile`. **Therefore the assigned-tag list only ever exists in the
   viewer** — "scope to the viewer only" needs no extra gating.

3. **`src/frontend/components/TagSelector.tsx`** — other consumers are independent:
   - `AppToolbar/Searchbar.tsx` already passes its own `onTagClick`
     (`uiStore.toggleAdvancedSearch`) — unaffected.
   - `AdvancedSearch/Inputs.tsx` (`TagCriteriaItem`) passes no `onTagClick` — unaffected.
   - `AppToolbar/FileTagEditor.tsx` does **not** use `<TagSelector>` at all (only imports
     `TagOption` and renders bare `Tag` widgets) — inherently excluded, so the toolbar tag
     editor will **not** gain click-to-filter (which is correct; the requirement is
     viewer-only).

4. **`widgets/tag.tsx` (Tag widget)** — the remove "X" `IconButton` already calls
   `e.stopPropagation()` before `onRemove()` (`tag.tsx:42-44`), so clicking the X will
   **not** also trigger the new `onClick`. `onContextMenu` is a separate handler, so
   right-click still opens the existing `FileTagMenuItems` context menu. The only
   cosmetic gap: the `.tag` label has no `cursor: pointer`, so the new click target does
   not look clickable. A scoped style (only for the inspector instance) should add the
   pointer cursor without globally restyling every `Tag` (Searchbar/AdvancedSearch chips
   also use this widget).

5. **`UiStore.addSearchCriteria` → `viewQueryContent` → `FileStore.fetchFilesByQuery`** —
   the canonical add path triggers a refetch. Two viewer-side effects to handle
   deliberately:
   - **Content-mode flip drops the viewer to the grid.** `setContentQuery`
     (`FileStore.ts:631-637`) calls `disableSlideMode()` **only when `content` actually
     changes** (`Content.All` → `Content.Query`). If the viewer was opened from
     *all-content* (no active query), the first added criterion flips the mode and kicks
     the user out of the viewer to the grid. If the viewer was already showing query
     results, `changed` is false and the viewer persists.
   - **Viewed file may be re-anchored or jump.** `updateFromBackend` re-anchors
     `firstItem` by file identity via `reconcileFirstItemTo` (`FileStore.ts:1753-1776`).
     Since the user clicks the viewed image's *own* assigned tag, that image normally
     still matches the (narrowed) filter, so the viewer stays on the same image. Only if
     other active criteria already exclude it (e.g. with `searchMatchAny` off) would the
     viewer clamp to an adjacent image rather than crash. No tear-down/blank occurs.

---

## UX / Requirements Specification

### Purpose

Make the viewer's assigned-tag chips an actionable filter affordance: clicking a tag's
label adds it to the current tag filters, letting a user pivot from "this photo" to "all
photos with this tag" without leaving the viewer (when already in a query view) or
reaching for the Tags Panel.

### User-Stated Design Decisions

1. **Click an assigned tag's label name → add that tag to the current tag filters.** —
   The explicit requested behavior. Implemented via the canonical
   `uiStore.addSearchCriteria(new ClientTagSearchCriteria('tags', tag.id))`.

### Behavioral Specifications

- **Add (append), not replace.** "Added to the current tag filters" means append to
  `searchCriteriaList`, matching the Tags Panel "Add to Search" semantics — not "Replace
  Search". Existing criteria are preserved.
- **Avoid duplicate criteria.** If a `ClientTagSearchCriteria` for the same `tag.id`
  already exists in `searchCriteriaList`, do not add a second identical criterion (no-op
  or harmless re-add); the existing Tags Panel path does not dedupe, but for a single
  inspector chip a guard avoids a confusing duplicate row in the search bar.
- **Reuse the canonical path.** Call `uiStore.addSearchCriteria` with a
  `ClientTagSearchCriteria('tags', tag.id)`; do not author a new helper or a parallel
  criteria-mutation path.
- **The remove "X" still removes the tag from the file** (unchanged) and **right-click
  still opens the assigned-tag context menu** (unchanged). Only a left-click on the label
  triggers the new filter add.
- **Cursor affordance.** The inspector tag label should show a pointer cursor so the new
  click target is discoverable, without restyling tags elsewhere.

### Explicit Rejections

- Do **not** apply click-to-filter to the toolbar `FileTagEditor` popover or the
  AdvancedSearch tag inputs — the requirement is viewer-specific, and those use different
  components/own callbacks.
- Do **not** change the click to "Replace Search" — it must *add*.

---

## Holistic Solution

### Approach

1. **Wire `onTagClick` in `FileTag.tsx`.** Pass an `onTagClick` callback to `TagSelector`
   that calls `uiStore.addSearchCriteria(new ClientTagSearchCriteria('tags', tag.id))`,
   guarded against adding a duplicate criterion for the same `tag.id`. Pull `uiStore`
   from `useStore()` (the component already uses `useStore()` for `tagStore`). This is the
   single functional change; all plumbing already exists in `TagSelector`/`Tag`.

2. **Add a scoped pointer-cursor affordance.** Give the inspector's `TagSelector`/`Tag`
   labels a `cursor: pointer` only within the inspector tag context (e.g. via an existing
   inspector/`#inspector` SCSS scope or a class on the `FileTags` `TagSelector`), so the
   chips look clickable without affecting Searchbar/AdvancedSearch chips.

The two SlideMode side effects from Blast Radius #5 are **acceptable existing behavior**
and require no new code: when the viewer is already in a query view the viewer persists;
when opened from all-content the first criterion intentionally drops to the grid (the
file list is now filtered — consistent with how every other "add to search" entry point
behaves). These are documented here so QA expects them rather than reporting them as
regressions.

### Expected Outcomes

- Clicking an assigned tag's label in the viewer appends that tag to the search filters;
  the search bar shows the new criterion and the gallery/result set narrows accordingly.
- Re-clicking the same tag does not create a duplicate criterion.
- The remove "X" and right-click context menu behave exactly as before.
- No other `TagSelector` consumer (Searchbar, AdvancedSearch, FileTagEditor) changes.

### Risks and Tradeoffs

- **Dropping to the grid when filtering from all-content.** Mode-dependent and expected;
  documented for QA. If product later wants the viewer to persist across this flip, that
  is a separate change to `setContentQuery`/`disableSlideMode` and out of scope here.
- **Discoverability.** Without the cursor affordance the feature is invisible; the scoped
  SCSS change mitigates this. Low risk.

---

## Game Documentation Updates

- [x] No updates needed
