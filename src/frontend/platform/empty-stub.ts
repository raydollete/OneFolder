/**
 * Empty stub module for the web SPA bundle.
 *
 * The webpack web config (webpack.web.js, TASK-130) uses NormalModuleReplacementPlugin
 * to redirect Electron-only static imports in src/renderer.tsx (e.g. fs-extra, path,
 * better-sqlite3 reachable deps) to this file.
 *
 * All of those imports are used only inside the `if (!IS_WEB_BUILD)` branch of
 * renderer.tsx, which is dead-code-eliminated when IS_WEB_BUILD=true.  The stub
 * ensures webpack never tries to resolve or bundle those Node/Electron modules at
 * all — they become empty objects at the module boundary and are then tree-shaken.
 *
 * This file intentionally exports nothing.  Any accidental use at runtime will
 * return undefined for named imports and an empty object for the default import,
 * both of which are harmless given the dead-code guarantee.
 *
 * See INV-034 / TASK-130.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _stub: any = {};
export default _stub;
