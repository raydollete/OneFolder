## 1. Empty-name fallback, isReady wiring, structured worker error (primary)

- [x] 1.1 In `src/frontend/entities/Location.ts`, rewrite `get name()` to `basename(this.path) || this.path || '(unnamed)'` using `platform.path.basename`.
- [x] 1.2 In `folderWatcher.worker.ts` `.on('error', ...)`, replace `postMessage({ type: 'error', value: error })` with a structured payload `{ type: 'error', value: { message, code, path } }` (cast via `NodeJS.ErrnoException`), keeping the existing `console.error`.
- [x] 1.3 In `Location.ts` `watch()`, widen the `worker.onmessage` `data` type union so the `error` case is `{ type: 'error'; value: { message: string; code?: string; path?: string } }` (keep `add`/`remove` cases).
- [x] 1.4 In the `error` handler: if `!this.isReady`, `console.warn` the suppressed initial-scan error and return without toasting; if `this.isReady`, show `Could not access "${this.name}": ${value.code ?? ''} ${value.path ?? value.message}` with a per-location key `` `location-error-${this.id}` `` and fix the `occured`→`occurred` spelling.
- [x] 1.5 In `Location.ts` `watch()`, set `this.isReady = true` immediately after `await this.worker.watch(...)` resolves with `initialFiles`.
- [x] 1.6 In `LocationStore.create()`, throw early if `path` is empty or `path.trim() === ''`.
- [x] 1.7 In `LocationStore.init()`, filter out fetched `dirs` with an empty `path` before constructing `ClientLocation`s, logging `console.warn('Skipping malformed location row with empty path', dir.id)`.

## 2. Slow-scan progress note (secondary)

- [x] 2.1 In `LocationStore.watchLocations()`, raise the `readyTimeout` from `20000` to `60000` ms.
- [x] 2.2 Replace the toast message with `` `Scanning location "${location.name}"… this can take a while for large folders.` `` and remove the `clickAction` (`Retry?` / `platform.desktop.reload`) entirely.
- [x] 2.3 Change the toast key from `'retry-init'` to `` `retry-init-${location.id}` `` (and update the matching `AppToaster.dismiss` call to the same key).
- [x] 2.4 Update or remove the stale `// TODO` / `// FIXME` comments above the timeout to reflect the intentional progress-note behavior.

## 3. Empty-path defensive guards (data layer)

- [x] 3.1 In `src/backend/sqlite-backend.ts` `createLocation`, throw if `location.path` is empty/whitespace before the INSERT.
- [x] 3.2 In `src/backend/migration-indexeddb-to-sqlite.ts` location loop, skip rows with an empty `path` and log a count of skipped rows.
- [x] 3.3 In `scripts/convert-dexie-backup.js`, apply the same skip-and-warn for empty-path location rows.

## 4. Build, typecheck, and lint

- [x] 4.1 Run `yarn lint` and `yarn build` (or `tsc --noEmit`) and resolve any type errors from the widened union / new guards. Batch a single build at the end. — Webpack build compiled successfully; my touched files produce zero errors (only pre-existing warnings elsewhere). Bare `tsc --noEmit` and `yarn lint` surface only pre-existing node_modules/unrelated-file issues.

## 5. Manual QA (REQUIRES MANUAL EXECUTION — Windows/GUI)

> Agent-reachable QA attempted: a jsdom/node unit test for the pure-logic parts
> (name fallback 1.1, `create()` empty-path guard 1.6) was written but could not
> run — importing `Location.ts`/`LocationStore.ts` in the ts-jest harness fails on
> the pre-existing `import.meta.url` webpack coupling at `Location.ts:278`
> (unrelated to this change). The logic is trivial and is confirmed visually by 5.1.
> Full existing suite (24 suites / 223 tests) re-run green after the edits — no regressions.
> Manual GUI QA below executed and confirmed passing by the user (Ray) on 2026-07-01.

- [x] 5.1 Cold-launch with a drive-root location (`D:\`) persisted: confirm NO startup error toast fires, and the Locations sidebar shows the path (e.g. `D:\`) rather than an empty label. Capture evidence (screenshot/log). — Confirmed by user 2026-07-01.
- [x] 5.2 Trigger a watch-time error post-startup (e.g. disconnect the drive) and confirm a toast appears naming the location with the chokidar `code`/`path`. — Confirmed by user 2026-07-01.
- [x] 5.3 With a large/slow location, confirm the old "taking longer than usual" toast no longer appears within 60 s; if a location exceeds 60 s, confirm the calm `Scanning location "…"` note appears with NO Retry button and dismisses on completion. With a fast location, confirm it never appears. — Confirmed by user 2026-07-01.
- [x] 5.4 (Optional, data layer) Run the dexie-backup converter / migration against a hand-crafted backup containing one empty-path location row and confirm the row is skipped with a warning and absent from the resulting store. — Confirmed by user 2026-07-01.
