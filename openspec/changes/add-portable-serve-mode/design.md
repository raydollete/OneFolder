# Design — add-portable-serve-mode

## Approach

**1. Make the server a library, not a script.** `src/server/index.ts` becomes `startServer(opts)` in a module the Electron main bundle can import. It derives nothing: `userData`, `dbPath`, `thumbnailDir`, `exiftoolPath`, `spaDir`, `port`, `credential`, and TLS material are all parameters. `resolveExeDir()` (`:112`), `resolveUserDataPath()` (`:153`), `resolveExiftoolPath` (`:133`) and the module-scope `main()` invocation (`:534`) are deleted rather than adapted. Startup failures reject instead of calling `process.exit()`, so the caller decides what a failure means.

**2. Fork the Electron entry point.** `src/main.ts` parses `--serve` and `--port <n>` from `process.argv` before the single-instance lock runs. In serve mode it skips `app.requestSingleInstanceLock()` (`:476`), skips `createWindow()`/`createPreviewWindow()` (`:179`-`:180`), skips `mediaJobService.setTempBaseDir()`/`sweepTempDir()` (`:176`-`:177`), and calls `startServer()` with the paths Electron has already resolved at module scope (`:100`-`:121`). The GUI path is untouched when the flag is absent.

**3. Guard the two paths that would silently un-serve the server.** Bomb-squad findings 6 and 13 below are load-bearing for this design:
- `main.ts:481`-`:492` — the `second-instance` handler calls `initialize()` when `mainWindow === null`. A headless serve process holds no lock under (2), but the handler must still be inert in serve mode, or a later double-click spawns a GUI window inside the server process.
- `main.ts:1157` — `forceRelaunch` builds `const args = app.isPackaged ? [] : [process.argv[1]]`, discarding every user flag. It is reachable from the tray menu (`:323`), the uncaught-exception restart dialog (`:538`), `onClearDatabase` (`:637`) and `reload()` (`:642`). A serve process that hits any of them relaunches as a GUI with no listener and the sidecar silently disappears. `forceRelaunch` must forward the original flags.

**4. Invert the auth contract, and close the fail-open it exposes.** `makeAuthMiddleware` (`src/server/auth.ts:215`) calls `next()` when the credential is null instead of returning 401 (`:234`-`:246`); the login route (`:363`) no-ops instead of returning 503 (`:365`). Because absent auth becomes legal, `resolveCredential()` (`:153`) must stop treating an empty-string env var as a configured credential — otherwise `ONEFOLDER_AUTH_SECRET=''` yields `{user:'', password:''}` and the server accepts `Authorization: Basic Og==` while logging that auth is enabled. Empty is absent.

**5. Disclose exposure instead of restricting it.** Binding stays `0.0.0.0` (`src/server/index.ts:505`, `:513`) because the owner's stated use case requires it. The startup banner replaces the current line that hard-codes `localhost` while binding every interface, and states the resolved exposure and auth mode explicitly. `PORT`/`--port` is validated — today `Number(process.env.PORT ?? 8666)` turns `PORT=''` into `0`, which makes the OS assign a random ephemeral port.

**6. Log to a file.** `data\server.log` receives the banner, startup failures, request errors, and shutdown. Measured during exploration: `electron.exe` is a Windows GUI-subsystem binary whose stdout does not reliably attach to a parent console — probe output vanished on two runs, then arrived late and interleaved with a later command. Console output is a convenience, never the record.

**7. Packaging.** `sharp` is added to the four Electron webpack `externals` blocks (`webpack.prod.js:30`, `:94`; `webpack.dev.js:30`, `:85`) and to `asarUnpack`; the SPA is built by `yarn build` and shipped via `extraResources`. Today neither `sharp`'s native binaries nor `dist-web/` are in the package at all (`package.json:79`-`:86`), so an in-process serve mode would throw `MODULE_NOT_FOUND` on the first thumbnail and serve the `503 SPA not built yet` fallback for every page.

