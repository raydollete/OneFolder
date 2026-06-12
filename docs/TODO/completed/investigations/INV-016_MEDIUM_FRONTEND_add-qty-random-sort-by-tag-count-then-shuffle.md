---
id: INV-016
title: "Add a 'Qty Random' sort that orders files by ascending tag count, then randomizes files that share the same tag count"
reported_bug: "Feature request: add an additional sort method called 'Qty Random' which first sorts by quantity of tags in ascending order, and then randomizes anything that has the same number of tags."
date: 2026-06-08
status: resolved # active | tasks-created | superseded | resolved
superseded_by:
tasks_spawned: [TASK-066, TASK-067, TASK-068]
root_cause_category: architectural-shortcoming
affects:
  - 'OrderBy<T> sort-key type (src/api/data-storage-search.ts:1-5) — the sort union is keyof FileDTO | "random"; a tag-count sort is neither a column key nor "random", so the type must be widened to admit a new sentinel value'
  - 'SQLite backend fetchFiles + searchFiles (src/backend/sqlite-backend.ts:464-478, 516-541) — both interpolate ORDER BY f.${order}; tag count is an aggregate over the file_tags join, not an f.* column, so both need a dedicated ORDER BY branch'
  - 'Dexie backend fetchFiles + searchFiles (src/backend/backend.ts:142-156, 180-203) — deprecated but still live for unmigrated users; tags is an array field so orderBy("tags")/sortBy("tags") cannot express a count, needs a custom JS comparator + tie shuffle'
  - 'Sort menu UI (src/frontend/containers/AppToolbar/Menus.tsx:62-98) — sortMenuData drives the radio menu; new entry needed with hideDirection:true (direction is fixed)'
  - 'FileStore order persistence + flow (src/frontend/stores/FileStore.ts:50,77-78,1161-1182,1413-1419) — orderBy is persisted to localStorage and passed verbatim to the backend; the new sentinel flows through transparently, OrderDirection is irrelevant for this mode'
  - 'ListGallery column-header sort indicator (src/frontend/containers/ContentView/ListGallery.tsx:221) — isSortedBy compares orderBy to a column sortKey; the new sentinel matches no column, so no list-view header highlights — correct, but worth confirming no crash'
---

## Bug Report

### Observed Behavior

OneFolder currently exposes a fixed set of sort modes in the Sort menu
(`Name`, `File type`, `File size`, `Date added`, `Date modified`,
`Date created`, `Random`). There is no way to sort the gallery by how many
tags each file has, and no way to combine "fewest tags first" with a random
shuffle of files that are tied on tag count.

### Expected Behavior

Add a new sort method named **"Qty Random"** to the Sort menu. When selected
it must:

1. **Primary key:** sort all files by the *quantity of tags* each file has, in
   **ascending** order (files with the fewest tags first; untagged files —
   tag count 0 — appear first).
2. **Tie-break:** among files that have the *same* tag count, randomize their
   relative order.

This is intended to surface under-tagged files first (so the user can
prioritise tagging them) while still presenting a fresh shuffle within each
tag-count bucket on each fetch, consistent with how the existing `Random`
sort reshuffles on every fetch (see INV-011).

### Reproduction Context

Not a defect — a feature request. Deterministic to add. Must work in:

- Both backends: SQLite (`sqlite-backend.ts`, the current default after the
  SQLite migration) and the deprecated Dexie backend (`backend.ts`, still
  live for users who have not migrated).
- Both fetch entry points: unfiltered browsing (`fetchFiles`, used by
  `fetchAllFiles` / `fetchMissingFiles` / `fetchDuplicatesFiles`) and
  filtered/search views (`searchFiles`, used by `fetchFilesByQuery` and the
  Untagged selector).
- All content modes (All / Untagged / Query / Duplicates / Missing) since
  every fetcher passes `this.orderBy` straight through.

---

## Root Cause Analysis

**Category:** architectural-shortcoming

