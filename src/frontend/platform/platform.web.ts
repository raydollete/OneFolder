/**
 * Web (browser) implementation of the platform seam.
 *
 * This file is selected for the web SPA bundle via the webpack alias (TASK-130).
 * All Node/Electron capabilities are either:
 *   - Stubbed out (desktop affordances that don't exist in a browser)
 *   - Throwing loudly (fs writes/deletes — read-only constraint)
 *   - Returning placeholder values to be wired up in subsequent tasks
 *     (e.g. encodeFilePath → HTTP URL in TASK-127, fs reads → HTTP in TASK-129/131)
 *
 * Path helpers use a simple browser-safe implementation rather than Node's path
 * module (which is not available in a plain browser bundle).
 *
 * See INV-034 / TASK-126.
 */

import type {
  Platform,
  PlatformFs,
  PlatformPath,
  PlatformDesktop,
  PlatformExifHandle,
} from './index';
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
// Helpers
// ---------------------------------------------------------------------------

function noOp(): void {
  // intentional no-op for desktop affordances that don't exist in a browser
}

// ---------------------------------------------------------------------------
// Browser-safe path helpers (POSIX-only, sufficient for URL construction)
// ---------------------------------------------------------------------------

const path: PlatformPath = {
  sep: '/',
  basename(p, ext?) {
    const base =
      p
        .replace(/[/\\]+$/, '')
        .split(/[/\\]/)
        .pop() ?? '';
    if (ext && base.endsWith(ext)) {
      return base.slice(0, -ext.length);
    }
    return base;
  },
  extname(p) {
    const base = path.basename(p);
    const dotIdx = base.lastIndexOf('.');
    return dotIdx > 0 ? base.slice(dotIdx) : '';
  },
  join(...segments) {
    return segments.join('/').replace(/\/+/g, '/').replace(/\/+$/, '');
  },
  dirname(p) {
    const parts = p.replace(/[/\\]+$/, '').split(/[/\\]/);
    parts.pop();
    return parts.join('/') || '/';
  },
  normalize(p) {
    // Collapse repeated slashes; does not resolve `..` (out of scope for web stubs)
    return p.replace(/[/\\]+/g, '/');
  },
};

// ---------------------------------------------------------------------------
// Filesystem — reads will be replaced by HTTP fetches in TASK-129/131.
// Writes and deletes reject loudly to enforce the read-only constraint.
// ---------------------------------------------------------------------------

const fs: PlatformFs = {
  readFile(_path) {
    // Full implementation deferred to TASK-129 (HTTP fetch to /original endpoint)
    return Promise.reject(
      new Error('[platform.web] readFile: not yet implemented — use HTTP endpoints (TASK-129)'),
    );
  },
  pathExists(_path) {
    // Full implementation deferred to TASK-129
    return Promise.resolve(false);
  },
  stat(_path) {
    return Promise.reject(new Error('[platform.web] stat: not available in the web build'));
  },
  readdir(_path) {
    return Promise.reject(new Error('[platform.web] readdir: not available in the web build'));
  },
  ensureDir(_path) {
    return Promise.resolve();
  },
  ensureDirSync(_path) {
    // No filesystem access in the browser — silently do nothing
    noOp();
  },
  move(_src, _dest) {
    return Promise.reject(
      new Error(
        '[platform.web] move: write operations are not supported in the read-only web build',
      ),
    );
  },
  writeFile(_path, _data) {
    return Promise.reject(
      new Error(
        '[platform.web] writeFile: write operations are not supported in the read-only web build',
      ),
    );
  },
  remove(_path) {
    return Promise.reject(
      new Error(
        '[platform.web] remove: write operations are not supported in the read-only web build',
      ),
    );
  },
  copy(_src, _dest) {
    return Promise.reject(
      new Error(
        '[platform.web] copy: write operations are not supported in the read-only web build',
      ),
    );
  },
  existsSync(_path) {
    // No synchronous filesystem check in a browser
    return false;
  },
  extractZipEntry(_zipPath, _entryName, _outputPath) {
    // Krita (.kra) thumbnail extraction is desktop-only
    return Promise.resolve(false);
  },
};

