# Handoff — add-portable-linux-appimage (2026-09-07)

## Where we are

The `add-portable-linux-appimage` change has completed `/rad-explore` and `/rad-propose`. Its proposal, design, Tier 3 external review, spec delta, bomb-squad findings, and implementation graph are durable. Implementation has not started: `openspec list` reports 0/9 tasks complete, every checkbox in `tasks.md` is unticked, and the ready frontier is 1.1, 2.1, 2.2, and 3.1. The codebase has not been changed for this feature.

A separate pre-existing live change, `add-portable-serve-mode`, reports 27/34 tasks complete. It was not modified as part of this proposal, but its implemented code overlaps some areas the AppImage work will touch, so apply must preserve and re-read that work.

## Owner's verbatim words

The harness does not expose original per-message timestamps. The following governing messages are reproduced exactly and were captured at 2026-09-07T00:45:48Z UTC rather than assigned fabricated send times.

- `/rad-explore The current codebase was designed for an electron app to be built for Windows.  How can we create a similar portable build for Linux/Gnome?`
- `/rad-propose

  Track progress in your native task list: seed it with the propose phase steps (proposal, design, external review, spec deltas, tasks) now and keep step statuses updated as you work.`
- `run ~/dev/radflow/adopt.sh`
- `Try peer-review again`
- `<name>rad-preclear</name>`

## Done this session

- Investigated the real Windows-shaped packaging, bootstrap, relaunch, helper, trash, path-identity, GNOME, documentation, and test surfaces and recorded the evidence in `proposal.md` and `design.md`.
- Created the Tier 3 change artifacts at `openspec/changes/add-portable-linux-appimage/`: `proposal.md`, `design.md`, `specs/portable-linux-appimage/spec.md`, and `tasks.md`.
- Incorporated the completed bomb-squad hunt into `design.md`; its findings include AppImage outer-path confusion, missing Linux FFmpeg/FFprobe, ExifTool case/mode/lifecycle defects, Windows-only trash assumptions, Linux path-case aliasing, and missing packaged GNOME acceptance.
- Ran the configured peer-review MCP directly after adoption because the already-running Codex session did not hot-load the newly registered tool. Quorum was achieved at weight 3/3 with certainty 1 and caller agreement 1: DeepSeek and Gemini agreed; Qwen timed out. The exact roster, consensus text, and accepted/rejected dispositions are in `design.md`. The review's unsafe suggestion to fall back directly to physical deletion was rejected because permanent deletion requires renewed explicit user consent.
- Ran `/home/rjdollete/dev/radflow/adopt.sh --harness codex`. This installed/refreshed `.agents/` lifecycle skills, changed `openspec/config.yaml` into the canonical Radflow link, refreshed templates, retained `openspec/config.yaml.pre-radflow`, and altered legacy `.claude` command/skill surfaces. These adoption changes are uncommitted and must be preserved.
- Verified `openspec validate add-portable-linux-appimage --strict` passes and `/home/rjdollete/dev/radflow/bin/radflow-lint add-portable-linux-appimage` is clean. `openspec status` reports planning complete.
- The native tracked goal covering proposal, design, external review, spec deltas, and tasks was marked complete. No production AppImage build, automated implementation test, or GNOME UI verification has run because implementation has not begun.

## Next action

Run `$rad-apply add-portable-linux-appimage`. Start from the graph's ready frontier (1.1, 2.1, 2.2, and 3.1), preserve all existing work, and let the coordinator alone update `tasks.md` and record evidence.

## Open questions

- None block apply. Vendored Linux FFmpeg/FFprobe provenance, license compatibility, checksum, build flags, and an `h264_nvenc`-capable x86_64 distribution must be established by task 3.1 rather than assumed.
- The separate `add-portable-serve-mode` change is still open at 27/34 tasks. Its status is not part of this change, but overlapping main/headless code must be re-read before edits.

## Gotchas

- `codex mcp list` shows `peer-review` enabled at `/home/rjdollete/dev/peer-review/dist/app.js`, but the live session's tool inventory did not hot-load `mcp__peer-review__peer_review`. A fresh session should load it; if not, diagnose registration before declaring it unavailable. The direct MCP retry in this session succeeded.
- Whole-repository `radflow-lint` currently reports violations in the separate `add-portable-serve-mode` change. Use the targeted command `/home/rjdollete/dev/radflow/bin/radflow-lint add-portable-linux-appimage` for this change; it is clean.
- The worktree is intentionally dirty from the requested Radflow adoption and the new untracked AppImage change. Nothing is staged. Do not reset, delete, or overwrite those changes.
- `tasks.md` is the apply contract and was deliberately not edited during this preclear capture.
- The Linux capability must not be described as working until task 5.1 drives the real packaged AppImage under GNOME Wayland and inspects visual evidence. Passing unit tests or extracting the package is insufficient.

## Resume prompt

Read `openspec/changes/add-portable-linux-appimage/handoff.md`, then the change's `proposal.md`, `design.md`, and `tasks.md`. Continue with `$rad-apply add-portable-linux-appimage` — planning is complete, implementation is 0/9, and the ready frontier is tasks 1.1, 2.1, 2.2, and 3.1.
