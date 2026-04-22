---
id: TASK-016
title: 'Document multi-library architecture (docs/multi-library.md, CLAUDE.md, imageLoader.close() deferral caveat)'
investigation: INV-001
status: done
priority: medium
blocked_by: []
date_created: 2026-04-21
date_completed: 2026-04-21
files:
  - 'docs/multi-library.md (new)'
  - 'docs/index.md'
  - 'CLAUDE.md'
---

## What

Close out the two unchecked "Documentation Updates" items from INV-001 and document one undocumented implementation caveat discovered during QA review:

1. **Create `docs/multi-library.md`** — a new feature doc that explains the library concept, the registry files, the per-library on-disk layout, the startup / switch flow, and the one-time migration from the flat single-library layout. Follows the `docs/` style conventions (YAML front-matter, title as H1, lowercase-hyphen filename, cross-links).
2. **Edit `CLAUDE.md`** — add one or two bullets to the "Architecture" section so the library abstraction (`src/api/library.ts`, `common/library-registry.ts`) appears alongside the other top-level subsystems.
3. **Record the `imageLoader.close()` deferral in `docs/multi-library.md`** — TASK-005 step 1 called for `this.imageLoader.close()` to be invoked from `RootStore.close()`, but `ImageLoader` has no `close()` method and the call was omitted. This is safe only because library switches currently reload the page, which tears down the module-level thumbnail workers. A future soft-switch implementation (same renderer process, no reload) would leak those workers into the new library's session. The caveat must be documented so whoever implements soft-switch is warned.

## Why

INV-001's investigation file has two unchecked boxes under "Documentation Updates" (`docs/multi-library.md` and `CLAUDE.md` Architecture section). The task-closer agent cannot move INV-001 to `completed/` until those boxes are checked. Separately, the `imageLoader.close()` omission is an undocumented landmine for a future contributor: the code currently works, so there is nothing to catch the issue, but it will silently break as soon as someone attempts an in-process library switch.

See [INV-001](../investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md).

## Implementation Steps