// ---------------------------------------------------------------------------
// encodeFilePath (TASK-127, updated TASK-129)
//
// In the web build all images are served by the sidecar over HTTP.
// Route scheme (ID-based only — no raw filesystem paths accepted by the server):
//
//   blob: / data:          → returned as-is (already browser-loadable)
//   Already starts with /  → returned as-is (already a server-relative URL,
//                             e.g. /api/thumb/<id> previously emitted below)
//   UUID v4                → /api/thumb/<id>
//                             FileStore sets thumbnailPath to the file's UUID in
//                             web mode so thumbnails are served via this route.
//   UUID v4 for original   → /api/original/<id>  (caller uses encodeOriginalPath)
//
// Security note (INV-034 § TASK-129):
//   The prior implementation emitted /api/original?path=<encoded-path> for
//   absolute disk paths.  That form was a path-traversal risk because the server
//   would have to accept an untrusted client-supplied path and validate it, which
//   is error-prone.  It is now REMOVED.  All image URLs MUST be ID-based.
//
//   If `filePath` is an absolute disk path (i.e. not a UUID, blob, or server URL),
//   we log a loud error and return an intentionally invalid URL so the broken
//   call site surfaces immediately in the browser Network tab instead of silently
//   making a request that could bypass the security boundary.
//
// This function NEVER emits file:// URLs — those are browser-inaccessible from
// a remote web origin.
// ---------------------------------------------------------------------------

/** UUID v4 pattern — used to distinguish a file ID from an absolute disk path. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeFilePath(filePath: string): string {
  // 1. Already browser-loadable blobs / data URIs
  if (filePath.startsWith('data:image') || filePath.startsWith('blob:')) {
    return filePath;
  }

  // 2. Already a server-relative URL (e.g. /api/thumb/<id> set by FileStore in web mode)
  if (filePath.startsWith('/')) {
    return filePath;
  }

  // 3. UUID — FileStore sets thumbnailPath to the file's UUID in web mode so that
  //    thumbnails are served by the sidecar at /api/thumb/:id.
  if (UUID_RE.test(filePath)) {
    return `/api/thumb/${filePath}`;
  }

  // 4. Absolute disk path — SECURITY: the sidecar no longer accepts raw paths.
  //    All image requests must go through the ID-based endpoints (/api/original/:id
  //    or /api/thumb/:id) so that path-resolver is the sole gatekeeper.
  //
  //    A call reaching this branch means the caller has an absolute path but
  //    not a file ID — this is a code defect in the web build.  Log loudly and
  //    return an invalid placeholder URL so the Network tab shows a clear error
  //    rather than silently bypassing the security boundary.
  console.error(
    '[platform.web] encodeFilePath: received an absolute disk path in the web build.',
    'All image URLs must be ID-based (/api/original/:id or /api/thumb/:id).',
    'Call site must be updated to pass the file ID instead of the absolute path.',
    'Offending path:',
    filePath,
  );
  return '/api/original/invalid-path-not-an-id';
}

/**
 * Encodes a file ID as an /api/original/:id URL for use in <img src> or fetch()
 * calls when the caller wants the full-size original (not the thumbnail).
 *
 * Unlike encodeFilePath (which maps UUIDs to /api/thumb/:id), this helper
 * maps the same UUID to /api/original/:id.  Use it in the SlideMode / full-size
 * viewer where the original is needed.
 */
export function encodeOriginalPath(fileId: string): string {
  if (fileId.startsWith('data:image') || fileId.startsWith('blob:') || fileId.startsWith('/')) {
    return fileId;
  }
  if (UUID_RE.test(fileId)) {
    return `/api/original/${fileId}`;
  }
  console.error(
    '[platform.web] encodeOriginalPath: argument is not a UUID.',
    'Offending value:',
    fileId,
  );
  return '/api/original/invalid-path-not-an-id';
}

/**
 * Encodes a file ID as an /api/preview/:id URL for use in <img src> or fetch()
 * calls when the caller wants a server-decoded preview of a non-web format.
 *
 * Maps the file UUID to /api/preview/:id so the sidecar decodes HEIC/PSD/TIFF/EXR
 * server-side and returns a webp.  Used by ImageLoader.getImageSrc in the viewer
 * (SlideMode / full-size view) for non-web format files.
 *
 * TASK-131.
 */
