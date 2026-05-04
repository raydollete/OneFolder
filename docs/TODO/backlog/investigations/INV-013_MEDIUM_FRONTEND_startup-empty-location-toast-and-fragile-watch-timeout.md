---
id: INV-013
title: 'Two startup toasts: chokidar error from a drive-root / unreadable location surfaces as `An error has occurred while initializing location ""`, and a fixed 20s watchLocations timer fires `This appears to be taking longer than usual` on every cold start of a real-world library'
reported_bug: 'On every app launch, two toasts appear: (1) `An error has occurred while initializing location ""` — note the empty quoted name; and (2) `This appears to be taking longer than usual.` with a Retry button. Both fire deterministically on every startup. The user wants the root causes traced, related latent issues found, and a holistic fix planned.'
date: 2026-05-04
last_updated: 2026-05-04
status: active
superseded_by:
tasks_spawned: [TASK-055, TASK-056, TASK-057]
root_cause_category: missing-edge-case
affects:
  - 'src/frontend/entities/Location.ts (chokidar error toast, ClientLocation.name getter, isReady never set, error payload typed-as-string mismatch)'
  - 'src/frontend/stores/LocationStore.ts (20s readyTimeout heuristic in watchLocations, shared retry-init toast key, no per-location guard against empty/malformed paths)'
  - 'src/frontend/workers/folderWatcher.worker.ts (`error` channel posts an Error object even though receivers type it as string; chokidar emits noisy permission errors when watching drive roots)'
  - 'src/frontend/containers/Outliner/LocationsPanel/index.tsx (location list shows blank label when ClientLocation.name resolves to "")'
  - 'src/frontend/containers/Outliner/LocationsPanel/LocationCreationDialog.tsx and LocationRecoveryDialog.tsx (dialogs title/body interpolate location.name; render as empty quotes for drive-root paths)'
  - 'src/backend/sqlite-config.ts (locations.path TEXT NOT NULL, but no CHECK constraint that prevents empty string or drive-root paths)'
  - 'src/backend/migration-indexeddb-to-sqlite.ts and scripts/convert-dexie-backup.js (no path validation when copying location rows from legacy stores)'
---

## Bug Report

### Observed Behavior

On every app launch, two toasts appear:

1. **`An error has occurred while initializing location ""`** — note the empty quoted name (the `"<name>"` interpolation came back as the empty string).
2. **`This appears to be taking longer than usual.`** — with a clickable `Retry?` action.

Both are deterministic — they fire on every cold start, not just intermittently.

### Where the strings are produced

- Toast #1: `src/frontend/entities/Location.ts:302-310`. The exact source string has the typo "occured":
  ```ts
  AppToaster.show(
    {
      message: `An error has occured while ${
        this.isReady ? 'watching' : 'initializing'
      } location "${this.name}".`,
      timeout: 0,
    },
    'location-error',
  );
  ```
  This fires from the `data.type === 'error'` branch of the message handler attached to `FolderWatcherWorker`. The worker forwards chokidar's `error` event into this branch (`src/frontend/workers/folderWatcher.worker.ts:132-135`). The user reported the message as "occurred" (with two r's); the actual code string is misspelled "occured" (one r). Same toast.

- Toast #2: `src/frontend/stores/LocationStore.ts:143-155`. A fixed 20-second `setTimeout` inside the per-location loop in `watchLocations()`:
  ```ts
  const readyTimeout = setTimeout(() => {
    AppToaster.show(
      {
        message: 'This appears to be taking longer than usual.',
        timeout: 0,
        clickAction: { onClick: RendererMessenger.reload, label: 'Retry?' },
      },
      'retry-init',
    );
  }, 20000);
  console.groupCollapsed(`Initializing location ${location.name}`);
  const diskFiles = await location.init();
  // ...
  clearTimeout(readyTimeout);
  AppToaster.dismiss('retry-init');
  ```
  This fires whenever a single location's `location.init()` (chokidar initial scan + `refreshSublocations`) takes more than 20 seconds. There is a "TODO" + "FIXME" comment immediately above it (`LocationStore.ts:140-142`) that admits: "Toasts should not be abused for error handling. Could also be some of the following steps though." — i.e. the author already knew it was fragile.

### Why the location name is empty

`ClientLocation.name` is a derived getter:

```ts
get name(): string {
  return SysPath.basename(this.path);
}
```

`SysPath.basename` returns the empty string when given a drive root or a path that does not contain a separator-and-trailing-segment. On Windows specifically:

- `path.basename('D:\\')` → `''`
- `path.basename('D:')` → `''`
- `path.basename('//server/')` (UNC root) → `''`

