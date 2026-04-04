export const IS_MAC = process.platform === 'darwin';
export const IS_WIN = process.platform === 'win32';
export const IS_DEV = process.env.NODE_ENV === 'development';

// Set by src/main.ts at module load time before any path resolution occurs.
// In the renderer process, query this via RendererMessenger.isPortableMode() instead.
export let IS_PORTABLE = false;
export function setPortableMode(value: boolean): void {
  IS_PORTABLE = value;
}
