---
id: TASK-103
title: 'Harden temp-file cleanup on cancel/error/quit (no leaked temp, no moved partial) and QA the temp-dir staging on a Windows portable build across ALL THREE tools.'
investigation: INV-026
status: planned
priority: high
blocked_by: [TASK-100, TASK-101, TASK-102]
date_created: 2026-06-13
date_completed:
files:
  - 'src/ReEncodeManager.ts'
---

## What

Ensure the temp-dir staging never leaks a temp file and never leaves a partial
file at the final target path, on ffmpeg failure, user cancel, or app
quit-mid-job. Then manually QA the full temp-dir-then-move flow on a Windows
portable build, exercising all three media-job tools through the identical shared
path.

## Why

With output staged in `<targetDir>/.onefolder-tmp/` and moved by an atomic rename
(TASK-100/101/102), the existing cleanup that removed a single in-place
`outputPath` must now target the TEMP path, and a new window exists if cancel/quit
lands during/after commit. Leaks of hidden temp files in users' photo folders are
unacceptable, and the whole fix must be verified on the real portable build per
project QA discipline.

See [INV-026](../investigations/INV-026_HIGH_FRONTEND_media-job-temp-dir-then-move-to-avoid-watcher-race-on-partial-output.md).

## Implementation Steps

- [ ] 1. In `src/ReEncodeManager.ts`: update `child.on('error')` (:267-278) and
      `child.on('close')` non-zero (:280-298) to `fse.remove(job.tempPath)` (the
      encode target is now the temp path), not the final path. The final file does
      not exist yet on these paths (ffmpeg failed before commit), so only the temp
      partial needs removal.

- [ ] 2. Update `_killAndClean` (:361-390) to remove `job.tempPath` if
      `phase !== 'done'`, and — defensively — `job.finalPath` if
      `phase === 'committing'` (a non-atomic cross-volume commit could have left a
      partial there; the same-volume atomic rename cannot, but be safe). After
      removing the temp file, best-effort remove the `.onefolder-tmp` dir if empty.
      `cancel` (:142-153) and `killAll` (:160-168) call `_killAndClean`, so they
      inherit this.

- [ ] 3. In `commit` (added in TASK-100): on rename/move failure, remove the temp
      file and reject; never leave a half-written file at `finalPath` (overwrite:
      false guarantees we never clobber, and the atomic rename is all-or-nothing on
      the same volume).

- [ ] 4. Add a best-effort startup sweep: on app start (where `reEncodeManager` is
      constructed / first used in `src/main.ts`), remove any stale
      `.onefolder-tmp` contents under known location roots is out of scope here;
      instead ensure each job removes its own `.onefolder-tmp` dir when it becomes
      empty after commit/cleanup. Document that orphaned temp dirs (e.g. after a
      hard crash) are dot-dirs ignored by the watcher and harmless until the next
      job sweeps them.

- [ ] 5. **REQUIRES MANUAL EXECUTION (Windows portable build).** Build the portable
      target (`yarn build` then `yarn package`, or run the existing portable build),
      launch it, and for EACH of the three tools (Re-encode x264, Compress &
      Normalize Audio, Create Clip) on a tagged video inside a watched location,
      verify and capture evidence (screenshot / log line / clip) for:
      - (a) No "outside a watched folder / could not be confirmed" toast.
      - (b) The output carries the source's tags (check the inspector tag list AND
        re-read EXIF/XMP, e.g. exiftool on the file, to confirm both DB and file
        metadata).
      - (c) The output auto-opens in SlideMode and the delete-original prompt
        appears.
      - (d) Running from a TAG-FILTERED view still tags and opens the output
        (the original INV-019 failure mode).
      - (e) Cancel mid-encode: no file left in `.onefolder-tmp` and none at the
        final target path.
      - (f) Force-quit the app mid-encode: no leaked temp file (re-launch and check
        `.onefolder-tmp`).
      - (g) Name collision (run the same tool twice): the second output increments
        (`name 1.mp4`) and both are tagged/openable.
      - (h) Zero-tag source: the EXIF write is skipped, the output still opens.
      - (i) The `.onefolder-tmp` dir is NEVER ingested by the watcher (no phantom
        library entries for temp files).

- [ ] 6. Record the evidence in this task file (or link it) per
      docs/TODO/QA-DISCIPLINE.md before promoting INV-026 out of backlog.

## Done When

- [ ] On ffmpeg error/cancel/quit, the temp partial is removed and no partial file
      exists at the final target path; `.onefolder-tmp` is left empty/removed.
- [ ] All three tools pass the manual Windows-portable QA matrix (a)–(i) with
      attached evidence; no "outside a watched folder" toast and no untagged
      imports observed.
- [ ] `yarn lint` and `yarn build` pass.
