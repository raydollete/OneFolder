---
id: TASK-064
title: 'QA: SlideMode auto-advances on delete under random sort with no gallery reshuffle, with captured evidence'
investigation: INV-015
status: done
priority: medium
blocked_by: [TASK-063]
date_created: 2026-05-15
date_completed: 2026-05-15
files:
  - docs/TODO/backlog/investigations/INV-015_MEDIUM_FRONTEND_video-delete-exits-slidemode-and-reshuffles-random-sort.md
---

> Adheres to [QA-DISCIPLINE](../../QA-DISCIPLINE.md). All `REQUIRES MANUAL
> EXECUTION` steps may only be marked `[x]` by the human QA executor after
> performing the step and capturing evidence (screenshot, screen recording,
> or pasted log line). This task may not be marked DONE without evidence
> for at least one successful scenario in each of steps 4, 5, 6, and 7.

## What

Run a focused manual QA matrix to verify TASK-063's fix produces the
behavior INV-015 specifies: SlideMode auto-advances to the next file on
delete, the gallery order does not reshuffle under random sort, the
deleted file is gone from the visible list, and the boundary cases
(tail file, last-file-in-list, bulk delete) all behave as specified.

## Why

INV-015 Behavioral Specifications enumerate seven distinct delete
scenarios (single from SlideMode, tail from SlideMode, empties-the-list,
bulk from SlideMode with currently-viewed in deleted set, bulk from
gallery without SlideMode, bulk from gallery WITH SlideMode where
viewed file is not in deleted set, image delete). Each is a distinct
state-machine branch. A code-side smoke test alone cannot cover all
seven; manual QA is required.

The QA-DISCIPLINE evidence requirement was introduced by INV-014 after
TASK-042 was marked DONE without any of its nine manual-Windows steps
having actually been executed. This task complies with the discipline
by gating "DONE" on captured evidence.

See [INV-015](../investigations/INV-015_MEDIUM_FRONTEND_video-delete-exits-slidemode-and-reshuffles-random-sort.md).

## Implementation Steps

REQUIRES MANUAL EXECUTION BY THE HUMAN QA EXECUTOR.

- [ ] 1. Build and launch OneFolder with the TASK-063 changes applied
      (`yarn dev`, then `yarn start` in a separate terminal). Open
      DevTools (Ctrl+Shift+I) → Console tab. Leave it visible.

- [ ] 2. Prepare a test library with at least:
  - 8-12 `.mp4` / `.webm` videos of varied content (so reshuffles
    would be visually obvious — pick videos with distinguishable
    first frames or use filenames that include sequence numbers).
  - 8-12 `.jpg` / `.png` images for the image-delete regression
    scenarios.
  - Total at least ~20 files so an in-place splice meaningfully
    differs from a reshuffle.

- [ ] 3. Settings → Appearance: confirm sort is set to Random. (If
      the persisted setting is something else, switch to Random via
      the Sort menu, then refresh.) Note the visible order of the
      first 8-10 thumbnails — take a screenshot of the gallery
      header area as the "before" reference.

- [ ] 4. **Scenario A: single video delete from SlideMode (the
      reported scenario).** REQUIRES MANUAL EXECUTION.
  - Double-click a video thumbnail to enter SlideMode. Note the
    filename of the current video (visible in the Inspector pane
    if open, or in the URL bar / page title).
  - Press the Delete hotkey. Confirm the trash dialog.
  - VERIFY:
    - [ ] SlideMode stays open. The view did NOT return to the
          thumbnail grid.
    - [ ] The video on screen is now a DIFFERENT file — specifically
          the next file in the current order.
    - [ ] The deleted file is gone from disk (check the original
          folder via Windows Explorer / Finder) and gone from the
          gallery DB (escape SlideMode and confirm the thumbnail no
          longer appears in the grid).
    - [ ] The gallery order has NOT reshuffled. The first 8-10
          thumbnails should match the "before" reference from
          step 3, MINUS the deleted entry. Take a screenshot
          comparing.
  - **Evidence:** paste both screenshots (before and after) into
    this task file or attach to a linked issue/comment.

- [ ] 5. **Scenario B: delete of the TAIL file from SlideMode.**
      REQUIRES MANUAL EXECUTION.
  - Navigate to the end of the gallery list (in SlideMode, press
    Right Arrow until the "next" button greys out — you are now
    on the last file).
  - Delete it. Confirm.
  - VERIFY:
    - [ ] SlideMode stays open. View is now showing the
          previous-to-last file (which is the new tail).
    - [ ] The "next" button stays greyed out (no further file).
    - [ ] Gallery order unchanged otherwise.
  - **Evidence:** brief screen-recording clip or before/after
    screenshots showing the file at the tail before delete,
    SlideMode still active after delete, and the new tail file
    visible.

