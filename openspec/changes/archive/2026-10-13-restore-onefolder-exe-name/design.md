# Design — restore-onefolder-exe-name

## Approach

**Packaging (package.json, one test).**
- `build.win.executableName`: set `"OneFolder"` explicitly instead of deleting the key. Deleting it yields the same `OneFolder.exe` (the electron-builder default is the sanitized `productName`), but the explicit value pins the inner name independently of `productName`, and the test can assert it.
- `build.portable.artifactName`: `OneFolder-${version}-x64.${ext}`. The user picked this name. It mirrors Linux's `OneFolder-${version}-x86_64.${ext}` and keeps the `-x64` suffix that electron-builder conventionally uses for Windows.
- `tests/appimage-packaging.test.ts:118` currently pins the brave identity. It becomes "keeps the Windows portable OneFolder identity" and asserts the two new values plus `win.target === ['portable']`, so the portable-only invariant is pinned in the same test.

**Live references (rename only, no behavior).**
- Comments: `src/main.ts:161`, `src/serve-mode.ts:2`, `src/server/index.ts:12`, `webpack.web.js:16`.
- argv fixtures in `tests/serve-mode.test.ts` become `OneFolder.exe`. `parseServeArgs` ignores argv[0], so the assertions are unchanged.
- `CLAUDE.md:64`.
- In docs, serve-mode command examples use the artifact name, `OneFolder-<version>-x64.exe --serve`, because that is the file the user runs (the wrapper forwards args to the inner `OneFolder.exe`). Directory-tree diagrams show the artifact name too.