function encodePreviewPath(fileId: string): string {
  if (fileId.startsWith('data:image') || fileId.startsWith('blob:') || fileId.startsWith('/')) {
    return fileId;
  }
  if (UUID_RE.test(fileId)) {
    return `/api/preview/${fileId}`;
  }
  console.error(
    '[platform.web] encodePreviewPath: argument is not a UUID.',
    'Offending value:',
    fileId,
  );
  return '/api/preview/invalid-path-not-an-id';
}

// ---------------------------------------------------------------------------
// ExifIO HTTP shim — INV-034 / TASK-132
//
// Provides an ExifIO-shaped object whose read methods fetch the sidecar's
// /api/metadata/by-path/* endpoints, and whose write methods reject loudly
// to enforce the read-only constraint.
//
// The shim accepts absolutePath strings — the same strings that callers
// (ImageLoader, AnnotoriousWrapper, entities/File.ts) already pass to ExifIO.
// The server validates the path against the DB before serving.
//
// Cast to `ExifIO` via `unknown` so RootStore and consumers can type their
// `exifTool` property as `ExifIO` without changes.
// ---------------------------------------------------------------------------

/** Base URL for the metadata API — relative so it works regardless of port. */
const META_BASE = '/api/metadata/by-path';

function readOnlyReject(method: string): never {
  throw new Error(
    `[platform.web] ExifIO.${method}: write operations are not supported in the read-only web build`,
  );
}

/**
 * Fetch a metadata endpoint for the given absolutePath.
 * Throws on HTTP error or network failure.
 */
async function metaFetch(subpath: string, absolutePath: string): Promise<Response> {
  const url = `${META_BASE}/${subpath}?absolutePath=${encodeURIComponent(absolutePath)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`[platform.web] ExifIO HTTP ${res.status} from ${url}: ${body}`);
  }
  return res;
}

/**
 * POST a metadata endpoint for the given absolutePath with a JSON body.
 */
async function metaPost(subpath: string, absolutePath: string, body: unknown): Promise<Response> {
  const url = `${META_BASE}/${subpath}?absolutePath=${encodeURIComponent(absolutePath)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`[platform.web] ExifIO HTTP ${res.status} from ${url}: ${errBody}`);
  }
  return res;
}

/**
 * Creates an ExifIO-shaped HTTP shim for the web build.
 *
 * The `hierarchicalSeparator` parameter is used for parsing tag hierarchies
 * returned by the server (the server uses its own default, but the client
 * applies the separator to the already-parsed string[][] result — in practice
 * the server does the parsing so the client value is informational).
 */
