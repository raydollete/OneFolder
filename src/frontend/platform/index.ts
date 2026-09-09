/**
 * Platform seam — build-time abstraction over Node/Electron capabilities.
 *
 * Two implementations exist:
 *   - platform.electron.ts  Faithful pass-through to fse/path/shell/RendererMessenger/
 *                           encodeFilePath. Selected for the Electron renderer bundle via
 *                           a webpack alias. Desktop behaviour is byte-for-byte unchanged.
 *   - platform.web.ts       Browser-safe stubs and HTTP-backed reads for the read-only
 *                           web SPA target (TASK-127 onwards).
 *
 * Callers import from 'src/frontend/platform' (or the alias 'platform-seam').
 * The alias in webpack.dev.js / webpack.prod.js resolves this module to the
 * correct implementation at bundle time.
 *
 * See INV-034 for the full architectural context.
 */

import type fse from 'fs-extra';
import type ExifIO from 'common/ExifIO';
import type {
  ClipServerEnabledMessage,
  DragExportMessage,
  PreviewFilesMessage,
  RunInBackgroundMessage,
  StoreFileMessage,
  StoreFileReplyMessage,
  TagsMessage,
  ThemeMessage,
  MediaJobType,
  MediaJobProgressMessage,
  MediaJobStartResult,
  MediaJobCommitResult,
  DeleteLibraryAndFilesResult,
  LibraryDiskPaths,
  WindowSystemButtonPress,
  SYSTEM_PATHS,
} from 'src/ipc/messages';
import type { LibraryDTO } from 'src/api/library';

// ---------------------------------------------------------------------------
// Filesystem surface
// The web build routes these to HTTP or throws; the electron build delegates
// to fs-extra directly.
// ---------------------------------------------------------------------------

