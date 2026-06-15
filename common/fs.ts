// Needed for test:
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
import fse from 'fs-extra';
import { thumbnailFormat } from '../common/config';
import { IS_DEV } from './process';

export function getThumbnailPath(filePath: string, thumbnailDirectory: string): string {
  const baseFilename = path.basename(filePath, path.extname(filePath));

  // Hash is needed to avoid files with the same name to clash with each other, when they come from different paths
  const hash = hashString(filePath);

  return path.join(thumbnailDirectory, `${baseFilename}-${hash}.${thumbnailFormat}`);
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

export function isFileExtensionVideo(fileExtension: string) {
  return fileExtension === 'webm' || fileExtension === 'mp4' || fileExtension === 'ogg';
}

function hashString(s: string) {
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
