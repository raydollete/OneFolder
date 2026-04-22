---
id: TASK-017
title: 'Add automated tests for multi-library infrastructure (LibraryRegistry, namespaced storage key helpers, and renderer migration)'
investigation: INV-001
status: done
priority: high
blocked_by: []
date_created: 2026-04-21
date_completed: 2026-04-21
files:
  - 'tests/library-registry.test.ts (new)'
  - 'tests/storage-key-helpers.test.ts (new)'
  - 'tests/renderer-migration.test.ts (new)'
  - 'common/library-registry.ts (read-only reference)'
  - 'src/frontend/stores/UiStore.ts (read-only reference)'
  - 'src/frontend/stores/FileStore.ts (read-only reference)'
  - 'src/renderer.tsx (read-only reference — extraction may be required, see step 3)'
---

## What

Add Jest test coverage for the multi-library infrastructure introduced by INV-001 (TASK-001 through TASK-006). All six tasks shipped without automated tests; the task-closer QA review flagged this as a cross-cutting gap. Three new test files are required, landing in the existing `tests/` directory alongside `backend.test.ts`, `tag-store.test.ts`, and `utils.test.ts`.

Scope is limited to the three surfaces the QA review identified:

1. `LibraryRegistry` in `common/library-registry.ts` — full CRUD round-trip plus `libraries.json` / `active-library.json` persistence semantics.
2. Storage key helpers — `getSqliteDbPath`, `getPreferencesStorageKey`, `getFileStorageKey` — behavior across `undefined`, empty string, and UUID inputs.
3. `migrateToMultiLibraryLayout()` in `src/renderer.tsx` — idempotency, WAL/SHM sidecar handling, localStorage key migration (all four keys), and backup directory move.

Do NOT expand into testing surfaces unrelated to INV-001 (e.g., SQLite backend, backup scheduler, portable mode detection — those are INV-002 concerns).

## Why

The task-closer agent found that zero automated tests were added for any of the new infrastructure under INV-001. Because the registry, namespaced storage, and migration all run at startup on every user's machine, regressions here silently break data access for every library on disk. Locking in round-trip and idempotency guarantees now prevents future refactors from re-introducing the kind of bugs this investigation was created to fix.

See [INV-001](../investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md).

## Test Framework and Conventions (reference)

Before writing, confirm the conventions already in use in this repo:

- **Framework:** Jest 29 with `ts-jest` preset (`jest.config.js`).
- **Test environment:** `node` — `localStorage`, `window`, and other browser globals are NOT available. Tests that need `localStorage` must install a polyfill inside the test file (see step 2 below).
- **Test location:** Flat `tests/` directory at the repo root (NOT co-located `*.test.ts`). Existing examples: `tests/backend.test.ts`, `tests/tag-store.test.ts`, `tests/utils.test.ts`, `tests/virtualized-renderer.test.ts`.
- **Global setup:** `tests/setup/jest.crypto.js` polyfills `global.crypto.randomUUID()` by delegating to Node's `crypto` module. `fake-indexeddb/auto` is registered for IndexedDB tests but is irrelevant to these three files.
- **No existing `fs-extra` or `localStorage` mocking conventions:** this task establishes them. Prefer real filesystem I/O against `os.tmpdir()` + `crypto.randomUUID()`-scoped directories (cleaned up in `afterEach`) over mocking `fs-extra`, so that we test the real serialization path. Use an in-memory `localStorage` shim for the renderer tests.
- **Run command:** `yarn test` (runs `jest`).

## Implementation Steps

Ordered by priority: registry round-trip (highest) > migration idempotency > key helpers.

