// Needed for test:
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
import fse from 'fs-extra';
import { thumbnailFormat } from '../common/config';
import { IS_DEV } from './process';

/**
 * Portable, OS-independent identity of a file within its library, used as the
 * key for every path-derived cache (thumbnails, previews, visual hashes).
 *
 * The key is `(locationId, relativePath)` — stable across operating systems,
 * drive/mount prefixes, and location re-points — NOT the absolute path, which
 * differs per OS on a shared library. `relativePath` is normalized to
 * forward slashes (its canonical form in the app; see entities/File.ts) so the
 * same file yields byte-identical keys on Windows and Linux, and any leading
 * separators are trimmed so `join`-style relative paths cannot shift the key.
 *
 * Case is preserved: two case-distinct siblings (`A.jpg`/`a.jpg`) must resolve
 * to distinct cache entries, so folding happens in path-identity comparison, not
 * here.
 */
export function portableFileKey(locationId: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${locationId}/${normalized}`;
}

/**
 * On-disk thumbnail cache path for a source file.
 *
 * `fileKey` MUST be the portable identity from {@link portableFileKey}, not the
 * absolute path — keying on the absolute path regenerates the whole cache when
 * the same shared library is opened on the other OS or the location is re-pointed.
 */
export function getThumbnailPath(fileKey: string, thumbnailDirectory: string): string {
  const baseFilename = path.basename(fileKey, path.extname(fileKey));

  // Hash is needed to avoid files with the same name to clash with each other, when they come from different paths
  const hash = hashString(fileKey);

  return path.join(thumbnailDirectory, `${baseFilename}-${hash}.${thumbnailFormat}`);
}

/**
 * On-disk full-size preview cache path for a source file. Previews live in a
 * `previews/` sibling of the thumbnail directory and are always webp. Mirrors
 * {@link getThumbnailPath}: same portable `fileKey` and same hash, differing only
 * by directory and extension — so preview and thumbnail caches stay consistent.
 *
 * `fileKey` MUST be the portable identity from {@link portableFileKey}, not the
 * absolute path. Lives here (not the server) so both the sidecar and the desktop
 * renderer (cache migration) derive preview names identically.
 */
export function getPreviewPath(fileKey: string, thumbnailDir: string): string {
  const baseFilename = path.basename(fileKey, path.extname(fileKey));
  const hash = hashString(fileKey);
  const previewDir = path.join(path.dirname(thumbnailDir), 'previews');
  return path.join(previewDir, `${baseFilename}-${hash}.webp`);
}

/** Use this for any <img src attribute! */
export function encodeFilePath(filePath: string): string {
  if (filePath.startsWith('data:image') || filePath.startsWith('blob:')) {
    return filePath;
  }
  // Take into account weird file names like "C:/Images/https_%2F%2Fcdn/.../my-image.jpg"
  const basename = path.basename(filePath);
  let basepath = filePath.slice(0, filePath.length - basename.length);
  let filename = filePath.slice(basepath.length);
  // but don't encode url params, we need those to stay intact, e.g. myImage.jpg?v=1
  // unix allows question marks in filenames though, not bothering with that
  let params = '';
  const paramsIndex = filename.lastIndexOf('?');
  // can't be first char of filname, so > 0
  if (paramsIndex > 0) {
    params = filename.slice(paramsIndex);
    filename = filename.slice(0, paramsIndex);
  }
  // edge case for #
  // TODO: there must be others edge cases like this. Why is this so hard? Is there no built-in function for this?
  basepath = basepath.replace(/#/g, '%23');
  return `file://${basepath}${encodeURIComponent(filename)}${params}`;
}

export async function isDirEmpty(dir: string) {
  const dirContents = await fse.readdir(dir);
  return dirContents.length === 0 || (dirContents.length === 1 && dirContents[0] === '.DS_Store');
}

/** The single authoritative video-extension list (discovery only — NEVER a
 *  playability test; playability is src/frontend/image/playability.ts). */
const VIDEO_FILE_EXTENSIONS: readonly string[] = ['webm', 'mp4', 'ogg', 'mov', 'mkv', 'ts'];

export function isFileExtensionVideo(fileExtension: string) {
  return VIDEO_FILE_EXTENSIONS.includes(fileExtension);
}

/** Tri-state gallery media-type display filter. `'all'` shows everything, `'video'` only
 *  recognized video files, `'images'` everything that is not a recognized video file. */
export type MediaTypeFilter = 'all' | 'images' | 'video';

