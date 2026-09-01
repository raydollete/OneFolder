# Verification — add-portable-serve-mode

Date: 2026-08-04
Tier: 3

## Verdict: PASS-WITH-FINDINGS

The implementation matches every checked claim in `tasks.md`, and the mechanical controls are
clean (`radflow-lint --tier-check` exit 0, `radflow-lint --doctor` "all workflow controls
present", peer-review verdict achieved at quorum 4/3). None of the four blocking conditions
is met: no checked box claims code that does not exist, no `evidence:` location was found to
contradict its claim, the tier is declared 3 with External Review achieved, and lint exits 0.

The live browser pass, however, found that the served SPA does not boot — a **pre-existing**
web-bundle defect that this change did not introduce and never claimed to fix, but which
means the feature's user-visible outcome ("browse your library from your phone") cannot be
reached today. It also falsifies the reason recorded on tasks 7.1/7.2 (`BLOCKED on test data,
not on code`). That is a Reachable finding, so it is advisory here, but it is the finding that
matters most and it is written up first below.

## Dimensions

- **Implemented — PASS.** All 22 checked boxes were verified by opening the cited files; every
  claimed change is present (see `## Evidence audited`). Four `evidence:` line anchors have
  drifted by 7-12 lines, but in each case the claimed construct is in the cited file (finding 3).
  Runtime claims were independently corroborated rather than taken on trust: `data/server.log`
  contains the port-in-use, invalid-port, both auth banners and the `ExifIO (exiftool)
  initialized` lines quoted in the tasks; `dist/data/server.log` contains the packaged-build
  `Database not found` line; the packaged tree contains `resources/dist-web/index.html`,
  `resources/wasm/packages/exr/exr_decoder_bg.wasm`, `resources/resources/exiftool/exiftool.exe`
  and `app.asar.unpacked/node_modules/{sharp,@img,better-sqlite3}`; `build/main.bundle.js`
  contains exactly one `require("sharp")`, proving the webpack external took effect.
  Task 1.1's done-when holds: `git grep -nE "process\.execPath|PORTABLE_EXECUTABLE_DIR|__dirname|process\.exit" -- src/server/index.ts`
  returns only a prose line in the module doc comment.
- **Reachable — PARTIAL.** The server half is genuinely reachable: `src/main.ts:135` parses the
  flag at module scope above the lock, `src/main.ts:489` forks into `startServeMode`, and a live
  `electron ./build/main.bundle.js --serve --port 8123` run in this session answered `GET /` 200,
  `GET /api/files/count` 200 and `GET /api/tags` 200 with COOP/COEP/CORP headers and no
  `WWW-Authenticate`. The GUI path is untouched when the flag is absent (the lock, the
  `second-instance` handler and both windows now live in the `else` branch). The SPA half is NOT
  reachable: the page loads, but `renderer.bundle.js` throws at module-init and React never
  mounts (finding 1). Serve mode's own single-instance and coexistence design is sound by
  construction — a serve process never calls `requestSingleInstanceLock()`, so it neither quits
  nor fires the running GUI's `second-instance` handler.
- **Tested — PASS.** `yarn test` (full suite, run in this session): 38 suites, 345 tests passed —
  identical to the figure recorded in the tasks. The narrowest suites, `tests/serve-mode.test.ts`
  + `tests/server-auth.test.ts`: 56 tests passed. `npx eslint` over all ten changed/added source
  files: clean. Gaps: no automated test covers the `POST /api/auth/login` no-op of task 2.3 (its
  evidence is a live `Invoke-WebRequest`), and no test exercises `startServeMode` end to end
  (deliberate — its collaborators are express/sqlite/sharp).
- **Optimal — advisory.** The module doc comments are unusually good: they record *why*
  (measured stdout unreliability, NSIS temp-dir `execPath`, the WAL-on-readonly false model)
  rather than *what*. Three quality notes are filed as findings 4-6. One process note, not a code
  defect: task 4.1 is left unchecked although its `evidence:` shows the webpack/`asarUnpack` work
  is complete and verified on the packaged build — only "generate a real thumbnail" is deferred to
  7.5. Leaving it unchecked is the honest call and is consistent with the lint's evidence rules.

## Evidence audited

- [1.1 extract `startServer(opts)`] — src/server/index.ts:208 — "export async function startServer(opts: ServeOptions): Promise<ServerHandle> {"
- [1.1 glue module] — src/serve-mode.ts:59 — "export async function startServeMode(deps: ServeModeDeps): Promise<ServerHandle> {"
- [1.2 remove WAL pragma on the read-only connection] — src/server/index.ts:222 — "const db = new Database(opts.dbPath, { readonly: true });"
- [1.3 validate the port] — src/server/config.ts:54 — "export function resolvePort(raw: string | undefined): number {" (evidence cites :47)
- [1.3 runtime] — data/server.log:23 — "[server] --port requires a whole number between 1 and 65535 (got 'abc')."
- [1.4 startup banner] — src/server/config.ts:113 — "export function buildStartupBanner(input: BannerInput): string[] {" (evidence cites :101)
- [1.4 banner, open run] — data/server.log:36 — "[server] Authentication: DISABLED — no credential configured"
- [1.5 file log] — src/server/logger.ts:41 — "export function createServerLogger(logFilePath: string): ServerLogger {"
- [1.6 operator-facing failures] — src/server/config.ts:19 — "export const messages = {"
- [1.6 port-in-use, live] — data/server.log:20 — "[server] Port 8666 is already in use. Another OneFolder server may already be running. Use --port <n> to choose a different port."
- [1.6 missing database, packaged] — dist/data/server.log:2 — "[server] Database not found at D:\Dev\OneFolder\dist\data\libraries\303e7a1d-fb8e-4122-ad50-1aa2fa61efcf\onefolder.db."
- [2.1 invert the null-credential branch] — src/server/auth.ts:264 — "if (cred === null || expectedToken === null) {"
- [2.2 empty env var is absent] — src/server/auth.ts:190 — "function readEnv(value: string | undefined): string | null {"
- [2.3 login is a no-op in open mode] — src/server/auth.ts:391 — "res.status(200).json({ ok: true, authRequired: false });"
- [2.4 tests for the inverted contract] — tests/server-auth.test.ts:93 — "it('serves a request that carries no credential at all', () => {"
- [3.1 parse the flag before the lock] — src/main.ts:135 — "const SERVE_ARGS = parseServeArgs(process.argv);"
- [3.1 fork the entry point] — src/main.ts:489 — "if (IS_SERVE_MODE) {"
- [3.2 no window from a second instance] — src/main.ts:575 — "if (mainWindow === null && !IS_SERVE_MODE) {"
- [3.2 no modal in a headless process] — src/main.ts:599 — "if (IS_SERVE_MODE) {" (inside the `uncaughtException` handler)
- [3.3 forceRelaunch forwards flags] — src/main.ts:1240 — "const userFlags = process.argv.slice(app.isPackaged ? 1 : 2);"
- [3.4 lazy exiftool handle] — common/ExifIO.ts:63 — "function getDefaultExiftoolProcess(): exiftool.ExiftoolProcess {"
- [3.4 guard the renderer-only global] — common/ExifIO.ts:198 — "if (typeof localStorage !== 'undefined') {"
- [4.2 ship the SPA as extraResources] — package.json:72 — "\"from\": \"dist-web\","
- [4.2 spaDir from Electron, never execPath] — src/main.ts:513 — "const spaDir = app.isPackaged" (evidence cites :501, the comment block above it)
- [4.3 yarn build produces the SPA] — package.json:18 — "\"build\": \"rimraf dist && yarn production && yarn build:web && yarn logo\","
- [4.4 wasm candidates for the Electron layouts] — src/server/decode.ts:183 — "// Electron main bundle in development (__dirname = <repo>/build)."
- [4.5 Express 5 SPA fallback] — src/server/index.ts:302 — "app.get(/.*/, (_req: Request, res: Response) => {"
- [5.1 delete the SEA target] — `git status --porcelain` — "D scripts/package-headless.js" and "D webpack.server.js"
- [5.2 reconcile TASK-137] — docs/TODO/pending_qa/tasks/TASK-137_...md:27 — "- [ ] 4. **Phase C — OBSOLETE.** Superseded by the OpenSpec change `add-portable-serve-mode`"
- [6.1 documentation] — docs/headless-web-build.md:161 — "### Authentication is optional"
- [7.3 credentialed path] — data/server.log:60 — "[server] Authentication: enabled (shared secret)" (and :48 shows the earlier `(user: changeme)` leak that task 1.4's `correction:` records — the log corroborates the correction rather than hiding it)

No boxes were skipped: all 22 checked boxes were verified individually (the >20 rule would have
permitted sampling).

## Findings

1. **HIGH — Reachable — the served SPA never mounts, so the change's user-facing outcome is
   unreachable.** `src/frontend/components/ExternalLink.tsx:1`, `src/frontend/containers/AppToolbar/SecondaryCommands.tsx:8`,
   `src/frontend/containers/ContentView/DuplicateGallery.tsx:4`, `src/frontend/containers/ContentView/Placeholder.tsx:35`
   and `src/frontend/containers/Settings/Appearance.tsx:2` all `import { shell } from 'electron'`
   directly — the platform-seam violation CLAUDE.md forbids. The web bundle therefore contains the
   `electron` npm package's launcher (`dist-web/renderer.bundle.js` still holds
   `ELECTRON_OVERRIDE_DIST_PATH` and `path.join("/","path.txt")`), whose module-scope code runs in
   the browser and throws. Observed live this session against `brave` serve mode on port 8123:
   console `TypeError: i.join is not a function at 1207 (renderer.bundle.js:2:253815)`, page
   snapshot empty, `document.body.innerHTML === '<div id="app"></div>'`. **Pre-existing, not
   introduced here** — those five files are untouched by this diff and `dist-web/renderer.bundle.js`
   is byte-identical to the 2026-07-18 build (task 4.3's "[compared for emit]" evidence). It was
   never caught because TASK-137 Phase A was never executed. Consequence for this change: tasks
   7.1 and 7.2 are blocked by CODE, not by "test data, not code" as their evidence states, and the
   delta spec scenario "the served gallery lists the files of that same library" cannot pass until
   the seam violation is fixed. Out of scope for this change; a follow-up change is warranted.
2. **MEDIUM — process — task 7.3 is checked while its own evidence records half of it unverified.**
   `tasks.md:134-137`: the done-when is "both the rejection and the authenticated success are
   observed" in a browser gallery, and the third evidence line says "the gallery/thumbnail half of
   this task shares task 7.1's blocker". The HTTP-layer half is solidly evidenced
   (`data/server.log:60` plus the 401/200/401 sequence); the browser half is not, and finding 1
   shows it cannot be until the SPA boots. Either narrow 7.3's done-when to the HTTP layer or
   uncheck it and fold the browser half into 7.1.
3. **LOW — accuracy — four `evidence:` line anchors have drifted.** `tasks.md:29` cites
   `src/server/config.ts:101` for `buildStartupBanner` (actually :113); `tasks.md:47` cites
   `src/server/auth.ts:257` for the `next()` branch (actually :264); `tasks.md:42` cites
   `src/serve-mode.ts:96` for the `messages.noLibrary` log (actually :75-77); `tasks.md:94` cites
   `src/main.ts:501` for `spaDir` (actually :513, :501 being the comment above it). In every case
   the claimed construct is present in the cited file — this is drift, not fabrication.
4. **LOW — Optimal — a failed start leaks the database connection and the exiftool child.**
   `src/server/index.ts:222` opens SQLite and `:234` spawns exiftool *before* the `listen()` block
   at `:319`-`:335`; on `EADDRINUSE` the promise rejects without closing either, and only the
   success path installs the SIGINT/SIGTERM shutdown hooks (`src/main.ts:524`-`:534`). Corroborated
   on this machine: six orphaned `exiftool.exe` processes are still running with start times that
   match the serve-mode sessions in `data/server.log` (18:00-18:13 local on 2026-08-03), and this
   audit's own run added a seventh (killed). Bounded in practice because serve mode calls
   `app.exit(1)` right after, but each serve run — including clean ones killed from Task Manager
   or by closing the console, where no SIGTERM is delivered on Windows — leaves an exiftool daemon
   behind. Wrapping the post-open failure paths in a cleanup, and/or closing the handle from
   `will-quit`, would fix it.
5. **LOW — Optimal — `sharp` was added to the renderer externals as well as the main ones.**
   `webpack.prod.js:98`-`:104` and `webpack.dev.js:89`-`:95`. Harmless today (no renderer module
   imports sharp) and consistent with task 4.1's wording, but it converts a future renderer-side
   `import sharp` from a build-time failure into a runtime `require` — exactly the class of silent
   seam breach the platform-seam rule exists to prevent. Only the main-process configs need it.
6. **LOW — docs — `webpack.web.js:17` and `:70` still describe the deleted `dist-server/` output**
   ("The sidecar server (dist-server/) looks for this dir via '../../dist-web'"). Task 5.1's
   done-when excluded `docs/`, so this is not a missed requirement, but it now documents a path
   that no longer exists.
7. **INFO — degraded controls: none.** `radflow-lint <change-dir> --tier-check` → exit 0, "clean —
   no violations". `radflow-lint --doctor` → exit 0, "all workflow controls present". The peer-review
   verdict in design.md is `achieved` (quorum 4/3, one peer errored, arbiter ok), which the Tier 3
   declaration requires. No tier-envelope warning was raised.

## Live UI pass

Ran. `npx electron ./build/main.bundle.js --serve --port 8123` (development main bundle, dev
library, no credential), then `playwright-cli open http://127.0.0.1:8123`.

- HTTP layer, verified with curl before the browser: `GET /` 200, `GET /api/files/count` 200,
  `GET /api/tags` 200 with `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`, and
  no `WWW-Authenticate` header anywhere — the optional-auth contract of task 2.1 holds end to end
  over a real socket.
- Browser: the page loads and then fails to mount (finding 1). Artifacts:
  `.playwright-cli/page-2026-08-04T18-39-23-290Z.yml` (empty snapshot) and
  `.playwright-cli/console-2026-08-04T18-39-22-979Z.log` (`TypeError: i.join is not a function`).
- Cleanup: browser closed, the serve process on port 8123 stopped, and the `exiftool.exe` orphan
  this run created was killed. The six orphans from the 2026-08-03 apply session were left in
  place and are reported as finding 4 instead.