- [x] 1. **Create `tests/library-registry.test.ts`** — Exercise `LibraryRegistry` end-to-end against a real temp directory. Use `beforeEach` to allocate `path.join(os.tmpdir(), 'onefolder-test-' + randomUUID())` and `fse.ensureDirSync` it; `afterEach` to `fse.removeSync` it. No mocking of `fs-extra`.

  Required test cases (group under `describe('LibraryRegistry', ...)`):

  1. **`constructor` returns empty list on a fresh base directory** — asserts `new LibraryRegistry(tmpDir).getLibraries()` returns `[]` and `getActiveLibraryId()` returns `null` when neither JSON file exists.
  2. **`createLibrary` round-trip** — creates a library with a given name, asserts the returned `LibraryDTO` has `id` (UUID format, 36 chars with hyphens), `name` equal to the input, and `createdAt` / `lastOpenedAt` that are `Date` instances within 2 seconds of `new Date()`.
  3. **`createLibrary` persists across instances** — create a library with registry A, instantiate a second registry B over the same `basePath`, assert B.getLibraries() returns the same entry with `Date` objects (NOT strings). This is the key Date (de)serialization test: serialize writes ISO strings, deserialize reconstructs `Date` instances. Assert `library.createdAt instanceof Date === true`.
  4. **`setActiveLibrary` + `getActiveLibraryId` round-trip** — set, read back, assert equality. Test across instances too (instantiate a second registry and read the active ID).
  5. **`getActiveLibraryId` returns null when the file is missing** — explicitly delete `active-library.json`, assert null.
  6. **`getActiveLibraryId` returns null when the file is malformed** — write garbage (`'not json'`) into `active-library.json`, assert null (the `try`/`catch` in the implementation swallows the error).
  7. **`renameLibrary` updates the name and persists** — create, rename, assert `getLibraries()[0].name` changes; instantiate a new registry and confirm persistence.
  8. **`renameLibrary` with an unknown ID is a no-op** — does NOT throw, does NOT add a phantom entry.
  9. **`deleteLibrary` removes the entry and persists** — create two libraries, delete one, assert the remaining list contains only the other. Confirm via a fresh registry instance.
  10. **`deleteLibrary` does NOT touch `active-library.json`** — set active to library X, delete library X, assert `active-library.json` still contains X's ID (the file is the caller's responsibility per TASK-001 docstring). This documents the current contract.
  11. **`updateLastOpened` mutates `lastOpenedAt` and persists** — capture the original timestamp, wait ~10ms, call `updateLastOpened`, assert the new timestamp is strictly greater. Confirm via a fresh registry instance.
  12. **`updateLastOpened` with unknown ID is a no-op** — does NOT throw.
  13. **`createLibrary` allows duplicate names** — create two libraries both named `'My Library'`, assert both exist with distinct IDs (matches TASK-004 step 4: "IDs are unique, names are display-only").
  14. **`libraries.json` is written with 2-space indentation** — read the file as text, assert it contains `'\n  '` (the implementation passes `{ spaces: 2 }`). This is cheap insurance against a future regression that would make the file a single giant line.

  Mocks required: none. Uses real `fs-extra` against a unique temp dir per test. `crypto.randomUUID()` is provided by the existing `tests/setup/jest.crypto.js` setup.

- [x] 2. **Create `tests/storage-key-helpers.test.ts`** — Unit-level coverage for the three module-level key helpers. These are pure functions, so no setup/teardown is required.

  Required test cases:

  **`getSqliteDbPath(basePath, libraryId)` from `common/library-registry.ts`:**
  1. With a POSIX-style basePath and a UUID libraryId, returns `{basePath}/libraries/{uuid}/onefolder.db` (use `path.join` in the assertion to remain platform-agnostic).
  2. With a Windows-style basePath (`C:\\Users\\me\\AppData`), produces a path whose segments include `libraries`, the UUID, and `onefolder.db`. Assert via `path.normalize` rather than a literal string so the test passes on both platforms.
  3. With an empty-string libraryId, returns `{basePath}/libraries//onefolder.db` (i.e., the function does NOT guard against empty strings; document the current behavior so a future refactor that adds guarding is a deliberate decision, not an accident).

  **`getPreferencesStorageKey(libraryId?)` from `src/frontend/stores/UiStore.ts`:**
  4. With `undefined`, returns exactly `'preferences'`.
  5. With no argument (equivalent to `undefined`), returns exactly `'preferences'`.
  6. With an empty-string libraryId, returns exactly `'preferences'` (because the implementation uses `libraryId ? ... : 'preferences'` — empty string is falsy). This is a documented behavior pin: the migration in `src/renderer.tsx` relies on it so that a caller who accidentally passes `''` does not create a `:preferences` orphan key.
  7. With a UUID libraryId, returns `'{uuid}:preferences'` — concrete assertion, e.g., `'1234-abcd:preferences'`.

  **`getFileStorageKey(libraryId?)` from `src/frontend/stores/FileStore.ts`:**
  8. With `undefined`, returns exactly `'OneFolder_File'`.
  9. With an empty-string libraryId, returns exactly `'OneFolder_File'` (same falsy-check rationale as step 6).
  10. With a UUID libraryId, returns `'{uuid}:OneFolder_File'`.

  Mocks required: none. Pure-function tests.

  Note: `getLocationPrefsKey` in `LocationStore.ts` is module-private (not exported). Do NOT add a test for it directly — its behavior is exercised indirectly by the migration test in step 3. If coverage of it becomes valuable later, exporting it is a separate refactor outside INV-001's scope.