- [x] 1. **Create `docs/multi-library.md`** with the following exact structure. Use the YAML front-matter from `docs/README.md` §3.1 and match the tone/heading style of `docs/location-loading.md` and `docs/thumbnail-generation.md`.

  **Front-matter:**
  ```yaml
  ---
  title: Multi-Library Support
  author: @system
  last_updated: 2026-04-21
  scope: feature
  aliases: ["multi-library", "libraries", "library-registry", "library-switching"]
  ---
  ```

  **Required headings (in this order):**

  - `# Multi-Library Support` — H1 title; 2-3 sentence elevator pitch that positions a "library" as a first-class entity scoping database, preferences, thumbnails, and backups.
  - `## Overview` — bullet list of the core ideas: one registry, many libraries; each library fully isolated on disk; sequential switching only (no simultaneous multi-window).
  - `## Concepts` — define the vocabulary used throughout the doc: **Library** (a UUID-identified collection with its own SQLite DB, backups, thumbnail cache, and localStorage namespace), **Library Registry** (`libraries.json`), **Active Library** (`active-library.json`).
  - `## On-Disk Layout` — show the exact layout under `userData` as a code-fenced tree. Base it on what is actually written by the code; the layout that ships is:
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
    Also show the thumbnail path in `temp`:
    ```
    {temp}/OneFolder/{libraryId}/thumbnails/
    ```
    Call out which paths are global vs per-library and cite the rationale from INV-001 (window position is a system concern, not a library concern; auto-update is installation-wide).
  - `## localStorage Namespacing` — table of the namespaced keys, the bare keys left global, and why. Source of truth: `migrateToMultiLibraryLayout` in `src/renderer.tsx` and the `getPreferencesStorageKey` / `getFileStorageKey` helpers. At minimum cover:
    - Per-library (prefixed `{libraryId}:`): `preferences`, `OneFolder_File`, `hierarchical-separator`, `location-store-preferences`.
    - Global (unchanged): `OneFolder_Window`, `tag-editor-height`.
  - `## Startup Flow` — ordered steps showing how `src/main.ts` and `src/renderer.tsx` cooperate to pick the active library:
    1. Main process constructs `LibraryRegistry(basePath)` (reads `libraries.json`).
    2. Main reads `getActiveLibraryId()` from `active-library.json`.
    3. Main loads `index.html?libraryId={uuid}` (main and preview windows both get the same ID).
    4. Renderer parses `libraryId` from the URL, runs the one-time migration if needed (`migrateToMultiLibraryLayout`), then opens `getSqliteDbPath(userData, libraryId)` via `sqliteInit`.
    5. `RootStore.main(backend, backup, libraryId)` propagates the ID into `UiStore`, `FileStore`, `LocationStore`, and `ExifIO` so every localStorage read/write is namespaced.
    6. If the renderer loads without a `libraryId` param AND more than one library exists, it renders `<LibrarySelector />` instead of `<App />`. The user's choice sets the active library and reloads with the new ID.
  - `## Library Selector UI` — one paragraph pointing at `src/frontend/containers/LibrarySelector.tsx`. List the operations it exposes (Open, Create, Rename, Delete) and note the "Switch Library" entry in Settings > Advanced. Mention that the selector is skipped for single-library users to match the pre-multi-library UX.
  - `## Switching Libraries` — explain the reload-based switch. Main process handles `onSwitchLibrary` by updating `active-library.json` then calling `mainWindow.loadURL(...)` with the new `libraryId`; the preview window is closed so it cannot show stale data from the old library. Cross-link to the IPC handler in `src/main.ts` and the teardown path in `RootStore.close()`.
  - `## Teardown (`RootStore.close()`)` — list the steps in the order the method executes them, matching the live code at `src/frontend/stores/RootStore.ts:224`:
    1. `await this.exifTool.close()` — flushes pending metadata writes before the child process exits.
    2. `await this.locationStore.closeAllWatchers()` — terminates every Chokidar `FolderWatcherWorker` so no file-change events fire into the next library's session.
    3. `this.#backend.close?.()` — releases the `better-sqlite3` handle so the WAL checkpoints and the file lock clears before the next library opens its DB.
  - `### Caveat: imageLoader.close() is not called` — **this subsection is required**, not optional. Document, in this order:
    - What was planned: TASK-005 step 1 in INV-001 called for `this.imageLoader.close()` as step 3 of the teardown sequence.
    - What actually shipped: `ImageLoader` (`src/frontend/image/ImageLoader.ts`) has no `close()` method, so the call was omitted.
    - Why it is safe today: library switches reload the renderer (`mainWindow.loadURL(...)` in `src/main.ts`, or `RendererMessenger.reload()` from the selector). The thumbnail worker pool is a module-level singleton created at import time of `src/frontend/image/ThumbnailGeneration.tsx` (see the `workers[]` initialization around line 26), so a full page reload drops the old workers and the new page creates a fresh pool. The per-format loader workers (`HEICLoader`, `PSDLoader`, plus the WASM-backed `TifLoader` / `ExrLoader`) are owned by the `ImageLoader` instance, which is itself dropped when `RootStore` is discarded on reload.
    - Why it will break under a future soft-switch: a soft-switch keeps the renderer process alive and swaps the `RootStore`. The module-level thumbnail worker pool would survive, and the old `ImageLoader` instance — including its per-format workers and its in-memory `srcBufferCache` — would leak into the next library's session, mixing thumbnails between libraries and holding file handles open on the old library's images.
    - What a soft-switch implementer must do: add an `async close()` method to `ImageLoader` that terminates its per-format workers, add a corresponding teardown hook for the module-level thumbnail workers in `src/frontend/image/ThumbnailGeneration.tsx` (e.g. a `resetThumbnailWorkers()` export), and invoke both from `RootStore.close()` in the documented order (after `locationStore.closeAllWatchers()`, before `backend.close()`).
  - `## Migration from Single-Library (Pre-INV-001) Installs` — describe the idempotent migration in `migrateToMultiLibraryLayout` (`src/renderer.tsx`). Call out the precondition (legacy `{userData}/onefolder.db` exists AND new path does not), what gets moved (`.db` plus any `-wal`/`-shm` sidecars, backup directory, the four localStorage keys), and what is deliberately left in place (existing thumbnail cache, per INV-001 Option B). Mention portable mode nests the whole `libraries/` tree inside `{appDir}/data/` without code changes.
  - `## Key Files` — bullet list pointing to the load-bearing source files so a new contributor can jump in fast:
    - `src/api/library.ts` — `LibraryDTO` interface.
    - `common/library-registry.ts` — `LibraryRegistry` class, `getLibraryPaths`, `getSqliteDbPath`.
    - `src/main.ts` — registry instantiation, active-library resolution, `onSwitchLibrary` handler, URL injection.
    - `src/renderer.tsx` — URL parsing, `migrateToMultiLibraryLayout`, SQLite open, selector-vs-app branching.
    - `src/frontend/containers/LibrarySelector.tsx` — selector UI.
    - `src/frontend/stores/RootStore.ts` — `main()` / `preview()` factories, `close()` teardown.
    - `src/frontend/stores/UiStore.ts` / `FileStore.ts` / `LocationStore.ts` — `storageKeyPrefix` constructor parameter plumbing.

  **Verification:** the doc compiles as valid Markdown, all cross-links resolve, and the heading hierarchy is `# > ## > ###` (no skipped levels). Open the file in a Markdown preview and confirm the on-disk layout tree renders inside a code fence.

