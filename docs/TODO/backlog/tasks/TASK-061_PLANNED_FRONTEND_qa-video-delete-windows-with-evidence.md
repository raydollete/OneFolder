---
id: TASK-061
title: 'QA: re-run full Windows video delete/move repro matrix with captured evidence'
investigation: INV-014
status: planned
priority: high
blocked_by: [TASK-058, TASK-059, TASK-060]
date_created: 2026-05-04
date_completed:
files:
  - docs/TODO/backlog/investigations/INV-014_HIGH_FRONTEND_video-delete-ebusy-recurs-fix-incomplete.md
---

> Adheres to [QA-DISCIPLINE](../../QA-DISCIPLINE.md) — this task IS the evidence-gated QA gate that INV-014 introduced the discipline to enforce. All `REQUIRES MANUAL EXECUTION ON WINDOWS` steps may only be marked `[x]` by the human QA executor after performing the step and capturing evidence.

## What

Run the full INV-008 reproduction matrix on Windows after TASK-058, TASK-059, and
TASK-060 have shipped, capturing concrete evidence (devtools log lines from the new
TASK-058 dev logging, plus screenshots/clips of successful deletes) for each test
step. Do NOT mark this task DONE until the evidence is in hand and the matrix passes
end-to-end — this is the QA gate that TASK-042 skipped.

## Why

INV-014 Root Cause #4: TASK-042 was marked DONE without any of its 9
"REQUIRES MANUAL EXECUTION ON WINDOWS" steps having actually been executed, and the
investigation was promoted to `pending_qa/` based on that false signal. That is what
allowed Root Causes #1, #2, and #3 to ship without anyone noticing. This task closes
that loop with explicit evidence requirements.

The dev-only logging added in TASK-058 makes the "did the release actually happen?"
question observable: every `releasePaths` call logs `registryHits` and `domHits`. A
successful delete must show non-zero hits for any video that was previewed.

See [INV-014](../investigations/INV-014_HIGH_FRONTEND_video-delete-ebusy-recurs-fix-incomplete.md).

## Implementation Steps

REQUIRES MANUAL EXECUTION ON WINDOWS BY THE HUMAN QA EXECUTOR.

- [ ] 1. Build and launch OneFolder with the TASK-058/059/060 changes applied
      (`yarn dev` then `yarn start` in a separate terminal). Open DevTools (Ctrl+Shift+I)
      and switch to the Console tab — leave it visible during all subsequent steps so
      the dev log lines are captured.

- [ ] 2. Prepare a test library with at least:
  - 3 `.mp4` files of varied sizes (small <10MB, medium ~100MB, large >500MB)
  - 1 `.webm`
  - 1 `.ogg`
  - 4-6 `.jpg`/`.png` for regression control

- [ ] 3. Settings: set `Gallery video playback mode` to `hover`. Run the matrix below.
      For EACH bullet, capture a devtools-console screenshot or log paste showing the
      `[MediaReleaseCoordinator] releasePaths` log line with `registryHits` or `domHits`
      > 0, AND confirm the file is gone from disk and the gallery DB record is removed.

  - [ ] Hover an `.mp4` thumbnail for ~2s, press Delete hotkey, confirm. Verify:
        no EBUSY toast, file in trash, log shows `registryHits >= 1`.
  - [ ] Hover an `.mp4`, right-click → Delete file, confirm. Same verification.
  - [ ] Hover a `.webm`, repeat. Same verification.
  - [ ] Hover an `.ogg`, repeat. Same verification.
  - [ ] Select 3 mixed files (1 image, 2 videos), press Delete, confirm. Verify all
        three trash; log shows hits for the videos.
  - [ ] Open a video in SlideMode (double-click), let it play for ~3s, press Delete,
        confirm. Verify slide-mode advances/closes, file trashes, log shows hits.
  - [ ] Open a video in SlideMode where `prevFile` and `nextFile` are also videos
        (so the preload effect creates orphans). Without navigating, press Delete on
        the current video. Verify file trashes; log shows hits.
  - [ ] In SlideMode, navigate forward past a video, then back to it, then delete it.
        Verify file trashes; log shows hits.
  - [ ] Open Duplicate Gallery; if any video appears in a duplicate group, click the
        per-row Delete button. Verify file trashes. (Skip if no video duplicates.)

- [ ] 4. Settings: change `Gallery video playback mode` to `auto`. Repeat the first 4
      bullets of step 3. Verify videos that auto-play also delete cleanly.

- [ ] 5. Settings: change `Gallery video playback mode` to `disabled`. Repeat first
      bullet. Verify no regression (delete still works; with no preview, log may show
      `registryHits = 0` and `domHits = 0` — that is expected and correct).

- [ ] 6. Drag-and-drop a hovered video into a sub-location. Verify:
      no EBUSY, file appears at destination, original is gone, no duplicate DB
      entries after chokidar settles, log shows hits for the source path.

- [ ] 7. Drag-and-drop a video onto a folder that already contains a video file with
      the same name (overwrite scenario). Choose Replace. Verify clean overwrite,
      log shows hits for both src and dst.

- [ ] 8. Regression sanity:
  - [ ] Hover preview still plays on mouse-enter, pauses on mouse-leave.
  - [ ] Auto playback still starts when thumbnails enter the viewport.
  - [ ] SlideMode video plays with controls/autoplay/loop.
  - [ ] Image delete is unchanged (no extra latency, no errors).
  - [ ] Outliner counts (All Images, Untagged) match gallery after each delete.

- [ ] 9. Edge: rapidly hover across a row of 5+ video thumbnails (so multiple
      `<video>` elements have file handles open simultaneously). Delete one of them.
      Verify only the targeted file trashes, others continue playing/previewing,
      log shows `registryHits >= 1` (the target was registered).

- [ ] 10. Capture all evidence (screenshots, log pastes) into a single comment on this
       task file (or a linked Discord/issue thread referenced from this file).
       Reference each bullet by name.

- [ ] 11. ONLY after every checkbox above is ticked AND evidence is in the task
       record, mark this task `status: DONE`, fill `date_completed`, and move it to
       `docs/TODO/pending_qa/tasks/`. Do NOT mark DONE based on
       "looks like it should work" or partial verification.

## Done When

- [ ] Every checkbox in steps 3-9 is ticked, with evidence captured in step 10.
- [ ] No EBUSY toast appears for any of the test files during any step.
- [ ] No regression observed in image delete, hover preview, auto preview, or
      SlideMode playback.
- [ ] Evidence is captured (screenshots and/or log pastes) for at least one
      successful delete per unique trigger surface.
- [ ] Task status is updated to DONE only after all of the above is complete.
