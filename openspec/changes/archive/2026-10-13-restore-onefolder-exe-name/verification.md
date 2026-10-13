# Verification — restore-onefolder-exe-name

Date: 2026-10-13
Tier: 2

## Verdict: PASS

## Dimensions
- Implemented: PASS — all 8 ticked boxes verified against the working tree. `package.json:78` `"executableName": "OneFolder"` and `:101` `"artifactName": "OneFolder-${version}-x64.${ext}"`; comment swaps at `src/main.ts:161`, `src/serve-mode.ts:2`, `src/server/index.ts:12`, `webpack.web.js:16`, `CLAUDE.md:64`; README `### Portable builds` at `README.md:87` with `#### Windows (portable .exe)` (`:93`, steps 1-3) and `#### Linux (AppImage)` (`:110`, steps 1-4); fork-notes `## Windows executable name` at `docs/personal-fork-notes.md:25`; name swaps in the four other docs; both in-flight spec deltas corrected. Tier-check: lint warns the diff suggests Tier 3 (exit 1, warning only). External Review was run and achieved at Tier 2 (`design.md:60`), so no control was voided and FAIL condition 3 does not apply. The lint's 28-file diff count includes dirty paths this change does not own (`.claude/` deletions, `openspec/config.yaml*`, `openspec/templates/*`, and the sibling `prepare-public-repo` edits to `resources/THIRD_PARTY.md` and `docs/reencode-x264.md`, as listed in `handoff.md`). This change's own diff is 17 files.
- Reachable: PASS — `package:portable` (`package.json:15`, `electron-builder --win portable`) consumes `build.win.executableName` and `build.portable.artifactName`. In the installed electron-builder 26.15.2, `node_modules/app-builder-lib/out/appInfo.js:56-57` maps `win.executableName` to `productFilename` (the inner exe), and `out/targets/nsis/NsisTarget.js:137` expands the portable `artifactName` pattern. The other edits are comments, docs, and test fixtures, so no call chain applies. No runtime site reads the basename: portable root comes from `PORTABLE_EXECUTABLE_DIR` (`src/portable-launch-context.ts:114`).
- Tested: PASS — ran `yarn test tests/appimage-packaging.test.ts tests/serve-mode.test.ts` here: 2 suites, 50 tests passed (22 + 28, matching the task evidence), exit 0. The identity test (`tests/appimage-packaging.test.ts:118-121`) fails against the pre-change `"brave"` values, so it is not a test that passes either way. `openspec validate --strict` passes for add-portable-linux-appimage, add-portable-serve-mode, and restore-onefolder-exe-name. The live-reference `git grep` sweep matches task 7's allowed list exactly. The packaged Windows check (task 8) needs a Windows x64 host, and no command on this Linux host covers it. The owner waived it (`tasks.md:38-39`, recorded as an owner waiver and not claimed as performed). The packaged names are pinned by the config test plus the electron-builder mapping above.
- Optimal: advisory — nothing found. The docs reference `resources/THIRD_PARTY.md` for checksums instead of copying them. The test change reuses the existing `gitMode` helper (`tests/appimage-packaging.test.ts:145`).
- Reused: PASS — the change adds no component, hook, client, formatter, or store. It touches packaging config, comments, one test file that reuses its existing `gitMode` helper and `pkg` fixture, and docs. No artifact or comment claims code reuse. design.md's "mirrors Linux's `OneFolder-${version}-x86_64.${ext}`" describes a naming convention, not a code import.
- Faithful: PASS — every Stated Requirements bullet is covered and every behavior change is traced. (1) "Remove the reference to brave.exe — update the windows build back to the old file name" → tasks 1, 2, 4, 5, 6, 7; `package.json:78,101`, the inner exe is `OneFolder.exe`, and the sweep leaves only the README upgrade note and the fork-notes history. (2) "documentation that this fork is specifically about portable builds" → task 3; `README.md:87-89`. (3) "instructions on how to both do a Windows and Linux build" → task 3; `README.md:93-127`. (4) The artifact-name decision `OneFolder-<ver>-x64.exe` → task 1; `package.json:101`, `tests/appimage-packaging.test.ts:120`. Reverse trace: the ffmpeg-untracked test inversion traces to task 1's `— fixed` discovery. The `.gitignore:37-39` ignore traces to task 7's `— fixed` discovery. The stale portable-detection sentence (`docs/personal-fork-notes.md:37`) traces to task 4's `— fixed` discovery. The `docs/headless-web-build.md:121` rename traces to task 5's `— fixed` discovery. Fork-notes `:11` and the licensing caveat belong to the sibling change `prepare-public-repo`, not to this one.
- Environment: radflow-lint --doctor reported four warnings. (1) `openspec/config.yaml` schema is 'spec-driven', not 'radflow'. (2) `openspec/templates/` is still present (retired per-repo skeleton copy). (3) The skill link `/home/rjdollete/.claude-rpa/skills/rad-deploy` is missing. (4) The skill link `/home/rjdollete/.claude-rpa/skills/rad-qa` is missing.

## Evidence audited
- [1 In `package.json`, set `build.win.executableName` to `"OneFolder"` a] — package.json:78 — "      "executableName": "OneFolder","
- [2 Replace the `brave.exe` references with the new names in these place] — tests/serve-mode.test.ts:41 — "      'OneFolder.exe',"
- [3 In `README.md`, replace the "Release Build" section with `### Portab] — README.md:103 — "**Upgrade an existing portable directory** (including one from an older build that shipped as `brave.exe`):"
- [4 In `docs/personal-fork-notes.md`:] — docs/personal-fork-notes.md:27 — "From INV-005 until the `restore-onefolder-exe-name` change, the Windows binary was named `brave.exe`."
- [5 Replace the `brave.exe` names with the artifact name in `docs/headle] — docs/index.md:45 — "| [Personal Fork Notes](personal-fork-notes.md)                   | Fork-specific deviations: portable-only, Windows executable name history; second bundled binary (ffmpeg + GPL caveat) |"
- [6 Correct the unsynced in-flight spec deltas in place: `openspec/chang] — openspec/changes/restore-onefolder-exe-name/specs/windows-portable-build/spec.md:15 — "- **AND** no installer (`*Setup*.exe`) and no `brave.exe` is produced"
- [7 Live-reference sweep. Run `git grep -nIi brave -- . ':!yarn.lock' ':] — README.md:103 — "**Upgrade an existing portable directory** (including one from an older build that shipped as `brave.exe`):"
- [8 **REQUIRES MANUAL EXECUTION** (Windows x64 host). Run `yarn install ] — tests/appimage-packaging.test.ts:118 — "  it('keeps the Windows portable OneFolder identity', () => {"

## Findings
none

## Advisory rules judged
- Stage decay: none. tasks.md has no `## Follow-ups` heading, and this verification.md is the first one, so no task was added after it existed. Each `discovery:` line names something that surfaced while running that task's own Verify or done-when (a failing suite, a stale citation, a grep miss).
- Declined discoveries: n/a, because no `— declined:` lines exist. The one non-fixed disposition, `scoped: add-linux-appimage-build` (`tasks.md:32`), hands the brave references in that untracked change to the change that owns them. That disposition is adequate.

## Live UI pass
n/a — no UI surface