function createWebExifIOShim(hierarchicalSeparator: string = '|'): ExifIO {
  // We build a plain object that satisfies the ExifIO public surface.
  // Private members (isOpening, extraArgs) and MobX decorators are not needed
  // in the browser — we cast via `unknown` after confirming all public methods
  // are present.
  const shim = {
    hierarchicalSeparator,

    isOpen(): boolean {
      // The exiftool process lives on the server, not in the browser.
      return true;
    },

    async initialize(): Promise<ExifIO> {
      // No-op: the exiftool process is initialized on the server.
      return this as unknown as ExifIO;
    },

    async close(): Promise<void> {
      // No-op: the exiftool process is managed by the server.
    },

    setHierarchicalSeparator(val: string): void {
      // Update via `this` to avoid a direct reference to the `shim` variable
      // that would cause a TypeScript self-initializer cycle.
      (this as { hierarchicalSeparator: string }).hierarchicalSeparator = val;
      localStorage.setItem('hierarchical-separator', val);
    },

    // ------------------------------------------------------------------
    // READ methods — fetch the sidecar metadata endpoints
    // ------------------------------------------------------------------

    async getDimensions(filepath: string): Promise<{ width: number; height: number }> {
      try {
        const res = await metaFetch('dimensions', filepath);
        return (await res.json()) as { width: number; height: number };
      } catch (err) {
        console.error('[platform.web] ExifIO.getDimensions failed:', err);
        return { width: 0, height: 0 };
      }
    },

    async getDimensionsAndTags(filepath: string): Promise<{
      dimensions: { width: number; height: number };
      tags: string[][];
    }> {
      try {
        const res = await metaFetch('dimensions-and-tags', filepath);
        return (await res.json()) as {
          dimensions: { width: number; height: number };
          tags: string[][];
        };
      } catch (err) {
        console.error('[platform.web] ExifIO.getDimensionsAndTags failed:', err);
        return { dimensions: { width: 0, height: 0 }, tags: [] };
      }
    },

    async readTags(filepath: string): Promise<string[][]> {
      try {
        const res = await metaFetch('tags', filepath);
        const json = (await res.json()) as { tags: string[][] };
        return json.tags;
      } catch (err) {
        console.error('[platform.web] ExifIO.readTags failed:', err);
        return [];
      }
    },

    async readFacesAnnotations(filepath: string): Promise<MWGRegionInfo | undefined> {
      try {
        const res = await metaFetch('faces', filepath);
        const json = (await res.json()) as { regionInfo: MWGRegionInfo | null };
        return json.regionInfo ?? undefined;
      } catch (err) {
        console.error('[platform.web] ExifIO.readFacesAnnotations failed:', err);
        return undefined;
      }
    },

    async readExifTags(filepath: string, tags: string[]): Promise<(string | undefined)[]> {
      try {
        const res = await metaPost('exif-tags', filepath, { tags });
        const json = (await res.json()) as { values: (string | undefined)[] };
        return json.values;
      } catch (err) {
        console.error('[platform.web] ExifIO.readExifTags failed:', err);
        return tags.map(() => undefined);
      }
    },

    async readDescription(filepath: string): Promise<string | undefined> {
      try {
        const res = await metaFetch('description', filepath);
        const json = (await res.json()) as { description: string | null };
        return json.description ?? undefined;
      } catch (err) {
        console.error('[platform.web] ExifIO.readDescription failed:', err);
        return undefined;
      }
    },

    async readParameters(filepath: string): Promise<string | undefined> {
      // Parameters is AI-generation metadata — not critical for web read-only.
      // Return undefined gracefully rather than hitting the server.
      void filepath;
      return undefined;
    },

    async readPrompt(filepath: string): Promise<string | undefined> {
      // Prompt is AI-generation metadata — not critical for web read-only.
      void filepath;
      return undefined;
    },

    async readAllExifTags(filepath: string): Promise<Record<string, unknown>> {
      try {
        const res = await metaFetch('all-exif', filepath);
        const json = (await res.json()) as { exif: Record<string, unknown> };
        return json.exif;
      } catch (err) {
        console.error('[platform.web] ExifIO.readAllExifTags failed:', err);
        return {};
      }
    },

    /**
     * extractThumbnail — in the web build the server generates thumbnails
     * on-demand via /api/thumb/:id.  The ExifIO-based extraction path (for
     * embedded PSD/Krita thumbnails) is not used in the browser; returning
     * false causes ImageLoader to fall through to its server-side thumb route.
     */
    async extractThumbnail(_input: string, _output: string): Promise<boolean> {
      // Thumbnail generation is handled server-side via /api/thumb/:id.
      // The browser ExifIO shim never writes files, so this is always false.
      return false;
    },

    // ------------------------------------------------------------------
    // WRITE methods — reject loudly (read-only web build)
    // ------------------------------------------------------------------

    async writeTags(_filepath: string, _tagNameHierarchy: string[][]): Promise<void> {
      readOnlyReject('writeTags');
    },

    async writeFacesAnnotations(
      _filepath: string,
      _regionInfo: MWGRegionInfo | null,
    ): Promise<void> {
      readOnlyReject('writeFacesAnnotations');
    },

    async writeData(
      _filepath: string,
      _data: Record<string, unknown>,
      _opts?: { onlyIfUndefined?: boolean },
    ): Promise<void> {
      readOnlyReject('writeData');
    },
  };

  // Cast via unknown — the shim satisfies the public ExifIO surface.
  // Private members and MobX decorators are intentionally absent in the browser.
  return shim as unknown as ExifIO;
}

// ---------------------------------------------------------------------------
// Platform exif handle — web implementation
// ---------------------------------------------------------------------------

const exif: PlatformExifHandle = {
  getExifIO(hierarchicalSeparator?: string): ExifIO {
    return createWebExifIOShim(hierarchicalSeparator);
  },
};

// ---------------------------------------------------------------------------
// Desktop affordances — all no-ops or loud rejects in the browser
// ---------------------------------------------------------------------------

