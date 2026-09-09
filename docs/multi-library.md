---
title: Multi-Library Support
author: @system
last_updated: 2026-04-21
scope: feature
aliases: ["multi-library", "libraries", "library-registry", "library-switching"]
---

# Multi-Library Support

OneFolder treats a **library** as a first-class entity that scopes its own SQLite database, preferences, thumbnail cache, and database backups. Users can create multiple independent libraries — for example, "Personal" and "Client Work" — and switch between them without any data bleeding across boundaries.

## Overview

- **One registry, many libraries.** A single `libraries.json` file in `{userData}` records all known libraries. Each library is identified by a UUID.
- **Full disk isolation.** Each library owns its own subdirectory under `{userData}/libraries/{libraryId}/` containing its database and backups. Thumbnails are stored separately under the system temp directory.
- **Sequential switching only.** The app opens one library at a time. Switching reloads the renderer; simultaneous multi-window access to different libraries is not supported.

## Concepts

- **Library** — A UUID-identified collection with its own SQLite database (`onefolder.db`), database backups, thumbnail cache, and `localStorage` namespace. Identified by a v4 UUID assigned at creation time.
- **Library Registry** — The file `{userData}/libraries.json`, managed by the `LibraryRegistry` class in `common/library-registry.ts`. It stores an ordered array of `LibraryDTO` objects (id, name, createdAt, lastOpenedAt).
- **Active Library** — The file `{userData}/active-library.json`, which records `{ activeLibraryId: string }`. The main process reads this at startup and injects the ID into the renderer URL. It is updated whenever the user switches libraries.

## On-Disk Layout

All per-library data lives under `{userData}` (or `{appDir}/data/` in portable mode — see below).

```
{userData}/
├── libraries.json                        # LibraryRegistry: array of LibraryDTO
├── active-library.json                   # { activeLibraryId: string }
├── libraries/
│   └── {libraryId}/
│       ├── onefolder.db                  # SQLite (from SQLITE_DB_FILENAME)
│       ├── onefolder.db-wal              # (only while WAL is active)
│       ├── onefolder.db-shm              # (only while WAL is active)
│       └── backups/                      # SQLiteBackupScheduler output
├── preferences.json                      # GLOBAL: auto-update settings
└── windowState.json                      # GLOBAL: window position/size
```

Thumbnails are written to the system temp directory, namespaced per library:

```
{temp}/OneFolder/{libraryId}/thumbnails/
```

**Global vs. per-library rationale** (from INV-001): window position and auto-update settings are installation-wide concerns. A user who switches libraries does not want the window to jump or for update checks to reset. Everything that varies by which photos you are looking at — database, backups, thumbnails, preferences — is per-library.

**Portable mode:** When OneFolder runs in portable mode, `app.setPath('userData', ...)` and `app.setPath('temp', ...)` both point to `{appDir}/data/`. The `libraries/` tree then lives at `{appDir}/data/libraries/` and thumbnails at `{appDir}/data/OneFolder/{libraryId}/thumbnails/`. No code changes are required; the path-building functions receive the already-remapped paths.

**Portable unit on each platform.** The portable unit is the executable **plus a sibling `data/` directory** created beside it on first launch:

- **Windows** — the portable `brave.exe` and its sibling `data/`.
- **Linux** — the `OneFolder-<version>-x86_64.AppImage` file and its sibling `data/`.

