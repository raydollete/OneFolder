---
id: TASK-057
title: 'Defensive empty-path validation in createLocation and the IndexedDB→SQLite + Dexie-backup migration tools'
investigation: INV-013
status: planned
priority: low
blocked_by: []
date_created: 2026-05-04
date_completed:
files:
  - src/backend/sqlite-backend.ts
  - src/backend/migration-indexeddb-to-sqlite.ts
  - scripts/convert-dexie-backup.js
---

## What

Add defense-in-depth empty-path validation on the data-storage side: `SQLiteBackend.createLocation` throws on an empty `path`, and the migration tools (`migration-indexeddb-to-sqlite.ts`, `scripts/convert-dexie-backup.js`) skip-and-warn on legacy rows with empty paths instead of silently propagating them. No SQL `CHECK` constraint is added in this task — schema migrations introduce risk that is unjustified by the symptom; the application-layer guards are sufficient.

## Why

The investigation traced the user-facing empty-name toast to a drive-root location whose `SysPath.basename` returns `''` rather than to a literal `path=''` row. However, the data layer currently has no defense against a literal empty path being persisted, and migration tools faithfully copy whatever Dexie had — so a single bad legacy row could create a permanent ghost entry in a user's library that surfaces as an empty-named, unclickable item in the sidebar (not even reachable via the broken-link recovery dialog because the broken-name UX is itself fragile). The renderer-side guards in TASK-055 step 5 + step 6 are the primary defense; the data-layer guards in this task ensure that even a malformed import or a hand-edited DB cannot silently introduce one.

See [INV-013](../investigations/INV-013_MEDIUM_FRONTEND_startup-empty-location-toast-and-fragile-watch-timeout.md) for the full blast-radius analysis.

## Implementation Steps

- [ ] 1. **`src/backend/sqlite-backend.ts:587-604` (`createLocation`) — reject empty path.** At the top of the method, before the `INSERT INTO locations` statement, add:

  ```ts
  if (!location.path || location.path.trim() === '') {
    throw new Error(`Refusing to persist location ${location.id} with empty path`);
  }
  ```

  Verification: write a unit test (or run a manual test in dev console via `rootStore['#backend'].createLocation({ id: 'x', path: '', dateAdded: new Date(), subLocations: [], index: 0 })`) and confirm it throws. The renderer-side guard from TASK-055 step 5 should prevent this code path from being reached in normal operation; this is defense in depth.

- [ ] 2. **`src/backend/migration-indexeddb-to-sqlite.ts:233-250` — skip-and-warn on empty-path location rows.** Wrap the `for (const location of locations)` loop body with a guard:

  ```ts
  let skippedEmptyPathCount = 0;
  for (const location of locations) {
    if (!location.path || (typeof location.path === 'string' && location.path.trim() === '')) {
      skippedEmptyPathCount++;
      continue;
    }
    // ... existing insertLocation.run({...}) call ...
  }
  if (skippedEmptyPathCount > 0) {
    console.warn(
      `Migration: skipped ${skippedEmptyPathCount} location row(s) with empty path during IndexedDB → SQLite migration`,
    );
  }
  ```

  Verification: hand-craft a legacy IndexedDB dump that includes one location row with `path=''` and confirm migration completes, the SQLite DB has zero empty-path rows, and the console shows the warning.

- [ ] 3. **`scripts/convert-dexie-backup.js:233` — same skip-and-warn for the offline backup converter.** Apply the same guard pattern as step 2 to the `INSERT OR IGNORE INTO locations` loop in the offline backup conversion script. Use `console.warn` (the script runs under Node and `console.warn` is fine).

  Verification: run the script against a synthetic Dexie backup containing an empty-path location row and confirm the resulting SQLite DB does not include it.

- [ ] 4. **Document the behavior change.** No `docs/` change is required, but optionally add a short comment block above each guard explaining "INV-013: defense-in-depth against empty location paths." Self-documenting code; aids future readers.

- [ ] 5. **Decide on schema constraint (deferred).** Do NOT add `CHECK (length(path) > 0)` to the `locations` table in this task. Capture the deferral in the inline comment so future maintainers see it: schema migrations have higher risk than the symptom warrants, and the application-layer guards (TASK-055 + TASK-057) provide sufficient defense in practice. If a future investigation finds another way for empty paths to enter the table, revisit.

- [ ] 6. **Lint and typecheck.** Run `yarn lint`; run `yarn build`. The migration-script edits are JavaScript so will not affect TypeScript compilation; run any existing migration tests if present.

## Done When

- [ ] `SQLiteBackend.createLocation` throws on empty or whitespace-only `path`.
- [ ] `migration-indexeddb-to-sqlite.ts` skips legacy location rows with empty `path` and logs how many were skipped.
- [ ] `scripts/convert-dexie-backup.js` does the same for offline backups.
- [ ] No SQL `CHECK` constraint is added (deliberate deferral, documented in code comment).
- [ ] A synthetic legacy DB containing one empty-path location row migrates cleanly with the row dropped and a console warning emitted.
- [ ] `yarn lint` passes; `yarn build` typecheck passes.