**Portable-builds documentation (README).**
- Replace the "Release Build" section (`README.md:87-91`) with a "Portable builds" section. It opens with the fork's purpose: a portable-only fork with one Windows `.exe` and one Linux `.AppImage`, each with a sibling `data/`, and no installers, auto-update, or code signing.
- **Windows** subsection: build host Windows x64 (native modules are compiled for the host); Node.js ≥ 22.12 (the floor set by `@electron/rebuild` 4.0.4) and Yarn 1.22 (`packageManager`); `yarn install` → `yarn build` → `yarn package:portable` → `dist/OneFolder-<version>-x64.exe`. Then how to install it into a portable dir, and how to upgrade from a `brave.exe` dir: delete `brave.exe`, keep `data/`.
- **Linux** subsection: the existing AppImage content moves under it unchanged. It gains a prerequisite step before `yarn package:appimage`: `resources/ffmpeg/linux/ffmpeg` and `ffprobe` are not tracked in git (145 MB each, over GitHub's 100 MB limit). Download the BtbN archive named in `resources/THIRD_PARTY.md`, place `bin/ffmpeg` and `bin/ffprobe` there with mode 0755, and compare `sha256sum` with THIRD_PARTY.md. If the moving `latest` archive differs, update THIRD_PARTY.md.
- The dual-boot paragraph and the Build Options table switch to the new name.

**Fork notes (docs/personal-fork-notes.md).**
- Deviation 1 and the three brave sections (`:26-:52`), plus the "Antivirus / naming caveat" (`:103`), collapse into one "Windows executable name" section. It records that the Windows binary was named `brave.exe` from INV-005 until this change to engage NVIDIA VSR, that the name was reverted for public release, and that VSR no longer engages. The INV-005 reference entry is annotated "reverted by restore-onefolder-exe-name".
- The "How to update this fork" step (`:97`) uses the versioned artifact and says to remove the previous `.exe`.

**Other docs.** `docs/headless-web-build.md`, `docs/multi-library.md`, `docs/dual-boot-acceptance-runbook.md`, and `docs/index.md:45` get a name swap only.

**In-flight change artifacts.**
- `add-portable-linux-appimage/specs/portable-linux-appimage/spec.md:164`: the scenario now says the Windows portable artifact (`OneFolder-<version>-x64.exe`) is produced. Its requirement, "Adding the Linux AppImage SHALL NOT change the Windows … artifact name", stays true as a statement about the AppImage change.
- `add-portable-serve-mode/specs/headless-serve-mode/spec.md:9,16`: launch examples use the new name.
- Evidence lines and proposal prose in those changes are historical and stay unchanged.

**Verification.**
- `yarn test tests/appimage-packaging.test.ts tests/serve-mode.test.ts`.
- A tracked-file grep proves no live `brave` reference remains outside the historical paths.
- The packaged Windows build needs a Windows host, so it is a `REQUIRES MANUAL EXECUTION` task. Run `yarn package:portable`, confirm the `dist/` listing, then from a copy in a portable dir check the GUI launch, Task Manager (`OneFolder.exe`), the existing `data/` being picked up, and `--serve --port 9000`.

## Decisions

- **Explicit `executableName: "OneFolder"` over deleting the key.** Same output today, but explicit pins the spec'd inner name against a future `productName` edit. Alternative (delete, exact upstream config) rejected: the identity would then live implicitly in electron-builder's default.
- **Artifact name in docs, not the inner name.** Users launch the artifact. `OneFolder.exe` appears only where the docs describe the extracted process (Task Manager, Windows properties).
- **Edit in-flight spec deltas in place instead of MODIFIED deltas here.** Their capabilities have no base spec in `openspec/specs/` yet, so a MODIFIED delta from this change would have nothing to apply to. Leaving them alone would sync `brave.exe` into the main specs when those changes archive.
- **Leave historical records untouched.** `docs/TODO/**` is frozen, archives are immutable, and evidence lines record what actually ran.

## Risks / Trade-offs

- [VSR no longer engages for in-app video] → accepted by the owner. Recorded in the fork notes so it isn't rediscovered as a regression.
- [An old `brave.exe` left in a portable dir runs against the same `data/`] → the README upgrade step says to delete it. Both builds use the same `data/` and single-instance lock (the lock is keyed on userData), so at worst the user launches an old build, with no corruption.
- [Windows packaging can't be exercised on the Linux dev host] → the config test pins the names, and the packaged check is a manual Windows task with recorded evidence.
- [BtbN `latest` URL is a moving target, so the checksum may not match] → the docs say to update THIRD_PARTY.md when the downloaded build differs. They don't claim reproducibility.

## Migration Plan

Users replace `brave.exe` with `OneFolder-<version>-x64.exe` in the same directory and keep `data/`. No data migration. Rollback is reverting the two `package.json` keys.

## External Review

### Peer Review Verdict

Quorum: achieved (weight 2/2, escalated to tier 1)
Certainty: 1
Caller Agreement: 0.95
Arbiter: ok
Sources:
- deepseek-flash (deepseek-flash) — error, agreement n/a
- qwen (qLLM) — ok, agreement 1
- gemini-flash (google/gemini-3.5-flash) — ok, agreement 1

### Review Feedback

Consensus feedback recorded verbatim: "The consensus approach is to update package.json configuration (executableName to 'OneFolder' and artifactName to 'OneFolder-${version}-x64.${ext}'), update test suites (appimage-packaging and serve-mode), and sweep active documentation while preserving frozen historical records. Additional blast radius includes CI/CD workflows, release scripts, and NVIDIA allowlist side-effects. Risks are mitigated by leveraging environment-driven portable pathing, utilizing CI Windows runners for verification, and pinning/validating ffmpeg binaries. The optimal implementation focuses on pre-build caching, automated bootstrap scripts for ffmpeg verification, and atomic commits for configuration and documentation updates."

- Config values, test updates, doc sweep preserving historical records — ACCEPTED: matches the Approach as drafted.
- "CI/CD workflows, release scripts" as extra blast radius — ACCEPTED as a check: grepped `brave|artifactName|executableName|dist/.*\.exe` across `.github/` and `scripts/`, and nothing names the Windows artifact (`scripts/verify-appimage.js:96` names only the AppImage). No edit needed; the final grep task covers both trees.
- "NVIDIA allowlist side-effects" — ACCEPTED: already a recorded risk. The fork notes state that VSR no longer engages.
- "Environment-driven portable pathing" — ACCEPTED: this is the existing mechanism (`PORTABLE_EXECUTABLE_DIR`) that the migration relies on. The manual Windows task checks that an existing `data/` is picked up.
- "Utilizing CI Windows runners for verification" — REJECTED: `.github/workflows/build.yml:25` pins Node 16, below the `@electron/rebuild` 4.0.4 floor (Node ≥ 22.12), and only runs on tag pushes with a release step. Fixing CI is out of scope, so a Windows host run with recorded evidence verifies the build instead.
- "Pinning/validating ffmpeg binaries" — ACCEPTED in documentation form: the Linux build steps compare `sha256sum` with `resources/THIRD_PARTY.md`.
- "Automated bootstrap scripts for ffmpeg verification" — REJECTED: a fetch script is new tooling beyond "add documentation", and the moving BtbN `latest` URL would make a pinned script fail on every upstream rebuild. Documented manual steps keep the decision with the owner.
- "Pre-build caching" — REJECTED: build performance isn't affected by a rename or docs.
- "Atomic commits for configuration and documentation updates" — ACCEPTED: the change lands as one commit at close, so the config, test, and docs never disagree in history.