/** Returns true when a file with the given extension should be shown under the active
 *  media-type filter. Reuses {@link isFileExtensionVideo} as the single authoritative
 *  video-extension list, so new video formats propagate here automatically. */
export function mediaTypeMatches(filter: MediaTypeFilter, fileExtension: string): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'video':
      return isFileExtensionVideo(fileExtension);
    case 'images':
      return !isFileExtensionVideo(fileExtension);
  }
}

/**
 * Deterministic 32-bit hash of a string, the single hash implementation used
 * for every cache key (thumbnails, previews, visual hashes) across the desktop
 * and sidecar server, so both agree on the same on-disk name.
 */
export function hashString(s: string) {
  let hash = 0;
  let chr = 0;
  if (s.length === 0) {
    return hash;
  }
  for (let i = 0; i < s.length; i++) {
    chr = s.charCodeAt(i);
    // tslint:disable-next-line: no-bitwise
    hash = (hash << 5) - hash + chr;
    // tslint:disable-next-line: no-bitwise
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
}

/**
 * Returns a unique temp file path inside the application-owned staging directory.
 *
 * `baseDir` is an APPLICATION-relative temp directory (e.g. a subfolder of the OS
 * temp dir / Electron `app.getPath('temp')`), deliberately OUTSIDE any watched
 * photo location — ffmpeg writes here so the chokidar folder watcher never observes
 * a partial/untagged file. The finished file is later moved into the target folder
 * via an atomic same-directory rename (see ReEncodeManager.commit).
 *
 * The temp file name is a random UUID with the given extension, making collisions
 * between concurrent jobs effectively impossible.
 *
 * Do NOT call `fse.ensureDir` here — the caller (ReEncodeManager._runJob) ensures
 * `baseDir` exists immediately before spawning ffmpeg.
 */
export function getMediaJobTempPath(
  baseDir: string,
  ext: string,
): { tempDir: string; tempPath: string } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { randomUUID } = require('crypto') as typeof import('crypto');
  const tempPath = path.join(baseDir, `${randomUUID()}.${ext}`);
  return { tempDir: baseDir, tempPath };
}

/**
 * Returns a collision-free sibling path in `dir` with the given `baseName` and `ext`.
 *
 * Resolution order:
 *   1. `dir/baseName.ext`      — used if the path does not exist
 *   2. `dir/baseName 1.ext`    — if the first candidate is taken
 *   3. `dir/baseName 2.ext`    — and so on
 *
 * This matches the auto-increment convention used throughout the codebase
 * (e.g. re-encoding `clip.mp4` produces `clip 1.mp4`, then `clip 2.mp4`).
 * The `ext` parameter must NOT include a leading dot.
 */
export function getUniqueSiblingPath(dir: string, baseName: string, ext: string): string {
  const candidate = path.join(dir, `${baseName}.${ext}`);
  if (!fse.existsSync(candidate)) {
    return candidate;
  }
  let n = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const numbered = path.join(dir, `${baseName} ${n}.${ext}`);
    if (!fse.existsSync(numbered)) {
      return numbered;
    }
    n++;
  }
}

/**
 * Gets the path to a resource set up in `"extraResources`" in the package.json.
 * See https://www.electron.build/configuration/contents#extraresources
 * Could look into process.resourcesPath, but that doesn't seem to work in dev mode
 * @param resourcePath The from from the resources directory, e.g. `"themes/myTheme.css"`
 */
export function getExtraResourcePath(resourcePath: string): string {
  const relativeResourcesPath = (IS_DEV ? '../' : '../../') + 'resources';
  return path.resolve(__dirname, relativeResourcesPath, resourcePath);
}

/**
 * Returns the path to the bundled ffmpeg binary (resources/ffmpeg/ffmpeg.exe on Windows).
 * Resolves correctly in both dev mode (via ../resources) and the packaged portable build
 * (via ../../resources), because it delegates to getExtraResourcePath.
 *
 * NOTE: This build ships ffmpeg with --enable-gpl --enable-libx264. If this fork is ever
 * distributed publicly, the GPL obligations (source offer / license notice) must be
 * addressed before distribution.
 */
export function getFfmpegPath(): string {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  return getExtraResourcePath(`ffmpeg/${exe}`);
}

/**
 * Returns the path to the bundled ffprobe binary (resources/ffmpeg/ffprobe.exe on Windows).
 * Used for duration probing / progress calculation in the ffmpeg job runner (TASK-075).
 * Same GPL caveat as getFfmpegPath.
 */
export function getFfprobePath(): string {
  const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  return getExtraResourcePath(`ffmpeg/${exe}`);
}
