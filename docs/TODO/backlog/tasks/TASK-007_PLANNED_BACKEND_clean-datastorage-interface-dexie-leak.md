---
id: TASK-007
title: 'Remove Dexie type leak from DataStorage interface'
investigation: INV-002
status: planned
priority: high
blocked_by: []
date_created: 2026-04-04
date_completed:
files:
  - 'src/api/data-storage.ts'
  - 'src/backend/backend.ts'
  - 'src/frontend/stores/LocationStore.ts'
---

## What

Remove the `IndexableType` import from Dexie in the `DataStorage` interface (`src/api/data-storage.ts`). Replace it with a union type `string | number | Date` that covers all actual usage. This decouples the public API contract from the Dexie implementation, which is a prerequisite for swapping to SQLite.

## Why

The `DataStorage` interface is the abstraction boundary between the backend and frontend. It currently imports `IndexableType` from `dexie` at line 1, which means any alternative backend implementation must also depend on Dexie's type definitions. This is the only Dexie leak in the interface.

See [INV-002](../investigations/INV-002_HIGH_BACKEND_sqlite-migration-and-portable-mode.md).

## Implementation Steps

- [ ] 1. In `src/api/data-storage.ts`, remove the `import { IndexableType } from 'dexie'` statement at line 1. Define a local type alias: `type IndexableValue = string | number | Date;`. Update the `fetchFilesByKey` signature to use `IndexableValue` instead of `IndexableType`.
- [ ] 2. In `src/backend/backend.ts`, update the `fetchFilesByKey` method signature to accept `string | number | Date` (or import the new type from data-storage). The internal Dexie call accepts these types natively, so no logic change is needed.
- [ ] 3. Verify the single call site in `src/frontend/stores/LocationStore.ts:496` (`fetchFilesByKey('ino', fileStats.ino)`) -- `fileStats.ino` is a `string`, which satisfies the new type.
- [ ] 4. Run `yarn lint` and `yarn test` to confirm no type errors.

## Done When

- [ ] `src/api/data-storage.ts` has zero imports from `dexie`
- [ ] `fetchFilesByKey` accepts `string | number | Date` instead of `IndexableType`
- [ ] All existing call sites compile without changes
- [ ] `yarn lint` passes