**8. Retire the SEA target.** `scripts/package-headless.js`, `webpack.server.js`, and the `package:headless`/`build:server`/`dev:server` scripts are deleted. One implementation in one host makes parity structural.

## UX / Requirements

### Pattern

The owner's task, in their vocabulary: *start the thing that lets me look at my photos from my
phone, without opening the app on the PC.* The surface that serves it is a **launch parameter
plus a startup banner in a log file** — a headless daemon bootstrap. No `Archetype:` line is
recorded here on purpose: the closed vocabulary (`radflow-lint --print-archetypes`:
settings-list, master-detail, data-table, wizard, form, feed, dashboard, detail-view, picker)
describes graphical surfaces, and this change adds no screen at all. Inventing a value to
satisfy the field would be a fabricated citation; the honest record is that the archetype set
does not cover a CLI-launched server, and the pattern below is drawn from that domain instead.

The established pattern it instantiates is the **dev-server startup banner**: on bind, enumerate
every URL the server is actually reachable on, distinguish loopback from network, and state the
authentication posture in the same breath — so that what was exposed is legible at the moment of
exposure rather than discoverable later.

Anchor: Vite dev server — prints `Local: http://localhost:5173/` and, when not exposed,
`Network: use --host to expose`; binding all interfaces is opt-in via `--host`. It prescribes
enumerating the reachable URLs at startup and distinguishing loopback from network. This design
adopts the enumeration and deliberately inverts the default: OneFolder binds all interfaces
without a flag, because the owner's stated case is reaching it from a phone, and a loopback
default would break the only use case (`https://vite.dev/config/server-options`).

Anchor: Jupyter notebook server — token authentication is on by default and the token is printed
in the startup URL so it can be copied; the documentation states authentication can be disabled
by setting token and password to empty strings but that this is "NOT RECOMMENDED, unless
authentication or access restrictions are handled at a different layer". It prescribes printing
the credential posture with the reachable URL. This design keeps the disclosure and departs from
the default: unconfigured means open, per the owner's verbatim requirement, with the banner line
`Authentication: DISABLED — no credential configured` carrying the warning Jupyter carries in its
docs (`https://jupyter-notebook.readthedocs.io/en/v6.4.8/security.html`).

Rejected pattern: an **interactive first-run prompt** for the credential and the bind address —
the shape a desktop app would normally use to make exposure a conscious act. Rejected because the
process has no console it can trust (measured: `electron.exe` is a GUI-subsystem binary whose
stdout does not reliably reach the parent console) and no window in serve mode, so a prompt would
block a headless server on input nobody can supply. Disclosure-after-the-fact in the log is the
weaker but reachable form of the same intent.

Rejected pattern: a **quiet daemon** that logs only errors, the systemd/service convention. It
fits a service an administrator configured deliberately; it does not fit a server whose defining
risk is that the operator does not realize it is open to the network. The banner exists to be
noisy about exactly that.

### Conventions consulted

- `openspec/conventions.md` — searched; the store does not exist in this repo yet, so no
  `Convention:` marker is cited here. Nothing was invented to fill the slot.
- Searched the web for the startup-banner convention of comparable locally-run servers: the Vite
  dev server's `Local:`/`Network:` enumeration and `--host` opt-in, and the Jupyter notebook
  server's token-in-URL disclosure and its explicit "NOT RECOMMENDED" framing of disabling
  authentication. Both are cited as `Anchor:` lines above with what each prescribes and where
  this design follows or departs from it.
- Norms applied from that reading: enumerate every reachable address rather than asserting one;
  name the authentication posture in the same banner; never print the credential itself; make an
  open server loud at the moment it opens.
- Norm deliberately NOT applied: the loopback-by-default bind that both references use. The
  divergence is recorded in Explicit Rejections with the owner's verbatim reason, and it is the
  one point where independent peer review and the owner's stated requirement disagreed.

### Controls & States