`data/` holds the per-library `libraries/` tree, `backups/`, `thumbnails/`, `themes/`, and the app temp. To relocate the app, move the executable **and** its sibling `data/` together, and only **while the app is CLOSED** — SQLite (`better-sqlite3`) holds file locks and helper (ExifTool / ffmpeg) processes must be released first. On Linux the AppImage plus `data/` must live in a **writable and executable** location; launched from a read-only or `noexec` path, startup fails loud naming the directory, with **no** fallback to the system user-data dir (state always stays beside the artifact). See the [README Linux build notes](../README.md#linux-appimage) for the full launch/troubleshooting checklist.

**Case-sensitive library paths on Linux.** Library file paths are **case-sensitive** on Linux — `Clip.mp4` and `clip.mp4` are distinct files — whereas Windows treats them as the same file.

## Dual-boot shared library (one library, two OSes)

A single OneFolder library can be **shared across a dual-boot machine**: put both portable executables and one shared `data/` in the same portable directory, and the same library opens from either OS with **no per-boot Location Recovery and no thumbnail/preview/visual-hash re-derivation**.

```
<portable dir>/
├── brave.exe                          # Windows portable
├── OneFolder-<version>-x86_64.AppImage # Linux portable
├── data/                               # ONE shared data dir (both exes)
└── Photos/                             # a location under the portable dir
```

How it works:

- **Portable identity, not absolute path.** A file's durable identity is `(locationId, relativePath)`, not its absolute path (which differs per OS — `D:\…` vs `/mnt/…`). Reconciliation and every path-derived cache (thumbnails, previews, perceptual visual-hashes) key on this identity, so a cross-OS boot matches existing entries instead of re-inserting or regenerating them.
- **Anchored location roots.** A location whose root lies **inside the portable directory** is stored as a root-relative segment (its *portable anchor*) and resolved per-OS at load as `join(<portable dir>, segment)`. Locations on an external drive (outside the portable directory) keep their fixed absolute path and are **not** shared across OSes.
- **One-time migration.** An existing single-OS library upgrades in place on first launch: the DB is backed up first, locations under the portable directory are auto-anchored, and existing caches are **renamed** (not rebuilt) to the portable key. The migration is idempotent and safe to run from either OS of the shared `data/`.

**Case-sensitivity caveat.** The case-fold policy is chosen from the **library filesystem** (probed empirically at open), not the running OS. On a case-sensitive shared tree, `A.jpg` and `a.jpg` stay distinct even when the library is opened from Windows — so no sibling is shadowed or has its tags merged. Keep a shared library on a filesystem whose case-sensitivity is consistent between boots; do not, for example, expose a case-sensitive Linux tree to Windows and then create case-only-distinct siblings.

**Not supported:** simultaneous access from both OSes (SQLite holds a single-writer lock — one OS at a time), and cross-*library* portability (two separate databases). Windows drive-letter paths are not rewritten into Linux mount paths for **unanchored** (external-drive) locations.

## localStorage Namespacing

Renderer-side preferences are stored in `localStorage`. Keys that vary by library are prefixed with `{libraryId}:` so that switching libraries always reads the correct set of preferences. Keys that are installation-wide remain unprefixed.

| Key | Scope | Notes |
|-----|-------|-------|
| `{libraryId}:preferences` | Per-library | UiStore — theme, thumbnail dir, view settings, inspector state, hotkeys, etc. |
| `{libraryId}:OneFolder_File` | Per-library | FileStore — sort order and sort direction |
| `{libraryId}:hierarchical-separator` | Per-library | ExifTool tag hierarchy separator character |
| `{libraryId}:location-store-preferences` | Per-library | LocationStore — enabled file extensions |
| `OneFolder_Window` | Global | Window fullscreen state |
| `tag-editor-height` | Global | FileTagEditor panel height |

Source of truth: `migrateToMultiLibraryLayout` in `src/renderer.tsx` (shows the four keys that are migrated) and the `getPreferencesStorageKey` / `getFileStorageKey` helpers in `src/frontend/stores/UiStore.ts` and `src/frontend/stores/FileStore.ts`.

## Startup Flow

The main process and renderer cooperate at startup to agree on which library is active:

1. Main process constructs `LibraryRegistry(basePath)`, which reads `{userData}/libraries.json`. If no libraries exist (fresh install), it creates the default "My Library" entry and writes `active-library.json`.
2. Main reads `getActiveLibraryId()` from `active-library.json` to determine which library was last opened.
3. Main loads `index.html?libraryId={uuid}` into the main window. The preview window, if opened later, receives the same `libraryId` param via `&libraryId={uuid}`.
4. Renderer parses `libraryId` from the URL query string. If this is a first launch after an upgrade (legacy `{userData}/onefolder.db` exists but the new per-library path does not), `migrateToMultiLibraryLayout` moves the database, backups, and `localStorage` keys. Then `getSqliteDbPath(userData, libraryId)` provides the database path and `sqliteInit` opens it.
5. `RootStore.main(backend, backup, libraryId)` propagates the ID into `UiStore`, `FileStore`, `LocationStore`, and `ExifIO` so every `localStorage` read/write uses the correct namespaced key.
6. If the renderer loads without a `libraryId` param **and** more than one library exists, it renders `<LibrarySelector />` instead of `<App />`. The selector halts initialization; the user's library choice calls `switchLibrary()`, which reloads the page with the chosen ID.

## Library Selector UI

`src/frontend/containers/LibrarySelector.tsx` is the full-screen selector that appears in multi-library scenarios. It exposes four operations:

- **Open** — sets the active library and reloads into `<App />`.
- **Create** — prompts for a name, registers the new library, and opens it immediately.
- **Rename** — updates the library's display name in the registry.
- **Delete** — removes the registry entry and optionally deletes the library's on-disk data.

The selector is also reachable via Settings > Advanced ("Switch Library"). Single-library users never see it — if exactly one library exists and `libraryId` is present in the URL, initialization proceeds directly to `<App />`, matching the pre-multi-library UX.

## Switching Libraries

When the user picks a different library (from the selector or the Settings menu), the renderer calls the `switchLibrary` IPC command. In `src/main.ts`, the `onSwitchLibrary` handler:

1. Writes the new library ID to `active-library.json` via `registry.setActiveLibrary(newLibraryId)`.
2. Updates the library's `lastOpenedAt` timestamp via `registry.updateLastOpened(newLibraryId)`.
3. Destroys any open preview window — it holds a reference to the old library's data and cannot be cleanly reused.
4. Calls `mainWindow.loadURL(...)` with `?libraryId={newLibraryId}`, triggering a full renderer reload.

The reload causes the browser's `beforeunload` event to fire, which calls `rootStore.close()` to tear down the outgoing library before the new one initializes.

## Teardown (`RootStore.close()`)

`RootStore.close()` in `src/frontend/stores/RootStore.ts` executes three steps in strict order:

1. `await this.exifTool.close()` — flushes all pending metadata writes and terminates the ExifTool child process before it exits. Must run first so no writes are lost.
2. `await this.locationStore.closeAllWatchers()` — terminates every Chokidar `FolderWatcherWorker` so no file-change events fire into the next library's session.
3. `this.#backend.close?.()` — releases the `better-sqlite3` handle so the WAL checkpoints cleanly and the file lock clears before the next library opens its own database.

### Caveat: `imageLoader.close()` is not called

**What was planned:** TASK-005 step 1 in INV-001 called for `this.imageLoader.close()` as part of the teardown sequence, intended to shut down the thumbnail worker pool and the per-format loader workers.

**What actually shipped:** `ImageLoader` (`src/frontend/image/ImageLoader.ts`) has no `close()` method, so the call was omitted from `RootStore.close()`.

**Why it is safe today:** Library switches reload the renderer via `mainWindow.loadURL(...)` in `src/main.ts` (or `RendererMessenger.reload()` when triggered from the selector). The thumbnail worker pool is a module-level singleton created at import time inside `src/frontend/image/ThumbnailGeneration.tsx` (the `workers[]` array around line 26). A full page reload drops the entire module graph, so the old workers are garbage-collected and the new page creates a fresh pool. The per-format loader workers (`HEICLoader`, `PSDLoader`, plus the WASM-backed `TifLoader` / `ExrLoader`) are owned by the `ImageLoader` instance that `RootStore` holds; when the renderer reloads, that instance is discarded along with everything else.

**Why it will break under a future soft-switch:** A soft-switch would keep the renderer process alive and swap only the `RootStore`. The module-level thumbnail worker pool would survive across the switch, and the old `ImageLoader` instance — including its per-format workers and its in-memory `srcBufferCache` — would leak into the next library's session. This could mix thumbnails between libraries and hold file handles open on the old library's images indefinitely.

**What a soft-switch implementer must do:**

1. Add an `async close()` method to `ImageLoader` that terminates each of its per-format workers (`heicLoader`, `psdLoader`, `tifLoader`, `exrLoader`).
2. Add a `resetThumbnailWorkers()` export (or equivalent) to `src/frontend/image/ThumbnailGeneration.tsx` that terminates the module-level `workers[]` array and recreates them.
3. Invoke both from `RootStore.close()` in this order: after `locationStore.closeAllWatchers()`, before `backend.close()`.

## Migration from Single-Library (Pre-INV-001) Installs

The `migrateToMultiLibraryLayout` function in `src/renderer.tsx` handles the one-time migration from the flat single-library layout to the per-library layout. It runs on every startup but is idempotent — the migration is skipped once the new path exists.

**Precondition:** The legacy `{userData}/onefolder.db` exists AND the new per-library path (`{userData}/libraries/{libraryId}/onefolder.db`) does not.

**What gets moved:**

- The SQLite database (`onefolder.db`) and any WAL/SHM sidecars (`onefolder.db-wal`, `onefolder.db-shm`).
- The backup directory (`{userData}/backups/` → `{userData}/libraries/{libraryId}/backups/`).
- The four per-library `localStorage` keys (`preferences`, `OneFolder_File`, `hierarchical-separator`, `location-store-preferences`) are renamed to their `{libraryId}:`-prefixed equivalents.

**What is deliberately left in place:** The existing thumbnail cache. Moving potentially gigabytes of thumbnail data on upgrade was judged worse than leaving orphaned thumbnails (INV-001 Option B). New thumbnails for the migrated library are generated in the new default directory; the old thumbnails remain where they are and eventually go stale.

**Portable mode:** The migration function receives `userDataPath` from the renderer, which is already the portable `data/` directory when running in portable mode. No special portable-mode handling is required in the migration code.

## Key Files

| File | Role |
|------|------|
| `src/api/library.ts` | `LibraryDTO` interface (id, name, createdAt, lastOpenedAt) |
| `common/library-registry.ts` | `LibraryRegistry` class, `getLibraryPaths`, `getSqliteDbPath` |
| `src/main.ts` | Registry instantiation, active-library resolution, `onSwitchLibrary` handler, URL injection |
| `src/renderer.tsx` | URL parsing, `migrateToMultiLibraryLayout`, SQLite open, selector-vs-app branching |
| `src/frontend/containers/LibrarySelector.tsx` | Selector UI (Open, Create, Rename, Delete) |
| `src/frontend/stores/RootStore.ts` | `main()` / `preview()` factories, `close()` teardown |
| `src/frontend/stores/UiStore.ts` | `storageKeyPrefix` constructor parameter, `getPreferencesStorageKey` |
| `src/frontend/stores/FileStore.ts` | `storageKeyPrefix` constructor parameter, `getFileStorageKey` |
| `src/frontend/stores/LocationStore.ts` | `storageKeyPrefix` constructor parameter |