- [ ] 6. **Scenario C: delete the only remaining file (empties the
      list).** REQUIRES MANUAL EXECUTION.
  - In a search box, filter the gallery down to exactly one file
    (e.g. tag-search or filename match for a unique file).
  - Open it in SlideMode.
  - Delete it. Confirm.
  - VERIFY:
    - [ ] SlideMode closes (no file to show).
    - [ ] The gallery is empty (no thumbnails visible).
    - [ ] Clear the search filter — the rest of the library is
          visible again, in its original (non-reshuffled) order.
    - [ ] `uiStore.isSlideMode` is false: re-adding a file (e.g.
          drop a file into the watched folder) does NOT auto-open
          SlideMode.
  - **Evidence:** screenshot of empty gallery + screenshot of
    post-clear gallery showing original order preserved.

- [ ] 7. **Scenario D: bulk delete from gallery WITH SlideMode
      currently viewing one of the to-be-deleted files.** REQUIRES
      MANUAL EXECUTION.
  - In the thumbnail grid, select 3 adjacent files using
    Ctrl+click. Note their filenames and which one is the
    "middle" one.
  - Double-click the middle one to open SlideMode.
  - Press Delete (deletes the full 3-file selection). Confirm.
  - VERIFY:
    - [ ] SlideMode stays open. The view is now showing the file
          that was AFTER the deleted set (or BEFORE, if no file
          was after — per the auto-advance fallback in the
          investigation).
    - [ ] All three selected files are gone from the gallery.
    - [ ] Gallery order is otherwise unchanged.
  - **Evidence:** screenshot of SlideMode after delete (showing
    surviving file) + screenshot of gallery showing the three
    files removed and surrounding order intact.

- [ ] 8. **Scenario E: bulk delete from gallery WITHOUT SlideMode
      open.** REQUIRES MANUAL EXECUTION.
  - Close SlideMode (Escape).
  - Select 3 files via Ctrl+click.
  - Delete. Confirm.
  - VERIFY:
    - [ ] All three files are gone.
    - [ ] Gallery order is unchanged. Scroll position is roughly
          preserved (not jumped to top).
    - [ ] No SlideMode opens unexpectedly.
  - **Evidence:** before/after screenshots.

- [ ] 9. **Scenario F: image (not video) delete from SlideMode.**
      REQUIRES MANUAL EXECUTION. Repeat Scenario A with a .jpg
      instead of a .mp4. Same expected outcome — confirms the fix
      is content-type-agnostic and not video-specific.

- [ ] 10. **Regression: non-random sort modes.** REQUIRES MANUAL
       EXECUTION. Change Sort menu to "Date Added" descending.
       Repeat Scenario A. Verify same auto-advance behavior, and
       confirm the gallery order is still date-added-desc (no
       reordering). Then change to "Name" ascending and repeat
       once more. No regression.

- [ ] 11. **Regression: in-memory state consistency.** REQUIRES
       MANUAL EXECUTION. Open the DevTools console. After
       Scenario A, type:
       ```js
       (function() {
         const fs = window.__rootStore?.fileStore || /* find it via React DevTools if needed */;
         console.log('numTotalFiles:', fs.numTotalFiles, 'fileList.length:', fs.fileList.length, 'numUntaggedFiles:', fs.numUntaggedFiles);
       })()
       ```
       (If `window.__rootStore` is not exposed, use React DevTools
       to inspect the Provider's value.) Verify that `numTotalFiles
       === fileList.length` after delete (no count drift). Verify
       that re-opening SlideMode and using arrow keys does not
       error out.

- [ ] 12. **Regression: chokidar file-watcher events do not
       reshuffle in a confusing way.** REQUIRES MANUAL EXECUTION.
       Drop a new file into the watched folder while in random
       sort. Verify that the gallery still works (acceptable per
       INV-011's accepted UX — this is the "new files trigger
       refetch which reshuffles" path that we explicitly DID NOT
       change in INV-015).

- [ ] 13. Collect all evidence (screenshots, recordings, console
       pastes) into this task file or linked thread. Reference each
       scenario by letter.

- [ ] 14. ONLY after every checkbox above is ticked AND evidence is
       captured, mark this task `status: done`, fill
       `date_completed`, and move it to `docs/TODO/pending_qa/tasks/`.

## Done When

- [ ] All scenarios A-F pass with the expected behavior.
- [ ] Regression scenarios (steps 10-12) confirm no breakage of
      existing behavior.
- [ ] Evidence for scenarios A, B, C, and D (at minimum) is
      captured and pasted into / linked from this file.
- [ ] No console errors during the QA matrix (warnings about the
      stale-fetch generation gate from INV-009 are acceptable; new
      errors are not).
- [ ] Task status is updated to `done` only after all of the above.
