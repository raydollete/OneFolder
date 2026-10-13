# Handoff — restore-onefolder-exe-name

**Objective:** make the repo public-ready. This change removes `brave.exe` (Windows build becomes `OneFolder-<version>-x64.exe`, inner `OneFolder.exe`) and adds README "Portable builds" docs with Windows and Linux build steps. Repo: `/home/rjdollete/dev/OneFolder`, branch `master`, nothing committed.

**Stage:** planning complete (proposal, spec, design with peer review achieved, tasks). Apply not started; 0/8 tasks.

## Open items

- **Tier warning (advisory):** radflow-lint suggests Tier 3 (17 cited files incl. openspec/). Kept Tier 2: 14 files outside openspec/, rename + docs. The owner was told and has not objected.
- **Task 8 is REQUIRES MANUAL EXECUTION** on a Windows x64 host; it can't be packaged on this Linux box (no Wine).

## Sibling change: prepare-public-repo (hotfix, 3/3 tasks done, next `/rad-archive`)

Its uncommitted edits: `README.md` (fork notice :6), `docs/personal-fork-notes.md`, `docs/reencode-x264.md`, new `resources/ffmpeg/NOTICE.md`. This change edits README.md and personal-fork-notes.md again; build on those edits, don't revert them.

**Committed fix still owed before archiving it:** `resources/ffmpeg/NOTICE.md` duplicates the pre-existing `resources/THIRD_PARTY.md` (Windows section at "## FFmpeg / FFprobe — Windows x86_64", which is vague: "GPL/LGPL depending on the original build"). Fold NOTICE.md's facts into that section and delete NOTICE.md:
- build `8.1.1-essentials_build-www.gyan.dev`
- GPLv3 via `--enable-gpl --enable-version3`, no nonfree
- source URLs: ffmpeg.org 8.1.1 tarball, gyan.dev builds page, GyanD/codexffmpeg releases

Then repoint the three links to it (README.md:6, docs/personal-fork-notes.md:117, docs/reencode-x264.md:398). Also, NOTICE.md's claim that the Linux binaries are untracked is true, but THIRD_PARTY.md describes them as "committed".

## Not ours

Other dirty paths predate this session and belong to the radflow re-adopt or other changes; don't sweep them into these changes' reasoning:
- `.claude/` deletions
- `openspec/config.yaml*`
- `openspec/templates/*`
- `.agents/`
- `openspec/changes/add-linux-appimage-build/`

## Resume prompt

```
Read openspec/changes/restore-onefolder-exe-name/handoff.md first. Working in /home/rjdollete/dev/OneFolder on master. Run /rad-apply restore-onefolder-exe-name and work tasks 1-7; task 8 needs a Windows host — leave it for the owner with exact steps. Separately, prepare-public-repo still owes the NOTICE.md → resources/THIRD_PARTY.md fold described in the handoff before it is archived. Do not commit or push unless asked.
```
