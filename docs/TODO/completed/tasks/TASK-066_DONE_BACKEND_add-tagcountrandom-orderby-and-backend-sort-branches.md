---
id: TASK-066
title: "Add 'tagCountRandom' sort sentinel to OrderBy and implement the ascending-tag-count + within-bucket-shuffle branch in both backends"
investigation: INV-016
status: done # planned | in-progress | blocked | done
priority: medium # critical | high | medium | low
blocked_by: []
date_created: 2026-06-08
date_completed: 2026-06-08
files:
  - src/api/data-storage-search.ts
  - src/backend/sqlite-backend.ts
  - src/backend/backend.ts
---

## What

Add a new non-column sort sentinel `'tagCountRandom'` to the `OrderBy<T>`
union and implement it in both data backends. The sort orders files by tag
count ascending (fewest tags first, untagged files first) and randomizes the
order of files that share the same tag count. This is the engine half of the
"Qty Random" feature; the menu wiring is TASK-067.

## Why

The `OrderBy<T>` type only models "a column key OR `'random'`". Tag count is
an aggregate over the `file_tags` relationship, not a column, so it needs a
second sentinel and a dedicated `ORDER BY` branch in each backend — the same
pattern by which `'random'` was added.

See [INV-016](../investigations/INV-016_MEDIUM_FRONTEND_add-qty-random-sort-by-tag-count-then-shuffle.md).

## Implementation Steps

- [x] 1. **Widen the sort type.** In `src/api/data-storage-search.ts`, change
      the `OrderBy<T>` union (lines 1-5) to append the new literal:
      ```ts
      export type OrderBy<T> =
        | { [K in keyof T]: K extends string ? K : never }[keyof T]
        | 'random'
        | 'tagCountRandom';
      ```
      Verify the project still type-checks (`yarn lint` / `tsc`); this is a
      pure widening so no existing call site should break.

- [x] 2. **SQLite `fetchFiles`.** In `src/backend/sqlite-backend.ts`
      (`fetchFiles`, ~lines 464-478), add a branch BEFORE the generic
      `ORDER BY f.${order}` interpolation, alongside the existing
      `order === 'random'` branch:
      ```ts
      if (order === 'tagCountRandom') {
        const rows = this.#db
          .prepare(`${FILE_SELECT} ${FILE_GROUP_BY} ORDER BY COUNT(ft.tagId) ASC, RANDOM()`)
          .all() as FileRow[];
        return rows.map(fileRowToDTO);
      }
      ```
      Use `COUNT(ft.tagId)` (NOT `COUNT(*)`) so untagged files — which produce
      a single NULL `ft.tagId` row from the existing `LEFT JOIN file_tags` —
      count as 0 and sort first. Do not honor `fileOrder` for this branch.

- [x] 3. **SQLite `searchFiles`.** In the same file (`searchFiles`, ~lines
      516-541), add a parallel branch in the `sql` selection, before the
      generic `f.${order}` path:
      ```ts
      if (order === 'tagCountRandom') {
        sql = `${FILE_SELECT} WHERE ${whereFragment} ${FILE_GROUP_BY} ORDER BY COUNT(ft.tagId) ASC, RANDOM()`;
      } else if (order === 'random') {
        sql = `${FILE_SELECT} WHERE ${whereFragment} ${FILE_GROUP_BY} ORDER BY RANDOM()`;
      } else {
        const direction = fileOrder === OrderDirection.Desc ? 'DESC' : 'ASC';
        sql = `${FILE_SELECT} WHERE ${whereFragment} ${FILE_GROUP_BY} ORDER BY f.${order} ${direction}`;
      }
      ```
      The existing `WHERE` clauses use EXISTS subqueries on `file_tags`, so
      they compose cleanly with the `COUNT(ft.tagId)` aggregate and the
      existing `GROUP BY f.id`.

- [x] 4. **Dexie `fetchFiles`.** In `src/backend/backend.ts` (`fetchFiles`,
      ~lines 142-156), add a branch alongside `order === 'random'`:
      ```ts
      if (order === 'tagCountRandom') {
        const all = await this.#files.toArray();
        shuffleArray(all); // randomize ties first
        all.sort((a, b) => a.tags.length - b.tags.length); // stable sort keeps shuffle within equal counts
        return all;
      }
      ```
      Order matters: shuffle FIRST, then stable-sort by `tags.length` ascending.
      `Array.prototype.sort` is stable (ES2019+), so equal-count runs preserve
      the random order. Do not honor `fileOrder` for this branch.

- [x] 5. **Dexie `searchFiles`.** In the same file (`searchFiles`, ~lines
      180-203), add the equivalent branch on the filtered collection:
      ```ts
      if (order === 'tagCountRandom') {
        const all = await collection.toArray();
        shuffleArray(all);
        all.sort((a, b) => a.tags.length - b.tags.length);
        return all;
      }
      ```

- [x] 6. **Confirm `shuffleArray` is in scope.** It is already imported in
      `backend.ts` from `../../common/core` (used by the `'random'` branches).
      No new import needed.

## Done When

- [x] `OrderBy<FileDTO>` accepts `'tagCountRandom'` and the project type-checks.
- [x] SQLite `fetchFiles` and `searchFiles` return files ordered by ascending
      `COUNT(ft.tagId)` with `RANDOM()` tie-break when `order ===
      'tagCountRandom'`; untagged files (count 0) sort first.
- [x] Dexie `fetchFiles` and `searchFiles` return files ordered by ascending
      `tags.length` with a uniformly random order within each equal-count
      group when `order === 'tagCountRandom'`.
- [x] Neither backend reverses or otherwise honors `OrderDirection` for this
      mode.
- [x] No regression to the existing `'random'` or column-sort branches (pre-existing test failure confirmed unrelated; no lint errors in changed files).
