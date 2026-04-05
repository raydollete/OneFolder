---
id: TASK-005
title: 'Implement full library teardown and reinitialization for switching between libraries'
investigation: INV-001
status: planned
priority: medium
blocked_by: [TASK-003, TASK-004]
date_created: 2026-04-04
date_completed:
files:
  - 'src/frontend/stores/RootStore.ts'
  - 'src/frontend/stores/FileStore.ts'
  - 'src/frontend/stores/TagStore.ts'
  - 'src/frontend/stores/LocationStore.ts'
  - 'src/frontend/stores/UiStore.ts'
  - 'src/frontend/stores/SearchStore.ts'
  - 'src/frontend/image/ImageLoader.ts'
  - 'src/renderer.tsx'
  - 'src/main.ts'
---

## What

Implement a clean teardown path that stops all active processes (ExifTool, file watchers, thumbnail generation), closes the current database, clears MobX state, and reinitializes with a different library's data -- all without restarting the Electron process.

## Why

When switching libraries via the Library Selector (TASK-004), the app must fully tear down the current library's state before initializing the new one. Incomplete teardown would leak resources (e.g., file watchers from the old library still running) or show stale data.

The simplest reliable approach is a full renderer reload (which TASK-004 already does via `RendererMessenger.reload()`), but this task ensures all cleanup happens properly during that reload, and also provides a foundation for a future "soft switch" without full reload.

See [INV-001](../investigations/INV-001_MEDIUM_ELECTRON_multi-library-support.md).

## Implementation Steps

- [ ] 1. **`src/frontend/stores/RootStore.ts`** — Extend the `close()` method to perform full teardown:
  ```typescript
  async close(): Promise<void> {
    // 1. Close ExifTool child process
    await this.exifTool.close();
    // 2. Stop all file watchers
    await this.locationStore.closeAllWatchers();
    // 3. Close the image loader (any worker threads)
    this.imageLoader.close();
    // 4. The Dexie database closes automatically when the page unloads,
    //    but for soft-switch we might need explicit db.close()
  }
  ```
  Verify: After `close()`, no ExifTool process is running, no chokidar watchers are active.

- [ ] 2. **`src/frontend/stores/LocationStore.ts`** — Add a `closeAllWatchers()` method:
  - Iterate over all `ClientLocation` instances and call their watcher's `close()` method.
  - The `FolderWatcherWorker` (in `src/frontend/workers/folderWatcher.worker.ts`) already has a `close()` method that calls `watcher?.close()`.
  - Each `ClientLocation` holds a reference to its watcher worker via Comlink. The `closeAllWatchers` method must terminate each worker.
  Verify: After calling `closeAllWatchers()`, no chokidar FSWatcher instances remain in memory. Check via DevTools memory snapshot or by confirming no file-change events fire.

- [ ] 3. **`src/renderer.tsx`** — Ensure the `beforeunload` handler (line 123) calls the extended `close()` method. This is already the case (`rootStore.close()`), but verify it covers the new cleanup steps.
  Verify: Refreshing the page (F5) or switching libraries triggers full cleanup.

- [ ] 4. **`src/main.ts`** — When handling the `RELOAD` message for a library switch, update the `active-library.json` BEFORE the reload so the renderer picks up the new library ID:
  ```typescript
  MainMessenger.onSwitchLibrary((newLibraryId) => {
    registry.setActiveLibrary(newLibraryId);
    registry.updateLastOpened(newLibraryId);
    // Reload the renderer with the new library ID
    if (mainWindow) {
      mainWindow.loadURL(`file://${__dirname}/index.html?libraryId=${newLibraryId}`);
    }
  });
  ```
  This is cleaner than a full `app.relaunch()` because it preserves the window state.
  Verify: After switching, the renderer initializes with the new library's database and preferences.

- [ ] 5. **Handle preview window during switch** — When the main window switches libraries, the preview window must also be reloaded or closed:
  - Close the preview window on library switch.
  - It will be recreated with the new library ID when next requested.
  Verify: No stale preview window shows data from the old library.

- [ ] 6. **Handle in-progress operations** — If a thumbnail generation batch or metadata import is in progress when the user switches libraries:
  - Cancel any active thumbnail generation workers.
  - The file watcher teardown (step 2) handles watcher cleanup.
  - Display a brief "Switching library..." indicator if needed.
  Verify: No errors from interrupted operations. No orphaned worker threads.

## Done When

- [ ] Switching libraries fully tears down ExifTool, file watchers, and thumbnail workers.
- [ ] The renderer reinitializes with the new library's database, preferences, and directories.
- [ ] No resources leak between library switches (no lingering file watchers, no orphaned ExifTool processes).
- [ ] The preview window is properly handled during switches.
- [ ] Rapid sequential switches (open library A, immediately switch to B) do not crash or corrupt data.
