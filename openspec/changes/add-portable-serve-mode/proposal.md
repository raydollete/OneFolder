# Serve the web sidecar from the portable executable via `--serve`

Tier: 3 — cross-cutting: forks the Electron entry point, deletes an entire packaging pipeline (SEA), and changes the server's authentication contract in one change; not Tier 2 because the blast radius spans process bootstrap, two webpack configs, electron-builder packaging, and the security boundary rather than a single bounded behavior.
Type: feature

## Stated Requirements

What the owner asked for. Quoted lines marked *verbatim* are reproduced from the exploration
record; the site each was already transcribed at is cited so the wording can be traced rather
than taken on trust. Lines marked *paraphrase* were never captured as a direct quote and are
recorded as what the artifacts assert the owner wanted, not as their words.

- *verbatim* — **"the credentials should be optional. if none provided, then it does not require it."** (transcribed at `proposal.md` "What Changes" and `design.md` Explicit Rejections). This is the authentication contract: absent credentials means no gate, not a locked-out server.
- *verbatim* — the no-authentication case is **"for access from my phone on my home wifi"** (transcribed at `design.md` Explicit Rejections; the "What Changes" list quotes a shorter span of the same sentence). This is why the bind address stays `0.0.0.0` against the reviewers' recommendation of a loopback default.
- *verbatim* — on retiring the separate headless binary: **"I don't really care as long as there is feature parity"** (transcribed at `proposal.md` "What Changes" and `design.md` Explicit Rejections). Parity is the constraint; the number of implementations is not.
- *paraphrase* — the capability must be reachable from the artifact this fork actually ships, the portable `brave.exe`, as a launch parameter that starts the web server in the same portable context instead of opening the desktop GUI. Recorded in "Why" as the owner's expectation; no direct quote was captured.
- *paraphrase* — the change is scoped to the flag itself. A system-tray icon and an in-GUI toggle were both put to the owner and left out; recorded in `design.md` Explicit Rejections.

## Why

The headless web sidecar (INV-034, `docs/headless-web-build.md`) can only be run today by building from source (`yarn build:web` + `yarn dev:server`) or by producing a separate Node SEA binary in `dist-headless/`. Neither is reachable from the artifact this fork actually ships: the portable `brave.exe`. The owner's expectation is that the capability lives in the portable executable itself — a launch parameter that starts the web server in the same portable context instead of opening the desktop GUI.

The SEA pipeline exists solely to re-solve a problem the portable build already solved: shipping a self-contained binary that carries `better-sqlite3`, `sharp`, exiftool, and the SPA, re-deriving its paths at launch. Adding `--serve` does not add a second way to run the server — it removes one.

## What Changes

