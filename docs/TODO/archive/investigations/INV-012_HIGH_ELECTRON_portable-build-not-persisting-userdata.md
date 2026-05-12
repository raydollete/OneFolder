---
id: INV-012
title: 'Portable Windows build does not persist userData (preferences, libraries.json, SQLite, thumbnails) across launches'
reported_bug: 'A user observation while reviewing INV-011: launching the portable Windows build (`dist\brave.exe`, electron-builder ``portable`` target) appears to behave like a fresh install every time — theme, sort, and library state are not retained. The temp path `C:\Users\rjdol\AppData\Local\Temp\3CgR4ivGOpSxHbiBAyzrUmQma5t\OneFolder.exe` was observed in earlier sessions, suggesting the running process lives inside an ephemeral self-extract directory whose contents are wiped on exit. If `userData` is co-located with the extracted app, every launch loses everything in localStorage, the library registry, all SQLite databases, all thumbnails, and all backups — not just "settings."'
date: 2026-05-03
status: tasks-created
superseded_by:
tasks_spawned: [TASK-052, TASK-053, TASK-054]
root_cause_category: silent-failure
affects:
  - 'Electron `userData` path resolution for the Windows portable target (src/main.ts:36-58)'
  - 'Library registry persistence — `{userData}/libraries.json` and `{userData}/active-library.json` (common/library-registry.ts:11-12, 60-62)'
  - 'Per-library SQLite database location — `{userData}/libraries/{libraryId}/onefolder.db` (common/library-registry.ts:169-171)'
  - 'Per-library SQLite WAL/SHM sidecars and backups (`{userData}/libraries/{libraryId}/onefolder.db-wal`, `-shm`, `backups/`) (docs/multi-library.md:30-41)'
  - 'Thumbnail cache — in portable mode redirected to `{userData}/thumbnails/{libraryId}/` (src/ipc/renderer.ts:180-192)'
  - 'Themes directory — `{userData}/themes/` (src/ipc/renderer.ts:201-204)'
  - 'localStorage (`{userData}/Local Storage/leveldb/`) — owns ALL renderer-side preferences, including the four per-library namespaced keys (`{libraryId}:preferences`, `{libraryId}:OneFolder_File`, `{libraryId}:hierarchical-separator`, `{libraryId}:location-store-preferences`) and the global keys (`OneFolder_Window`, `tag-editor-height`)'
  - 'Window state file — `{userData}/windowState.json` (src/main.ts:63, 1013)'
  - 'Global preferences file — `{userData}/preferences.json` (src/main.ts:62, 93)'
  - 'Auto-update state (irrelevant in this fork — already gated off in portable mode at src/main.ts:128)'
  - 'electron-builder portable target wrapper — `portable.nsi` template (node_modules/app-builder-lib/templates/nsis/portable.nsi:33-38, 77-79, 90)'
---

## Bug Report

### Observed Behavior

The user reports that the Windows portable build of OneFolder (`dist\brave.exe`, produced by `yarn package:portable`) does not persist user state across launches. The specific symptoms called out:

