/**
 * Electron implementation of the platform seam.
 *
 * Every method here is a thin delegation to exactly the API the call site used
 * BEFORE the seam was introduced. No logic is added; no behaviour changes.
 * The Electron renderer bundle targets this file via the webpack alias:
 *   'src/frontend/platform' → 'src/frontend/platform/platform.electron.ts'
 *
 * See INV-034 / TASK-126.
 */

import fse from 'fs-extra';
import nodePath from 'path';
import { shell, webUtils } from 'electron';
import StreamZip from 'node-stream-zip';

import { encodeFilePath as _encodeFilePath } from 'common/fs';
import { IS_WIN } from 'common/process';
import { RendererMessenger } from 'src/ipc/renderer';
import ExifIO from 'common/ExifIO';

import {
  normalizePathIdentity as _normalizePathIdentity,
  getPathIdentityFoldCase,
} from './index';
import type {
  Platform,
  PlatformFs,
  PlatformPath,
  PlatformDesktop,
  PlatformExifHandle,
} from './index';

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

const fs: PlatformFs = {
  readFile: (path) => fse.readFile(path),
  pathExists: (path) => fse.pathExists(path),
  stat: (path) => fse.stat(path),
  readdir: (path) => fse.readdir(path),
  ensureDir: (path) => fse.ensureDir(path),
  ensureDirSync: (path) => fse.ensureDirSync(path),
  move: (src, dest) => fse.move(src, dest),
  writeFile: (path, data) =>
    data instanceof ArrayBuffer
      ? fse.writeFile(path, Buffer.from(data))
      : fse.writeFile(path, data),
  remove: (path) => fse.remove(path),
  copy: (src, dest) => fse.copy(src, dest),
  existsSync: (path) => fse.existsSync(path),
  extractZipEntry: async (zipPath, entryName, outputPath) => {
    const zip = new StreamZip.async({ file: zipPath });
    let success = false;
    try {
      const count = await zip.extract(entryName, outputPath);
      success = count === 1;
    } catch (e) {
      console.error('Could not extract zip entry', entryName, 'from', zipPath, e);
    } finally {
      zip.close().catch(console.warn);
    }
    return success;
  },
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const path: PlatformPath = {
  basename: (p, ext?) => nodePath.basename(p, ext),
  extname: (p) => nodePath.extname(p),
  join: (...segments) => nodePath.join(...segments),
  dirname: (p) => nodePath.dirname(p),
  normalize: (p) => nodePath.normalize(p),
  sep: nodePath.sep,
  // Desktop path-identity: fold separators everywhere; fold case per the library
  // filesystem probe (set at library open), defaulting to the OS heuristic
  // (Windows folds) until the probe runs. See getPathIdentityFoldCase.
  normalizePathIdentity: (p) => _normalizePathIdentity(p, getPathIdentityFoldCase(IS_WIN)),
};

// ---------------------------------------------------------------------------
// Image source encoding
// Delegates to the existing encodeFilePath in common/fs.ts → emits file:// URLs.
// ---------------------------------------------------------------------------

const encodeFilePath = _encodeFilePath;

/**
 * On the desktop the preview path is the same as the file path — the renderer
 * decodes HEIC/PSD/TIFF/EXR locally via the format-specific loaders.
 * TASK-131: web build overrides this to /api/preview/:id.
 */
const encodePreviewPath = _encodeFilePath;

// ---------------------------------------------------------------------------
// Desktop affordances
// ---------------------------------------------------------------------------

const desktop: PlatformDesktop = {
  // shell
  showItemInFolder: (fullPath) => shell.showItemInFolder(fullPath),
  openExternal: (url) => shell.openExternal(url),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // RendererMessenger — window chrome
  initialized: () => RendererMessenger.initialized(),
  clearDatabase: () => RendererMessenger.clearDatabase(),
  toggleDevTools: () => RendererMessenger.toggleDevTools(),
  reload: (frontEndOnly?) => RendererMessenger.reload(frontEndOnly),
  showOpenDialog: (options) => RendererMessenger.showOpenDialog(options),
  showMessageBox: (options) => RendererMessenger.showMessageBox(options),
  showMessageBoxSync: (options) => RendererMessenger.showMessageBoxSync(options),
  getPath: (name) => RendererMessenger.getPath(name),
  setFullScreen: (isFullScreen) => RendererMessenger.setFullScreen(isFullScreen),
  isFullScreen: () => RendererMessenger.isFullScreen(),
  onFullScreenChanged: (cb) => RendererMessenger.onFullScreenChanged(cb),
  setZoomFactor: (level) => RendererMessenger.setZoomFactor(level),
  getZoomFactor: () => RendererMessenger.getZoomFactor(),
  isMaximized: () => RendererMessenger.isMaximized(),
  onMaximize: (cb) => RendererMessenger.onMaximize(cb),
  onUnmaximize: (cb) => RendererMessenger.onUnmaximize(cb),
  onFocus: (cb) => RendererMessenger.onFocus(cb),
  onBlur: (cb) => RendererMessenger.onBlur(cb),
  pressWindowSystemButton: (button) => RendererMessenger.pressWindowSystemButton(button),
  getVersion: () => RendererMessenger.getVersion(),
  isPortableMode: () => RendererMessenger.isPortableMode(),
  getDefaultThumbnailDirectory: (libraryId?) =>
    RendererMessenger.getDefaultThumbnailDirectory(libraryId),
  getDefaultBackupDirectory: (libraryId?) => RendererMessenger.getDefaultBackupDirectory(libraryId),
  getThemesDirectory: () => RendererMessenger.getThemesDirectory(),

  // RendererMessenger — tags / clip server / theme / run-in-background
  onGetTags: (fetchTags) => RendererMessenger.onGetTags(fetchTags),
  isClipServerEnabled: () => RendererMessenger.isClipServerEnabled(),
  setClipServerImportLocation: (dir) => RendererMessenger.setClipServerImportLocation(dir),
  isRunningInBackground: () => RendererMessenger.isRunningInBackground(),
  setClipServerEnabled: (msg) => RendererMessenger.setClipServerEnabled(msg),
  setTheme: (msg) => RendererMessenger.setTheme(msg),
  setRunInBackground: (msg) => RendererMessenger.setRunInBackground(msg),

  // RendererMessenger — file ops
  trashFile: (absolutePath) => RendererMessenger.trashFile(absolutePath),
  deleteFilePermanently: (absolutePath) => RendererMessenger.deleteFilePermanently(absolutePath),
  checkRecyclable: (paths) => RendererMessenger.checkRecyclable(paths),
  storeFile: (msg) => RendererMessenger.storeFile(msg),
  startDragExport: (msg) => RendererMessenger.startDragExport(msg),

  // RendererMessenger — preview window
  sendPreviewFiles: (msg) => RendererMessenger.sendPreviewFiles(msg),
  onReceivePreviewFiles: (cb) => RendererMessenger.onReceivePreviewFiles(cb),
  onClosedPreviewWindow: (cb) => RendererMessenger.onClosedPreviewWindow(cb),

  // RendererMessenger — library management
  getLibraries: () => RendererMessenger.getLibraries(),
  getActiveLibraryId: () => RendererMessenger.getActiveLibraryId(),
  setActiveLibrary: (id) => RendererMessenger.setActiveLibrary(id),
  createLibrary: (name) => RendererMessenger.createLibrary(name),
  deleteLibrary: (id) => RendererMessenger.deleteLibrary(id),
  renameLibrary: (id, name) => RendererMessenger.renameLibrary(id, name),
  switchLibrary: (newLibraryId) => RendererMessenger.switchLibrary(newLibraryId),
  getLibraryDiskPaths: (id) => RendererMessenger.getLibraryDiskPaths(id),
  deleteLibraryAndFiles: (id) => RendererMessenger.deleteLibraryAndFiles(id),

  // RendererMessenger — media jobs
  startMediaJob: (jobType, inputPath, clip?) =>
    RendererMessenger.startMediaJob(jobType, inputPath, clip),
  commitMediaJob: (jobId) => RendererMessenger.commitMediaJob(jobId),
  onMediaJobProgress: (cb) => RendererMessenger.onMediaJobProgress(cb),
  cancelMediaJob: (jobId) => RendererMessenger.cancelMediaJob(jobId),
  probeVideoCodecs: (candidates) => RendererMessenger.probeVideoCodecs(candidates),
};

// ---------------------------------------------------------------------------
// ExifIO — native exiftool, faithful pass-through.
//
// Constructs a real ExifIO instance with the caller-supplied hierarchical
// separator.  This preserves the exact behaviour that existed before the seam
// was introduced — RootStore previously called `new ExifIO(separator)` directly.
// ---------------------------------------------------------------------------

const exif: PlatformExifHandle = {
  getExifIO(hierarchicalSeparator?: string): ExifIO {
    return new ExifIO(hierarchicalSeparator);
  },
};

// ---------------------------------------------------------------------------
// Default export — the full platform object for the Electron target.
// ---------------------------------------------------------------------------

const platform: Platform = {
  fs,
  path,
  encodeFilePath,
  encodePreviewPath,
  isWebBuild: false,
  desktop,
  exif,
};
export default platform;