const desktop: PlatformDesktop = {
  showItemInFolder(_fullPath) {
    noOp();
  },
  async openExternal(url) {
    // Open in a new tab instead of delegating to the OS
    window.open(url, '_blank', 'noopener,noreferrer');
  },
  getPathForFile(_file) {
    // webUtils.getPathForFile is Electron-only; no equivalent in the browser.
    // Drag-drop import is out of scope for the read-only web build.
    return '';
  },

  // RendererMessenger — window chrome (all no-ops in the browser)
  initialized() {
    noOp();
  },
  clearDatabase() {
    noOp();
  },
  toggleDevTools() {
    noOp();
  },
  reload(_frontEndOnly?) {
    window.location.reload();
  },
  showOpenDialog(_options) {
    return Promise.reject(
      new Error('[platform.web] showOpenDialog: not available in the web build'),
    );
  },
  showMessageBox(_options) {
    return Promise.reject(
      new Error('[platform.web] showMessageBox: not available in the web build'),
    );
  },
  showMessageBoxSync(_options) {
    return Promise.reject(
      new Error('[platform.web] showMessageBoxSync: not available in the web build'),
    );
  },
  getPath(_name: SYSTEM_PATHS) {
    return Promise.reject(new Error('[platform.web] getPath: not available in the web build'));
  },
  setFullScreen(_isFullScreen) {
    return Promise.resolve();
  },
  isFullScreen() {
    return !!document.fullscreenElement;
  },
  onFullScreenChanged(_cb) {
    noOp();
  },
  setZoomFactor(_level) {
    return Promise.resolve();
  },
  getZoomFactor() {
    return 1;
  },
  isMaximized() {
    return false;
  },
  onMaximize(_cb) {
    return noOp;
  },
  onUnmaximize(_cb) {
    return noOp;
  },
  onFocus(_cb) {
    return noOp;
  },
  onBlur(_cb) {
    return noOp;
  },
  pressWindowSystemButton(_button: WindowSystemButtonPress) {
    noOp();
  },
  getVersion() {
    return '0.0.0';
  },
  isPortableMode() {
    return false;
  },
  getDefaultThumbnailDirectory(_libraryId?) {
    return Promise.reject(
      new Error('[platform.web] getDefaultThumbnailDirectory: not available in the web build'),
    );
  },
  getDefaultBackupDirectory(_libraryId?) {
    return Promise.reject(
      new Error('[platform.web] getDefaultBackupDirectory: not available in the web build'),
    );
  },
  getThemesDirectory() {
    return Promise.reject(
      new Error('[platform.web] getThemesDirectory: not available in the web build'),
    );
  },

  // RendererMessenger — tags / clip server / theme / run-in-background
  onGetTags(_fetchTags: () => Promise<TagsMessage>) {
    noOp();
  },
  isClipServerEnabled() {
    return false;
  },
  setClipServerImportLocation(_dir) {
    return Promise.resolve();
  },
  isRunningInBackground() {
    return false;
  },
  setClipServerEnabled(_msg: ClipServerEnabledMessage) {
    noOp();
  },
  setTheme(_msg: ThemeMessage) {
    noOp();
  },
  setRunInBackground(_msg: RunInBackgroundMessage) {
    noOp();
  },

  // RendererMessenger — file ops (reject loudly — read-only)
  trashFile(_absolutePath) {
    return Promise.reject(
      new Error(
        '[platform.web] trashFile: write operations are not supported in the read-only web build',
      ),
    );
  },
  deleteFilePermanently(_absolutePath) {
    return Promise.reject(
      new Error(
        '[platform.web] deleteFilePermanently: write operations are not supported in the read-only web build',
      ),
    );
  },
  checkRecyclable(_paths) {
    return Promise.resolve([]);
  },
  storeFile(_msg: StoreFileMessage): Promise<StoreFileReplyMessage> {
    return Promise.reject(
      new Error(
        '[platform.web] storeFile: write operations are not supported in the read-only web build',
      ),
    );
  },
  startDragExport(_msg: DragExportMessage) {
    noOp();
  },

  // RendererMessenger — preview window (no-ops in the web build)
  sendPreviewFiles(_msg: PreviewFilesMessage) {
    noOp();
  },
  onReceivePreviewFiles(_cb: (msg: PreviewFilesMessage) => void) {
    noOp();
  },
  onClosedPreviewWindow(_cb: () => void) {
    noOp();
  },

  // RendererMessenger — library management (deferred to HttpBackend in TASK-127)
  getLibraries(): Promise<LibraryDTO[]> {
    return Promise.reject(new Error('[platform.web] getLibraries: use HttpBackend (TASK-127)'));
  },
  getActiveLibraryId(): Promise<string | null> {
    return Promise.resolve(null);
  },
  setActiveLibrary(_id: string): Promise<void> {
    return Promise.resolve();
  },
  createLibrary(_name: string): Promise<LibraryDTO> {
    return Promise.reject(
      new Error('[platform.web] createLibrary: not supported in the read-only web build'),
    );
  },
  deleteLibrary(_id: string): Promise<void> {
    return Promise.reject(
      new Error('[platform.web] deleteLibrary: not supported in the read-only web build'),
    );
  },
  renameLibrary(_id: string, _name: string): Promise<void> {
    return Promise.reject(
      new Error('[platform.web] renameLibrary: not supported in the read-only web build'),
    );
  },
  switchLibrary(_newLibraryId: string): Promise<void> {
    return Promise.reject(
      new Error('[platform.web] switchLibrary: not supported in the read-only web build'),
    );
  },
  getLibraryDiskPaths(_id: string): Promise<LibraryDiskPaths> {
    return Promise.reject(
      new Error('[platform.web] getLibraryDiskPaths: not available in the web build'),
    );
  },
  deleteLibraryAndFiles(_id: string): Promise<DeleteLibraryAndFilesResult> {
    return Promise.reject(
      new Error('[platform.web] deleteLibraryAndFiles: not supported in the read-only web build'),
    );
  },

  // RendererMessenger — media jobs (reject — out of scope for read-only)
  startMediaJob(
    _jobType: MediaJobType,
    _inputPath: string,
    _clip?: { start?: string; end?: string },
  ): Promise<MediaJobStartResult> {
    return Promise.reject(
      new Error('[platform.web] startMediaJob: not supported in the read-only web build'),
    );
  },
  commitMediaJob(_jobId: string): Promise<MediaJobCommitResult> {
    return Promise.reject(
      new Error('[platform.web] commitMediaJob: not supported in the read-only web build'),
    );
  },
  onMediaJobProgress(_cb: (msg: MediaJobProgressMessage) => void): () => void {
    return noOp;
  },
  cancelMediaJob(_jobId: string): void {
    noOp();
  },
};

