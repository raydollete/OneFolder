---
id: TASK-001
title: 'Create Library Registry infrastructure for tracking multiple libraries'
investigation: INV-001
status: planned
priority: high
blocked_by: []
date_created: 2026-04-04
date_completed:
files:
  - 'src/api/library.ts (new)'
  - 'common/library-registry.ts (new)'
  - 'src/main.ts'
---

## What

Create a `LibraryRegistry` class that manages a list of known libraries, persisted as a JSON file in the global `userData` directory. Each library has an ID (UUID), name, creation date, and last-opened date. Also create an `active-library.json` file to track which library is currently selected.

## Why

The application currently has no concept of a "library" as a first-class entity. All per-library data (database, preferences, thumbnails, backups) is stored in hardcoded global locations. This task creates the foundational data model and persistence layer that all subsequent tasks depend on.

See [INV-001](../investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md).

## Implementation Steps

- [ ] 1. **Create `src/api/library.ts`** — Define the `LibraryDTO` interface:
  ```typescript
  export interface LibraryDTO {
    id: string;        // UUID v4
    name: string;      // User-chosen display name
    createdAt: Date;
    lastOpenedAt: Date;
  }
  ```
  Verify: File compiles with `yarn dev`.

- [ ] 2. **Create `common/library-registry.ts`** — Implement the `LibraryRegistry` class:
  - Constructor takes `basePath: string` (the global `userData` directory).
  - Reads/writes `{basePath}/libraries.json` (array of `LibraryDTO`).
  - Reads/writes `{basePath}/active-library.json` (single `{ activeLibraryId: string }`).
  - Methods:
    - `getLibraries(): LibraryDTO[]` — returns all known libraries.
    - `getActiveLibraryId(): string | null` — returns the currently active library ID, or null if none.
    - `setActiveLibrary(id: string): void` — updates `active-library.json`.
    - `createLibrary(name: string): LibraryDTO` — generates UUID, adds to registry, returns new entry.
    - `renameLibrary(id: string, name: string): void` — updates name in registry.
    - `deleteLibrary(id: string): void` — removes from registry (does NOT delete database/files; that is the caller's responsibility).
    - `updateLastOpened(id: string): void` — sets `lastOpenedAt` to now.
  - All writes are synchronous (using `fse.writeJSONSync`) since they happen at startup/shutdown and must complete before proceeding.
  - Use `crypto.randomUUID()` for ID generation (available in Node 19+ and Electron 27).
  Verify: Write a simple test or manual verification that creating/reading/deleting libraries round-trips correctly.

- [ ] 3. **Create helper function `getLibraryPaths(basePath: string, libraryId: string)`** in the same file:
  ```typescript
  export function getLibraryPaths(basePath: string, libraryId: string) {
    return {
      backupDir: path.join(basePath, 'libraries', libraryId, 'backups'),
      // Thumbnail dir is in temp, handled separately
    };
  }
  ```
  This centralizes path construction so other tasks do not need to duplicate logic.
  Verify: Paths are constructed correctly on all platforms.

- [ ] 4. **Update `src/main.ts`** — Import `LibraryRegistry` and instantiate it during `initialize()`:
  - Create the registry: `const registry = new LibraryRegistry(basePath);`
  - Read the active library ID: `const activeLibraryId = registry.getActiveLibraryId();`
  - If no libraries exist yet, do NOT auto-create one here (that is handled by TASK-006 migration). Just store the registry instance for later use by IPC handlers.
  - Expose the registry via new IPC handlers (to be consumed by the renderer for the library selector in TASK-004):
    - `MainMessenger.onGetLibraries(() => registry.getLibraries())`
    - `MainMessenger.onGetActiveLibraryId(() => registry.getActiveLibraryId())`
    - `MainMessenger.onSetActiveLibrary((id) => { registry.setActiveLibrary(id); registry.updateLastOpened(id); })`
    - `MainMessenger.onCreateLibrary((name) => registry.createLibrary(name))`
    - `MainMessenger.onDeleteLibrary((id) => registry.deleteLibrary(id))`
    - `MainMessenger.onRenameLibrary((id, name) => registry.renameLibrary(id, name))`
  Verify: IPC handlers are registered. Calling `getLibraries` returns an empty array on a fresh install.

- [ ] 5. **Add IPC message types** — In `src/ipc/messages.ts`, add constants and types for the new library management messages. In `src/ipc/main.ts`, add the handler registrations. In `src/ipc/renderer.ts`, add the static methods to invoke them.
  Verify: TypeScript compiles cleanly. Round-trip IPC call works from renderer to main and back.

## Done When

- [ ] `LibraryDTO` interface exists and is importable.
- [ ] `LibraryRegistry` class can create, list, rename, delete, and select libraries, persisted to disk.
- [ ] IPC handlers exist for all registry operations.
- [ ] `RendererMessenger` has static methods for all library operations.
- [ ] Existing app functionality is completely unchanged (no behavioral differences until subsequent tasks wire things up).