- [x] 3. **Create `tests/renderer-migration.test.ts`** — Exercise `migrateToMultiLibraryLayout()` from `src/renderer.tsx`. The function is currently declared as a non-exported `async function` inside `renderer.tsx`. To test it without pulling in the full renderer (which imports React, MobX, widgets, etc.), choose one of the two approaches below:

  **Approach A (preferred):** Extract the function into a new module `src/renderer-migration.ts`, export it, and import it from `renderer.tsx`. This is a pure refactor with no behavioral change — the function already has no closure dependencies on `renderer.tsx` (it only uses `fse`, `path`, `SQLITE_DB_FILENAME`, `getSqliteDbPath`, and `localStorage`). Update the import in `renderer.tsx` accordingly. Document the extraction in the PR so reviewers can verify the function body is byte-identical.

  **Approach B (fallback if extraction is rejected):** Re-implement the same migration logic inside the test file as a local copy and test THAT. This is worse because the copy drifts from production; only fall back to this if Approach A is blocked. Flag it for follow-up.

  Once the function is reachable, install an in-memory `localStorage` polyfill at the top of the test file:

  ```typescript
  // localStorage polyfill for the node test environment
  const store = new Map<string, string>();
  (global as any).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size; },
  };
  ```

  Use a fresh temp directory per test (same pattern as step 1). Clear `localStorage` in `beforeEach` via `localStorage.clear()`.

  Required test cases (group under `describe('migrateToMultiLibraryLayout', ...)`):

  **Idempotency (highest priority for this file):**
  1. **No-op when the legacy DB does not exist** — tmpDir is empty, call migrate, assert nothing is created, nothing is thrown.
  2. **No-op when the library-scoped DB already exists** — pre-create both the legacy file AND `{tmpDir}/libraries/{libraryId}/onefolder.db`, call migrate, assert the legacy file is UNTOUCHED (the precondition guards against overwriting a good library with a stale legacy file).
  3. **Second invocation is a no-op** — run migrate once (legacy present, new absent → performs move), run migrate a second time, assert no error, assert the moved file is still at the new path and nothing else changed. This is the core idempotency guarantee called out in the INV-001 TASK-006 "Done When" list.

  **SQLite WAL/SHM sidecar handling:**
  4. **Moves `onefolder.db` alone when no sidecars exist** — pre-create `{tmpDir}/onefolder.db` with a known byte marker. Migrate. Assert the new path exists with the same marker, legacy path no longer exists, and no `-wal` / `-shm` files exist at either location.
  5. **Moves `onefolder.db` AND its `-wal` / `-shm` sidecars when they exist** — pre-create all three files with distinct byte markers. Migrate. Assert all three are present at the new location with the correct markers, and none remain at the legacy location.
  6. **Moves `onefolder.db` and only the `-wal` sidecar when `-shm` is missing** — the loop over `['-wal', '-shm']` uses `fse.pathExists` for each, so a missing one should be silently skipped. Assert no ENOENT is thrown.

  **localStorage key migration (all four keys):**
  7. **Migrates all four keys** — seed `localStorage` with entries at `'preferences'`, `'OneFolder_File'`, `'hierarchical-separator'`, and `'location-store-preferences'`. Pre-create the legacy DB file (so migration runs). Call migrate. Assert:
     - `localStorage.getItem('preferences') === null` (old key cleared)
     - `localStorage.getItem('{libraryId}:preferences')` returns the original value
     - Same assertions for the other three pairs
  8. **Leaves global keys in place** — seed `localStorage` with `'OneFolder_Window'` and `'tag-editor-height'` (which TASK-006 step 4 explicitly keeps global). Migrate. Assert both keys still exist with their original values under the bare names.
  9. **Does NOT overwrite an existing namespaced key** — seed both `'preferences'` (with value `'old'`) and `'{libraryId}:preferences'` (with value `'new'`). Document the current behavior: the implementation unconditionally calls `setItem(newKey, value); removeItem(oldKey);`, so `'new'` WILL be overwritten by `'old'`. If the test reveals this is undesirable, flag it in the test as a `TODO:` with a reference back to this task; do NOT silently fix it here (a fix would change observable behavior and requires its own investigation).
  10. **No-op when none of the legacy keys are present** — seed nothing, migrate, assert no namespaced keys are created.

  **Backup directory move:**
  11. **Moves `{userData}/backups/` to `{userData}/libraries/{libraryId}/backups/` when the legacy dir exists** — pre-create `{tmpDir}/backups/snapshot.db` with a known marker (and the legacy DB file to trigger migration). Migrate. Assert the file is at the new location with the correct marker and the old `backups/` dir no longer exists.
  12. **Skips the backup move when the legacy dir does not exist** — pre-create only the legacy DB file. Migrate. Assert `{tmpDir}/backups/` is not created and no error is thrown.
  13. **Skips the backup move when the new backup dir already exists** — pre-create the legacy DB, legacy `backups/snapshot.db`, AND an empty `{tmpDir}/libraries/{libraryId}/backups/` dir. Migrate. Assert the legacy `backups/` is left alone (the implementation's guard: `if (exists(old) && !exists(new))`). This prevents clobbering an already-migrated library's backups if a stale legacy dir somehow reappears.

  **Integration sanity check:**
  14. **Full migration leaves the expected on-disk layout** — seed legacy DB + `-wal` + `-shm` + `backups/snapshot.db` + all four localStorage keys. Migrate. Walk the tmpDir and assert:
     - `{tmpDir}/onefolder.db` does NOT exist
     - `{tmpDir}/onefolder.db-wal` does NOT exist
     - `{tmpDir}/onefolder.db-shm` does NOT exist
     - `{tmpDir}/backups/` does NOT exist
     - `{tmpDir}/libraries/{libraryId}/onefolder.db` EXISTS with correct marker
     - `{tmpDir}/libraries/{libraryId}/onefolder.db-wal` EXISTS
     - `{tmpDir}/libraries/{libraryId}/onefolder.db-shm` EXISTS
     - `{tmpDir}/libraries/{libraryId}/backups/snapshot.db` EXISTS with correct marker
     - All four namespaced localStorage keys are populated; bare keys are gone

  Mocks required: only the `localStorage` polyfill shown above. Use real `fs-extra` against a temp directory. Do NOT mock Electron `app.getPath` — the function under test takes `userDataPath` as an argument, so the tmpDir is passed directly.

- [x] 4. **Verify tests pass** — All 3 new test files pass (14+10+14=38 tests). Previously passing suites (utils, backend, virtualized-renderer) continue to pass. tag-store.test.ts was already failing before this task (suite-level "Cannot find module 'widgets/button'" with 0 tests run). The moduleNameMapper additions in jest.config.js now allow it to load, exposing a pre-existing runtime failure in 1 test (TagStore.insertSubTag.indirect parent). The 12 other tag-store tests now pass. Approach A extraction confirmed: yarn dev compiles cleanly. — Run `yarn test` from the repo root. All three new files should pass with zero failures. Existing tests (`backend.test.ts`, `tag-store.test.ts`, `utils.test.ts`, `virtualized-renderer.test.ts`) must continue to pass unchanged.

  If the extraction in step 3 (Approach A) is performed, also verify:
  - `yarn dev` compiles `src/renderer.tsx` cleanly with the new import path.
  - `yarn start` launches the app and a first-time upgrade from a legacy-layout `userData` directory still performs the migration correctly (manual smoke test; no automation required).

- [x] 5. **Cross-link in INV-001** — Once the tests land, update `docs/TODO/pending_qa/investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md` to append `TASK-017` to the `tasks_spawned` array in the frontmatter. This closes the QA-flagged gap against the investigation record.

## Done When

- [x] `tests/library-registry.test.ts` exists with all 14 test cases listed in step 1, all passing.
- [x] `tests/storage-key-helpers.test.ts` exists with all 10 test cases listed in step 2, all passing.
- [x] `tests/renderer-migration.test.ts` exists with all 14 test cases listed in step 3, all passing.
- [x] `migrateToMultiLibraryLayout` is reachable from a test file (extracted to `src/renderer-migration.ts` via Approach A).
- [x] `yarn test` completes with all 3 new test suites passing and no previously-passing tests broken.
- [x] INV-001's `tasks_spawned` array includes `TASK-017`.
- [x] No production code changes other than the Approach A extraction in step 3. Coverage added WITHOUT altering INV-001's observable behavior.