- **`--serve`** — governs whether the process becomes the desktop GUI or the web server.
  Present: no window is created, the single-instance lock is skipped, ffmpeg staging is not
  seeded, the listener opens and the banner is written to `data\server.log`. Absent: the desktop
  GUI launches exactly as before and no listener is opened.
- **`--port <n>`**, falling back to the `PORT` environment variable — governs the listening port.
  A whole number in 1-65535: the server listens there and the banner names it. Anything else:
  the line `[server] --port requires a whole number between 1 and 65535 (got '<value>').` is
  written and the process exits non-zero with no listener opened. Neither set: port 8666.
- **`ONEFOLDER_AUTH_SECRET`, or `ONEFOLDER_AUTH_USER` + `ONEFOLDER_AUTH_PASSWORD`** — governs
  whether an authentication gate exists at all. Set: every route answers 401 with
  `WWW-Authenticate: Basic` until authenticated, and the banner reads
  `Authentication: enabled (shared secret)` or `Authentication: enabled (user: alice)`. Unset,
  empty, or whitespace-only: there is no gate, every route and the SPA answer 2xx, and the banner
  reads `Authentication: DISABLED — no credential configured`. The credential value is never
  printed in either state.
- **`ONEFOLDER_TLS=1`**, with optional `ONEFOLDER_TLS_CERT` / `ONEFOLDER_TLS_KEY` — governs the
  scheme. Set: the listener is HTTPS and every banner URL reads `https://`, using the supplied
  certificate or a self-signed one cached in userData. Unset: plain HTTP, and the banner's URLs
  read `http://`.

### Display strings

Verbatim strings. Every line is written to `data\server.log` and also to stdout (which may or may not be visible).

Startup banner, authentication disabled:

```
[server] OneFolder serve mode — listening on port 8666
[server]   http://127.0.0.1:8666
[server]   http://192.168.1.42:8666   (reachable from your network)
[server] Authentication: DISABLED — no credential configured
[server] Library: My Library
[server] Log file: D:\OneFolder\data\server.log
```

Startup banner, authentication enabled — same shape, with one of:

```
[server] Authentication: enabled (user: alice)
[server] Authentication: enabled (shared secret)
```

The second form is used when the credential came from `ONEFOLDER_AUTH_SECRET`. Found by running it: that variable makes user and password the same string, so printing the user name writes the shared secret in plaintext into `server.log`. The name is only printed for an explicit `ONEFOLDER_AUTH_USER` + `ONEFOLDER_AUTH_PASSWORD` pair.

Errors:

- `[server] Port 8666 is already in use. Another OneFolder server may already be running. Use --port <n> to choose a different port.`
- `[server] No library found in <path>. Launch OneFolder normally at least once to create a library.`
- `[server] --port requires a whole number between 1 and 65535 (got '<value>').`
- `[server] Database not found at <path>.` followed by `[server] The library is registered but its database has not been created yet. Launch OneFolder normally once, then try --serve again.`

The second line was added after running the packaged portable build: a fresh install registers a default library at first launch, but the database itself is created by the renderer on its first GUI run. Serve mode therefore meets a registered library with no database and would otherwise name a missing path with no way to act on it.

Shutdown: `[server] Shutting down — closing database and exiftool.`

The credential value is never written to the log or to stdout; only the resolved user name is shown, and only when authentication is enabled.

### Explicit Rejections

