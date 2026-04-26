// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.

// Import the styles here to let Webpack know to include them
// in the HTML file
import './style.scss';

import fse from 'fs-extra';
import { autorun, reaction, runInAction } from 'mobx';
import path from 'path';
import React from 'react';
import { Root, createRoot } from 'react-dom/client';

import { IS_DEV } from 'common/process';
import { IS_PREVIEW_WINDOW, WINDOW_STORAGE_KEY } from 'common/window';
import { getSqliteDbPath } from 'common/library-registry';
import { RendererMessenger } from 'src/ipc/renderer';
import SQLiteBackend from './backend/sqlite-backend';
import SQLiteBackupScheduler from './backend/sqlite-backup-scheduler';
import { sqliteInit, SQLITE_DB_FILENAME } from './backend/sqlite-config';
import { migrateIfNeeded } from './backend/migration-indexeddb-to-sqlite';
import { migrateToMultiLibraryLayout } from './renderer-migration';
import App from './frontend/App';
import LibrarySelector from './frontend/containers/LibrarySelector';
import SplashScreen from './frontend/containers/SplashScreen';
import StoreProvider from './frontend/contexts/StoreContext';
import Overlay from './frontend/Overlay';
import PreviewApp from './frontend/Preview';
import { getFileStorageKey } from './frontend/stores/FileStore';
import RootStore from './frontend/stores/RootStore';
import { getPreferencesStorageKey } from './frontend/stores/UiStore';

async function main(): Promise<void> {
  console.groupCollapsed('Initializing OneFolder');
  // Render our react components in the div with id 'app' in the html file
  const container = document.getElementById('app');

  if (container === null) {
    throw new Error('Unable to create user interface.');
  }

  const root = createRoot(container);

  root.render(<SplashScreen />);

  // Show the library selector when multiple libraries exist and no library has
  // been chosen yet for this load. A single-library user always proceeds without
  // seeing the selector (matching the pre-multi-library UX).
  //
  // The selector is skipped if the URL already has a libraryId — that means the
  // user either came from a switch action or the main process already determined
  // which library to use (TASK-003 / TASK-006 migration).
  const hasSelectorParam = new URLSearchParams(window.location.search).has('libraryId');
  if (!hasSelectorParam) {
    const allLibraries = await RendererMessenger.getLibraries();
    if (allLibraries.length > 1) {
      // Render the selector and wait — the user's selection will call
      // switchLibrary(), which triggers a page reload with the chosen libraryId.
      root.render(<LibrarySelector />);
      return; // halt this init; the reload will restart main()
    }
  }

  // Extract the active library ID from the URL query string.
  // The main process injects this as ?libraryId=<uuid> when loading the window.
  // It may be absent on a truly fresh install (before TASK-006 migration runs) —
  // in that case we fall back to the legacy flat db path so the migration can
  // still create and move the database as needed.
  const urlParams = new URLSearchParams(window.location.search.slice(1));
  const libraryId = urlParams.get('libraryId') || undefined;

  const userDataPath = await RendererMessenger.getPath('userData');

  // TASK-006: Perform the one-time filesystem migration from the legacy
  // flat layout ({userData}/onefolder.db) to the per-library layout
  // ({userData}/libraries/{libraryId}/onefolder.db).
  if (libraryId) {
    await migrateToMultiLibraryLayout(userDataPath, libraryId);
  }

  // Per-library path when a library ID is present; legacy flat path otherwise.
  // The legacy path is only used transiently during first-launch migration (TASK-006).
  const dbPath = libraryId
    ? getSqliteDbPath(userDataPath, libraryId)
    : path.join(userDataPath, SQLITE_DB_FILENAME);

  await fse.ensureDir(path.dirname(dbPath));

  // Run the one-time IndexedDB → SQLite migration before opening the backend.
  // migrateIfNeeded is idempotent and no-ops after the first successful run.
  try {
    const migrated = await migrateIfNeeded(dbPath);
    if (migrated) {
      console.info('renderer: IndexedDB → SQLite migration completed successfully.');
    }
  } catch (e) {
    // Migration failure is non-fatal: the app continues with the SQLite backend.
    // The migration will be retried on the next launch.
    console.error('renderer: IndexedDB → SQLite migration failed — continuing with SQLite.', e);
  }

  const db = sqliteInit(dbPath);

  if (!IS_PREVIEW_WINDOW) {
    await runMainApp(db, dbPath, root, libraryId);
  } else {
    await runPreviewApp(db, root, libraryId);
  }
  console.groupEnd();
}