// ---------------------------------------------------------------------------
// On-demand rescan — INV-034 / TASK-135
//
// In the web build, the chokidar folderWatcher is not available (Node-only).
// Instead, the web client can call triggerRescan() to ask the sidecar to
// re-query its read-only SQLite DB and return current file/location counts.
// The caller is then responsible for re-fetching store data via HttpBackend
// (e.g. FileStore.refetch(), LocationStore.init()).
//
// This is intentionally minimal — a first-cut currency mechanism, not a
// live-watch reimplementation.  See INV-034 Requirement 12.
// ---------------------------------------------------------------------------

/** Shape of the response returned by POST /api/rescan */
export interface RescanResult {
  ok: boolean;
  fileCount?: number;
  locationCount?: number;
  scannedAt?: string;
  error?: string;
}

/**
 * Trigger an on-demand rescan on the sidecar server.
 *
 * Sends POST /api/rescan and returns the DB counts reported by the server.
 * After calling this, the caller should re-fetch store data (FileStore.refetch,
 * LocationStore.init) to reflect the current DB state in the UI.
 *
 * Returns { ok: false, error: ... } on network failure — does NOT throw, so
 * callers can treat failure as a non-fatal "no update available" condition.
 */
export async function triggerRescan(): Promise<RescanResult> {
  try {
    const res = await fetch('/api/rescan', { method: 'POST' });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${body}` };
    }
    return (await res.json()) as RescanResult;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Default export — the full platform object for the web target.
// ---------------------------------------------------------------------------

const platform: Platform = {
  fs,
  path,
  encodeFilePath,
  encodePreviewPath,
  isWebBuild: true,
  desktop,
  exif,
};
export default platform;
