---
id: TASK-054
title: 'Document portable persistence policy and verification protocol in multi-library and personal-fork notes'
investigation: INV-012
status: PLANNED
priority: low
blocked_by: [TASK-052]
date_created: 2026-05-03
date_completed:
files:
  - 'docs/multi-library.md'
  - 'docs/personal-fork-notes.md'
---

## What

Add explicit documentation of the portable-persistence policy (next-to-the-exe, per-INV-012's decision matrix) and the verification protocol that proved it works (TASK-052) to two existing docs: `docs/multi-library.md` and `docs/personal-fork-notes.md`. This is the institutional-knowledge step so future contributors (and the user, six months from now) can re-verify after every electron-builder bump without re-doing the source-code dive in INV-012.

## Why

`docs/multi-library.md:51` already mentions portable-mode userData/temp redirection in one line. INV-012 adds two pieces of value worth pinning into the documentation: (a) the explicit policy decision among the three options (a/b/c) the user's prompt called out, with reasoning, and (b) a concrete verification protocol that future contributors can run to confirm the redirect still works. Without this, a future investigator hitting the same "settings don't persist" report would have to re-do INV-012's full source-code archaeology — including reading the electron-builder portable.nsi template — to re-establish what is actually a stable, well-understood mechanism.

This task is blocked by TASK-052 because the documentation should reflect the verified result of that QA, not the pre-QA hypothesis.

See [INV-012](../investigations/INV-012_HIGH_ELECTRON_portable-build-not-persisting-userdata.md).

## Implementation Steps

- [ ] 1. **Update `docs/multi-library.md`.** Find the "Portable mode" subsection at line 51 (one paragraph today). Expand it to a small numbered subsection covering:
    - **Persistence policy:** next-to-the-exe (the 'a' option from INV-012). State the reasoning briefly (single-user fork, NSIS dropped, "everything travels together" intent).
    - **Mechanism:** electron-builder's portable wrapper sets `PORTABLE_EXECUTABLE_DIR=$EXEDIR` (cite `node_modules/app-builder-lib/templates/nsis/portable.nsi:77`). `src/main.ts:36-58` reads that env var, computes `<exe-dir>/data/`, and calls `app.setPath('userData', ...)` and `app.setPath('temp', ...)` BEFORE `app.whenReady()`. Chromium's localStorage, IndexedDB, and all `app.getPath('userData')` consumers see the redirected path.
    - **What persists:** library registry (`libraries.json`, `active-library.json`), per-library SQLite (`libraries/<uuid>/onefolder.db` and WAL/SHM), backups, thumbnails, themes, localStorage (per-library namespaced keys + global keys), `windowState.json`, `preferences.json`. **What does NOT persist** (because it lives in the wrapper's `%TEMP%\<random>\` extract dir which gets `RMDir /r`'d on exit by `portable.nsi:90`): the unpacked Electron runtime files, `chrome_100_percent.pak`, etc. Those are re-extracted from the outer wrapper on every launch — that's the design.
    - **Verification protocol:** point the reader to TASK-052 for the empirical checklist, and to TASK-053 for the in-app diagnostic surface that confirms the redirect at runtime.
    - **Cross-reference:** link to INV-012 and INV-002 (the original portable-mode investigation).

- [ ] 2. **Update `docs/personal-fork-notes.md`.** Find the "Portable-only, no installer" section. Add a short paragraph at the end:
    - "**Persistence is verified next-to-the-exe.** The portable build redirects `userData` to `<exe-dir>\data\` via `app.setPath('userData')` at module load (`src/main.ts:36-58`). All user state — library registry, SQLite databases, localStorage, thumbnails, backups, themes — lives there and travels with the executable. See [INV-012](TODO/...) for the verification protocol; the diagnostic surface added in TASK-053 prints the resolved path on every startup for ongoing verifiability."
    - Do NOT duplicate the full mechanism description — just point at multi-library.md and INV-012 for depth.

- [ ] 3. **Update the references list at the bottom of `docs/personal-fork-notes.md`.** Today the "Reference" section at the bottom lists INV-005 + TASK-026/27/28. Add INV-012 + TASK-052/53/54 alongside them with the same one-line format.

- [ ] 4. **Confirm cross-references in INV-011 are still accurate.** INV-011's "Risks and Tradeoffs" section has a "Related observation (OUT OF SCOPE)" callout pointing at this investigation. Re-read it and confirm the callout's wording still matches what INV-012 actually concluded. If TASK-052 turned up a real bug (instead of "verified working"), update the callout's wording in INV-011 accordingly. If TASK-052 confirmed the build works as designed, leave the callout as-is — it correctly describes what the user observed even though the underlying code path is sound.

- [ ] 5. **Lint check.** Run any markdown linter the project uses (`yarn lint:md` if it exists, otherwise no-op). Visually inspect the rendered docs in a markdown previewer to confirm the new sections render cleanly (no broken links, headings nest correctly, code fences balance).

## Done When

- [ ] `docs/multi-library.md` has the expanded "Portable mode" subsection covering policy, mechanism, what-persists, verification protocol, and cross-references.
- [ ] `docs/personal-fork-notes.md` has the persistence-verified paragraph in the "Portable-only, no installer" section, plus updated references at the bottom.
- [ ] INV-011's cross-reference callout to INV-012 is reviewed and either left intact (if TASK-052 verified the build) or updated to reflect the actual finding (if TASK-052 surfaced a real bug).
- [ ] Markdown renders cleanly in a previewer.