- **`brave.exe --serve` starts the sidecar instead of the desktop GUI**, in the same portable context: same `data\` directory, same active library, same thumbnail cache, same exiftool. `--port <n>` overrides the default 8666.
- **The server runs in the Electron main process.** `src/server/index.ts` is refactored so `startServer(opts)` derives nothing — `userData`, `dbPath`, `thumbnailDir`, `exiftoolPath`, `spaDir`, `port`, credential, and TLS material are all injected by the caller. Electron already resolved every one of those paths before the flag is read.
- **BREAKING — authentication becomes optional.** Today, no configured credential means the server rejects every request with HTTP 401 forever. After this change, no credential means no authentication gate at all. Owner-stated requirement, verbatim: *"the credentials should be optional. if none provided, then it does not require it."*
- **The bind address stays `0.0.0.0`** (all interfaces) — the no-auth case is explicitly *"access from my phone on my home wifi"*, which loopback-only would break.
- **A startup banner names what is exposed**: the reachable LAN URLs and whether auth is on, printed and logged, so an open server is visible rather than implicit.
- **Serve mode logs to `data\server.log`.** Verified during exploration: `electron.exe` is a Windows GUI-subsystem binary and its stdout does not reliably attach to the parent console — probe output vanished, then arrived late and interleaved with a subsequent command. Console output cannot be the source of truth in serve mode.
- **The single-instance lock is skipped in serve mode.** The lock is keyed on `userData`, which the GUI and the server share, so it would otherwise make the two mutually exclusive. The port bind (`EADDRINUSE`) is the natural and self-explaining mutex for a second server.
- **BREAKING — the Node SEA target is retired.** `scripts/package-headless.js`, `webpack.server.js`, and the `package:headless`, `build:server`, and `dev:server` scripts are removed. One server implementation in one host is what makes the owner's stated constraint — *"I don't really care as long as there is feature parity"* — true by construction instead of by repeated QA.
- **The SPA ships inside the packaged app** as `extraResources`, and `yarn build` produces it. `express.static` serving every image byte out of an asar archive is avoided deliberately.
- **`sharp` is externalized in the Electron webpack configs** and unpacked from asar, since the main process will now load it for thumbnail generation and non-web-format decoding.

## Capabilities

### New Capabilities
- `headless-serve-mode`: launching the read-only web sidecar from the portable executable — the launch parameter and its contract, the portable-context binding, the authentication policy (including the open, no-credential mode), network exposure and its disclosure, and serve-mode observability.

### Modified Capabilities
<!-- None. `openspec/specs/` contains dependency-hygiene, inspector-metadata-reliability, large-library-performance, location-watching, media-type-filter, multi-select-tagging, video-metadata-display, video-playback, viewer-file-anchoring — none of them specify the sidecar server, its packaging, or its auth. The headless build predates this repo's OpenSpec migration and was never given a spec. -->

## Blast Radius

1. `src/main.ts:476` — `app.requestSingleInstanceLock()` quits any second instance; serve mode must bypass it or the GUI and the server become mutually exclusive (they share `userData`, which keys the lock).
2. `src/main.ts:498` — `app.whenReady().then(initialize)` is the only entry path; the `--serve` fork is introduced here.
3. `src/main.ts:164` — `initialize()` calls `createWindow()` (`:179`) and `createPreviewWindow()` (`:180`), and seeds ffmpeg staging via `mediaJobService.setTempBaseDir()` (`:176`); serve mode must skip all three.
4. `src/main.ts:103` — `IS_PORTABLE_MODE` and the `app.setPath('userData'|'temp')` calls at `:115`-`:117` already resolve the portable context at module scope. This is the context serve mode inherits, and the reason the server's own derivation becomes redundant.
5. `src/server/index.ts:112` — `resolveExeDir()`, `resolveUserDataPath()` (`:153`) and `resolveExiftoolPath` re-derive by hand what Electron already knows; these are deleted, not adapted, and are the main place a subtle path regression could hide.
6. `src/server/index.ts:248` — `main()` is script-shaped (`process.exit()` on failure, module-scope invocation at `:534`); it becomes an injectable `startServer(opts)`.
7. `src/server/index.ts:451` — `spaDir` is resolved as `path.join(exeDir, 'dist-web')`, which is wrong under electron-builder packaging; the SPA location becomes an injected parameter.
8. `src/server/index.ts:505` and `src/server/index.ts:513` — both `listen()` calls omit the host argument, so the server binds all interfaces. Confirmed intended; the startup banner must disclose it.
9. `src/server/auth.ts:215` — `makeAuthMiddleware()` rejects every request when `cred === null` (`:234`-`:246`); this is the site of the optional-auth inversion.
10. `src/server/auth.ts:153` — `resolveCredential()` returns `null` when no env var is set; its contract comment ("server will reject everything") becomes wrong.
11. `src/server/auth.ts:363` — `POST /api/auth/login` returns HTTP 503 when no credential is configured (`:365`); in open mode it must not error.
12. `webpack.prod.js:30` and `webpack.prod.js:94`, `webpack.dev.js:30` and `webpack.dev.js:85` — all four `externals` blocks list only `better-sqlite3` and `fsevents`. `sharp` must be added for the main-process bundle or webpack will try to inline a native module.
13. `src/server/thumbnails.ts:24` and `src/server/decode.ts:25` — the only two `sharp` importers in the repo (grepped `from 'sharp'|require\('sharp'\)|import sharp` across the repo excluding `node_modules`; no other sites). Both become reachable from the Electron main process for the first time.
14. `package.json:24`, `:26`, `:28` — `dev:server`, `build:server`, and `package:headless` scripts are removed; `:79`-`:82` (`build.files`) and `:84`-`:86` (`asarUnpack`) change to ship the SPA and unpack `sharp`.
15. `webpack.server.js:73` (the Node-target externals block) and `scripts/package-headless.js:63` (the `dist-headless/` output root) — both files are deleted in full. `dist-headless/` does not exist on this machine, so the SEA path has never been produced here.
16. `src/renderer.tsx:71` — the web SPA constructs `new HttpBackend('')` with no user or password, so it already sends no `Authorization` header. Open mode requires no client change; this is evidence the SPA side of the auth inversion is already correct.
17. `docs/headless-web-build.md:162`, `:253`-`:259`, `:337` — document the old "rejects every request" auth contract and the removed build scripts; all three must be corrected.
18. `docs/TODO/pending_qa/tasks/TASK-137_PENDING_QA_OTHER_qa-headless-web-build-and-desktop-regression.md:27` — the open QA task's Phase C step verifies "the packaged binary on a clean machine with no Node installed" and asserts the auth gate returns 401 when unauthenticated. Both premises are superseded here (no SEA binary; unauthenticated is a legal mode), so this step must be reconciled rather than silently orphaned.
19. Searched for prior challenging scenarios: `openspec/lessons.md` does not exist in this repo yet (`Test-Path openspec\lessons.md` → false; `openspec/templates/lessons.md` exists but no store has been created), so there is no recorded scenario to draw on.

## Impact

**Runtime.** The Electron main process gains an HTTP server, Express, `sharp`, and a second `better-sqlite3` connection (read-only, alongside the renderer's read-write one). All native dependencies were verified to load under both runtimes during exploration: `better-sqlite3` loads under plain Node (ABI 137) and Electron 41.7.2 (ABI 145) from a single `.node` file; `sharp` loads and encodes webp under both (libvips 8.18.3); the EXR decoder wasm compiles under both. No ABI work is required.

**Security.** The change makes it possible to run an unauthenticated, all-interfaces HTTP server that streams any file in the library to any caller that can reach the port. The library remains read-only over HTTP — the exposure is disclosure, not modification. This is the owner's explicit, informed choice for a home-network deployment; the mitigation is disclosure at startup, not refusal.

**Desktop regression surface.** The desktop GUI path must be byte-for-byte unchanged when no flag is passed. The webpack `externals` and `asarUnpack` edits touch the packaged desktop build, so the portable GUI must be re-verified after packaging, not only after a source build.

**Removed surface.** `yarn dev:server`, `yarn build:server`, `yarn package:headless`, and `dist-headless/` cease to exist. Running the server from source during development is served by `brave.exe --serve` (or `electron ./build/main.bundle.js --serve`) instead.