1. **Theme preference is lost.** The user manually selected dark mode (or otherwise non-default) and on the next launch the app reverts to the default.
2. **Sort order preference is lost.** Same pattern — the user picked a sort, restart, sort returns to the field-initializer default.
3. **Library state appears reset.** The user implies "fresh install" behavior. If true, this is broader than preferences — it would mean `libraries.json` itself is being lost, which would force the main process at `src/main.ts:74-77` to re-create the default "My Library" entry every launch.
4. The user observed the path `C:\Users\rjdol\AppData\Local\Temp\3CgR4ivGOpSxHbiBAyzrUmQma5t\OneFolder.exe` from a previous debugging session — a `%TEMP%\<random>\` directory containing what was the inner Electron exe. (The basename `OneFolder.exe` indicates this observation predates the brave.exe rename in INV-005 / TASK-026, so the captured path itself is stale, but the structural concern about a per-launch random temp dir owning the process is current.)

The architectural concern that prompted this investigation: **electron-builder's Windows ``portable`` target self-extracts the unpacked app to a per-launch random `%TEMP%\<...>\` directory**, and the portable wrapper deletes that directory on normal exit (`portable.nsi:90` `RMDir /r $INSTDIR`). If `userData` is co-located with the extracted app — even transiently — every launch wipes all persisted state.

### Expected Behavior

For a portable build the persistence policy should be **next-to-the-exe** (the spirit of "portable" is "everything travels together"):

1. `app.getPath('userData')` should resolve to a directory **alongside the outer `brave.exe`**, e.g. `<exe-dir>/data/`, not inside the `%TEMP%\<random>\` self-extract directory.
2. After running `dist\brave.exe`, a `data/` directory should exist alongside it containing `libraries.json`, `active-library.json`, `libraries/<uuid>/onefolder.db`, `Local Storage/leveldb/...` (Chromium localStorage), `windowState.json`, `preferences.json`, `themes/`, `thumbnails/`, `backups/`. None of these should ever live under `%TEMP%`.
3. Closing and re-launching `dist\brave.exe` should pick up exactly that directory: theme, sort order, library list, SQLite contents, thumbnail cache, and every renderer-side preference all persist.
4. `%APPDATA%\OneFolder\` (the Electron default for non-portable installs) should NOT be created when the portable build runs — the two persistence locations must not collide.

These are the specifications already documented in `docs/multi-library.md:51` and the implementation at `src/main.ts:36-58` is intended to enforce them.

### Reproduction Context

Deterministic if the hypothesis is correct:

1. Build: `yarn package:portable`. Output: `dist\brave.exe`.
2. Copy `dist\brave.exe` to a fresh, clean directory, e.g. `C:\Temp\onefolder-portable-test\` (NOT a directory that already contains a `data/` from a prior run — that biases the test).
3. Launch. Pick a theme (e.g. dark), a sort (e.g. random), create a second library, add a location.
4. Close OneFolder. Confirm via Task Manager that the `brave.exe` process tree is fully torn down (the portable wrapper's NSIS exit path runs `RMDir /r $INSTDIR` on the self-extract dir at `portable.nsi:90`).
5. Re-launch. Observe whether theme / sort / library list / location list are retained.

Variants worth testing:
- **No `portable.txt` / `data/` sentinel next to the exe** before first launch — this is the canonical "user just downloaded brave.exe" state. The portable wrapper unconditionally sets `PORTABLE_EXECUTABLE_DIR=$EXEDIR` (`portable.nsi:77`), so the env-var detection branch in `src/main.ts:41` should still trigger portable mode and create `data/` next to the exe on first launch.
- **Sentinel present** (`portable.txt` or pre-existing `data/`) — should also work, via the file-presence branches in `src/main.ts:42-43`.
- **Run from a path that contains a space or unicode character** — sanity check for path-quoting bugs in the wrapper's `ExecWait`.
- **Run from a read-only location** (CD, network share where current user lacks write) — should fail loudly (the `fse.ensureDirSync` at `src/main.ts:48-51` would throw), but verify the failure mode is not silent fallback to a per-launch path that mimics the bug.

Platform: Windows 11 Pro 10.0.26200. Electron 27.1.2. electron-builder 23.6.0. better-sqlite3 12.8.0.

---

## Root Cause Analysis

**Category:** silent-failure (with a side-order of architectural-shortcoming around verifiability)

### Diagnosis

#### What the code currently does (correct path)

`src/main.ts:36-58` already implements next-to-the-exe portable redirection:

```ts
const _portableAppDir =
  process.env.PORTABLE_EXECUTABLE_DIR ??
  (app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..'));

const IS_PORTABLE_MODE =
  process.env.PORTABLE_EXECUTABLE_DIR !== undefined ||
  fse.pathExistsSync(path.join(_portableAppDir, 'portable.txt')) ||
  fse.pathExistsSync(path.join(_portableAppDir, 'data'));

if (IS_PORTABLE_MODE) {
  const portableDataDir = path.join(_portableAppDir, 'data');
  fse.ensureDirSync(portableDataDir);
  fse.ensureDirSync(path.join(portableDataDir, 'backups'));
  fse.ensureDirSync(path.join(portableDataDir, 'thumbnails'));
  fse.ensureDirSync(path.join(portableDataDir, 'themes'));
  app.setPath('userData', portableDataDir);
  app.setPath('temp', portableDataDir);
}
```

The flow is:

1. `PORTABLE_EXECUTABLE_DIR` is set unconditionally by the portable wrapper's NSIS section to `$EXEDIR` (the directory holding the OUTER `brave.exe` on disk; verified at `node_modules/app-builder-lib/templates/nsis/portable.nsi:77`).
2. The env-var presence triggers `IS_PORTABLE_MODE = true` regardless of any sentinel file.
3. `portableDataDir = <outer-exe-dir>/data/`.
4. `app.setPath('userData', portableDataDir)` is called **before `app.whenReady()`** (the call lives at module scope; `app.whenReady().then(initialize)` is not invoked until line 445). Electron's documentation requires `setPath` to run before any Chromium subsystem caches the original path — this ordering constraint is satisfied.
5. After this redirection, Chromium's localStorage, IndexedDB, Cache, Cookies, Service Worker storage, and any `app.getPath('userData')` consumer all see `<outer-exe-dir>/data/` as the base.

In **dev** (`yarn start`), `app.isPackaged === false`, so `_portableAppDir = path.resolve(__dirname, '..')` which evaluates to the project root (`D:\Dev\OneFolder`). Because a `data/` directory exists at the project root from prior dev runs, `IS_PORTABLE_MODE` is `true`, and `userData` is redirected to `D:\Dev\OneFolder\data\`. This is verifiable on the current working tree:

```
D:\Dev\OneFolder\data\
├── active-library.json
├── libraries.json
├── libraries\<uuid>\onefolder.db
├── Local Storage\leveldb\           ← Chromium localStorage lives here
├── thumbnails\
├── themes\
├── backups\
├── preferences.json
└── windowState.json
```

The presence of `Local Storage\leveldb\` and a populated `libraries\<uuid>\` confirms the dev build persists correctly into `data/`. **The mechanism works.** This rules out "the implementation is fundamentally wrong."

#### Why the user is still seeing non-persistence — three plausible scenarios

The user's reported symptoms are real, but the source of the symptom is most likely **NOT the implementation in `src/main.ts:36-58`** as it stands. The most likely causes, in order of probability:

**Scenario 1 (highest probability): the user's "non-persisting" observation is from a stale build that predates TASK-013 and/or TASK-026.**

The temp path the user cited — `C:\Users\rjdol\AppData\Local\Temp\3CgR4ivGOpSxHbiBAyzrUmQma5t\OneFolder.exe` — names the inner exe `OneFolder.exe`, not `brave.exe`. The brave.exe rename landed in TASK-026 (electron-builder `win.executableName: "brave"`, `package.json:56`); that change is in the working tree right now. So the cited evidence is from a build before that rename. The portable-mode bootstrap (`src/main.ts:36-58`) was added in TASK-013 (DONE), but if the user's observation predates TASK-013 too, then the build they tested would have been a vanilla `app.getPath('userData')` that lived inside the `%TEMP%\<random>\` extraction dir and got wiped on every exit. That perfectly matches the reported symptom — and is fixed in the current code.

**Verification:** rebuild from current `master` (`yarn package:portable`), test from a fresh directory (no pre-existing `data/`), and confirm a `data/` is created alongside `dist\brave.exe` containing `libraries.json` and `Local Storage\leveldb\...`. If yes, the bug was already fixed; this investigation closes with a "verified-not-broken" QA task and the documentation of how it works.

**Scenario 2 (medium probability): the build works correctly when the exe is in a writable directory the user owns, but breaks if the user runs `dist\brave.exe` from somewhere unusual.**

Specifically:

- **Run from inside `dist/`.** Today, `dist/` exists at `D:\Dev\OneFolder\dist\` but no `data/` is alongside `dist\brave.exe` (verified: `ls D:/Dev/OneFolder/dist/` shows only `brave.exe`, `builder-debug.yml`, `builder-effective-config.yaml`, `win-unpacked/`). On first launch, `data/` would be created at `D:\Dev\OneFolder\dist\data\`. **However**, the project root has its own `D:\Dev\OneFolder\data\` (the dev-mode portable dir). If the user manually launches `dist\brave.exe` to test, it should produce a SEPARATE `dist\data\` — but if they somehow conflate the two, they would observe what looks like "I changed this and it didn't take" because they checked the dev `data/` instead of the dist `data/`. This is a self-inflicted observation error, not a bug, but it is the kind of confusion the reported symptom would produce.

- **Run from a Downloads folder or a subdirectory that gets cleaned.** Some Windows machines have aggressive Storage Sense rules ("Delete files in my Downloads folder that haven't been opened in 30 days"), or the user may keep `brave.exe` on a network share / OneDrive folder with sync conflict resolution that strips the sibling `data/`. These would all manifest as "preferences don't persist."

- **Antivirus quarantine.** INV-005's "Risks and Tradeoffs" §4 already flagged that an unsigned `brave.exe` whose name impersonates Brave Browser may trip heuristic AV. If AV deletes or relocates `brave.exe` between sessions, the redirection still works on the surviving launch, but a re-download to a different location creates a new `data/` (the old one is orphaned), looking exactly like "fresh install."

**Scenario 3 (low probability): a path-resolution edge case in `src/main.ts:36-58` that fails silently.**

Three concrete edge cases worth defensive hardening:

a. **`fse.ensureDirSync` failing.** If `<outer-exe-dir>` is not writable for the current user (read-only mount, locked-down corporate Windows policy), `ensureDirSync` throws synchronously at module load. The exception is unhandled — Electron will likely show a generic startup crash, not a silent fall-back, so this is not actually silent. Still: there is no try/catch around lines 48-51, and the failure mode is not user-friendly.

b. **`PORTABLE_EXECUTABLE_DIR` is set but points at a directory that no longer exists.** Cannot happen for a normally-launched outer wrapper because `$EXEDIR` is the dir of the running process, but it could happen if the env var leaked into a child via `env: process.env` (cf. INV-003 / TASK-020 — that exact bug-class is already documented and pending fix). For this investigation's purposes, the leak is a separate concern; the fix is being tracked in TASK-020.

c. **`process.execPath` fallback in non-portable runs.** Line 38 falls back to `path.dirname(process.execPath)` when `PORTABLE_EXECUTABLE_DIR` is undefined. For a packaged but **not** portable build (e.g., if the user ever switched to NSIS), `process.execPath` is `<install-dir>/OneFolder.exe`, and `_portableAppDir` becomes the install dir. If the user happened to drop a `data/` folder into `Program Files\OneFolder\` (say, by manual file management), this would silently flip the install into portable mode, redirect `userData` into Program Files (which Windows blocks for non-elevated processes), and `ensureDirSync` would throw. Cascade: the user observes "settings don't save" but actually the app crashed during startup. This fork drops the NSIS target (`package.json:57-59`), so the case is moot for this codebase, but the defensive hardening (catch the `ensureDirSync` failure, log it, fall back to `app.getPath('userData')` and surface a warning to the user) costs little.

#### Why the diagnosis is "silent-failure" rather than another category

**Wrong mental model?** No. The implementation matches the documented intent in `docs/multi-library.md:51`. The contributor (TASK-013) understood electron-builder's portable wrapper correctly and implemented the right redirection.

**Architectural shortcoming?** Partially. The architecture is correct, but there is no automated test or CI gate that **proves** the redirection works for a real packaged build. TASK-027 was the verification task; its `completion_note` says "Closed as verified through normal use ... Formal QA checklist not executed." So the architecture has a verification gap, not a design gap.

**Incorrect order of operations?** No. `app.setPath('userData', ...)` runs at module load, before `app.whenReady()`. Verified.

**Missing edge case?** Some — see Scenario 3 above. None of those edge cases match the reported symptom shape ("fresh install every launch") for a normal local run, but they are worth defensive hardening.

**Wrong abstraction?** No. The single-point override (`app.setPath('userData')`) is the canonical Electron mechanism.

**Silent failure?** Yes — this is the best fit. If the redirection were ever NOT happening (because of a stale build, a per-machine path issue, or one of the Scenario 3 edge cases), the app would silently start up writing to a doomed temp dir AND the user would observe exactly what they describe: "fresh install every launch." There is no UI surface (Settings page, log line, console message) that confirms to the user "you are running in portable mode and your data lives at X." That absence of an audit trail is the silent-failure shape — when something goes wrong, the user has no way to know it went wrong.

The fix has two prongs: (a) verify the current code works on a real packaged build, (b) add a small, persistent observability surface so future regressions are obvious.

### Diagnostic Questions Considered

- **Wrong mental model?** No — the redirection is correct in design. The contributor (TASK-013) and the multi-library design (`docs/multi-library.md:51`) both anchor on next-to-the-exe.
- **Architectural shortcoming?** Mild — there is no CI test that exercises the packaged portable build's `userData` path. INV-005's TASK-027 (the QA task) was closed without running its checklist.
- **Incorrect order of operations?** No — `app.setPath` happens before `app.whenReady()`.
- **Missing edge case?** Yes, three minor ones (Scenario 3 a/b/c) — none match the reported symptom shape but all are worth defensive treatment.
- **Wrong abstraction?** No — `app.setPath('userData')` is the right hammer.
- **Silent failure?** Yes — if the redirection is ever bypassed, the user has no on-screen indicator that something is wrong; the only symptom is "preferences don't persist."

---

## Blast Radius

The user's prompt called this out: the report mentioned only "settings" but the same root cause (if `userData` ever points at an ephemeral location) takes down everything that lives under `userData`. Listed in order of user-visibility:

1. **Library registry — `libraries.json` and `active-library.json`** (`common/library-registry.ts:11-12, 60-62, 145`). Lost on every launch ⇒ `src/main.ts:74-77` recreates "My Library" (a fresh UUID). The user's previous library entries (with their UUIDs and lastOpenedAt timestamps) are GONE, and any per-library SQLite databases that lived under `libraries/<old-uuid>/` are orphaned (still on disk if `userData` was persistent, lost forever if userData was inside the `%TEMP%` extract dir).

2. **Per-library SQLite database — `libraries/{libraryId}/onefolder.db`** (`common/library-registry.ts:169-171`). Lost ⇒ all imported files, all tags, all locations, all visual hashes, all metadata. The user re-imports from scratch every launch. This is by FAR the largest blast — a library with thousands of photos may take minutes to re-index, and any tags / annotations the user added are unrecoverable if metadata-write was disabled.

3. **SQLite WAL/SHM sidecars — `onefolder.db-wal`, `onefolder.db-shm`** — present only while WAL mode is active, but if the WAL was cleanly checkpointed before close (per `RootStore.close()` in `src/frontend/stores/RootStore.ts`, the SQLite handle release at step 3 should checkpoint), they should not exist on next launch. If they DO exist mid-session and the userData dir gets wiped, in-flight transactions are lost. INV-003 already documents this concern for the database-restore flow.

4. **SQLite backups — `libraries/{libraryId}/backups/`** (`docs/multi-library.md:35-38`). Lost ⇒ the `SQLiteBackupScheduler` writes new backups but the user's history is gone every launch.

5. **Thumbnails — in portable mode at `{userData}/thumbnails/{libraryId}/`** (`src/ipc/renderer.ts:180-192`). Lost ⇒ every gallery view re-generates thumbnails, which is expensive (PSD, HEIC, EXR, RAW formats are slow). At a multi-thousand-image library this is observable as a slow first scroll on every launch.

6. **Custom themes — `{userData}/themes/`** (`src/ipc/renderer.ts:201-204`). Lost ⇒ user-installed CSS themes vanish.

7. **localStorage — `{userData}/Local Storage/leveldb/`**. Owned by Chromium. Holds:
   - `{libraryId}:preferences` — UiStore (theme, thumbnail dir, view settings, inspector state, hotkeys) (`src/frontend/stores/UiStore.ts`, `getPreferencesStorageKey`)
   - `{libraryId}:OneFolder_File` — FileStore (sort order + direction) (`src/frontend/stores/FileStore.ts`, `getFileStorageKey`)
   - `{libraryId}:hierarchical-separator` — ExifTool tag-hierarchy separator
   - `{libraryId}:location-store-preferences` — LocationStore enabled file extensions
   - `OneFolder_Window` — global fullscreen state
   - `tag-editor-height` — global FileTagEditor panel height
   Source: `docs/multi-library.md:56-66`.

8. **Window state — `{userData}/windowState.json`** (`src/main.ts:63, 1013`). Lost ⇒ window opens at default size/position every launch instead of where the user last left it.

9. **Global preferences — `{userData}/preferences.json`** (`src/main.ts:62, 93`). Lost ⇒ `checkForUpdatesOnStartup` defaults back to `true` every launch (irrelevant because portable mode gates auto-update off anyway, but it's still a stale write).

10. **Migration idempotency — `migrateToMultiLibraryLayout` in `src/renderer-migration.ts`**. The function is idempotent because it bails when the new per-library path already exists. But if `userData` is wiped every launch, both the legacy `{userData}/onefolder.db` AND the new `{userData}/libraries/{libraryId}/onefolder.db` are gone, so the migration runs every launch as a no-op (the legacy file isn't there either). Not a correctness bug, but it does mean the migration is structurally exposed — any future bug in the migration would re-fire forever.

11. **IndexedDB → SQLite migration tool — `migrateIfNeeded`** (`src/backend/migration-indexeddb-to-sqlite.ts`, called at `src/renderer.tsx:93`). Same shape as #10 — idempotent against existing SQLite, but if `userData` is wiped and the old IndexedDB happens to also live there (it does, in `{userData}/IndexedDB/`), the migration runs on an empty database every launch.

12. **Chromium-managed state under `userData`** — Cookies, Cache, Code Cache, Local State (Chromium settings file), Network/, Preferences (Chromium settings, distinct from `{userData}/preferences.json`), Session Storage, Service Worker storage, Indexed DB, GPUCache, DawnCache, blob_storage, databases. None of these are user-facing in OneFolder specifically (no cookies, no PWA, no service workers), but they collectively fill the userData dir. They get re-created every launch, which is harmless beyond a few extra MB of disk churn.

13. **Single-instance lock** (`app.requestSingleInstanceLock()` at `src/main.ts:423`) — process-level, not path-level, so it works regardless of where userData lives. Not affected.

14. **Auto-updater** — `electron-updater` reads `app.getVersion()` and writes a small cache under `userData`, but the actual update check is gated off in portable mode (`src/main.ts:128`, `src/main.ts:775-794`). The auto-updater's userData footprint is tiny and lossy-ok.

15. **`forceRelaunch`** (`src/main.ts:1018-1041`) — re-executes `PORTABLE_EXECUTABLE_FILE` (the outer wrapper). Its env-var leak bug is being tracked separately in TASK-020 (INV-003). **Note for this investigation:** if `forceRelaunch` propagates `PORTABLE_EXECUTABLE_FILE` and `PORTABLE_EXECUTABLE_DIR` from the dying parent's env to the child, the child is still pointed at the right OUTER exe location, so the child's portable redirect still lands on `<outer-exe-dir>/data/`. The "delete user data" version of the bug (TASK-020) is about the PARENT's NSIS-extracted temp dir being deleted out from under the child, which doesn't affect persistent user data — those live in `<outer-exe-dir>/data/`. So INV-012 and INV-003 are independent.

16. **The dev build (`yarn start`) — UNAFFECTED.** Verified by reading `data/` at the project root. The dev build hits the same portable-mode branch (because `data/` exists at the project root) and persists into `D:\Dev\OneFolder\data\`. The user's daily dev usage works precisely because of this; they would not have noticed a packaged-portable issue from dev alone.

---

## UX / Requirements Specification

### Purpose

Confirm and (if needed) lock down that the Windows portable build (`dist\brave.exe` from `yarn package:portable`) persists ALL user state — preferences, library registry, SQLite databases, thumbnails, backups, window state — in a directory next to the outer executable, not in the per-launch `%TEMP%\<random>\` self-extract directory.

### User-Stated Design Decisions

The user's prompt explicitly listed three persistence-policy options:

(a) **Next-to-the-exe** (`<exe-dir>/data/`) — classic portable, everything travels together.
(b) **Per-user `%APPDATA%`** — Electron default for non-portable installs, persistent per-user.
(c) **Per-machine `%APPDATA%/OneFolder-portable`** — compromise, distinguishable from any installed-build state.

The user stated: "Default recommendation in the absence of explicit user intent: **(a) next-to-the-exe**, since the user packaged a 'portable' build deliberately and the spirit of portable is 'everything travels together.'"

**Decision: option (a), next-to-the-exe.** Three reasons confirm this:

1. **It is already the implemented and documented intent.** `docs/multi-library.md:51` says: "When OneFolder runs in portable mode, `app.setPath('userData', ...)` and `app.setPath('temp', ...)` both point to `{appDir}/data/`." The implementation at `src/main.ts:36-58` does exactly that. This investigation is not changing the policy; it is confirming and verifying it.
2. **The user runs this on a single Windows 11 machine.** Per `docs/personal-fork-notes.md`, this is a personal fork. There is no need for cross-user persistence, and option (b) would require hidden coordination with `productName` and `app.getName()` defaults.
3. **The fork dropped the NSIS installer target** (`package.json:57-59`, INV-005). There is no installed-build to coexist with, so option (c) is unnecessary defensive complexity.

Other user-stated decisions extracted from the investigation prompt:

1. **The investigation must expand scope beyond "settings."** Per the user: "The user mentioned only 'settings'; the agent should expand the scope to whatever IS actually affected by the same root cause and document it." Done in §Blast Radius — the same root cause (if it were ever to fire) takes out the library registry, SQLite databases, thumbnails, backups, window state, and global preferences alongside localStorage.

2. **No source-code changes in this investigation.** Per the user: "This is INVESTIGATE-ONLY. Do not modify source code, only docs." Honored. Spawned tasks include a verification (TASK-052), defensive hardening that is purely additive (TASK-053), and a documentation/QA task (TASK-054). The verification task may surface that no code change is needed at all.

3. **Migration of pre-existing portable-user data is not required.** Per the user: "If migration of any existing portable-user data is needed (probably not — portable users have never persisted, so there is nothing to migrate), include that too." Confirmed: portable users have not been persisting (per the report) so there is nothing to migrate from. The first launch after the verified-working build will create fresh `data/` and proceed normally.

### Behavioral Specifications

After this investigation closes:

1. **Fresh portable launch.** `dist\brave.exe` placed in a clean directory `<X>\`. Launch. After the first session:
   - `<X>\data\` exists and contains `libraries.json`, `active-library.json`, `libraries\<uuid>\onefolder.db`, `Local Storage\leveldb\<files>`, `windowState.json`, `preferences.json`, `themes\`, `thumbnails\`, `backups\`.
   - `%APPDATA%\OneFolder\` does NOT exist.
   - No files were left in `%TEMP%\<random>\` after exit (the wrapper's `RMDir /r $INSTDIR` cleaned them up).

2. **Subsequent portable launches.** Re-launch `dist\brave.exe` from the same directory. The persisted state is read; theme, sort, libraries, locations, tags, and thumbnails all carry over unchanged.

3. **Move the exe + data dir together.** Copy `<X>\brave.exe` AND `<X>\data\` to a different machine or location `<Y>\`. Launch. State carries over because everything traveled together. (This is the "spirit of portable" check.)

4. **Move the exe WITHOUT the data dir.** Copy only `<X>\brave.exe` to `<Y>\`. Launch. A fresh `<Y>\data\` is created (because no sentinel and no data dir trigger the portable detection — but the env var is set unconditionally by the wrapper, so portable mode still activates). The user's old state at `<X>\data\` is intact and will be picked up if they launch from `<X>\` again. This is the correct "two independent portable instances" behavior; not a bug.

5. **No user-visible regression to dev mode.** `yarn start` continues to use `D:\Dev\OneFolder\data\`. Verified currently.

6. **Switching libraries continues to work end-to-end.** `LibrarySelector` opens, user picks a different library, `onSwitchLibrary` fires, the renderer reloads with the new `libraryId`, and all of that library's state is read from `<X>\data\libraries\<that-uuid>\`.

### Explicit Rejections

- **Do NOT change the persistence policy to option (b) or (c).** The user explicitly preferred (a) and the implementation already matches.
- **Do NOT add a UI prompt asking the user where to put `data/` on first portable launch.** Out of scope and contrary to the "everything travels together" intent.
- **Do NOT migrate existing per-launch ephemeral data.** Per the report, portable users have never persisted, so there is nothing to migrate from.
- **Do NOT introduce a separate environment variable or settings.json key for "portable persistence directory override."** Future portability work might want this, but the user did not ask for it and the spirit-of-portable answer is "next to the exe, no override."
- **Do NOT delete or refactor the `portable.txt` / `data/` sentinel-file detection branches in `src/main.ts:42-43`.** They remain valid for users who deliberately copy the exe to a directory and want to opt into portable mode without relying on the env-var-set-by-wrapper path. (E.g., a user who renames the exe back, or runs it via a custom launcher that strips env vars.)
- **Do NOT widen scope to address INV-003 / TASK-020 (the `forceRelaunch` env-var leak).** That bug is independent and already tracked.
- **Do NOT widen scope to add a mechanism for the user to relocate `data/` after-the-fact** (e.g. a "move user data" Settings flow). Out of scope for this investigation; if needed later, file a separate INV.

### Uncertainty resolution

The investigation could not, from documents and source alone, **prove** that the symptom the user reports does NOT currently occur — only that the code path that should fix it is correctly implemented and is verifiably working in dev. The decisive verification requires running the packaged portable artifact in a clean directory and inspecting the resulting on-disk layout. That is precisely TASK-052's role.

If TASK-052 confirms persistence works, the investigation closes with a "verified-not-broken" finding plus the defensive hardening from TASK-053. If TASK-052 surprises by finding the redirection is NOT working in the packaged build, this investigation reopens with the actual evidence and a follow-up task is added to fix whatever specific discrepancy was found (with extremely high prior-probability that it would be one of Scenario 3's edge cases or an unforeseen electron-builder 23.6.0 quirk).

---

## Holistic Solution

### Approach

Three tasks, ordered by dependency:

1. **TASK-052 — Verify the packaged portable build persists `userData` correctly.** Manual QA. Build `dist\brave.exe` from current master. Copy to a clean directory outside the repo. Launch, change theme/sort/library, close, re-launch. Confirm persistence. Inspect `<X>\data\` contents to confirm the layout matches the spec. Confirm `%APPDATA%\OneFolder\` is NOT created. This is the decisive evidence.

2. **TASK-053 — Add defensive hardening and an observability surface to the portable-mode bootstrap.** Wrap `fse.ensureDirSync` calls in try/catch with a clear error dialog if the data directory cannot be created (Scenario 3a). Add a `console.info` line on every startup logging the resolved `userData` path and whether portable mode was triggered, so any future regression has a visible audit trail. Optionally surface "Portable mode: data dir is `<path>`" in Settings → Advanced as a read-only diagnostic. This task IS a code change but is intentionally additive — no behavior change to the happy path; the only change is failure-mode visibility.

3. **TASK-054 — Update `docs/personal-fork-notes.md` and `docs/multi-library.md` with the verified persistence behavior.** Cite this investigation, lock in the next-to-the-exe policy with explicit reasoning, and document the verification protocol so future contributors can re-run it after every electron-builder bump. This is the institutional-knowledge step.

### Conditional follow-up (NOT created upfront)

If TASK-052 surprises by finding the redirection is NOT working in the packaged build, file a new TASK at that point with the specific evidence — the most likely shape would be one of:

- A bug in `app.setPath` ordering relative to some Electron 27 internal cache → fix is a new ordering tweak in `src/main.ts`.
- `PORTABLE_EXECUTABLE_DIR` not being set by the wrapper for some reason → fix is reading the same value via an alternative path (e.g. `path.dirname(process.env.PORTABLE_EXECUTABLE_FILE)`) as a defense-in-depth fallback.
- electron-builder 23.6.0 portable wrapper inserting the inner exe into a path with a `unicode` or `space` character that breaks `ExecWait` quoting → fix is `unpackDirName` or similar pinning.

Don't pre-write that fix; the verification task will tell us what the actual issue is, if any.

### Expected Outcomes

- After TASK-052: a verified, on-disk `<exe-dir>\data\` directory containing `libraries.json`, SQLite, localStorage, thumbnails, etc. — proving the implementation works for the packaged portable build. Any state changes (theme, sort, libraries) survive a close-and-relaunch cycle.
- After TASK-053: a clear error path if the data dir cannot be created, plus a startup log line and a Settings diagnostic that future maintainers can use to confirm portable mode is active and `userData` is where they expect.
- After TASK-054: documentation explicitly lists the verified persistence policy, the verification commands, and the related INVs (this one + INV-002 + INV-005).

### Risks and Tradeoffs

- **Risk: TASK-052 surprises by finding the bug is real in the packaged build.** Mitigated by including a "what to do if QA fails" branch in TASK-052 itself; the most likely fixes are listed in §Conditional follow-up.
- **Risk: TASK-053's diagnostic logging exposes the `userData` path in console output, which could be sensitive on a shared machine.** Mitigated by gating the log behind `IS_DEV` for the path string and showing only a generic "Portable mode active" line in production. (See TASK-053 step 3.)
- **Risk: Adding a "Portable mode: data dir is `<path>`" surface in Settings → Advanced is scope creep.** Mitigated by making it optional — TASK-053's core deliverable is the error-path hardening and the startup log line; the Settings surface is a nice-to-have that can be skipped if reviewers feel it's overreach.
- **Risk: a future electron-builder version changes how `PORTABLE_EXECUTABLE_DIR` is set or removes it entirely.** Mitigated by the existing fallback chain (`portable.txt`, `data/` sentinel) and by the documentation in TASK-054 that records the citation chain, so a future contributor can re-verify.
- **Tradeoff: "verify-don't-fix" is a soft outcome.** If the underlying bug is somehow specific to the user's machine and TASK-052 fails to reproduce it on an arbitrary Windows machine, the investigation may close as "could not reproduce" and the user has to provide more detail. This is a known shape for bug reports based on stale evidence (the `OneFolder.exe` temp path predates the brave.exe rename) and is the right place to land if the data supports it.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated:
  - `docs/multi-library.md` — section "On-Disk Layout" / "Portable mode" subsection — add a short "Verification" subsection citing this investigation and TASK-052's protocol.
  - `docs/personal-fork-notes.md` — section "Portable-only, no installer" — add a paragraph about the verified persistence policy and the diagnostic surface added in TASK-053.

(Both updates are in scope of TASK-054.)
