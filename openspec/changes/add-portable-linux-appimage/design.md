# Design — add-portable-linux-appimage

## Context

See `proposal.md` — Why. The renderer already has one Electron platform implementation selected through `src/frontend/platform`; Linux does not require a second renderer or a fork of the React tree. Electron-builder already declares an AppImage target, native modules are already externalized/unpacked, and the main process already redirects `userData`/`temp` early for Windows portable launches. The missing layer is an accurate Linux distribution context plus complete Linux helper resources and packaged verification.

The implementation must preserve these bindings: Electron remains pinned at 41.7.2; `better-sqlite3` and `sharp` are rebuilt for the Linux target and remain unpacked from ASAR; frontend code imports native capabilities only through `src/frontend/platform`; desktop and `--serve` modes share the same portable context; and Windows `brave.exe` behavior stays unchanged.

The AppImage runtime defines `APPIMAGE` as the absolute outer artifact and `APPDIR` as its mounted payload. `process.execPath` therefore identifies the executable inside that payload, not the file the user can move or relaunch. GNOME Wayland is the primary desktop session; Electron 41 selects Wayland automatically, while programmatic positioning/focus may be constrained by the compositor.

## Goals / Non-Goals

**Goals:**

- Produce one Linux x86_64 AppImage that launches without installation and owns a sibling `data/` directory from first launch.
- Give portable detection, GUI mode, serve mode, and forced relaunch one authoritative view of the outer artifact and writable root.
- Ship every helper promised by existing desktop behavior, with Linux execute permissions, provenance, and fail-loud verification.
- Preserve Linux trash semantics and make the artifact identifiable in GNOME launchers and window switching.
- Verify the real packaged artifact under a GNOME Wayland session, not only bundles or unit tests.

**Non-Goals:**

- Translating Windows absolute library paths or drive letters to Linux mounts.
- Adding Flatpak, Snap, Debian/RPM packages, automatic updates, signing, or a background installer/integration daemon.
- Replacing the established frameless titlebar with GTK/libadwaita controls or creating a Linux-only renderer tree.
- Supporting ARM64, musl/Alpine, or non-GNOME desktops in this change.
- Adding a software encoder fallback for media jobs; the existing NVIDIA/NVENC contract remains fail-loud on unsupported hosts.

## Approach

**1. Centralize launch-context resolution before Electron paths are read.** Add a small pure main-process module under `src/` that accepts an environment and executable path and returns the outer executable, its containing directory, and whether the packaging format implies portable mode. Precedence is `PORTABLE_EXECUTABLE_FILE`/`PORTABLE_EXECUTABLE_DIR` for the Windows wrapper, then `APPIMAGE` for Linux, then `process.execPath` for ordinary packaged/dev launches. `src/main.ts` consumes this result before its first `app.getPath()` call, adds the existing `portable.txt`/`data` opt-in checks for nonportable formats, and performs the existing `app.setPath` calls. A search across `src/`, `common/`, and `scripts/` found no equivalent shared resolver; `common/process.ts` only exposes platform/build booleans, so widening it would couple renderer bundles to main-process environment/path policy.

**2. Reuse that same result for relaunch.** `forceRelaunch` executes the resolved outer artifact rather than independently choosing between one Windows environment variable and `process.execPath`. Its existing packaged/dev argument slicing and user-flag forwarding remain intact, including `--serve` and `--port`. This is preferred over `app.relaunch()` because both Windows portable and AppImage formats run an inner executable from transient storage.

**3. Keep established resource lookup; complete the Linux payload.** Continue using `getExtraResourcePath` and the existing platform-selected names (`exiftool.pl`, `ffmpeg`, `ffprobe`) rather than introducing a second path API. Correct the Linux/macOS `.ExifTool_config` declaration to the tracked exact case. Add Linux x86_64 FFmpeg/FFprobe assets to a platform-specific source directory and map them into `resources/ffmpeg/{ffmpeg,ffprobe}` only for the Linux target, leaving the current Windows layout byte-identical. Preserve executable file modes for both binaries and `exiftool.pl`. Record upstream version, source URL, license, build configuration, and SHA-256 for vendored binaries; acceptance checks execute `ffmpeg -version`, `ffprobe -version`, verify the required `h264_nvenc` encoder is compiled in, and start ExifTool. Perl remains a documented Ubuntu/GNOME host prerequisite for the upstream ExifTool script; missing Perl or helpers is a startup/feature error, never a silent fallback.