This is a feature addition, but it surfaces a genuine architectural
constraint: the sort abstraction (`OrderBy<T>`) was modelled as "a column key
OR the special string `random`". Tag count is neither — it is an *aggregate*
over a one-to-many relationship (`file_tags` junction in SQLite, the `tags:
ID[]` array in the DTO / Dexie). The existing sort plumbing has exactly one
escape hatch from "sort by a real column" (the `'random'` sentinel), and the
new sort needs a *second* such escape hatch. So the change is structurally the
same as how `'random'` was added: widen the type, then add a branch in each
backend's `ORDER BY` construction and in the menu.

### Diagnosis

The sort key travels through three layers, and the new mode needs a hook in
each:

1. **Type layer — `src/api/data-storage-search.ts:1-5`:**
   ```ts
   export type OrderBy<T> =
     | { [K in keyof T]: K extends string ? K : never }[keyof T]
     | 'random';
   ```
   `'random'` is hard-coded as the one non-column sort. The new mode needs a
   second literal in this union (proposed: `'tagCountRandom'`). Without it,
   TypeScript rejects `fileStore.orderBy = 'tagCountRandom'` and the menu
   entry won't type-check.

2. **Backend layer — `ORDER BY` construction:**
   - **SQLite (`src/backend/sqlite-backend.ts`):** `fetchFiles`
     (464-478) and `searchFiles` (516-541) both special-case `order ===
     'random'` (→ `ORDER BY RANDOM()`) and otherwise interpolate
     `ORDER BY f.${order} ${direction}`. Crucially, the shared `FILE_SELECT`
     fragment already `LEFT JOIN file_tags ft ON f.id = ft.fileId` and every
     query uses `FILE_GROUP_BY = 'GROUP BY f.id'`. That means the tag count
     per file is already available as `COUNT(ft.tagId)` in the aggregate — no
     schema change, no new join. The new branch is:
     ```sql
     ... GROUP BY f.id ORDER BY COUNT(ft.tagId) ASC, RANDOM()
     ```
     `COUNT(ft.tagId)` (not `COUNT(*)`) correctly yields 0 for files with no
     tag rows, because the LEFT JOIN produces a single NULL `ft.tagId` row for
     untagged files and `COUNT` ignores NULLs. This is the key correctness
     detail. The `RANDOM()` secondary key provides the within-bucket shuffle
     and re-rolls on every fetch (matching `'random'` semantics).
   - **Dexie (`src/backend/backend.ts`):** `fetchFiles` (142-156) and
     `searchFiles` (180-203) special-case `'random'` via `shuffleArray(...)`
     and otherwise call `orderBy(order)` / `sortBy(order)`. `tags` is an
     array on the DTO, so neither Dexie sort can express "by length." The new
     branch must materialise the array, then sort with a JS comparator: first
     `shuffleArray()` the whole list (to randomise ties cheaply and
     uniformly), then a **stable** sort by `a.tags.length - b.tags.length`.
     Because JS `Array.prototype.sort` is stable (ES2019+), shuffling first
     and then stably sorting by tag count yields ascending tag count with a
     uniformly random order preserved *within* each equal-count run — exactly
     the spec. (Sorting first and shuffling buckets would also work but is
     more code.)

3. **UI layer — `src/frontend/containers/AppToolbar/Menus.tsx:62-98`:**
   `sortMenuData` is the single source of menu entries. A new row
   `{ prop: 'tagCountRandom', icon: ..., text: 'Qty Random', hideDirection:
   true }` is required. `hideDirection: true` mirrors `'random'`: the
   ascending-by-count direction is fixed and the up/down arrow accelerator
   must be suppressed, so toggling direction is meaningless. The existing
   `onClick` handler `orderBy === prop ? switchOrderDirection() :
   orderFilesBy(prop)` would, on a re-click, call `switchOrderDirection()`
   even for `'random'` today — that flips `orderDirection` (which the backend
   ignores for these modes) and harmlessly re-fetches (re-shuffling). For
   `'tagCountRandom'` a re-click likewise should simply re-fetch (re-roll the
   within-bucket shuffle). See Behavioral Specifications for the exact desired
   re-click semantics.

