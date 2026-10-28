# Handoff — support-mov-playback

Objective: `.MOV` player lane — ingest `mov`, background ffprobe codec triage (facts, not verdicts), gallery badge, banner + "Create playable copy" (reuses `reencode-x264`; NVENC-only loud failure; scope in proposal.md).

Location: worktree `/home/rjdollete/dev/OneFolder.worktrees/support-mov-9pdfza` (branch `support-mov-9pdfza`), radflow root = repo root.

Stage: **apply 7/8 ticked** (1.1–1.6, 1.8 — each box carries `evidence:`; read tasks.md). **1.7 open: operator leg — DEFERRED by owner 2026-10-27** ("I just want to move onto the .ts and .mkv implementation. defer the test"). Box stays unticked/blocked; the tick still needs an `operator-approval:` record bound to a commit sha, and **no commit/push authorized** (owner standing rule). The HEVC-test ask reopens whenever the operator chooses — likely one consolidated pass covering both lanes.

Holds: owner previously tested the AppImage — only "showing and playing", indeterminate codec; unplayable flow not witnessed. A guaranteed-HEVC clip can be made with `ffmpeg -f lavfi -i testsrc2=duration=5:size=640x360:rate=25 -c:v libx265 -pix_fmt yuv420p -an hevc-test.mov`. Expectations: badge, banner, Create-playable-copy → drawer → .mp4 sibling with tags → Keep prompt, original byte-unchanged; drawer `Failed` = specified NVENC-loud, not a bug.

Verified: change tests green; tsc source-clean; `yarn verify:appimage` PASSED; packaged sidecar served `/api/files` with codec columns; payload boots (xvfb); two-window startup race fixed (BEGIN IMMEDIATE + busy_timeout + INSERT OR IGNORE — 1.3 evidence line). Caveat: full parallel `jest` wedges in media-job's real-ffmpeg leg under host load — pre-existing flake; run that file standalone, rest batched.

Environment: worktree `node_modules` = real local Linux yarn install (main-checkout tree is Windows-built — never symlink it). Use `./node_modules/.bin/jest`; DB tests use `node:sqlite` + `declarations/node-sqlite.d.ts`; package with `electron-builder --linux AppImage --publish never`; dev `electron .` needs shim `../resources → ../OneFolder/resources` (deleted). `dist/` has the current AppImage; `dist-web/` is tracked — css hash rotation is legit output; `.playwright-mcp/` disposable.

Active: `openspec/changes/support-mkv-ts-playback/` (Tier 2, **apply 8/9 ticked** — 1.1–1.8 carry `evidence:`+`discovery:`; **1.9 open: operator leg**, criteria final). Same for mov **7/8** with 1.7 open. Owner chose 2026-10-27 to run mkv `/rad-apply` in this worktree on the mov lane's uncommitted code. Latent defects found+fixed (each with discovery + regression test): (1) sidecar 415'd ALL video originals → VIDEO_FORMAT_MIME (six containers, BR-12); (2) probe pass NEVER ran in packaged app (pre-ingest trigger + fileList candidates) → RootStore.main fires after watchLocations+refetch, DB-row candidates (buildProbeCandidatesFromRows/applyProbeUpdatesToRows, codec-probe-trigger.test.ts); (3) repeated -select_streams clobbers on bundled ffprobe n8.1.3 → probe spawns WITHOUT selectors; real-binary tests added; (4) VP9 badged unplayable while playing → table widened to {h264,vp8,vp9,av1}; (5) owner removed Create-playable-copy button → banner text-only pointing at Tools Re-encode (x264), specs/tasks/docs synced; (6) NVENC defaulted to the reserved workstation GPU (RTX PRO 6000, VRAM fully committed → slow encodes) → FfmpegRunner.nvencDeviceEnv pins CUDA_VISIBLE_DEVICES to the first GeForce card (nvidia-smi, cached; ONEFOLDER_NVENC_GPU override; no-GeForce → default), proven on this host (5060 Ti). Verification: media-job 37/37 (incl. real-binary + pin tests), lane batch green, tsc 0. Current AppImage 17:03 has all of it. Operator's live instance: /home/rjdollete/go/x/_OneFolder2 (portable). Awaiting: operator re-test → per-leg approval records (binding commit needs owner OK) → rad-simplify (mpegts de-dup pending) → rad-verify → archive mov → mkv sync/archive.

## Owner's verbatim words
- "The build does not run, ... Could not initialize OneFolder! SqliteError" (fixed, verified)
- "I have tested this and MOV files are showing and playing"
- "I don't know what exactly I tested with, but they played."

Resume prompt:

```
Continue the radflow change support-mov-playback in /home/rjdollete/dev/OneFolder.worktrees/support-mov-9pdfza (worktree branch support-mov-9pdfza). Read openspec/changes/support-mov-playback/handoff.md, recheck git status and tasks.md, then run $rad-apply: only task 1.7 (operator leg) remains — collect the operator's HEVC-test observation, and on approval transcribe the operator-approval: record (ask first whether I may create the binding commit), tick 1.7 with evidence, then run rad-simplify and rad-verify. Support-mkv-ts-playback stays queued until this change archives.
```