**4. Make Linux packaging explicit and reproducible.** Extend the existing `logo` preparation to create electron-builder's conventional `build/icons/<size>x<size>.png` set from the already-owned PNG assets. Configure Linux `executableName`, `desktopName`, icon directory, AppImage artifact name, and x64 target explicitly. Keep electron-builder's generated desktop entry as the single source, align its `StartupWMClass` with the runtime `WM_CLASS`/application identity, and request Electron's automatic Ozone platform selection on Linux so a Wayland session remains native without globally forcing XWayland. Build from a clean locked dependency installation on Linux so `better-sqlite3`, `sharp`, and `@img` resolve for Electron/Linux x64; inspect the extracted AppImage before launch. Documentation explains optional user-level GNOME integration because running an AppImage itself requires no installation.

**5. Make ExifTool initialization a shared retryable promise.** Replace `isOpening` plus an uncleared polling interval with one in-flight initialization promise. Concurrent callers await the same promise; success clears the in-flight marker and observes the open process, while rejection also clears it so a later call can retry. Preserve the explicit-path server instance and lazy desktop singleton rather than creating another ExifTool wrapper.

**6. Restrict the Recycle Bin probe to Windows.** The existing `$Recycle.Bin` test remains exactly as-is on `win32`. Other platforms report “recyclable” to the renderer and let Electron's `shell.trashItem` use the desktop's native trash implementation; actual trash failure continues through the established error path. This avoids both a Linux-specific duplicate trash implementation and the current false permanent-delete classification for `/`.

**7. Centralize platform-aware path identity and reuse it.** Add one formatter to the existing frontend platform surface (or widen its current path implementation) that normalizes separators on every desktop but folds case only on Windows. `MediaReleaseCoordinator`, `LocationStore` suppression/ingest matching, and `FileStore.waitForIngestedFile` import that formatter instead of retaining hand-written lowercase clones. This satisfies the repository's mandatory shared-module rule and preserves Windows behavior while allowing case-distinct Linux files. Changing `encodeFilePath`'s ambiguous treatment of `?` is explicitly rejected here: it cannot distinguish a legacy cache-busting suffix from a legal POSIX filename without changing its API and every caller.

**8. Test pure decisions and the packaged contract.** Unit tests table-drive Windows portable, AppImage, ordinary packaged, and development launch contexts, including precedence and relaunch target/flags. Platform trash tests prove the `$Recycle.Bin` filesystem probe is unreachable on Linux and unchanged on Windows. ExifTool tests cover concurrent initialize, failed open, retry, interval-free settlement, and process cleanup at application shutdown; path tests use case-distinct POSIX names and case-variant Windows names at every consumer. Packaging tests/inspection assert exact-case resource inputs, helper presence, execute bits, native-module architecture, desktop metadata including matching launcher/window class, icons, and the absence of Windows PE helpers in the Linux payload. The production pass launches the AppImage on GNOME Wayland and exercises first-run data creation, close/reopen (so SQLite handles and helper processes are released before moving the portable unit), forced reload, moving the artifact with its `data/` sibling, case-distinct library files, metadata read/write, thumbnails, trash, one compatible media job, frameless controls/drag/focus, dialogs, and `--serve`. XWayland is a diagnostic fallback only if the Wayland pass exposes a compositor-limited operation; it is not forced globally.

## Risks / Trade-offs