No changes are needed in `FileStore` beyond the type widening flowing through:
`orderBy` is typed `OrderBy<FileDTO>` (line 78), persisted (50, 1176-1182),
recovered (1161-1174), and passed verbatim to `backend.fetchFiles` /
`backend.searchFiles`. The sentinel rides through transparently — the same way
`'random'` already does.

### Diagnostic Questions Considered

- **Wrong mental model?** No. The request is well-specified.
- **Architectural shortcoming?** Yes — the `OrderBy<T>` union only had one
  non-column escape hatch (`'random'`). Adding tag-count sort means adding a
  second. The plumbing is fundamentally extensible (the `'random'` precedent
  proves it), it just hasn't been generalised — each new non-column sort is a
  manual addition in the type + both backends + menu.
- **Incorrect order of operations?** N/A (new feature). But the *correct*
  order-of-operations for the Dexie path is load-time concern: shuffle FIRST,
  then stable-sort by count — getting this backwards produces deterministic
  within-bucket order.
- **Missing edge case?** Two to handle: (a) untagged files (count 0) — must
  use `COUNT(ft.tagId)` not `COUNT(*)` in SQLite so the LEFT JOIN NULL row
  counts as 0; (b) `searchFiles` with the Untagged criterion — all results
  have count 0, so the whole result set becomes one shuffled bucket (still
  correct).
- **Wrong abstraction?** Mild. A fully general solution would model sorts as
  `{ key, kind: 'column' | 'random' | 'aggregate', aggregate?: ... }`. That is
  larger than warranted; following the `'random'` sentinel precedent keeps the
  change minimal and consistent with existing code. Flagged as future cleanup,
  not done here.
- **Silent failure?** Risk if the SQLite `ORDER BY` is built by naive string
  interpolation: `ORDER BY f.tagCountRandom` would be a SQL error (no such
  column). The branch MUST be added before the generic
  `ORDER BY f.${order}` path, exactly as `'random'` is.

---

## Blast Radius

1. **`OrderBy<T>` type (`src/api/data-storage-search.ts:1-5`).** Must admit
   the new sentinel. Every consumer of `OrderBy<FileDTO>` (FileStore,
   both backends, the menu, LocationStore's `fetchFiles('id', ...)` calls,
   the data-storage interface) type-checks against this union. Widening it is
   backward-compatible — existing call sites are unaffected.

2. **SQLite `fetchFiles` (`sqlite-backend.ts:464-478`).** New `ORDER BY
   COUNT(ft.tagId) ASC, RANDOM()` branch, placed alongside the `'random'`
   branch, before the generic `f.${order}` interpolation.

3. **SQLite `searchFiles` (`sqlite-backend.ts:516-541`).** Same new branch.
   The `WHERE ${whereFragment}` + existing `GROUP BY f.id` compose cleanly
   with the aggregate ORDER BY (the array criteria use EXISTS subqueries, so
   they do not interfere with `COUNT(ft.tagId)`).

4. **Dexie `fetchFiles` (`backend.ts:142-156`).** New branch: load all,
   `shuffleArray`, then stable sort by `tags.length` ascending.

5. **Dexie `searchFiles` (`backend.ts:180-203`).** Same new branch applied to
   the filtered collection's `toArray()`.

6. **Sort menu (`Menus.tsx:62-98`).** New `sortMenuData` entry "Qty Random"
   with `hideDirection: true`. Pick an icon (e.g. `IconSet.TAG` or
   `IconSet.RELOAD_COMPACT`).

7. **`ListGallery` header sort indicator (`ListGallery.tsx:221`).** `isSortedBy
   = fileStore.orderBy === sortKey` — the new sentinel equals no column
   `sortKey`, so no list-view column header shows the active-sort caret while
   "Qty Random" is selected. This is acceptable (same as `'random'` today,
   which also highlights no column). Confirm no crash / no console error.

8. **Persistence & recovery (`FileStore.ts:1161-1182`).** `orderBy:
   'tagCountRandom'` round-trips through localStorage like any other value.
   No migration needed; an unknown persisted value would simply be passed to
   the backend, so forward/backward compatibility is automatic. (A user who
   downgrades after selecting it would hit the generic `f.${order}` path and
   get a SQL error — but downgrade-after-feature is out of scope and matches
   how `'random'` behaves on very old builds.)

