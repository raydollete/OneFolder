---
id: TASK-028
title: 'Document brave.exe rename rationale and portable-only decision'
investigation: INV-005
status: DONE
priority: low
blocked_by: [TASK-026, TASK-027]
date_created: 2026-04-22
date_completed: 2026-04-23
files:
  - 'docs/personal-fork-notes.md'
  - 'docs/index.md'
---

## What

Create a short `docs/personal-fork-notes.md` (the filename is the author's choice — `personal-fork-notes.md`, `fork-customizations.md`, or `brave-rename.md` are all fine; pick one and stay consistent) that captures the non-obvious fork-specific decisions:

1. Why the Windows binary is named `brave.exe` (NVIDIA VSR driver-side allowlist).
2. The electron-builder 23.6.0 source citations proving `win.executableName` propagates to the portable target's inner exe.
3. The decision to drop the NSIS installer target and ship portable-only.
4. A pointer to INV-005 and TASK-026 / TASK-027 for the full investigation and QA record.

Add a single link entry to `docs/index.md` under an appropriate heading (match the neighboring conventions — this is a fork-customization note, not a feature doc, so a "Project / Fork notes" subsection may be appropriate; create one if none exists).

## Why

The Windows binary name being `brave.exe` is genuinely surprising when someone opens the repo fresh. Without a doc, a future reader (including the user six months from now) will waste time figuring out whether it's a typo, a malware rename, or a legitimate intentional decision. The three-line paper trail — `package.json` → `INV-005` → `personal-fork-notes.md` — lets a reader at any level of depth get the context they need.

Per CLAUDE.md, project documentation lives in `docs/` and should be read before making related changes. The rename rationale belongs there so that anyone touching `build.win.executableName`, `build.portable`, or the Electron binary naming in the future understands why it looks the way it does.

See [INV-005](../investigations/INV-005_MEDIUM_ELECTRON_brave-exe-rename-for-nvidia-vsr-and-portable-only.md).

## Implementation Steps

- [ ] 1. Create `docs/personal-fork-notes.md` (or chosen equivalent filename). Match the front-matter style of existing docs — check `docs/location-loading.md` or `docs/multi-library.md` for the shape.

- [ ] 2. Write sections:

  **Overview:** One paragraph stating that this is a personal single-user fork of OneFolder, portable-only on Windows, with two intentional deviations from upstream: the Windows binary is named `brave.exe`, and the NSIS installer target is disabled.

  **Why `brave.exe`?** Explain NVIDIA Video Super Resolution is gated on process basename allowlist (`chrome.exe`, `msedge.exe`, `brave.exe`, `vivaldi.exe`). VSR applies a driver-side upscaling / enhancement pass to HTML5 `<video>` decode output; OneFolder uses HTML5 `<video>` for video preview in slide mode (`src/frontend/containers/ContentView/SlideMode/index.tsx` lines 133, 145, 297). The fork renames the binary so the GPU child process — which inherits the parent basename on Windows — presents a name the driver will allowlist.

  **How the rename propagates through electron-builder 23.6.0.** Cite the chain (reference INV-005 for the full investigation):
  - `build.win.executableName: "brave"` in `package.json` sets `platformSpecificOptions.executableName`.
  - `node_modules/app-builder-lib/out/appInfo.js:53` uses it to set `appInfo.productFilename`.
  - `node_modules/app-builder-lib/out/electron/ElectronFramework.js:44-45` renames the Electron binary on disk to `brave.exe` before target packaging.
  - `node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js:155` writes `PRODUCT_FILENAME: "brave"` into the NSIS script defines for both the nsis setup target AND the portable wrapper.
  - `node_modules/app-builder-lib/templates/nsis/common.nsh:13` defines `APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"`.
  - `node_modules/app-builder-lib/templates/nsis/portable.nsi:86` launches `$INSTDIR\${APP_EXECUTABLE_FILENAME}` — i.e., the inner `brave.exe`.

  **What the rename does NOT change.** `productName` remains `"OneFolder"`, so `FileDescription` and `ProductName` stamped into the exe metadata (`winPackager.js:234,237`) still say "OneFolder". Windows Properties dialog, `app.getName()` defaults, window titles, dialog copy — all unaffected. The rename is narrowly targeted at the OS-level basename the NVIDIA driver inspects.

  **Portable-only, no NSIS installer.** The fork never ships an installer. `build.win.target` is `["portable"]` only; the `build.nsis` block was removed. `yarn package:portable` produces `dist/brave.exe` (the outer self-extracting wrapper); `yarn package` on Windows produces the same single artifact.

  **Antivirus / naming note.** The Windows binary is an unsigned `brave.exe` that is not actually Brave. Windows Defender should accept it on behavior. If heuristic AV false-positives, add an exclusion for the portable directory. This is a single-user personal machine, so the risk is bounded.

  **References.** Point back to INV-005 and the three tasks (TASK-026, TASK-027, TASK-028).

- [ ] 3. Open `docs/index.md` and add a link to the new doc in an appropriate section. If no "Fork notes" / "Project notes" section exists, create one under an appropriate heading (or append it near the other reference docs — match whatever grouping conventions are in use).

- [ ] 4. Render the Markdown in a preview to confirm internal links work (the `[INV-005](...)` relative link, the electron-builder source citations as paths relative to the repo root).

## Done When

- [ ] `docs/personal-fork-notes.md` (or chosen equivalent) exists and explains the Windows binary rename rationale, the electron-builder propagation chain, the portable-only decision, and the AV consideration.
- [ ] `docs/index.md` links to the new doc.
- [ ] A reader unfamiliar with this fork can, from the docs alone, understand (a) why the binary is named `brave.exe`, (b) why there is no installer, (c) how to verify VSR is engaging, and (d) where to go for the full investigation (INV-005).
