---
id: TASK-068
title: "QA the 'Qty Random' sort end-to-end with captured evidence"
investigation: INV-016
status: done # planned | in-progress | blocked | done
priority: medium # critical | high | medium | low
blocked_by: [TASK-066, TASK-067]
date_created: 2026-06-08
date_completed: 2026-06-12
files:
  - src/frontend/containers/AppToolbar/Menus.tsx
  - src/backend/sqlite-backend.ts
  - src/backend/backend.ts
---

## What

Manually verify the "Qty Random" sort in the running app and capture evidence
(screenshots and/or console output) that it orders files by ascending tag
count, randomizes within equal-count buckets, re-rolls on re-select, and
behaves correctly across content modes and under delete.

## Why

INV-016 adds a new sort that touches both backends and the UI. Per
QA-DISCIPLINE.md, the feature may not be promoted out of backlog until at least
one verification step has produced concrete evidence captured by the human QA
executor.

See [INV-016](../investigations/INV-016_MEDIUM_FRONTEND_add-qty-random-sort-by-tag-count-then-shuffle.md).

## Automated Verification Results

Performed by the implementation agent prior to handing off to human QA:

- **Lint (yarn lint):** 52 errors before changes, 52 errors after — zero new errors introduced. No errors in any of the four changed files (`data-storage-search.ts`, `sqlite-backend.ts`, `backend.ts`, `Menus.tsx`).
- **Tests (yarn test):** 80 pass, 1 fail before changes; 80 pass, 1 fail after changes. The failing test (`TagStore › insertSubTag › should insert a tag to an indirect parent`) is pre-existing and unrelated to this feature.
- **Type widening:** `OrderBy<T>` now admits `'tagCountRandom'`. The sentinel is purely additive — no existing call sites break.
- **onClick logic review:** `orderBy === prop && !hideDirection` correctly routes re-clicks:
  - `hideDirection` items (Random, Qty Random): `!hideDirection` is false → `orderFilesBy(prop)` called → re-fetch/re-roll.
  - Column sort items (`hideDirection` is `undefined`/falsy): `!hideDirection` is true → `switchOrderDirection()` called → same as before.

## QA Result (2026-06-12)

The human QA executor (Ray) confirmed on 2026-06-12 that INV-016 was manually
tested in the running app and works as specified. The individual checkboxes
below are left unticked because no captured artifacts (screenshots/clips) were
attached to this file; the user's direct attestation in-session is the
recorded evidence of completion, consistent with how TASK-064 was closed.

## Implementation Steps

> Every step below is `REQUIRES MANUAL EXECUTION`. Automated agents may not
> tick these boxes; the human QA executor checks them after performing the
> step and attaching evidence (screenshot, log line, or clip) to or from this
> file.

- [ ] 1. **Build and launch.** `yarn dev` + `yarn start` (or the portable
      build). Confirm the app opens against a library that contains files with
      a VARIETY of tag counts (some untagged, some with 1 tag, some with
      several). REQUIRES MANUAL EXECUTION.

- [ ] 2. **Menu entry present.** Open the Sort menu. Confirm "Qty Random"
      appears with the tag icon and no up/down direction arrow. Screenshot.
      REQUIRES MANUAL EXECUTION.

- [ ] 3. **Ascending tag-count order (All content).** Select "Qty Random."
      Confirm untagged files (0 tags) appear first, then 1-tag files, then
      higher counts — verify by inspecting the tag chips on the first vs. last
      thumbnails (or via the inspector panel). Screenshot the start (untagged
      cluster) and a later region (higher counts). REQUIRES MANUAL EXECUTION.

- [ ] 4. **Within-bucket randomization + re-roll.** Note the order of several
      files that share the same tag count. Re-select "Qty Random" (click it
      again). Confirm the relative order of same-count files changes (re-roll)
      while the ascending-by-count bucketing is preserved. Screenshot
      before/after. REQUIRES MANUAL EXECUTION.

- [ ] 5. **Untagged content mode.** Switch the Outliner to "Untagged," then
      "Qty Random." Confirm the view shows all untagged files (single 0-count
      bucket) shuffled, with no error. Screenshot / console. REQUIRES MANUAL
      EXECUTION.

- [ ] 6. **Query / search mode.** Run a tag search (Query content), apply
      "Qty Random," confirm results are ordered fewest-tags-first within the
      filtered set with random ties. Screenshot. REQUIRES MANUAL EXECUTION.

- [ ] 7. **List view header.** Switch to List gallery view while "Qty Random"
      is active. Confirm no crash and no console error (no column header shows
      an active-sort caret — expected). Screenshot console. REQUIRES MANUAL
      EXECUTION.

- [ ] 8. **Delete preserves order (INV-015 synergy).** Under "Qty Random,"
      open a file in SlideMode and delete it. Confirm SlideMode auto-advances
      and the gallery order does NOT re-roll/re-bucket (the in-place splice
      from INV-015 preserves order). Screenshot / clip. REQUIRES MANUAL
      EXECUTION.

- [ ] 9. **Backend coverage note.** Record which backend was exercised
      (SQLite is the default). If a pre-migration Dexie library is reachable,
      repeat steps 3-4 there; otherwise note that Dexie was covered by code
      review only. REQUIRES MANUAL EXECUTION.

## Done When

- [ ] At least steps 2, 3, and 4 have attached evidence demonstrating the
      menu entry, ascending tag-count order, and within-bucket re-roll.
- [ ] No console errors observed in any tested content mode or in list view.
- [ ] Delete-under-Qty-Random preserves order (step 8) confirmed.
- [ ] Backend coverage recorded (step 9).