9. **INV-015 in-place-splice delete path (`FileStore.removeFilesFromListInPlace`).**
   No change needed, but worth noting the synergy: because deletes now splice
   in place and never refetch (INV-015 / TASK-063), deleting a file under
   "Qty Random" will NOT re-roll the shuffle or re-bucket — the visible order
   is preserved exactly like under `'random'`. The new sort inherits the
   correct delete UX for free.

Items 1–6 are the implementation. Item 7 is a verification point. Items 8–9
are "no work, confirm behavior."

---

## UX / Requirements Specification

### Purpose

Let the user sort the gallery to surface their least-tagged files first
(tagging-triage workflow) while keeping a fresh random order within each
tag-count bucket, so repeated passes don't always present the same files in
the same order.

### User-Stated Design Decisions

1. **Sort name is "Qty Random."** — Use this exact label in the menu.
2. **Primary sort: quantity of tags, ascending.** — Fewest tags first;
   untagged (0 tags) first.
3. **Secondary sort: randomize within equal tag counts.** — Files tied on tag
   count appear in random relative order, re-rolled each fetch (consistent
   with the existing `Random` mode per INV-011's "reshuffle on every fetch is
   intentional").

### Behavioral Specifications

- **Menu entry:** "Qty Random" appears in the Sort radio group, after
  "Random" (or grouped near it, since both are non-column sorts). It is
  `hideDirection: true` — no up/down arrow accelerator; the direction is fixed
  (ascending by count).
- **Selecting it:** clicking "Qty Random" when a different sort is active calls
  `orderFilesBy('tagCountRandom')` → `refetch()` → the active fetcher passes
  `'tagCountRandom'` to the backend → results come back ordered by ascending
  tag count, shuffled within each count.
- **Re-clicking it while already active:** must re-fetch and re-roll the
  within-bucket shuffle (a fresh shuffle of tied files), and must NOT invert
  to descending. Two acceptable implementations:
  (a) Suppress `switchOrderDirection()` for this prop in the `onClick`
  handler and call `orderFilesBy('tagCountRandom')` again to force a re-fetch;
  or (b) let `switchOrderDirection()` run — it flips `orderDirection` (ignored
  by the backend for this mode) and re-fetches anyway, producing a re-roll.
  **Prefer (a) for clarity**, mirroring intent that direction is meaningless
  here. (Note `'random'` today uses path (b) — re-clicking Random flips an
  ignored direction and re-shuffles. Either is acceptable; (a) is cleaner.)
- **Untagged view:** when the Untagged content selector is active and the user
  picks "Qty Random," every result has 0 tags, so the entire result set is one
  shuffled bucket. Correct and harmless.
- **Empty library:** no files → empty gallery, no error.
- **Direction toggle does nothing visible:** because the backend ignores
  `OrderDirection` for this mode (the `ORDER BY` is hard-coded ascending +
  RANDOM()).

### Explicit Rejections

- **Do not add a separate "ascending vs descending tag count" pair.** The
  request is specifically ascending-with-random-ties. A descending variant is
  not requested; do not build it speculatively.
- **Do not change the existing `Random` sort.** "Qty Random" is additive.
- **Do not introduce a `tags` column on the files table or denormalise a
  tag-count column.** The `COUNT(ft.tagId)` aggregate over the existing
  `file_tags` join is sufficient and avoids schema migration / write-path
  bookkeeping to keep a cached count in sync.
- **Do not add a seeded / stable-across-fetch shuffle.** Within-bucket order
  re-rolls per fetch, exactly like the existing `Random` mode (INV-011
  rejected seeded shuffles as out of scope; the same applies here).
- **Do not generalise `OrderBy<T>` into a structured `{key, kind}` object in
  this change.** Follow the `'random'` sentinel precedent to keep the diff
  minimal; structured-sort refactor is a separate future task.

---

## Holistic Solution

### Approach

Three tasks, mirroring how `'random'` is already threaded through the codebase.

1. **TASK-066 — Type + both backends (the engine).**
   - Widen `OrderBy<T>` in `src/api/data-storage-search.ts` to
     `| 'random' | 'tagCountRandom'`.
   - SQLite `fetchFiles` and `searchFiles`: add a branch
     `order === 'tagCountRandom'` →
     `... GROUP BY f.id ORDER BY COUNT(ft.tagId) ASC, RANDOM()`
     (for `searchFiles`, with the `WHERE ${whereFragment}` retained). Place it
     before the generic `f.${order}` path so the bogus column name is never
     interpolated.
   - Dexie `fetchFiles` and `searchFiles`: add a branch that loads the array,
     `shuffleArray()`s it, then stable-sorts by `(a, b) => a.tags.length -
     b.tags.length`.
   - Keep `OrderDirection` ignored for this mode in both backends (do not
     reverse).

2. **TASK-067 — Sort menu entry (the UI).**
   - Add `{ prop: 'tagCountRandom', icon: <chosen icon>, text: 'Qty Random',
     hideDirection: true }` to `sortMenuData` in `Menus.tsx`.
   - Adjust the `onClick` so a re-click on the active "Qty Random" item
     re-fetches (re-rolls) rather than toggling direction — recommended
     option (a): `onClick={() => orderBy === prop && !hideDirection ?
     switchOrderDirection() : orderFilesBy(prop)}` (so any `hideDirection`
     item, including `random`, always re-fetches on re-click instead of
     flipping an ignored direction). Verify this does not regress the existing
     `Random` item (it improves it: re-clicking Random now cleanly re-shuffles
     via `orderFilesBy('random')`).

3. **TASK-068 — QA with evidence (manual).**
   - Verify in the running app on SQLite and (if reachable) Dexie:
     ascending-by-tag-count ordering, within-bucket randomisation, re-roll on
     re-select, behavior under Untagged + Query content modes, no list-view
     header crash, and that deleting under "Qty Random" preserves order
     (INV-015 splice path). Capture screenshots / console evidence per
     QA-DISCIPLINE.md.

### Expected Outcomes

- A new "Qty Random" entry in the Sort menu.
- Selecting it lists files fewest-tags-first, randomised within equal counts,
  re-rolled per fetch.
- Works identically across content modes and both backends.
- Zero schema changes; no migration.
- Deletes under the new sort preserve order (inherited from INV-015).

### Risks and Tradeoffs

- **SQLite `COUNT(*)` vs `COUNT(ft.tagId)`:** using `COUNT(*)` would count the
  single LEFT-JOIN NULL row as 1, giving untagged files a count of 1 instead
  of 0 and mis-bucketing them. Must use `COUNT(ft.tagId)`. Called out
  explicitly so the implementer doesn't reach for `COUNT(*)`.
- **Dexie shuffle-then-stable-sort ordering:** relies on `Array.prototype.sort`
  being stable (guaranteed ES2019+; the Electron/V8 runtime satisfies this).
  If the implementer sorts first then shuffles, ties become deterministic —
  wrong. The task spells out shuffle-first.
- **`switchOrderDirection` on hide-direction items:** the menu `onClick`
  tweak changes re-click behavior for the existing `Random` item too (from
  "flip ignored direction + refetch" to "refetch"). Net behavior is identical
  to the user (both re-shuffle); the change only removes a meaningless
  direction flip. Low risk, but QA should confirm `Random` re-click still
  re-shuffles.
- **List-view header indicator:** no column matches the sentinel, so no caret
  shows in list view while "Qty Random" is active. Acceptable and matches
  `'random'`. Confirm no crash.
- **Performance:** SQLite does the count + order in-engine (fast, indexed
  join). Dexie loads all rows into JS and sorts — same cost profile as the
  existing `'random'` path (which already `toArray()`s everything), so no new
  performance concern relative to status quo.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: TASK-068 (or a brief note in `docs/personal-fork-notes.md`)
      should record the addition of the "Qty Random" sort and the
      `COUNT(ft.tagId)` / shuffle-then-stable-sort implementation details, and
      cross-reference INV-011 (reshuffle-on-fetch is intentional) and INV-015
      (deletes splice in place, preserving sort order).
