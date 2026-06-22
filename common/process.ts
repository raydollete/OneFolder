// ---------------------------------------------------------------------------
// process.platform shim
// In Node/Electron, `process` is a built-in global. In the web bundle there is
// no native `process` object. Webpack's DefinePlugin (TASK-130) will replace
// `process.env.NODE_ENV` with a string literal, but `process.platform` needs
// a safe fallback so this module compiles in a browser bundle today.
//
// The guard `typeof process !== 'undefined'` is the accepted webpack-compatible
// pattern — DefinePlugin eliminates the dead branch in the web bundle.
// ---------------------------------------------------------------------------

/** Platform string, safe to read in both Node and browser contexts. */
const _platform: string =
  typeof process !== 'undefined' && process.platform ? process.platform : 'browser';

export const IS_MAC = _platform === 'darwin';
export const IS_WIN = _platform === 'win32';
export const IS_DEV =
  typeof process !== 'undefined' && process.env
    ? process.env.NODE_ENV === 'development'
    : false;

// Set by src/main.ts at module load time before any path resolution occurs.
// In the renderer process, query this via RendererMessenger.isPortableMode() instead.
export let IS_PORTABLE = false;
export function setPortableMode(value: boolean): void {
  IS_PORTABLE = value;
}