- **Vendored FFmpeg adds substantial repository and artifact size and carries GPL obligations** → use the repository's established vendored-binary pattern, record provenance/checksums/build flags, update license notices, and verify distribution obligations before release.
- **The required NVENC encoder still depends on compatible NVIDIA hardware, driver libraries, and permissions** → preserve the existing fail-loud behavior and test on the target NVIDIA GNOME machine; do not imply universal Linux encoding support.
- **ExifTool's upstream Perl script depends on `/usr/bin/perl`** → declare Ubuntu/GNOME with Perl as the supported baseline, validate it explicitly, and surface a concrete missing-runtime error. Bundling a private Perl runtime is rejected for this bounded target because it materially expands security and update ownership.
- **An AppImage placed in a read-only or `noexec` location cannot create its sibling `data/` directory or run** → fail at startup with the concrete filesystem error and document that the artifact plus `data/` must live in a writable, executable location.
- **Moving only the AppImage leaves its data behind** → document the portable unit as the AppImage plus sibling `data/`; do not hide data inside the immutable AppImage or overload `$HOME`.
- **Wayland may ignore programmatic position/focus operations** → accept compositor control where functionality remains usable, verify the actual workflows, and use an opt-in XWayland launch note only for a demonstrated blocking defect.
- **Platform-condition edits could regress Windows portable mode** → table-drive resolver precedence and run the existing Windows portable package/GUI smoke pass before completion.
- **Large native assets can accidentally be packaged for the wrong OS** → use per-platform `extraResources` mappings and assert extracted artifact contents rather than broad top-level resource inclusion.
- **Correcting Linux case sensitivity touches shared media/watcher consumers** → route every consumer through one platform-aware formatter, retain case-folding on Windows, and cover both policies with focused tests.

## Migration Plan

There is no database migration. Existing Linux users who previously ran a nonportable package may keep that profile in the normal Electron user-data directory; the new AppImage begins with an adjacent `data/` directory because no verified portable AppImage contract exists to preserve. Rollback is removing the new AppImage and retaining its sibling `data/`; no user library files are rewritten by packaging. Windows users remain on the current `brave.exe` path and data layout.

## External Review

### Peer Review Verdict

Quorum: achieved (weight 3/3, escalated to tier 1)
Certainty: 1
Caller Agreement: 1
Arbiter: ok
Sources:
- deepseek-flash (deepseek-v4-flash) — ok, agreement 1
- qwen (qLLM) — error, agreement n/a: Request to "qwen" was aborted
- gemini-flash (google/gemini-3.5-flash) — ok, agreement 1

### Review Feedback

Consensus feedback recorded verbatim:
- “To make the photo manager a reliable portable AppImage while preserving Windows behavior, implement a runtime context abstraction that resolves the outer executable path (using `process.env.APPIMAGE` on Linux and `PORTABLE_EXECUTABLE_FILE`/`PORTABLE_EXECUTABLE_DIR` on Windows) and the portable root, avoiding reliance on `process.execPath`.” — ACCEPTED: decisions 1 and 2 use one early launch context for portable paths and relaunch.
- “Set Electron's `userData` and `temp` paths early in the bootstrap process.” — ACCEPTED: decision 1 performs path selection before the first application-path read.
- “Resolve native helpers (ExifTool, FFmpeg) relative to the read-only mounted payload path (`process.resourcesPath`), ensure their executable permissions (0755) are preserved via electron-builder, and manage their lifecycle to prevent orphan processes.” — ACCEPTED: decisions 3, 5, and 8 preserve the shared resource resolver, executable modes, retryable initialization, and shutdown cleanup coverage.
- “For GNOME/Wayland, set `ozone-platform-hint` to `auto` and align `StartupWMClass` with `WM_CLASS`.” — ACCEPTED: decision 4 now records automatic Ozone selection and matching launcher/window identity, with packaged verification in decision 8.
- “Additional blast radius areas include file watchers, path equality checks (requiring canonicalization), SQLite database locks, trash/deletion mechanisms, CLI/headless dispatchers, and automatic updates.” — ACCEPTED: watcher/path identity, SQLite release before move, trash, and `--serve` are explicit in decisions 6–8; REJECTED for automatic updates because no updater subsystem or update feed exists in the repository, so it is not a reachable consumer of this change.
- “Explicit guardrails must address packaging (artifact acceptance tests), native modules (ABI rebuilds, `asarUnpack`), filesystem constraints (read-only root fallbacks), deletion (falling back to physical deletion if trash fails), licensing (redistribution compliance), and rollback (atomic updates).” — ACCEPTED: artifact inspection, Linux ABI rebuilds, `asarUnpack`, fail-visible unwritable-root behavior, licensing/provenance, and removable AppImage-plus-data rollback are already specified; REJECTED for silent read-only fallback because it would violate portable-data locality, physical deletion without renewed user consent because it is unsafe, and atomic updates because this application has no updater path in scope.

