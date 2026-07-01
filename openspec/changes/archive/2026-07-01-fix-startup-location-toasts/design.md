## Context

Two startup toasts fire deterministically on the user's Windows library, traced in investigation INV-013 and re-verified against current code:

1. `An error has occured while initializing location ""` — the chokidar `error` branch in `ClientLocation.watch()` (`Location.ts:300-308`). The empty name comes from `get name()` returning `basename(path)`, which is `''` for a drive/UNC root; the anonymous message comes from the worker posting the raw chokidar `Error` (`folderWatcher.worker.ts:143`) into a receiver slot typed as `string` (`Location.ts:279`), so `code`/`path` are dropped and the handler only shows a generic string.
2. `This appears to be taking longer than usual.` with a `Retry?` button — a fixed 20 s `setTimeout` in `watchLocations()` (`LocationStore.ts:151-163`) whose only action reloads the renderer and restarts the scan. Its own inline `TODO`/`FIXME` admit it is a band-aid.

Two latent defects compound these: `ClientLocation.isReady` is declared but never assigned `true` (`Location.ts:73`), so the phase distinction the error toast needs does not exist; and no layer validates a location's path, so an empty-path row can be persisted and then silently becomes an unnamed broken-link ghost.

Constraints: TypeScript strict; platform seam (frontend imports path/fs via `src/frontend/platform`, already satisfied here); fail-loud preference; the renderer is the sole ingester (watcher suppression already in place). The fix must be behavior-only — no DTO, IPC, or schema changes.

## Goals / Non-Goals

**Goals:**
- No anonymous or empty-named startup toast for a normally-progressing (even slow) library.
- A real, actionable error toast when a genuine watch-time failure occurs post-startup.
- Reframe the slow-scan warning as a calm, non-destructive progress note.
- Close the worker→renderer error-type mismatch and the dormant `isReady` flag.
- Add cheap defense-in-depth so an empty-path row cannot be created, loaded, or migrated in.

**Non-Goals:**
- Streaming incremental scan progress from the worker (a real per-file progress channel). Deferred; the threshold+copy change covers the pain without worker-contract churn.
- A SQL `CHECK (length(path) > 0)` constraint or any schema migration. Deferred; heavier than the symptom warrants — the application-level guards are sufficient.
- Platform-specific drive-root detection, filtering chokidar's traversal of system directories, or blocking users from adding drive-root locations. All rejected by the investigation.

## Decisions

**D1 — Fallback in the `name` getter, not a new `displayName`.** Wrap the existing getter: `basename(path) || path || '(unnamed)'`. One line, zero risk, and every existing caller (sidebar, dialogs, toasts, logs) benefits automatically. Alternative — a sibling `displayName` getter — was rejected because it would require touching every call site and leave `name` still capable of returning `''`.

**D2 — Suppress initial-scan errors via `isReady` (Approach A), not debounce coalescing (Approach B).** Only toast when `isReady === true`; during the initial scan, log to console. Initial-scan permission errors on drive roots are noise, not actionable; watch-time errors after the user is working are the ones worth surfacing. This also gives the dormant `isReady` flag its intended purpose. Debounced coalescing is more accurate but more code for no user-visible gain here.

**D3 — Set `isReady = true` after the initial scan resolves.** Assign it in `watch()` immediately after `await this.worker.watch(...)` resolves (which is gated on the worker's chokidar `'ready'` event), so the flag flips exactly at the scan→watch boundary. The worker already tracks its own separate `isReady` for the add/initialFiles split; this is the renderer-side counterpart.

**D4 — Structured error payload with a matching type union.** Worker posts `{ type: 'error', value: { message, code?, path? } }`; the receiver's union becomes `{ type: 'error'; value: { message: string; code?: string; path?: string } }`. The toast (post-ready only) reads `Could not access "<name>": <code ?? ''> <path ?? message>`. Per-location key `location-error-${this.id}` so concurrent errors don't overwrite.

**D5 — Slow-scan toast: raise to 60 s, reframe copy, drop the action, per-location key.** Message becomes `Scanning location "<name>"… this can take a while for large folders.`; remove the `clickAction` entirely; key `retry-init-${location.id}`; update/remove the `TODO`/`FIXME`. 60 s is a one-line constant that can be raised later if QA shows it still surprises.

**D6 — Empty-path guards at four layers, no schema change.** Throw in `LocationStore.create()` and in `sqlite-backend.createLocation` (fail loud); filter-and-warn in `LocationStore.init()`; skip-and-warn in `migration-indexeddb-to-sqlite.ts` and `scripts/convert-dexie-backup.js`. The renderer guard is the primary defense; the data-layer guard refuses to write garbage regardless of caller.

## Risks / Trade-offs

- **Suppressing initial-scan errors hides a genuine startup failure** → A deleted path is already caught by `fse.pathExists` → broken-link path, not the error toast; only sub-directory permission errors during scan are suppressed, and those are logged to console for dev visibility.
- **`name` falling back to full path exposes a long path in the sidebar** → The user chose that path, so it is not new information; long paths wrap the same way any long path already does, and it strictly improves on the empty-string baseline.
- **`isReady = true` placed just after the resolve** → The resolve is gated on chokidar `'ready'`, so no `'add'`/error events should slip in before the assignment. Worth a glance in QA but structurally correct.
- **60 s may still be too short on extreme libraries (millions of files, USB 2.0)** → The reframed copy is calm, so a late appearance is not alarming, and the deferred real-progress channel can replace the threshold entirely later.
- **Migration skip-and-warn changes migration behavior** → No effect on already-migrated installs (migration is idempotent/run-once); skipping bad rows on a fresh run is strictly an improvement.

## Migration Plan

No data migration, schema change, or rollback tooling required — all changes are behavior-only in renderer/worker/backend code paths. Rollback is a plain revert. The empty-path guards are additive and do not alter existing valid rows.

## Open Questions

- Whether the 60 s threshold needs to become 120 s/180 s is left to manual QA on the user's real library; changing it is a one-line constant edit.
- Whether TASK-057's data-layer guards warrant their own separate QA pass or can be verified via a synthesized empty-path row folded into the main QA is flagged for the implementer (the investigation leans toward folding).
