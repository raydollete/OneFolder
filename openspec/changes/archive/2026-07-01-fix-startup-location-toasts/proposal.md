## Why

Every cold start of a real-world library fires two misleading toasts: an anonymous `An error has occured while initializing location ""` (empty name, from a chokidar permission error during a drive-root scan) and `This appears to be taking longer than usual.` with a `Retry?` button that reloads the renderer and restarts the very scan the user is waiting on. Both are deterministic on the user's Windows library, and both point at real gaps — an empty display-name fallback, a dropped worker error payload, a dormant `isReady` flag, and a fixed 20 s wall-clock heuristic standing in for "is this hung?". This came out of investigation INV-013, whose premises were re-verified against current code and still hold.

## What Changes

- **Empty location name never renders.** `ClientLocation.name` falls back `basename(path) || path || '(unnamed)'`, so drive roots (`D:\`), UNC roots, and POSIX `/` display their path instead of `""` everywhere the getter is consumed (toasts, sidebar, dialogs, console logs).
- **Startup error toast is suppressed during the initial scan and made informative afterward.** Permission errors while chokidar first traverses a drive root are logged, not toasted. Post-scan watch errors surface with the real chokidar `code`/`path`. This requires wiring the dormant `ClientLocation.isReady` flag (declared but never set `true`) and giving each location its own toast key.
- **Worker→main error payload is structured.** `folderWatcher.worker.ts` serializes the chokidar `Error` into `{ message, code?, path? }` before `postMessage`, and the receiver's type union matches — closing the current `Error`-posted-into-a-`string`-slot mismatch that silently drops `code`/`path`.
- **"Taking longer than usual" is reframed as a calm progress note.** Threshold raised 20 s → 60 s, copy changed to `Scanning location "<name>"… this can take a while for large folders.`, the misleading `Retry?`/reload action **removed**, and the per-location toast key made unique. The stale `TODO`/`FIXME` band-aid comments are updated/removed.
- **Defensive guards against empty-path location rows.** `LocationStore.create()` and the SQLite `createLocation` refuse an empty/whitespace path; `LocationStore.init()` filters malformed rows with a warning; the IndexedDB→SQLite migration and the offline dexie-backup converter skip-and-warn on empty-path rows.

Explicitly **not** in scope (deferred, per the investigation): streaming incremental scan-progress from the worker; a SQL `CHECK (length(path) > 0)` constraint / schema migration; platform-specific drive-root detection; filtering chokidar's traversal of system directories; blocking users from adding drive-root locations.

## Capabilities

### New Capabilities
- `location-watching`: How a library's persisted locations are loaded, validated, initialized (initial chokidar scan), watched for live changes, and how initialization/error/progress states are surfaced to the user. Covers display-name derivation, initial-scan vs. watch-time error handling, the worker→renderer error contract, the slow-scan progress note, and empty-path safety at the create/load/migrate boundaries.

### Modified Capabilities
<!-- None: no existing spec's requirements change. multi-select-tagging is unrelated. -->

## Impact

- **Frontend**: `src/frontend/entities/Location.ts` (name getter, `isReady` wiring, error-message type union + handler), `src/frontend/workers/folderWatcher.worker.ts` (structured error payload), `src/frontend/stores/LocationStore.ts` (slow-scan toast, empty-path guard on `create`/`init`).
- **Backend / data layer**: `src/backend/sqlite-backend.ts` (`createLocation` empty-path guard), `src/backend/migration-indexeddb-to-sqlite.ts` and `scripts/convert-dexie-backup.js` (skip-and-warn on empty-path rows).
- **Behavioral surface**: startup toasts on every library open; Locations sidebar labels; location creation/recovery dialog titles. No DTO/schema/IPC contract changes; no migration required. Manual GUI QA on Windows is needed to confirm the startup-toast behavior.
