import { IS_DEV } from 'common/process';
import platform from 'src/frontend/platform';

/**
 * MediaReleaseCoordinator
 *
 * Mediates between destructive file operations (trash, move, rename) and the
 * React components that render `<video>` elements backed by `file://` URLs.
 *
 * ## Why this exists (INV-008)
 *
 * On Windows, Chromium opens video files via the platform file API with
 * `GENERIC_READ + FILE_SHARE_READ` — notably WITHOUT `FILE_SHARE_DELETE`.
 * The handle persists for the lifetime of the media resource, which outlives
 * `.pause()` and survives re-renders as long as the `src` attribute is set and
 * the element is mounted.  When `shell.trashItem` (or `fse.move`/`fse.remove`)
 * tries to relocate such a file, Windows returns `EBUSY`/`ERROR_SHARING_VIOLATION`.
 *
 * The canonical Chromium release sequence is:
 *   1. `video.pause()` — stop active playback (harmless if already paused)
 *   2. `video.removeAttribute('src')` — sever the URL association
 *   3. `video.load()` — transitions the element to `NETWORK_EMPTY`, which
 *      instructs the media pipeline to tear down the active resource and close
 *      the file handle
 *
 * `.pause()` alone is NOT sufficient — the MediaResource stays loaded.
 *
 * ## When to call `releasePaths`
 *
 * Call `await mediaReleaseCoordinator.releasePaths(paths)` BEFORE any
 * operation that mutates a file on disk (trashItem, fse.move, fse.remove).
 * The await ensures the DOM and Chromium's media pipeline have had at least one
 * animation-frame tick to process the src clear.
 *
 * ## No behavior change for images
 *
 * `<img>` elements do not hold persistent file handles after the image bytes
 * are read.  This coordinator is a no-op for non-video paths.
 */

/** Normalize an absolute path for map key comparisons. */
function normalizePath(p: string): string {
  // Shared path-identity seam: separators folded to '/', case folded only on
  // Windows (case-sensitive on Linux/macOS). See platform.normalizePathIdentity.
  return platform.path.normalizePathIdentity(p);
}

/**
 * Decode a `file://` URL (as stored in `<video src>`) back to an absolute
 * filesystem path suitable for comparison with registry keys.
 *
 * This is the inverse of `encodeFilePath` in `common/fs.ts`, which produces:
 *   `file://<basepath><encodeURIComponent(filename)>[?params]`
 *
 * Returns `undefined` if `src` is not a `file://` URL.
 */
export function decodeVideoSrcToPath(src: string): string | undefined {
  if (!src.startsWith('file://')) {
    return undefined;
  }
  // Strip any query params (e.g. ?v=1) before decoding
  const withoutProto = src.slice('file://'.length);
  const queryIdx = withoutProto.lastIndexOf('?');
  const pathPart = queryIdx > 0 ? withoutProto.slice(0, queryIdx) : withoutProto;

  // When Chromium (and the WHATWG URL parser) resolves a Windows file URL, it
  // normalizes `file://C:\Users\foo\bar.mp4` into `file:///C:/Users/foo/bar.mp4`
  // (triple-slash, forward slashes).  After stripping `file://` we are left with
  // `/C:/Users/foo/bar.mp4`.  On Windows, `path.normalize('/C:/...')` inserts a
  // leading backslash (`\C:\...`), which never matches the registry key derived
  // from `absolutePath` (`C:\...`).
  //
  // Fix: if the remaining path matches the drive-letter pattern `/^\/[A-Za-z]:\//`,
  // strip exactly one leading `/`.  This regex is inherently Windows-specific —
  // POSIX absolute paths (`/Users/foo/bar`) do not start with a drive letter, so
  // the strip is never applied on macOS / Linux.
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart;
  }

  // Strip leading `/` only when followed by a Windows drive letter + colon
  if (/^\/[A-Za-z]:[/\\]/.test(decoded)) {
    decoded = decoded.slice(1);
  }

  return decoded;
}

/** Release a single `<video>` element, freeing its OS file handle. */
function releaseVideoElement(el: HTMLVideoElement): void {
  el.pause();
  el.removeAttribute('src');
  el.load();
}

/**
 * Returns a Promise that resolves when `el` fires an `emptied` event, or
 * after `timeoutMs` milliseconds — whichever comes first.
 *
 * The `emptied` event fires when Chromium transitions the element to
 * `NETWORK_EMPTY` and the media pipeline has finished teardown.
 */