On POSIX:

- `path.basename('/')` → `''`

So a location whose `path` is a drive root (e.g., `D:\` for an external SSD with a photo library at the drive root, or `\\NAS\photos` UNC root) renders as a blank-named entity — including in the toast, the Locations sidebar list, the creation dialog title, and the recovery dialog. **The location DOES have a real path; only its derived display name is empty.**

A different but related cause: a corrupted persisted row where `path === ''` literally. The SQLite schema declares `path TEXT NOT NULL` (`src/backend/sqlite-config.ts:54`) but does NOT enforce `length(path) > 0`, and neither the create path (`src/backend/sqlite-backend.ts:587-604`) nor the migration paths (`src/backend/migration-indexeddb-to-sqlite.ts:233-250`, `scripts/convert-dexie-backup.js:233`) validate the path. A buggy import or a manually edited DB could persist a row with `path=''`. Such a row would still sail through `init()` because `fse.pathExists('')` returns `false`, so `setBroken(true)` is called and `watch()` is never reached — meaning empty-string `path` does NOT actually fire toast #1 (it gets silently treated as a broken link). The toast only fires when chokidar succeeds in attaching to a real (non-empty) path, then errors during traversal.

Confirmed scenario for the user's empty-quoted toast: **`this.path` is a drive root, the path exists, `watch()` succeeds in attaching to chokidar, chokidar emits one or more `error` events while traversing system-protected directories on the root (e.g. `System Volume Information`, `$RECYCLE.BIN`, `Config.Msi` on Windows; mountpoint sysdirs on macOS/Linux), and the toast renders `location "${this.name}"` where `this.name === ''`.**

### Why "taking longer than usual" fires every start

Toast #2 is a **fixed 20s threshold per location** with no relationship to the actual workload. On the user's library, at least one location's initial scan exceeds 20 seconds on every cold start. This is plausible on:

- Large libraries (tens or hundreds of thousands of files, deep hierarchies).
- Slow storage (HDD, network share, USB external).
- Cold-cache reads where the OS has not yet cached directory entries.
- Locations that include drive roots — chokidar walks into every subdirectory on the drive, including thousands of system / app / temp directories.

This is fundamentally a **UX/threshold problem**, not a bug in the strict sense — the operation is genuinely slow but still progressing. The toast is doubly misleading because:

(a) the operation is not actually stuck — it will complete; and
(b) the only offered action ("Retry?") reloads the renderer, which restarts the same scan from scratch — strictly worse than waiting.

### Reproduction Context

- **Toast #1 is deterministic** when at least one persisted location has a path whose `SysPath.basename` returns `''`. Most commonly: a location pointing at a Windows drive root (`D:\`, `E:\`, etc.) or a UNC root. Also any location whose path triggers chokidar `error` events during initial traversal — drive roots reliably do because of system-protected sysdirs.
- **Toast #2 is deterministic** when at least one location's initial scan exceeds 20 seconds. On any user with a sufficiently large or slow location, this is every launch.
- Both reproduce on Windows 11 (the user's platform). Toast #1 is platform-conditional on Windows-style drive-root paths but the underlying mechanism — `SysPath.basename` returning `''` for filesystem roots — is cross-platform.
- Independent of library; multi-library code path (INV-001 / `docs/multi-library.md`) is **not the source** of the empty path. The `libraryId` URL parameter and per-library `localStorage` namespacing have no influence on what `LocationDTO.path` values are stored in `locations` rows. See "Multi-library considered and ruled out" below.

### Multi-library considered and ruled out

`docs/multi-library.md` documents the per-library SQLite database, the `LibraryRegistry`, and the `migrateToMultiLibraryLayout` step in `src/renderer.tsx`. Those subsystems migrate the `onefolder.db` file location and the four per-library `localStorage` keys, but they do not touch the `locations` table inside the database — `locations` rows are migrated wholesale with the database file. So if a library has a drive-root location stored, it will keep that location across a multi-library upgrade and will keep producing the empty-name toast.

There is no "default seeded location" path that the registry creates on a fresh install. A fresh install creates a default "My Library" entry in `libraries.json` (`common/library-registry.ts`), but the SQLite `locations` table for that library starts empty — no synthetic locations are inserted. Empty-named locations therefore are not multi-library artifacts; they are pre-existing user-created locations whose path resolves to an empty basename.

---

## Root Cause Analysis

**Category:** missing-edge-case (with a side of silent-failure for the worker→main type mismatch)

### Diagnosis

#### Toast #1: empty-named error toast

Three independent missing-edge-cases stack:

1. **`ClientLocation.name` derives display from `SysPath.basename(this.path)`.** This is fine for a typical user-picked subdirectory like `D:\Photos\Family` (basename `Family`), but breaks for drive roots and UNC roots where basename returns `''`. There is no fallback. The `name` getter is consumed everywhere — toasts, sidebar list, dialog titles — so the empty string propagates.

2. **`refreshSublocations()` and `watch()` happily traverse drive roots.** When a user adds a drive root as a location (the path-validation in `LocationsPanel/index.tsx:511-566` only guards against duplicate, parent-of-existing, and child-of-existing locations — it does NOT guard against drive roots or non-photo system directories), chokidar walks into every subdirectory and reliably hits permission-denied system directories. Each EPERM/EACCES emits an `error` event, which triggers the toast. The user's "broken" symptom is actually a normal drive-root scan generating noise.

3. **The chokidar `error` is shown to the user as a generic toast with no specific information.** The error object from chokidar (which usually includes `code`, `path`, `errno`) is logged to the console (`Location.ts:301`) but the toast just says "An error has occurred". A user with a drive-root location and one EPERM error gets a toast that tells them nothing actionable. Compounded by the empty `name`, the toast is *information-free*.

   Sub-issue: the worker→main message channel for errors is type-mismatched. The receiver in `Location.ts:280-282` declares the union as `{ type: 'remove' | 'error'; value: string } | { type: 'add'; value: FileStats }`, but the worker posts `{ type: 'error', value: error }` where `error` is a chokidar `Error` object (`folderWatcher.worker.ts:132-135`). Web-worker `postMessage` structured-cloning will preserve `Error.message`, `name`, `stack` for a vanilla `Error` but not custom enumerables (chokidar may attach `code`, `path` as extras — those would be lost or partially preserved depending on Node/Electron version). The receiving handler treats `value` as opaque (`console.error('Location watch error:', value)`) so it never extracts useful fields. Net effect: the user-facing toast is generic AND the console log is partial.

4. **Latent: `ClientLocation.isReady` is declared but never set to `true`.** `Location.ts:75` declares `private isReady = false`, and the only read is at line 305 to choose between the words `watching` and `initializing` in the toast. Nothing ever assigns `true`. So the toast will always say "initializing" even if the error fires hours into the session. This is a small additional latent bug — separate from the root cause but fixed in the same patch is cheap.

The conceptual error is that `ClientLocation` was modeled as a "user-named photo collection", and the convenience getter `name = basename(path)` assumed every path has a meaningful trailing segment. Drive roots violate this assumption and were never handled. **This is missing-edge-case at the model level.**

#### Toast #2: 20s readyTimeout

The single conceptual error: **a fixed 20-second wall-clock heuristic was used as a stand-in for "this operation is hung."** The author admitted in inline comments (`LocationStore.ts:140-142`) that they could not find the real cause of intermittent hangs and added the timeout as a band-aid. On a real-world library that genuinely takes 30+ seconds to do an initial scan, the band-aid is wrong every time.

Conceptually, this is an **architectural shortcoming**: the system has no progress signal from the worker beyond the resolve-on-ready callback. The renderer cannot distinguish "scanning 100k files" from "stuck waiting for a syscall that will never return". A stuck syscall is rare; long scans are common. So the 20s timer punishes the common case to maybe-warn about the rare one.

Adding insult: the only offered action is `Retry?` → `RendererMessenger.reload`. This RELOADS the entire renderer, which means re-running the same scan from the beginning. There is no actual recovery — only a forced restart. If the scan was 18 seconds in and would have completed in 22, reloading makes it take another 22+. So users who click "Retry?" in earnest are made strictly worse off.

The `retry-init` toast key is also shared across all locations in the for-loop, but each iteration starts a fresh `setTimeout` — so the toast can cascade-fire as one slow location after another exceeds 20s, and each new fire replaces the previous toast (per `Toaster.tsx:18-31` the same id replaces the existing toast). This mostly just means repeat appearances — minor symptom but worth knowing for QA.

### Diagnostic Questions Considered

- **Wrong mental model?** Yes for toast #1 — the model assumed "every location has a non-empty `name` derivable from its path." Drive roots and UNC roots break the assumption. Yes for toast #2 — the model assumed "20s is a sensible stand-in for `is the watcher hung?`" without a real progress signal.
- **Architectural shortcoming?** Yes for toast #2 primarily. The `FolderWatcherWorker` has no progress channel beyond `'ready'`. The main thread cannot distinguish "scanning many files" from "stuck". The fix needs either (a) a real progress signal, (b) a saner threshold, or (c) removal of the warn-toast in favor of a more honest "still scanning…" indicator.
- **Incorrect order of operations?** No.
- **Missing edge case?** Yes — primary category for both. Drive roots, UNC roots, and `path === ''` for toast #1; long-but-progressing scans for toast #2.
- **Wrong abstraction?** Borderline. The `name` getter as `basename(path)` is fine for the common case. A `displayName` that falls back to the path itself (or to `path` minus drive letter) when basename is empty would correct the abstraction without breaking anything.
- **Silent failure?** Yes for the worker→main `error` channel: the worker posts a structurally-cloned Error object into a slot typed as `string`, the receiver `console.error`s it but never inspects fields, and the toast is generic. The actual error code (EPERM, EACCES, ENOENT, EBUSY, etc.) is lost from the user-facing path.

---

## Blast Radius

Every area touched by the same root causes:

### From the empty-name root cause (`SysPath.basename` returns empty for drive/UNC roots)

1. **`src/frontend/entities/Location.ts:130-132` (`get name()`)** — Primary site. The single source of every empty-string `name` in the UI. Fix here propagates to every consumer.
2. **`src/frontend/entities/Location.ts:302-310` (chokidar error toast)** — Renders empty quotes when `name === ''`. Even after fixing `name`, the toast is still uninformative — should also include the actual error code/path from chokidar.
3. **`src/frontend/stores/LocationStore.ts:157` (`Initializing location ${location.name}` console.groupCollapsed)** — Same empty-name effect. Console group title is "Initializing location " with a trailing space and nothing else.
4. **`src/frontend/stores/LocationStore.ts:169` (`Cannot find Location "${location.name}"`)** — Broken-link toast for missing location. Same empty-name effect for drive-root locations whose drive was unmounted.
5. **`src/frontend/stores/LocationStore.ts:228, 252, 331, 386, 458` (other `location.name` interpolations)** — Console logs and the "Location is ready!" toast. Same blank-name surface in console; less user-visible.
6. **`src/frontend/containers/Outliner/LocationsPanel/index.tsx:277, 406` (sidebar list label)** — A drive-root location renders as an empty label in the Locations panel. Already a UX issue independently of the toast.
7. **`src/frontend/containers/Outliner/LocationsPanel/LocationCreationDialog.tsx:153` (`Add Location "${location.name}"?` dialog title)** — Empty quotes when adding a drive-root location.
8. **`src/frontend/containers/Outliner/LocationsPanel/LocationRecoveryDialog.tsx:100, 267` (recovery dialog body and title)** — Same.
9. **`src/frontend/stores/FileStore.ts:500-501, 516-521` (re-index toasts)** — Same empty-name interpolation.

### From the worker→main error-channel type mismatch

10. **`src/frontend/workers/folderWatcher.worker.ts:132-135` (`'error'` postMessage)** — Posts an `Error` object into a slot the receiver types as `string`. Information loss. Source of the generic toast.
11. **`src/frontend/entities/Location.ts:280-282` (`onmessage` type union)** — Declares `value: string` for the `error` case, but the worker sends an `Error` object. TypeScript hides this mismatch because `as any` is implicitly happening on the worker's `postMessage` payload. Need to widen the receiver type to `unknown` or to a structured `{ message: string; code?: string; path?: string }`, normalize the worker's payload, and surface useful fields in the toast.

### From the persisted-empty-path safety gap

12. **`src/backend/sqlite-config.ts:52-58` (locations table schema)** — `path TEXT NOT NULL` allows empty string. No `CHECK (length(path) > 0)`. A bad import/migration could persist `path=''`, which then silently becomes a "broken link" with no UI to remove it (a broken-link recovery dialog can offer Locate, but only when the user finds the broken row in the Locations panel — and the row has empty `name`, so the user may not even see it as a useful entry).
13. **`src/backend/sqlite-backend.ts:587-604` (`createLocation`)** — No validation. Will accept any path including `''`.
14. **`src/backend/migration-indexeddb-to-sqlite.ts:233-250` (location migration loop)** — No validation. Copies whatever Dexie had, including possibly empty paths from older buggy versions.
15. **`scripts/convert-dexie-backup.js:233` (offline backup converter)** — Same gap.

### From the fixed 20s readyTimeout

16. **`src/frontend/stores/LocationStore.ts:140-155` (the readyTimeout itself + its inline FIXME comment)** — The single source of toast #2. Whatever fix lands here should also delete the FIXME comment — the comment author admitted this was a workaround.
17. **`src/frontend/stores/LocationStore.ts` `watchLocations()` overall (lines 105-322)** — Worth a once-over to see whether a real progress signal can be threaded through. Today the chokidar `'add'` events only fire for the initial-files batch via the resolved promise, not as a stream of incremental adds — so progress would have to be derived from a periodic count or by changing the worker contract to post incremental progress. The fix can be "lower-effort" (raise threshold, soften copy, drop misleading Retry button) without touching the worker contract.
18. **`src/frontend/workers/folderWatcher.worker.ts:83-136` (the `watch` method)** — If we want a real progress signal, this is where the chokidar `'add'` events would need to be counted and reported back during the initial-scan phase (before `'ready'` fires). Out of scope for the lower-effort fix; flagged for the higher-effort variant.

### Cross-cutting

19. **The toast key `'location-error'` is shared across all locations.** If two locations have errors, the second overwrites the first (per `Toaster.tsx:18-31`). Should be keyed per-location like `missing-loc-${location.id}` is.
20. **The toast key `'retry-init'` is shared across the for-loop.** Same overwrite behavior — only the most recent slow location's toast is shown. Cosmetic but worth fixing if we keep any version of the timeout toast.
21. **`ClientLocation.isReady` is declared and read but never assigned `true` (`Location.ts:75, 305`).** The toast always says "initializing", never "watching". Latent and free to fix in this patch.

---

## UX / Requirements Specification

### Purpose

Make startup quiet by default for the common case (locations that are progressing normally, even slowly), and informative when something is actually wrong (an error has a real cause, named correctly with details).

### User-Stated Design Decisions

These come directly from the user's prompt and from the project's existing inline comments:

1. **Address the root cause, not the symptom.** Do not just suppress the toasts — diagnose why they fire and fix the underlying gaps. *(Rationale: explicit user instruction.)*
2. **If the "taking longer than usual" warning is fundamentally a UX/threshold problem rather than a bug, say so and propose what to do about it.** *(Rationale: explicit user permission to recategorize toast #2 as a UX defect.)*
3. **Cover related latent issues found while investigating.** Identify any other places where locations are iterated without filtering empty/invalid entries, other timeout warnings with similar fragility, anywhere a location DTO can be persisted without a path. *(Rationale: explicit user instruction; investigation must capture blast radius beyond the two reported symptoms.)*

### Behavioral Specifications

#### Toast #1: empty-named chokidar error

- **Display name fallback.** `ClientLocation.name` (or a new sibling getter `displayName`) must NEVER return an empty string. Order of preference:
  1. `SysPath.basename(this.path)` if non-empty.
  2. The full `this.path` (e.g., `D:\` shows as `D:\` in the toast, not as `""`).
  3. A literal fallback like `(unnamed)` if `this.path` is itself empty.

  The simplest implementation is to wrap the existing getter:
  ```ts
  get name(): string {
    const base = SysPath.basename(this.path);
    return base || this.path || '(unnamed)';
  }
  ```
  This is a one-line, zero-risk change. All existing callers that interpolate `name` automatically benefit (sidebar, dialogs, toasts, console logs).
- **Toast must include the actual error reason.** Replace the generic copy with one that surfaces the chokidar error code/path. Suggested format: `Could not access "${displayName}": ${errorSummary}`. `errorSummary` derived from the chokidar Error: prefer `error.code` (`EPERM`, `EACCES`, `ENOENT`, `EBUSY`) + `error.path` (the specific subpath that failed) when present; otherwise fall back to `error.message`.
- **Worker→main contract change.** `folderWatcher.worker.ts` must serialize the chokidar Error into a typed payload before posting:
  ```ts
  ctx.postMessage({
    type: 'error',
    value: {
      message: error.message,
      code: (error as NodeJS.ErrnoException).code,
      path: (error as NodeJS.ErrnoException).path,
    },
  });
  ```
  And the receiver in `Location.ts` must declare the matching union and consume the structured value. **This eliminates the type-as-`string` mismatch.**
- **Per-location toast key.** Change `'location-error'` to `'location-error-${this.id}'` so concurrent errors from different locations don't overwrite each other.
- **Deduplicate noisy errors.** A drive-root location reliably emits multiple errors during initial scan (`System Volume Information`, `$RECYCLE.BIN`, `Config.Msi`, etc., on Windows; `/lost+found` and similar on Linux). The toast should NOT flash one toast per error during initial scan. Two acceptable approaches; pick the simpler one in the implementation task:
  - **Approach A (simpler):** Only show the error toast when `this.isReady === true` (i.e., post-initial-scan). During initial scan, log to console only. This requires fixing the `isReady` latent bug (see decision 7 below).
  - **Approach B:** Coalesce errors during initial scan via debounce; show one summary toast 500ms after the last error. More accurate but more code.

  Decision: **Approach A** is correct for this codebase. Initial-scan permission errors on drive roots are noise, not actionable; only watch-time errors after the user has been using the app are. The chosen approach also gives a meaningful purpose to the dormant `isReady` flag.
- **Fix the `isReady` latent bug.** Set `this.isReady = true` after `await this.worker.watch(directory, this.extensions)` resolves with the initial files (in `Location.ts:317`). This is what the field was always meant to indicate; the assignment was just forgotten.

#### Toast #2: "taking longer than usual"

- **Remove the misleading Retry button.** Reloading does not help; it restarts the same scan. Decision: **drop the click action entirely.** If the operation is slow, the user should wait or close the app — not be offered a button that strictly hurts them.
- **Soften the copy and reframe.** Replace `This appears to be taking longer than usual.` with a calm, accurate progress note: `Scanning location "${displayName}"… this can take a while for large folders.` Drop the implicit "something is wrong" framing.
- **Raise the threshold.** A fixed 20s threshold is too aggressive for real-world libraries. Two acceptable approaches:
  - **Approach A (lower-effort, recommended):** Raise the threshold to 60 seconds and rename the toast to a progress note (above). This catches genuine multi-minute hangs without false-positiving on slow-but-progressing scans. Keep the toast in the same location (around the existing `setTimeout`).
  - **Approach B (higher-effort, deferred):** Wire a real progress signal from the worker — count `'add'` events during initial scan and post a periodic "scanned N files" message back. Replace the timeout toast with a live progress count. Requires changes to the worker contract.

  Decision: **Approach A in this task; Approach B is a future task** (filed as a follow-up if the new behavior still feels uncomfortable in QA). Rationale: Approach B is genuinely better but materially larger and risks worker-contract churn that other tasks (INV-009 fetch generation, etc.) are still settling into. A threshold raise + copy tweak is a net win on its own.
- **Per-location toast key.** Change `'retry-init'` to `'retry-init-${location.id}'` so cascading slow locations don't overwrite each other (cosmetic; bundle into the same patch).
- **Update the inline `// TODO` and `// FIXME` comments** on `LocationStore.ts:140-142` to reflect the new design (or delete them outright if Approach A's threshold-and-copy is now considered the correct UX).

#### Persisted empty-path safety net

- **Validate path on create.** Add an early-return guard in `LocationStore.create()` (`LocationStore.ts:365-378`) that throws if `path` is empty or is just whitespace. Mirror in any other location creation path discovered.
- **Defensive filter on load.** In `LocationStore.init()` (`LocationStore.ts:62-97`), filter out rows where `dir.path` is empty before constructing `ClientLocation` instances. Log a warning (`console.warn('Skipping malformed location row with empty path', dir.id)`) so the issue surfaces in dev tools without crashing the app or scaring the user.
- **Schema constraint (lower priority).** Adding a SQL `CHECK (length(path) > 0)` to the `locations` table is the strongest guarantee but requires a migration. Defer to a follow-up task; for now the application-level guard is sufficient.

### Explicit Rejections

- **Do NOT suppress toast #1 unconditionally.** Genuine watch errors (e.g., the location's drive was unmounted mid-session) should still be visible to the user. The fix is to make the toast actionable, not to silence it.
- **Do NOT remove the `name` getter.** The basename behavior is correct for the common case; only the empty fallback needs handling.
- **Do NOT add platform-specific drive-root detection (`if (path.match(/^[A-Z]:\\?$/))`).** The fallback chain (`basename || path || '(unnamed)'`) handles drive roots, UNC roots, and POSIX `/` uniformly with no platform branching.
- **Do NOT add a settings toggle for the "scanning…" toast.** The user did not ask for one; the toast is informational and brief.
- **Do NOT block users from adding drive-root locations.** Some users legitimately want to point OneFolder at an entire external drive. The fix is to render those locations correctly, not to prohibit them.
- **Do NOT change the worker contract to stream incremental progress in this patch.** That is the deferred Approach B for toast #2; the lower-effort patch covers the user's pain without that surgery.
- **Do NOT add a SQL `CHECK` constraint in this patch.** Schema migrations introduce risk that is unjustified by the symptom. Defer to a follow-up.
- **Do NOT modify the chokidar `disableGlobbing`/`ignored` callback to filter out system directories like `System Volume Information`.** Tempting (it would silence the noise at the source) but fragile across OSes and could hide real errors. The right fix is to suppress the toast during initial scan (decision A above), not to filter chokidar's traversal.
- **Do NOT fix the typo "occured" → "occurred" silently in production data.** The string is only displayed to users in toasts; we will fix the typo in the same patch since the toast copy is being rewritten anyway. Just calling out that the misspelling is the same toast the user reported.

---

## Holistic Solution

### Approach

Three implementation tasks, two QA tasks merged into one, ordered for minimal back-tracking:

#### TASK-055 (FRONTEND, primary fix) — empty-name fallback, isReady wiring, and structured worker error payload

1. **`src/frontend/entities/Location.ts:130-132`:** rewrite the `name` getter with a fallback chain:
   ```ts
   get name(): string {
     const base = SysPath.basename(this.path);
     return base || this.path || '(unnamed)';
   }
   ```
2. **`src/frontend/entities/Location.ts:75, ~317`:** set `this.isReady = true` immediately after `await this.worker.watch(directory, this.extensions)` resolves with `initialFiles`. This is what the flag was always meant to indicate and what the toast `isReady ? 'watching' : 'initializing'` ternary needs to be true.
3. **`src/frontend/workers/folderWatcher.worker.ts:132-135`:** structure the error payload before posting:
   ```ts
   .on('error', (error) => {
     const errnoErr = error as NodeJS.ErrnoException;
     console.error('Error fired in watcher', directory, error);
     ctx.postMessage({
       type: 'error',
       value: {
         message: error.message,
         code: errnoErr.code,
         path: errnoErr.path,
       },
     });
   });
   ```
4. **`src/frontend/entities/Location.ts:278-312`:** widen the receiver type union to `{ type: 'error'; value: { message: string; code?: string; path?: string } }` (and keep the existing `add`/`remove` cases). In the `error` handler:
   - If `!this.isReady` → log only (`console.warn('Suppressed initial-scan error from location', this.name, value)`), do NOT toast. Initial-scan permission errors on drive roots are noise.
   - If `this.isReady` → toast with the new copy: `Could not access "${this.name}": ${value.code ?? ''} ${value.path ?? value.message}`. Use a per-location toast key: `\`location-error-${this.id}\``.
5. **`src/frontend/stores/LocationStore.ts:365-378` (`create`)**: throw early if `path === ''` or `path.trim() === ''`.
6. **`src/frontend/stores/LocationStore.ts:62-97` (`init`)**: filter `dirs` to drop entries with empty paths and log a warning. Continue with the remaining locations.

Verification: launch the app with a drive-root location persisted. Toast #1 should not fire on launch (initial-scan errors suppressed). Sidebar should display the path itself (e.g. `D:\`) rather than empty. Trigger a watch-time error post-startup (e.g., disconnect the drive) — toast should fire with code/path.

#### TASK-056 (FRONTEND, secondary fix) — relax watchLocations timeout and reframe the toast

1. **`src/frontend/stores/LocationStore.ts:140-155`:**
   - Raise `20000` ms to `60000` ms.
   - Replace the toast message with: `\`Scanning location "${location.name}"… this can take a while for large folders.\``
   - **Drop the `clickAction` entirely.** Remove the `Retry?` button and its `RendererMessenger.reload` callback. The button is misleading and worsens the user's situation.
   - Change the toast key from `'retry-init'` to `\`retry-init-${location.id}\``.
   - Remove or update the inline `// TODO` and `// FIXME` comments to reflect that this is now an intentional UX progress note, not a hung-detection workaround.

Verification: launch with a slow location (or simulate by adding a `setTimeout(1000)` between iterations in dev). After 60s the new "Scanning location 'X'..." toast appears with no Retry button. Wait for the scan to complete; the toast dismisses cleanly. With a fast location, the toast never appears. With multiple slow locations, each gets its own toast (per-location key).

#### TASK-057 (FRONTEND/BACKEND, hardening, optional but bundled) — defensive guards on persisted location paths

1. **`src/backend/sqlite-backend.ts:587-604` (`createLocation`)**: throw if `location.path === ''` (defense in depth — should already be caught in the renderer per TASK-055 step 5, but the data layer should also refuse to write garbage).
2. **`src/backend/migration-indexeddb-to-sqlite.ts:233-250`**: skip rows with empty `path` and log how many were skipped. Migration is run-once; making it forgiving prevents a single bad legacy row from creating a permanent ghost entry.
3. **`scripts/convert-dexie-backup.js:233`**: same skip-and-warn for the offline backup tool.
4. **No SQL `CHECK` constraint**: deliberately deferred. A schema migration is heavier than the symptom warrants. Filed as a future hardening task in the investigation notes.

Verification: unit-test or manually verify `createLocation` throws on empty path. Run the migration tool on a hand-crafted Dexie backup that includes one empty-path location row; verify the new SQLite DB has no empty-path row and the console shows the warning.

#### QA — folded into the same QA pass for TASK-055 and TASK-056

A single QA task is appropriate because both fixes touch startup toasts and would be tested in the same launch. (TASK-057 is internal data-layer hygiene with no user-visible behavior change beyond preventing a future regression — it can be QA'd as part of the same pass with a synthesized empty-path row, OR deferred to a code-review-only acceptance.)

For brevity the QA task is folded into TASK-055's "Done When" criteria (see the task file). If the user prefers a separate QA task analogous to TASK-048 / TASK-051, it can be split out — flag for the implementer.

### Expected Outcomes

After all three tasks land:

- **Cold launch with a drive-root location** produces no startup error toast. The sidebar shows the location with its path (e.g., `D:\`) as the label instead of an empty string. The console may show suppressed-error warnings, which is fine.
- **Cold launch with a large library** does not show the "taking longer than usual" toast within 60 seconds. If a single location takes more than 60s, a calmer "Scanning location 'X'…" progress note appears with NO Retry button.
- **Disconnecting an external drive mid-session** while a location on it is being watched produces a toast like `Could not access "D:\": EBUSY /path/that/failed` — actionable, not anonymous.
- **Multiple locations erroring concurrently** each get their own toast (per-location keys), instead of one overwriting the other.
- **Importing a malformed legacy DB** (with a row having empty path) skips the bad row at migration time with a console warning, and silently filters any leftover empty-path rows on each `LocationStore.init()`. The user is not shown a phantom empty-named entry.

### Risks and Tradeoffs

- **Suppressing initial-scan errors hides legitimate startup failures.** If a location's path was deleted on disk before launch, `fse.pathExists` already catches that and goes to the broken-link path (`Cannot find Location "${name}"` — separately fixed by the `name` fallback). Permission errors on subdirectories during initial scan are the only thing being suppressed, and those are noise on real workloads. The `console.warn` keeps the info available in dev tools. Acceptable risk.
- **Dropping the Retry button removes a recovery affordance, however broken.** In the original design the Retry was the only escape hatch for a user who saw the toast and panicked. With the toast reframed as a calm progress note, no escape hatch is needed — the operation will progress. If the user later finds themselves in a genuinely-stuck state, the tools are: close the app via the system close button, or open DevTools and inspect. Acceptable.
- **60-second threshold may still be too short** on extreme libraries (millions of files, USB 2.0 external drive). The new copy is calm so a 60s appearance isn't alarming, and a future Approach B (real progress signal) can replace the threshold entirely. If user testing in QA shows the toast still feels surprising, raising to 120s or 180s is a one-line change.
- **`isReady = true` after initial files resolve, but the chokidar watcher may not actually be ready to emit `'add'`/`'unlink'` events at that exact moment.** The worker's `'ready'` event is what fires the resolve, so this assignment is correctly placed (post-`'ready'`). Verify in QA that no errors arrive between `resolve` and the assignment — there shouldn't be, but worth a glance.
- **`name` fallback to `path` exposes the full filesystem path in the sidebar UI** for drive-root locations. This is information the user already has (they picked the path), so leaking it back into the UI is fine. Cosmetically, a long UNC root (`\\nas-server-01.local\share\photos`) might wrap awkwardly in the sidebar — but that's the same problem any long path already has, and it doesn't regress from the empty-string baseline.
- **Migration skip-and-warn changes migration behavior on already-migrated installs.** No effect — migration is idempotent and run-once. Skipping bad rows on a fresh migration run is strictly an improvement.
- **The `'retry-init-${location.id}'` toast key change** means that if the same location was already showing the old `'retry-init'` toast at update time, the new toast would not displace the old one (different key). Cold launch resets toasts so this is only a hot-reload concern in dev — acceptable.

---

## Documentation Updates

- [x] No updates needed to `docs/multi-library.md` — multi-library was considered and ruled out as the cause; no changes to that subsystem.
- [x] No updates needed to `docs/location-loading.md` — the file documents the location-loading flow but does not mention the readyTimeout or the chokidar error handling. If the user later wants the new copy / new threshold documented user-facing, that would be a small addition; out of scope for this investigation.
- [ ] If TASK-057 ships, consider adding a short note to `docs/location-loading.md` (or `docs/data-model.md` if it exists) about the empty-path defensive filter at load time and the validate-on-create rule. Not blocking; flagged.
