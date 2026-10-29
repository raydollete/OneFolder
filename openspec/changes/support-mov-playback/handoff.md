# Handoff — support-mov-playback

Objective: `.MOV` player lane — ingest `mov`, background ffprobe codec triage (facts, not verdicts), gallery badge, banner + "Create playable copy" (reuses `reencode-x264`; NVENC-only loud failure; scope in proposal.md).

Location: worktree `/home/rjdollete/dev/OneFolder.worktrees/support-mov-9pdfza` (branch `support-mov-9pdfza`), radflow root = repo root.

Stage: **apply 7/8 ticked** (1.1–1.6, 1.8 — each box carries `evidence:`; read tasks.md). **1.7 open: operator leg — DEFERRED by owner 2026-10-27** ("I just want to move onto the .ts and .mkv implementation. defer the test"). Box stays unticked/blocked; the tick still needs an `operator-approval:` record bound to a commit sha, and **no commit/push authorized** (owner standing rule). The HEVC-test ask reopens whenever the operator chooses — likely one consolidated pass covering both lanes.

Holds: owner previously tested the AppImage — only "showing and playing", indeterminate codec; unplayable flow not witnessed. A guaranteed-HEVC clip can be made with `ffmpeg -f lavfi -i testsrc2=duration=5:size=640x360:rate=25 -c:v libx265 -pix_fmt yuv420p -an hevc-test.mov`. Expectations: badge, banner, Create-playable-copy → drawer → .mp4 sibling with tags → Keep prompt, original byte-unchanged; drawer `Failed` = specified NVENC-loud, not a bug.

Verified: change tests green; tsc source-clean; `yarn verify:appimage` PASSED; packaged sidecar served `/api/files` with codec columns; payload boots (xvfb); two-window startup race fixed (BEGIN IMMEDIATE + busy_timeout + INSERT OR IGNORE — 1.3 evidence line). Caveat: full parallel `jest` wedges in media-job's real-ffmpeg leg under host load — pre-existing flake; run that file standalone, rest batched.

Environment: worktree `node_modules` = real local Linux yarn install (main-checkout tree is Windows-built — never symlink it). Use `./node_modules/.bin/jest`; DB tests use `node:sqlite` + `declarations/node-sqlite.d.ts`; package with `electron-builder --linux AppImage --publish never`; dev `electron .` needs shim `../resources → ../OneFolder/resources` (deleted). `dist/` has the current AppImage; `dist-web/` is tracked — css hash rotation is legit output; `.playwright-mcp/` disposable.

Done-with-gates: BOTH lanes **rad-verify PASS-WITH-FINDINGS** (fresh-context auditors; verification.md in each change dir; findings acted: probe doc comment, design.md UX realign, evidence anchors refreshed, jest.config registers tests/setup/globals.js). Binding commit **53a00179** (operator-approval records mov 1.7 + mkv 1.9 at=53a00179); verification round committed as **9d9c98d3**. radflow-lint clean (mov shows only the two known v:0/a:0 token WARNs, rc1). NEXT per trailers: rad-sync (both changes unsynced) → rad-archive mov → then mkv sync/archive → /rad-close. Optional (auditor note): tier-envelope WARN is the union diff of the two co-delivered lanes; the Tier-3-only bomb-squad pass was skipped — operator may run it or re-declare before archive.

## Owner's verbatim words
- "The build does not run, ... Could not initialize OneFolder! SqliteError" (fixed, verified)
- "I have tested this and MOV files are showing and playing"
- "I don't know what exactly I tested with, but they played."

Resume prompt:

```
Continue the radflow change support-mov-playback in /home/rjdollete/dev/OneFolder.worktrees/support-mov-9pdfza (worktree branch support-mov-9pdfza). Read openspec/changes/support-mov-playback/handoff.md, recheck git status and tasks.md, then run $rad-apply: only task 1.7 (operator leg) remains — collect the operator's HEVC-test observation, and on approval transcribe the operator-approval: record (ask first whether I may create the binding commit), tick 1.7 with evidence, then run rad-simplify and rad-verify. Support-mkv-ts-playback stays queued until this change archives.
```
