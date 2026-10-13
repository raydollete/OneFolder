# Restore the OneFolder Windows executable name and document the fork's portable builds

## Stated Requirements

- "Remove the reference to brave.exe — update the windows build back to the old file name"
- "Do the above but also add documentation that this fork is specifically about portable builds."
- "Include instructions on how to both do a Windows and Linux build"
- Decision (asked: "What should the Windows portable file be named?"): "OneFolder-<ver>-x64.exe (Recommended)"

Tier: 2 — packaging identity change plus a documentation sweep across 14 files outside openspec/; no runtime code path depends on the executable basename
Type: feature

## Why

The Windows build ships as `brave.exe` (an NVIDIA VSR allowlist workaround). Now that the repo is being made public, an executable named after another vendor's browser is confusing and looks like impersonation. The README also doesn't say that this fork exists for portable builds, and it has no complete Windows and Linux build instructions.

## What Changes

- **BREAKING (artifact name):** the Windows portable artifact becomes `dist/OneFolder-<version>-x64.exe` (was `dist/brave.exe`). The inner executable becomes `OneFolder.exe` (the electron-builder default from `productName`). Existing portable directories replace `brave.exe` with the new file; the sibling `data/` is unaffected because portable-root detection uses the wrapper's environment, not the basename.
- NVIDIA Video Super Resolution stops engaging for in-app video playback (accepted consequence of dropping the allowlisted name).
- Every live `brave.exe` reference (source comments, tests, CLAUDE.md, README, docs) is replaced with the new name. Historical records (`docs/TODO/**`, `openspec/changes/archive/**`, evidence lines in in-flight changes) are left as written.
- The README gains a "Portable builds" section saying this fork targets portable builds only (Windows portable `.exe` + Linux AppImage, each with a sibling `data/`). It gives step-by-step Windows and Linux build instructions, including the Linux ffmpeg acquisition step: those binaries are not tracked in git.
- `docs/personal-fork-notes.md` replaces the "Why brave.exe" rationale with a short record of the rename and its reversal.

## Capabilities

### New Capabilities
- `windows-portable-build`: the Windows build produces a single portable, versioned `OneFolder-<version>-x64.exe` whose inner executable is `OneFolder.exe`, keeps its state in a sibling `data/`, and accepts `--serve`.

### Modified Capabilities
<!-- None in openspec/specs/. The in-flight changes add-portable-linux-appimage and add-portable-serve-mode carry unsynced spec deltas naming brave.exe; those change artifacts are corrected in place (tasks), since they have no base spec to delta against. -->

## Impact

Packaging config, one packaging test, and documentation only. No runtime code path reads the executable basename (`src/portable-launch-context.ts:101` resolves the portable root from `PORTABLE_EXECUTABLE_DIR`). The NSIS installer stays disabled, and the Linux AppImage name is unchanged.

## Blast Radius

1. package.json:78 — `build.win.executableName: "brave"` (remove; default inner name `OneFolder.exe`).
2. package.json:101 — `build.portable.artifactName: "brave.${ext}"` becomes `OneFolder-${version}-x64.${ext}`.
3. tests/appimage-packaging.test.ts:118 — pins `executableName === 'brave'` and `artifactName === 'brave.${ext}'`; it will fail and must assert the new identity.
4. tests/serve-mode.test.ts:17 — `brave.exe` used as argv[0] fixture (and :2, :21, :29, :33, :37, :41); cosmetic but a live reference.
5. src/main.ts:161 — serve-mode comment names `brave.exe --serve`.
6. src/serve-mode.ts:2 — module doc names `brave.exe --serve`.
7. src/server/index.ts:12 — module doc names `brave.exe --serve`.
8. webpack.web.js:16 — comment names `brave.exe --serve`.
9. CLAUDE.md:64 — "Platform Seam / Web Build" names `brave.exe --serve`.
10. README.md:109 — dual-boot paragraph names `brave.exe`; also README.md:142-145 serve examples, and README.md:89-91 "Release Build" (rewritten as the portable-builds section).
11. docs/headless-web-build.md:17 — serve examples (and :327, :348-:360).
12. docs/personal-fork-notes.md:15 — deviation 1 and the "Why `brave.exe`?" section (:26-:52), plus :57, :67, :97, :105, :142.
13. docs/multi-library.md:55 — Windows portable entry (and :68 tree).
14. docs/dual-boot-acceptance-runbook.md:56 — portable dir tree (and :146, :177 launch steps).
15. docs/index.md:45 — index row describes the `brave.exe` rename.
16. openspec/changes/add-portable-linux-appimage/specs/portable-linux-appimage/spec.md:164 — unsynced scenario asserts "`brave.exe` is produced".
17. openspec/changes/add-portable-serve-mode/specs/headless-serve-mode/spec.md:9 — unsynced scenarios launch `brave.exe --serve` (and :16).
18. grepped `brave` (case-insensitive) across all tracked files excluding yarn.lock — every live hit is listed above; remaining hits are in docs/TODO/** (frozen pipeline), openspec/changes/archive/**, and evidence/proposal prose of the two in-flight changes (historical records, left unchanged).
19. grepped `execPath|PORTABLE_EXECUTABLE|basename(process` in src/ and common/ — portable root and relaunch use `PORTABLE_EXECUTABLE_DIR`/`PORTABLE_EXECUTABLE_FILE` (src/portable-launch-context.ts:37, src/main.ts:1298); no site depends on the inner basename.