- **Re-executing the exe with `ELECTRON_RUN_AS_NODE=1`** — rejected: it needs a second bundle shipped as a resource plus child-process supervision, and forfeits any future in-GUI server control. Its only advantage measured was roughly 60 MB of idle memory.
- **Keeping the Node SEA `dist-headless` target alongside `--serve`** — rejected: two implementations make "feature parity" something QA must re-verify every release instead of something guaranteed by shared code. The owner's constraint was *"I don't really care as long as there is feature parity"*.
- **Defaulting the bind address to `127.0.0.1` and requiring an explicit `--host` to reach the LAN** — rejected, against reviewer recommendation. The owner was asked this question directly and answered that the no-auth case is *"for access from my phone on my home wifi"*; a loopback default breaks the only stated use case. Mitigated by disclosure at startup rather than by restriction. See Review Feedback.
- **Requiring an explicit `--no-auth` flag before serving without a credential** — rejected: the owner's requirement is verbatim *"the credentials should be optional. if none provided, then it does not require it."* An opt-in flag would make them not optional.
- **Naming the flag `--headless`** — rejected: it collides with Chromium's own `--headless` switch on an Electron binary, and reads as "no UI at all" rather than "serve instead of show".
- **Serving the SPA from inside the asar archive** — rejected: every image byte would be read through asar. Shipped as `extraResources` instead.
- **A system-tray icon for serve mode** — rejected: the owner scoped this change to the flag alone. Revisit if serve mode proves hard to notice or stop.
- **A stop/restart lifecycle handle on `startServer()`** — rejected for now: the owner chose the fire-once bootstrap over designing for a future GUI toggle.

## External Review

### Peer Review Verdict

Quorum: achieved (weight 4/3, escalated to tier 2)
Certainty: 0.9833333333333334
Caller Agreement: 0.95
Arbiter: ok
Sources:
- gemini-flash (google/gemini-3.5-flash) — ok, agreement 1
- qwen (qLLM) — ok, agreement 0.95
- deepseek-flash (deepseek-v4-flash) — error, agreement n/a
- gemini-pro (google/gemini-3.1-pro-preview) — ok, agreement 1

### Review Feedback

Consensus feedback recorded verbatim:

- "Refactoring the server from a standalone script into an injectable library module, removing self-derivation of paths and `process.exit()` calls, and injecting paths (userData, dbPath, exiftool, SPA assets) and configuration from the Electron main process." — ACCEPTED: this is Approach 1; the derivation helpers are deleted rather than adapted.
- "Modifying the Electron main process to parse command-line arguments (e.g., `--serve`) early, conditionally bypassing GUI window creation and running the server in-process." — ACCEPTED: Approach 2. "Early" is load-bearing — parsing must precede the single-instance lock, which runs at module scope.
- "Handling the single-instance lock conditionally (either skipping it for server mode, making it mode-aware, or using it to forward commands to a running instance)." — ACCEPTED, taking the first option: serve mode skips the lock entirely and `EADDRINUSE` becomes the mutex. Bomb-squad finding 13 shows the third option is actively harmful here — the existing `second-instance` handler would spawn a GUI window inside the server process.
- "Updating webpack configurations to externalize native modules like `sharp` and `better-sqlite3`, and configuring `electron-builder` to unpack them (`asarUnpack`) along with the `exiftool` binary." — ACCEPTED: Approach 7. `better-sqlite3` and exiftool are already handled; `sharp` and the SPA are not, and bomb-squad confirmed both are missing from the package entirely.
- "Making authentication optional by bypassing the auth middleware when no credentials are configured." — ACCEPTED: Approach 4, plus the empty-string fail-open it exposes.
- Risk: "Windows stdout unreliability (mitigated by logging to a file or using a tray icon)" — ACCEPTED as the file-log half; the tray icon is explicitly rejected above as out of scope.
- Risk: "SQLite database locking (mitigated by using WAL mode and opening the database read-only)" — ACCEPTED in substance, with a correction: the database is already opened `readonly: true`, but bomb-squad finding 7 shows the existing `db.pragma('journal_mode = WAL')` on that read-only connection is based on a false model of SQLite and must be removed, not relied upon.
- Risk: "unauthorized network exposure on public Wi-Fi" — ACCEPTED as a real risk, REJECTED as a reason to change the default. The owner was asked directly and chose LAN reach over loopback for the no-auth case. The mitigation is the startup banner naming the reachable addresses and the auth state, so the exposure is visible rather than implicit. This is the one point where independent peers and the owner's stated requirement diverge, and it is resolved in favour of the stated requirement, recorded here rather than silently reinterpreted.
- Risk: "ASAR pathing issues for native modules and external binaries" — ACCEPTED: reinforced by bomb-squad finding 13, which notes that on the Windows portable target `process.execPath` is the NSIS temp extraction directory, so any path derived from the executable's own location points into a directory that is wiped on exit. This is an additional argument for injecting paths from Electron rather than deriving them.