function waitForEmptied(el: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        el.removeEventListener('emptied', onEmptied);
        resolve();
      }
    };
    const onEmptied = (): void => finish();
    el.addEventListener('emptied', onEmptied, { once: true });
    setTimeout(finish, timeoutMs);
  });
}

export interface ReleaseOptions {
  /** Maximum milliseconds to wait for `emptied` events. Default: 200. */
  timeoutMs?: number;
}

export class MediaReleaseCoordinator {
  /**
   * Registry of live video elements keyed by normalized absolute path.
   * Multiple elements may share a path (e.g. gallery thumbnail + preload).
   */
  readonly #registry = new Map<string, Set<HTMLVideoElement>>();

  /**
   * Register a `<video>` element that is currently rendering `absolutePath`.
   *
   * @returns An unregister function — call it on component unmount to remove
   * the element from the coordinator's registry.
   */
  register(absolutePath: string, el: HTMLVideoElement): () => void {
    const key = normalizePath(absolutePath);
    let set = this.#registry.get(key);
    if (!set) {
      set = new Set();
      this.#registry.set(key, set);
    }
    set.add(el);

    return () => {
      const s = this.#registry.get(key);
      if (s) {
        s.delete(el);
        if (s.size === 0) {
          this.#registry.delete(key);
        }
      }
    };
  }

  /**
   * Release all `<video>` elements associated with any of the given paths,
   * then yield to the browser so Chromium's media pipeline can close the OS
   * file handles before the caller proceeds with the destructive operation.
   *
   * Steps performed:
   *   1. For each registered element whose key is in `paths`: pause, remove
   *      src, call load().
   *   2. DOM fallback sweep: query `document.querySelectorAll('video[src]')`
   *      to catch orphan/detached elements (e.g. SlideMode preload videos)
   *      not yet cleaned up.
   *   3. Await `Promise.resolve()` (microtask) + `requestAnimationFrame` to
   *      let Chromium process the src clear.
   *   4. Await `emptied` events (up to `options.timeoutMs`, default 200 ms)
   *      for each element that was released, for a tighter guarantee on slow
   *      or contended systems.
   */
  async releasePaths(paths: Iterable<string>, options: ReleaseOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 200;

    // Build normalized target set
    const targetKeys = new Set<string>();
    for (const p of paths) {
      targetKeys.add(normalizePath(p));
    }

    if (targetKeys.size === 0) {
      return;
    }

    const releasedElements: HTMLVideoElement[] = [];
    let registryHits = 0;
    let domHits = 0;

    // 1. Release from explicit registry
    for (const [key, elements] of this.#registry) {
      if (targetKeys.has(key)) {
        for (const el of elements) {
          releaseVideoElement(el);
          releasedElements.push(el);
          registryHits++;
        }
      }
    }

    // 2. DOM fallback sweep — catches orphan preload videos and any elements
    //    that were never registered (e.g. created before the coordinator was
    //    wired in).  Detached nodes created via document.createElement are
    //    NOT in the DOM so querySelectorAll won't find them — those must be
    //    registered explicitly.
    if (typeof document !== 'undefined') {
      document.querySelectorAll<HTMLVideoElement>('video[src]').forEach((el) => {
        const decoded = decodeVideoSrcToPath(el.src);
        if (decoded) {
          const key = normalizePath(decoded);
          if (targetKeys.has(key)) {
            releaseVideoElement(el);
            // Only add if not already released via registry
            if (!releasedElements.includes(el)) {
              releasedElements.push(el);
              domHits++;
            }
          }
        }
      });
    }

    // 3. Microtask + rAF yield
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => resolve());
      } else {
        resolve();
      }
    });

    // 4. Wait for `emptied` events (or timeout) for each released element
    if (releasedElements.length > 0) {
      await Promise.all(releasedElements.map((el) => waitForEmptied(el, timeoutMs)));
    }

    // Dev-only diagnostics: log the release summary so QA can confirm
    // that registryHits >= 1, proving the callback-ref registration fired.
    // This is the runtime evidence the original fix shipped without. See INV-014.
    if (IS_DEV) {
      // eslint-disable-next-line no-console
      console.debug('[MediaReleaseCoordinator] releasePaths', {
        targets: targetKeys.size,
        registryHits,
        domHits,
        releasedElements: releasedElements.length,
      });
    }
  }
}