async function runMainApp(
  db: import('better-sqlite3').Database,
  dbPath: string,
  root: Root,
  libraryId?: string,
): Promise<void> {
  const defaultBackupDirectory = await RendererMessenger.getDefaultBackupDirectory(libraryId);
  // Initialize backup scheduler first so its reference is available to the
  // backend's notifyChange callback. SQLiteBackupScheduler.init only creates
  // the backup directory, so this is fast.
  const backup = await SQLiteBackupScheduler.init(db, dbPath, defaultBackupDirectory);
  const [backend] = await Promise.all([
    SQLiteBackend.init(db, () => backup.schedule()),
    fse.ensureDir(defaultBackupDirectory),
  ]);

  const rootStore = await RootStore.main(backend, backup, libraryId);

  RendererMessenger.initialized();

  // Recover global preferences
  try {
    const window_preferences = localStorage.getItem(WINDOW_STORAGE_KEY);
    if (window_preferences === null) {
      localStorage.setItem(WINDOW_STORAGE_KEY, JSON.stringify({ isFullScreen: false }));
    } else {
      const prefs = JSON.parse(window_preferences);
      if (prefs.isFullScreen === true) {
        RendererMessenger.setFullScreen(true);
        rootStore.uiStore.setFullScreen(true);
      }
    }
  } catch (e) {
    console.error('Cannot load window preferences', e);
  }

  // Debounced and automatic storing of preferences — use namespaced keys so
  // different libraries do not overwrite each other's stored settings.
  reaction(
    () => rootStore.fileStore.getPersistentPreferences(),
    (preferences) => {
      localStorage.setItem(getFileStorageKey(libraryId), JSON.stringify(preferences));
    },
    { delay: 200 },
  );

  reaction(
    () => rootStore.uiStore.getPersistentPreferences(),
    (preferences) => {
      localStorage.setItem(getPreferencesStorageKey(libraryId), JSON.stringify(preferences));
    },
    { delay: 200 },
  );

  autorun(() => {
    document.title = rootStore.getWindowTitle();
  });

  root.render(
    <StoreProvider value={rootStore}>
      <App />
      <Overlay />
    </StoreProvider>,
  );

  // -------------------------------------------
  // Messaging with the main process
  // -------------------------------------------

  RendererMessenger.onGetTags(async () => ({ tags: await backend.fetchTags() }));

  RendererMessenger.onFullScreenChanged((val) => rootStore.uiStore.setFullScreen(val));

  RendererMessenger.onClosedPreviewWindow(() => {
    rootStore.uiStore.closePreviewWindow();
  });

  // Runs operations to run before closing the app, e.g. closing child-processes
  // TODO: for async operations, look into https://github.com/electron/electron/issues/9433#issuecomment-960635576
  window.addEventListener('beforeunload', () => {
    rootStore.close();
  });

  // Expose debug methods in development mode
  if (IS_DEV) {
    (window as any).clearFilesOnly = () => rootStore.clearFilesOnly();
    (window as any).reIndexAllFiles = (importMetadata?: boolean) =>
      rootStore.fileStore.reIndexAllFiles(importMetadata);
    (window as any).refreshDatabase = async (importMetadata?: boolean) => {
      await rootStore.clearFilesOnly();
      await rootStore.fileStore.reIndexAllFiles(importMetadata);
    };

    // Helper to check/set re-indexing preferences
    (window as any).getReIndexPrefs = () => ({
      savedPreference: rootStore.uiStore.importMetadataAtReIndexing,
      locationLoadingDefault: rootStore.uiStore.importMetadataAtLocationLoading,
    });
    (window as any).setReIndexPref = (enable: boolean) =>
      rootStore.uiStore.setImportMetadataAtReIndexing(enable);

    // Edge case testing utilities
    (window as any).debugReIndex = {
      // Get current library stats
      getStats: () => ({
        totalFiles: rootStore.fileStore.numTotalFiles,
        untaggedFiles: rootStore.fileStore.numUntaggedFiles,
        missingFiles: rootStore.fileStore.numMissingFiles,
        locations: rootStore.locationStore.locationList.map((l) => ({
          id: l.id,
          name: l.name,
          path: l.path,
        })),
      }),

      // Test with simulated large library
      simulateProgress: async (steps = 5) => {
        for (let i = 0; i < steps; i++) {
          console.log(`Simulated step ${i + 1}/${steps}`);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        console.log('Simulation complete');
      },

      // Test error scenarios
      testErrorScenarios: async () => {
        console.log('Testing error scenarios...');

        // Test with no locations
        if (rootStore.locationStore.locationList.length === 0) {
          console.log('✅ No locations scenario already active');
        }

        // Test with metadata import enabled/disabled
        console.log('🔧 Current metadata settings:', {
          locationLoading: rootStore.uiStore.importMetadataAtLocationLoading,
          reIndexing: rootStore.uiStore.importMetadataAtReIndexing,
        });

        return 'Error scenario testing complete';
      },

      // Performance benchmarking
      benchmark: async (importMetadata: boolean) => {
        const startTime = performance.now();
        const startFileCount = rootStore.fileStore.numTotalFiles;

        console.log(`🏃 Starting benchmark (metadata: ${importMetadata ? 'enabled' : 'disabled'})`);
        console.log(`📊 Current files: ${startFileCount}`);

        try {
          await rootStore.clearFilesOnly();
          await rootStore.fileStore.reIndexAllFiles(importMetadata);

          const endTime = performance.now();
          const endFileCount = rootStore.fileStore.numTotalFiles;
          const duration = (endTime - startTime) / 1000;

          const results = {
            duration: `${duration.toFixed(2)}s`,
            filesPerSecond: Math.round(endFileCount / duration),
            filesBefore: startFileCount,
            filesAfter: endFileCount,
            metadataImport: importMetadata,
          };

          console.log('📈 Benchmark results:', results);
          return results;
        } catch (error) {
          console.error('❌ Benchmark failed:', error);
          throw error;
        }
      },
    };

    // INV-009 observability: exposes drop counter and current generation for QA
    // console queries and automated test assertions.
    (window as any).__inv009 = {
      get droppedCount() {
        return rootStore.fileStore.droppedApplyCount;
      },
      get generation() {
        return (rootStore.fileStore as any).fetchGeneration;
      },
      get content() {
        return (rootStore.fileStore as any).content;
      },
    };
  }
}

async function runPreviewApp(
  db: import('better-sqlite3').Database,
  root: Root,
  libraryId?: string,
): Promise<void> {
  // Preview window is read-only: no-op callbacks for change notification and
  // backup scheduling keep the interface compatible without touching the disk.
  const backend = new SQLiteBackend(db, () => {});
  const rootStore = await RootStore.preview(
    backend,
    new SQLiteBackupScheduler(db, '', ''),
    libraryId,
  );

  RendererMessenger.initialized();

  await new Promise<void>((executor) => {
    let initRender: (() => void) | undefined = executor;

    RendererMessenger.onReceivePreviewFiles(
      async ({ ids, thumbnailDirectory, viewMethod, activeImgId }) => {
        rootStore.uiStore.setThumbnailDirectory(thumbnailDirectory);
        rootStore.uiStore.setMethod(viewMethod);
        rootStore.uiStore.enableSlideMode();

        runInAction(() => {
          rootStore.uiStore.isInspectorOpen = false;
        });

        const files = await backend.fetchFilesByID(ids);

        // If a file has a location we don't know about (e.g. when a new location was added to the main window),
        // re-fetch the locations in the preview window
        const hasNewLocation = runInAction(() =>
          files.some((f) => !rootStore.locationStore.locationList.find((l) => l.id === f.id)),
        );
        if (hasNewLocation) {
          await rootStore.locationStore.init();
        }

        await rootStore.fileStore.applyPreviewFiles(files);
        rootStore.uiStore.setFirstItem((activeImgId && ids.indexOf(activeImgId)) || 0);

        if (initRender !== undefined) {
          initRender();
          initRender = undefined;
        }
      },
    );
  });

  autorun(() => {
    document.title = rootStore.getWindowTitle();
  });

  // Render our react components in the div with id 'app' in the html file
  // The Provider component provides the state management for the application
  root.render(
    <StoreProvider value={rootStore}>
      <PreviewApp />
      <Overlay />
    </StoreProvider>,
  );

  // Close preview with space
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'Escape') {
      rootStore.uiStore.clearFileSelection();
      rootStore.fileStore.clearFileList();
      rootStore.uiStore.enableSlideMode();

      // remove focus from element so closing preview with spacebar does not trigger any ui elements
      if (document.activeElement && document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }

      window.close();
    }
  });
}

main()
  .then(() => console.info('Successfully initialized OneFolder!'))
  .catch((err) => {
    console.error('Could not initialize OneFolder!', err);
    window.alert('An error has occurred, check the console for more details');

    // In dev mode, the console is already automatically opened: only open in non-dev mode here
    if (!IS_DEV) {
      RendererMessenger.toggleDevTools();
    }
  });
