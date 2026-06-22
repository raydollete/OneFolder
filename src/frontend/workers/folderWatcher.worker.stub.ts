/**
 * No-op stub for folderWatcher.worker.ts — web build only (INV-034 / TASK-135).
 *
 * webpack.web.js redirects the real folderWatcher.worker.ts import to this
 * file via NormalModuleReplacementPlugin so that chokidar, original-fs, and
 * the Node `fs` module never enter the browser bundle.
 *
 * In the web build, `platform.fs.pathExists()` always returns false, so
 * ClientLocation.init() takes the "broken" branch and never calls watch().
 * The FolderWatcherWorker is therefore never instantiated or invoked from the
 * browser — this stub just satisfies the TypeScript type reference at
 *   import { FolderWatcherWorker } from '../workers/folderWatcher.worker'
 * in entities/Location.ts.
 *
 * The class shape mirrors the public API of the real FolderWatcherWorker so
 * that comlink's `wrap<typeof FolderWatcherWorker>` resolves correctly at the
 * TypeScript level.  Any actual runtime call to these methods in the web build
 * would be a bug (the pathExists guard should prevent it), but we log loudly
 * just in case.
 *
 * See INV-034 / TASK-135.
 */

import type { FileStats } from '../stores/LocationStore';
import type { IMG_EXTENSIONS_TYPE } from '../../api/file';

export class FolderWatcherWorker {
  cancel(): void {
    // No-op — chokidar is not running in the web build.
    console.warn('[folderWatcher.stub] cancel() called in web build — no watcher to cancel');
  }

  async close(): Promise<void> {
    // No-op — nothing to close.
    console.warn('[folderWatcher.stub] close() called in web build — no watcher to close');
  }

  async watch(_directory: string, _extensions: IMG_EXTENSIONS_TYPE[]): Promise<FileStats[]> {
    // Should never be reached in the web build (pathExists guard prevents it).
    console.warn('[folderWatcher.stub] watch() called in web build — returning empty file list');
    return [];
  }
}