- [x] 2. **Update `docs/index.md`** — add `docs/multi-library.md` to the Documentation Index table, keeping the table alphabetically sorted by filename (so the new row slots between `location-loading.md` and `README.md`). Use a one-line description such as "Multi-library registry, per-library on-disk layout, startup and switch flows". This step is required by `docs/README.md` §4 (the index must list every file under `docs/`).

  **Verification:** `docs/index.md` lists `multi-library.md` in the table, in the correct alphabetical position.

- [x] 3. **Edit `CLAUDE.md`** — insert one bullet into the `# Architecture` section so the library abstraction is visible alongside the other top-level subsystems. The bullet should slot in logically near the top (between the `Electron main process` bullet and the `IPC layer` bullet, OR immediately after the `Common` bullet — either is acceptable; pick whichever reads more naturally in context). Exact text to add:

  ```markdown
  - **Library abstraction** (`src/api/library.ts`, `common/library-registry.ts`) — First-class "library" concept that scopes the SQLite database, preferences, thumbnails, and backups per library; the registry lives at `{userData}/libraries.json` (see `docs/multi-library.md`)
  ```

  Do NOT add a second bullet or expand this into a new section — per INV-001's "Documentation Updates" checklist, the requirement is "one or two bullets in Architecture." One bullet is sufficient because `docs/multi-library.md` carries the full architectural detail.

  **Verification:** `git diff CLAUDE.md` shows exactly one inserted bullet under `# Architecture`, with no other changes.

- [x] 4. **Cross-reference pass** — after writing `docs/multi-library.md`, add a one-line link to it from `docs/location-loading.md` and `docs/thumbnail-generation.md` if (and only if) those documents already mention library-scoped paths or per-library thumbnails. If they do not, skip this step — do not expand scope into content edits unrelated to INV-001.

  **Verification:** any cross-links that were added resolve; no unrelated edits were made to neighboring docs.

## Done When

- [x] `docs/multi-library.md` exists with the exact section structure above, including the mandatory `### Caveat: imageLoader.close() is not called` subsection under `## Teardown`.
- [x] `docs/index.md` lists `multi-library.md` in the Documentation Index table in the correct alphabetical position.
- [x] `CLAUDE.md` has exactly one new bullet in the `# Architecture` section referencing `src/api/library.ts` and `common/library-registry.ts` and pointing at `docs/multi-library.md`.
- [x] The on-disk layout in `docs/multi-library.md` matches what `common/library-registry.ts`, `src/renderer.tsx`, and `SQLiteBackupScheduler` actually write — not merely what INV-001 specified. (Spot-check by running the app in dev and comparing `{userData}` to the doc.)
- [x] The teardown section documents the three steps that actually run in `RootStore.close()` (ExifTool, watchers, backend) and clearly marks `imageLoader.close()` as deferred, with enough guidance that a future soft-switch implementer knows what to add.
- [x] INV-001's two "Documentation Updates" checkboxes can be checked and the investigation can move from `pending_qa/` to `completed/`.