## UI Review

Quorum: not achieved (weight 0/3, escalated to tier 2)
Certainty: 0
Caller Agreement: n/a
Arbiter: failed
Sources:
- gemini-flash (google/gemini-3.5-flash) — unavailable, agreement n/a
- qwen (qLLM) — ok, agreement n/a
- deepseek-flash (deepseek-v4-flash) — ok, agreement n/a
- gemini-pro (google/gemini-3.1-pro-preview) — unavailable, agreement n/a

Run twice on 2026-08-15 with the `### Pattern` subsection leading verbatim and the rest of the
filled UX / Requirements section following, no `callerAnswer`, tier 2 (the repo's `openspec/config.yaml`
carries no `ui_escalation` key, so this change's `tier3_escalation: 2` applies). Both runs returned
the identical roster: the two gemini sources unavailable and the arbiter failed, leaving agreeing
weight 0 against a required weight of 3. The second run was made because a failed arbiter is a
degraded result that the rules say to re-run rather than transcribe; the repeat identifies it as a
standing outage rather than a blip.

This is a HALT, not a pass. Per the recorded rule for an unmet quorum, nothing from either response
has been incorporated into this design or into the reasoning behind it, and no UX string, control
name, or banner line was changed on the strength of it. The two responding peers did return
substantive pattern-level critique; it is deliberately NOT transcribed or acted on here, because a
sub-quorum response carries no more authority than a single unreviewed opinion, and adopting the
half that answered would launder an outage into a verdict. The change owner decides how to proceed:
re-run once the gemini sources are reachable, direct a revision, or explicitly override.

## Bomb-squad findings

Hunt dispatched over the blast radius for two failure classes: (A) duplicated environment/path derivation, (B) a contract that inverts on absent configuration.

**In scope for this change — these block or corrupt `--serve`:**

1. `src/main.ts:481`-`:492` — the `second-instance` handler calls `initialize()` when `mainWindow === null`, so a headless serve process spawns a GUI window the first time the user double-clicks the exe.
2. `src/main.ts:1157` — `forceRelaunch` discards all user flags (`const args = app.isPackaged ? [] : [process.argv[1]]`); reachable from the tray menu (`:323`), the uncaught-exception dialog (`:538`), `onClearDatabase` (`:637`) and `reload()` (`:642`). A serve process that hits any of them relaunches as a GUI with no listener.
3. `package.json:79`-`:86` — `files` is `["build/**/*", "package.json"]` and `asarUnpack` covers only `better-sqlite3`. `sharp`'s native binaries and `dist-web/` are not in the Electron package at all: in-process serve would throw `MODULE_NOT_FOUND` on the first thumbnail and return the `503 SPA not built yet` fallback (`src/server/index.ts:492`) for every page.
4. `src/server/auth.ts:153`-`:167` — `user !== undefined && password !== undefined` accepts empty strings, so `ONEFOLDER_AUTH_SECRET=''` produces `{user:'', password:''}`, accepts `Authorization: Basic Og==`, and logs "Auth credential configured (user: )". Harmless while everything 401s; a fail-open the moment auth becomes optional.
5. `src/server/index.ts:249` — `Number(process.env.PORT ?? 8666)`: `PORT=''` → `0` → the OS assigns a random ephemeral port; `PORT=abc` → `NaN`. The server then logs `listening on http://localhost:0`.
6. `src/server/index.ts:505`, `:513` — both listeners bind every interface while the log line asserts `localhost`. The banner must state what was actually resolved.
7. `src/server/index.ts:355`-`:359` — `db.pragma('journal_mode = WAL')` on a `readonly: true` connection, justified by a comment that misstates how SQLite WAL works. It either no-ops or throws `SQLITE_READONLY` at startup depending on the file's current mode — inside the Electron main process that would take down serve mode.
8. `common/ExifIO.ts:54`-`:58` — module-level side effect: importing `ExifIO` (which `src/server/index.ts:68` does) evaluates `getExtraResourcePath()` and constructs an exiftool process handle at import time. `common/fs.ts:143`-`:146` derives that path as `(IS_DEV ? '../' : '../../') + 'resources'` — a build-mode plus directory-depth assumption that is wrong for any bundle emitted at a different depth. In-process serve imports this into the main bundle.
9. `common/ExifIO.ts:181` — calls `localStorage.setItem`, a renderer-only global, from a class the server instantiates. Reached from the Electron main process this throws.
10. `src/main.ts:101` vs `src/server/index.ts:112`-`:119`, `:340`-`:344` — three different anchor directories for portable detection, and `index.ts` answers the same yes/no question twice ~180 lines apart with different expressions. On the Windows portable target `process.execPath` is the NSIS temp extraction directory, not the folder holding the user's exe, so `spaDir` (`:451`) derived from it points into a directory wiped on exit.

**Out of scope — recorded, not fixed here:**

11. `src/server/thumbnails.ts:35`, `:41`, `:180`-`:186` — `SERVER_THUMBNAIL_MAX_SIZE = 600` is hard-coded while `common/config.ts:20` computes 400 on HiDPI, and `hashFilePath` is a hand-copied clone of `hashString` (`common/fs.ts:68`). Both processes write the same filenames into the same directory and neither regenerates when a file exists, so on a HiDPI machine whichever wrote first wins permanently. The stated reason for the duplication (`thumbnails.ts:17`-`:19`) is false — `routes/images.ts:54` already imports from `common/fs.ts`, which imports `common/config.ts`.
12. `src/server/thumbnails.ts:168`-`:173` — `getPreviewPath` derives its directory by walking up from `thumbnailDir`, so in portable mode previews land in `{userData}/thumbnails/previews`, shared across all libraries and outside every per-library directory. `src/main.ts:1023` can therefore never delete a portable library's previews, and `DELETE_LIBRARY_AND_FILES` reports success while leaving an unbounded orphan cache.
13. `src/server/path-resolver.ts:220`-`:236` — the Windows case-insensitive fallback lowercases without normalising separators, and SQLite's `LOWER()` is ASCII-only, so non-ASCII filenames fail the fallback match and return "Path not found in library".
14. `src/ipc/renderer.ts:187`-`:199` vs `common/library-registry.ts:185`-`:197` — two implementations of the thumbnail-directory rule, one carrying a legacy flat fallback the other lacks, despite the registry's comment claiming it exists to prevent exactly this duplication.
15. `src/media/MediaJobService.ts:65`, `:69`, `:74`-`:76` — `tempBaseDir` defaults to `os.tmpdir()` and is corrected only inside `initialize()`; any job started before that writes ffmpeg staging outside the portable data folder. Moot for serve mode (no media jobs) but a live temporal coupling in the GUI path.
16. `src/frontend/containers/Settings/BackgroundProcesses.tsx:25`, `:31` — `sendSync` on IPC channels `src/main.ts` no longer registers handlers for, which would block the renderer thread forever. Dormant only because `Settings/index.tsx:61` has the component commented out.

**Structural recommendation, deferred:** bomb-squad proposed a single `common/app-paths.ts` owning all environment resolution, with an ESLint `no-restricted-syntax` rule banning `PORTABLE_EXECUTABLE_DIR`, `APPDATA`, `os.tmpdir()`, `os.homedir()` and `path.resolve(__dirname, '..')` outside it. This change takes the first half for the server only — one owner (`main.ts`), one consumer (`startServer`) — and leaves the repo-wide extraction and the lint rule as follow-up work, since items 11-16 are pre-existing and independent of `--serve`.