## Bomb-squad findings

The required read-only hunt covered outer-artifact/writable-root confusion and Windows assumptions leaking into Linux/GNOME. Findings are dispositioned here; file:line references are pre-change.

**In scope — release blocking or directly exposed by this target:**

1. `src/main.ts:102`-`:120` conflates the inner packaged executable with the durable writable root. Under AppImage, portable mode is not entered and a sentinel in the mounted payload would redirect writes into read-only transient storage.
2. `src/main.ts:1253`-`:1281` handles only the Windows outer wrapper during relaunch, so AppImage reload/clear-database/exception restart can race the unmount of the executable it tries to spawn.
3. `package.json:36`-`:55` names `.Exiftool_config`, while the tracked file is `resources/exiftool/.ExifTool_config`; a case-sensitive Linux checkout cannot resolve the declared source.
4. `package.json:46`-`:67`, `common/fs.ts:157`-`:170`, and `resources/ffmpeg/` select Linux `ffmpeg`/`ffprobe` names at runtime but ship only Windows PE binaries. `tests/media-job.test.ts:255`-`:260` hides this by skipping functional media tests whenever the promised platform binary is absent.
5. `resources/exiftool/exiftool.pl:1` is tracked as mode `100644`; direct spawn on Linux fails with `EACCES`. Its `/usr/bin/perl` interpreter is also a host prerequisite that the portable contract previously left implicit.
6. `common/ExifIO.ts:165`-`:181` leaves `isOpening` true after `_ep.open()` rejects and polls with an interval that is never cleared. A Linux helper-start failure therefore makes later initialization hang forever rather than retry or fail.
7. `src/main.ts:806`-`:852` tests for `$Recycle.Bin` on every filesystem root. Every ordinary POSIX path maps to `/`, so GNOME files are classified as permanently deletable even when the desktop trash supports them.
8. `src/frontend/image/MediaReleaseCoordinator.ts:41`-`:44`, `src/frontend/stores/LocationStore.ts:533`-`:569`, and `src/frontend/stores/FileStore.ts:1620`-`:1627` lowercase all path keys. Distinct Linux files differing only by case can suppress, release, ingest, or resolve the wrong file.
9. `package.json:17`, `package.json:46`-`:56`, `src/main.ts:199`-`:220`, and `src/frontend/containers/WindowTitlebar.tsx:10`-`:81` provide no verified Linux desktop identity/icon input or GNOME Wayland packaged interaction evidence.
10. `README.md:90`-`:124` and `docs/headless-web-build.md:301`-`:358` remain Windows-shaped (`brave.exe`, Windows environment syntax, NSIS/console assumptions), so AppImage GUI and serve operation would be undiscoverable or misleading.

**Verified existing seams to preserve:**

- `src/main.ts:490`-`:575`, `src/serve-mode.ts:59`-`:124`, and `src/server/index.ts:78`-`:105` already inject serve-mode user data and packaged resources instead of re-deriving them; no `APPDIR` misuse was found.
- `src/server/path-resolver.ts:85` already preserves POSIX case sensitivity.
- Native modules are already under `asarUnpack`; the gap is Linux ABI/package verification, not a second native-module loading design.
- User flags are already forwarded and `src/serve-args.ts:25`-`:41` is packaging-neutral; selecting the correct outer executable completes that path.

**Explicitly deferred or rejected:**

- `.github/workflows/build.yml:16`-`:28` uses Node 16 and 2021-era actions. Release automation modernization is a separate change because this change's acceptance path is the explicit Linux package command and real local production artifact; the workflow must not be used as evidence until modernized.
- `common/fs.ts:18`-`:39` treats `?` in the last path component as URL parameters, conflicting with legal POSIX filenames. A safe correction needs an API decision separating filesystem paths from optional URL query suffixes and would change existing callers, so it is not silently folded into this target.
- AppImage support remains Linux x86_64 with documented NVIDIA/NVENC and Perl prerequisites. Adding a software encoder fallback, bundled Perl runtime, ARM64, or musl support is outside this change.