export interface PlatformFs {
  /** Read the entire contents of a file. */
  readFile(path: string): Promise<Buffer>;
  /** Test whether a path exists on disk. */
  pathExists(path: string): Promise<boolean>;
  /** stat a path. */
  stat(path: string): Promise<fse.Stats>;
  /** List the entries in a directory. */
  readdir(path: string): Promise<string[]>;
  /** Ensure a directory exists (creates parents). Async variant. */
  ensureDir(path: string): Promise<void>;
  /** Ensure a directory exists (creates parents). Sync variant for UiStore init. */
  ensureDirSync(path: string): void;
  /** Move a file/directory. */
  move(src: string, dest: string): Promise<void>;
  /** Write bytes to a file. */
  writeFile(path: string, data: Buffer | ArrayBuffer): Promise<void>;
  /** Remove a file or directory. */
  remove(path: string): Promise<void>;
  /** Copy a file/directory. */
  copy(src: string, dest: string): Promise<void>;
  /** Synchronous pathExists check. */
  existsSync(path: string): boolean;
  /**
   * Extract a single named entry from a zip archive to an output path.
   * Used for Krita (.kra) thumbnail extraction. Returns true if successful.
   * Web build returns false (Krita support is desktop-only).
   */
  extractZipEntry(zipPath: string, entryName: string, outputPath: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Path helpers
// The web build uses a browserified path util; the electron build delegates
// to Node's path module.
// ---------------------------------------------------------------------------

export interface PlatformPath {
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  join(...segments: string[]): string;
  dirname(p: string): string;
  normalize(p: string): string;
  /** Platform-specific path separator character. */
  sep: string;
  /**
   * Normalize an absolute path to a stable comparison key ("path identity").
   *
   * The SINGLE shared formatter for every path-identity comparison in the
   * frontend (video-release registry keys, ingest/suppression matching, and
   * `waitForIngestedFile`). Consumers MUST route through this seam member rather
   * than hand-rolling their own `replace(/\\/g, '/').toLowerCase()` clone so the
   * case policy stays consistent across the codebase.
   *
   * Policy:
   *   - Separators are always folded to forward slashes on every desktop
   *     platform (Windows emits backslashes; the folder watcher emits `/`).
   *   - Case is folded ONLY on Windows (a case-insensitive filesystem). On
   *     Linux/macOS the case is preserved so `Clip.mp4` and `clip.mp4` stay
   *     DISTINCT identities.
   *
   * This does NOT resolve `..`, collapse duplicate slashes, or touch the
   * `encodeFilePath` `?`-query contract — it is purely separator + case folding.
   */
  normalizePathIdentity(p: string): string;
}

/**
 * Pure path-identity normalizer shared by BOTH platform implementations.
 *
 * This is the ONE implementation of the path-identity policy; the electron and
 * web seam members delegate to it, differing only in the `foldCase` flag they
 * pass (Windows folds case; POSIX/web does not). Exported so the platform impls
 * and unit tests can exercise both policies without a live filesystem.
 *
 * @param p        Absolute path in any separator form.
 * @param foldCase When true (Windows), lower-case the result; otherwise keep
 *                 the original case so case-distinct POSIX paths stay distinct.
 */
export function normalizePathIdentity(p: string, foldCase: boolean): string {
  const forwardSlashed = p.replace(/\\/g, '/');
  return foldCase ? forwardSlashed.toLowerCase() : forwardSlashed;
}

// ---------------------------------------------------------------------------
// Runtime case-fold policy
//
// Case-sensitivity is a property of the FILESYSTEM hosting the library, not of
// the running OS: a shared dual-boot tree opened from Windows is still the same
// case-sensitive (or case-insensitive) filesystem it is on Linux. Folding case
// by `IS_WIN` lets a Windows boot merge `A.jpg`/`a.jpg` on a case-sensitive
// share and transfer/drop tags between distinct files. So the fold flag passed
// to `normalizePathIdentity` is overridable: at library open an empirical probe
// of the library filesystem sets it; until then the OS default applies.
// ---------------------------------------------------------------------------

let _foldCaseOverride: boolean | undefined;

/** Set the path-identity case-fold policy from the library filesystem probe. */
export function setPathIdentityFoldCase(foldCase: boolean): void {
  _foldCaseOverride = foldCase;
}

/** Clear the override so the OS default applies again (used between libraries and in tests). */
export function resetPathIdentityFoldCase(): void {
  _foldCaseOverride = undefined;
}

/**
 * The effective fold policy: the library-filesystem override when one has been
 * probed, else the caller's OS default (`IS_WIN` on desktop, `false` on web).
 */
export function getPathIdentityFoldCase(osDefault: boolean): boolean {
  return _foldCaseOverride ?? osDefault;
}

/** Flip the ASCII case of every letter; non-letters pass through unchanged. */
function flipAsciiCase(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch >= 'a' && ch <= 'z') {
      out += ch.toUpperCase();
    } else if (ch >= 'A' && ch <= 'Z') {
      out += ch.toLowerCase();
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Empirically determine whether the filesystem hosting `dir` is case-SENSITIVE,
 * by writing a probe file and testing whether its case-flipped name resolves to
 * the same file. Returns `true` when case-sensitive (`A.jpg` !== `a.jpg`),
 * `false` when case-insensitive.
 *
 * Probing beats inferring from the OS because exotic mounts (exFAT, case-folded
 * NTFS, a case-sensitive share mounted on Windows) do not follow the OS default.
 * The probe file is a hidden zero-byte temp always cleaned up. Callers handle a
 * thrown error (permission/missing dir) by keeping the OS default.
 */
export async function probeFilesystemCaseSensitive(
  dir: string,
  fs: Pick<PlatformFs, 'ensureDir' | 'writeFile' | 'existsSync' | 'remove'>,
  join: (...segments: string[]) => string,
): Promise<boolean> {
  // The token MUST contain letters so its case-flip is a different string.
  const token = `.onefolder-case-probe-ABC-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const probePath = join(dir, token);
  const flippedPath = join(dir, flipAsciiCase(token));
  await fs.ensureDir(dir);
  await fs.writeFile(probePath, new ArrayBuffer(0));
  try {
    // The flipped-case name resolving to our file means the filesystem folds
    // case (case-INSENSITIVE); not resolving means it is case-SENSITIVE.
    return !fs.existsSync(flippedPath);
  } finally {
    await fs.remove(probePath).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Image source encoding
// Electron → file:// URL; web → /original/<id> URL (full impl in TASK-127).
// ---------------------------------------------------------------------------

export type EncodeFilePath = (filePath: string) => string;

/**
 * Encode a file identifier as a full-size decoded preview URL.
 *
 * Electron: same as encodeFilePath — the desktop renderer decodes locally.
 * Web: maps the file UUID to /api/preview/:id so the sidecar decodes server-side.
 *
 * Used by ImageLoader.getImageSrc for non-web formats (HEIC/PSD/TIFF/EXR) in
 * the viewer / SlideMode where the full-size decoded image is needed.
 *
 * TASK-131.
 */
export type EncodePreviewPath = (fileId: string) => string;

// ---------------------------------------------------------------------------
// Desktop affordances
// All are optional / no-op in the web build; the electron build delegates to
// shell/RendererMessenger.
// ---------------------------------------------------------------------------

export interface PlatformDesktop {
  // shell
  showItemInFolder(fullPath: string): void;
  openExternal(url: string): Promise<void>;
  getPathForFile(file: File): string;

  // RendererMessenger — window chrome
  initialized(): void;
  clearDatabase(): void;
  toggleDevTools(): void;
  reload(frontEndOnly?: boolean): void;
  showOpenDialog(options: Electron.OpenDialogOptions): Promise<Electron.OpenDialogReturnValue>;
  showMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue>;
  showMessageBoxSync(options: Electron.MessageBoxSyncOptions): Promise<number>;
  getPath(name: SYSTEM_PATHS): Promise<string>;
  setFullScreen(isFullScreen: boolean): Promise<void>;
  isFullScreen(): boolean;
  onFullScreenChanged(cb: (val: boolean) => void): void;
  setZoomFactor(level: number): Promise<void>;
  getZoomFactor(): number;
  isMaximized(): boolean;
  onMaximize(cb: () => void): () => void;
  onUnmaximize(cb: () => void): () => void;
  onFocus(cb: () => void): () => void;
  onBlur(cb: () => void): () => void;
  pressWindowSystemButton(button: WindowSystemButtonPress): void;
  getVersion(): string;
  isPortableMode(): boolean;
  getDefaultThumbnailDirectory(libraryId?: string): Promise<string>;
  getDefaultBackupDirectory(libraryId?: string): Promise<string>;
  getThemesDirectory(): Promise<string>;

  // RendererMessenger — tags / clip server / theme / run-in-background
  onGetTags(fetchTags: () => Promise<TagsMessage>): void;
  isClipServerEnabled(): boolean;
  setClipServerImportLocation(dir: string): Promise<void>;
  isRunningInBackground(): boolean;
  setClipServerEnabled(msg: ClipServerEnabledMessage): void;
  setTheme(msg: ThemeMessage): void;
  setRunInBackground(msg: RunInBackgroundMessage): void;

  // RendererMessenger — file ops
  trashFile(absolutePath: string): Promise<Error | undefined>;
  deleteFilePermanently(absolutePath: string): Promise<Error | undefined>;
  checkRecyclable(paths: string[]): Promise<string[]>;
  storeFile(msg: StoreFileMessage): Promise<StoreFileReplyMessage>;
  startDragExport(msg: DragExportMessage): void;

  // RendererMessenger — preview window
  sendPreviewFiles(msg: PreviewFilesMessage): void;
  onReceivePreviewFiles(cb: (msg: PreviewFilesMessage) => void): void;
  onClosedPreviewWindow(cb: () => void): void;

  // RendererMessenger — library management
  getLibraries(): Promise<LibraryDTO[]>;
  getActiveLibraryId(): Promise<string | null>;
  setActiveLibrary(id: string): Promise<void>;
  createLibrary(name: string): Promise<LibraryDTO>;
  deleteLibrary(id: string): Promise<void>;
  renameLibrary(id: string, name: string): Promise<void>;
  switchLibrary(newLibraryId: string): Promise<void>;
  getLibraryDiskPaths(id: string): Promise<LibraryDiskPaths>;
  deleteLibraryAndFiles(id: string): Promise<DeleteLibraryAndFilesResult>;

  // RendererMessenger — media jobs
  startMediaJob(
    jobType: MediaJobType,
    inputPath: string,
    clip?: { start?: string; end?: string },
  ): Promise<MediaJobStartResult>;
  commitMediaJob(jobId: string): Promise<MediaJobCommitResult>;
  onMediaJobProgress(cb: (msg: MediaJobProgressMessage) => void): () => void;
  cancelMediaJob(jobId: string): void;
}

// ---------------------------------------------------------------------------
// Metadata / ExifIO handle
//
// The electron build constructs a real `ExifIO` instance (native exiftool).
// The web build returns an HTTP-backed shim that satisfies the same surface.
// Callers (RootStore, ImageLoader, AnnotoriousWrapper) receive the object via
// `platform.getExifIO(separator)` and treat it as `ExifIO`.
// ---------------------------------------------------------------------------

export interface PlatformExifHandle {
  /**
   * Returns an ExifIO-compatible object.
   *
   * @param hierarchicalSeparator  The separator character for HierarchicalSubject
   *   parsing (stored in localStorage per-library).  Defaults to '|'.
   *   The electron impl passes this to `new ExifIO(separator)`.
   *   The web impl stores it for tag parsing on the fetch-returned data.
   */
  getExifIO(hierarchicalSeparator?: string): ExifIO;
}

// ---------------------------------------------------------------------------
// Assembled platform interface
// ---------------------------------------------------------------------------

export interface Platform {
  fs: PlatformFs;
  path: PlatformPath;
  encodeFilePath: EncodeFilePath;
  /**
   * Encode a file identifier as a full-size decoded preview URL.
   * TASK-131: web → /api/preview/:id; electron → same as encodeFilePath.
   */
  encodePreviewPath: EncodePreviewPath;
  /**
   * True when running in the web SPA build (browser, no local filesystem).
   * False in the Electron desktop build.
   *
   * Use this to branch behaviour in shared modules (e.g. ImageLoader) that
   * need to route to HTTP endpoints instead of local file operations.
   * TASK-131.
   */
  isWebBuild: boolean;
  desktop: PlatformDesktop;
  exif: PlatformExifHandle;
}

// ---------------------------------------------------------------------------
// The default export is resolved by the webpack alias at bundle time.
// Each implementation file (platform.electron.ts / platform.web.ts) exports a
// Platform-shaped object as its default export so the alias resolves cleanly.
// ---------------------------------------------------------------------------

// This re-export is rewritten by the webpack alias to point at the correct
// implementation. The alias target must export `default: Platform`.
export { default } from './platform.electron';
