---
id: TASK-098
title: 'QA the corrected Mark Start/End capture and single-marker Create Clip on the Windows portable build, and update docs'
investigation: INV-024
status: pending_qa
priority: high
blocked_by: [TASK-096, TASK-097]
date_created: 2026-06-13
date_completed:
files:
  - docs/create-clip.md
  - docs/TOOLS.md
---

## What

Manually verify, on the Windows portable build, that Mark Start / Mark End capture
the real playback time of the watched video and that Create Clip works with a single
marker (start-only / end-only) as well as both. Then correct the docs that describe
the (now-fixed) capture mechanism and the new single-marker behavior.

## Why

INV-024 fixed a silent capture bug (always `00:00:00`, from selecting a gallery
thumbnail `<video>` instead of the slide video) and relaxed Create Clip to a single
marker. Per the project memory (verify empirically; test the portable build), these
must be confirmed by running the real app, not by code inspection. `docs/create-clip.md`
and `docs/TOOLS.md` currently document the old (wrong) `document.querySelector('video')`
capture and the both-markers-required rule, and must be corrected.

See [INV-024](../investigations/INV-024_HIGH_FRONTEND_clip-tool-marktime-zero-and-single-marker.md).

## Implementation Steps

> All checkboxes in the QA matrix below are REQUIRES MANUAL EXECUTION — they may only
> be ticked by the human QA executor after personally performing the step on the
> Windows portable build and capturing evidence (screenshot / log line / ffprobe
> output). Automated agents may not tick these.

- [ ] 1. **Build the portable app** (`yarn build` then `yarn package`, or the project's
      portable build step) and launch it.

- [ ] 2. **Capture — paused.** Open a video from the grid (so its thumbnail and at
      least one neighbor video thumbnail are mounted in the grid behind the slide).
      Pause at a known position (e.g. ~00:01:30). Click **Mark Start** → field shows
      ~`00:01:30` (NOT `00:00:00`). Evidence: screenshot.

- [ ] 3. **Capture — scrubbed/playing.** Scrub to ~00:03:00, click **Mark End** →
      field shows ~`00:03:00`. Repeat with the video playing (unpaused) to confirm a
      non-zero live read. Evidence: screenshot.

- [ ] 4. **Capture — no slide video.** With an image (non-video) open, confirm the
      Tools section shows the no-tools caption (no Mark buttons), i.e. the capture is
      only reachable for videos. (Sanity; the `?? 0` fallback path is exercised only
      if a video is open but unmounted, which the pinning makes unlikely.)

- [ ] 5. **Single marker — start-only.** Fill only Start (e.g. `00:00:05`), leave End
      empty → **Create Clip enabled**. Run it. ffprobe the output: duration ≈
      (source duration − 5s), codec identical to source, near-instant completion
      (stream copy). Evidence: ffprobe output + timing.

- [ ] 6. **Single marker — end-only.** Fill only End (e.g. `00:00:10`), leave Start
      empty → **Create Clip enabled**. Run it. ffprobe: duration ≈ 10s, codec
      identical, near-instant. Confirm an end-only of `00:00:00` keeps Create Clip
      DISABLED. Evidence: ffprobe + screenshot of disabled state.

- [ ] 7. **Both markers.** Fill Start `00:00:05`, End `00:00:10` → enabled; run →
      ~5s clip, codec identical. Fill Start ≥ End → DISABLED with "End must be after
      start." hint. Evidence: ffprobe + screenshot.

- [ ] 8. **Gating matrix.** Both empty → disabled. Lone present marker malformed
      (e.g. `1:2:3`, `99:99:99`) → disabled. Evidence: screenshots.

- [ ] 9. **Finalize + delete-original.** On a successful clip, confirm the new clip
      auto-opens with the source's tags replicated and the delete-original
      (Recycle-Bin) prompt appears; confirm the fields reset after success. Evidence:
      screenshot.

- [ ] 10. **Preview window (if reachable).** If ImageTools/Inspector is reachable in
       the preview window, confirm Mark Start/End capture correctly there too (same
       `#zoomable-image` scope). Evidence: screenshot or note "not reachable."

- [ ] 11. **Update `docs/create-clip.md`** (lines ~33-36 and any "Implementation"
       section): replace the `document.querySelector('video').currentTime`
       description with the corrected scoped read (`#zoomable-image video`, excluding
       gallery thumbnail videos that carry `data-file-id`), and document the
       single-marker behavior: start-only → `-ss` only; end-only → `-to` only; both →
       both; Create Clip enabled when at least one valid `HH:MM:SS` marker is present
       (start < end when both present; end-only requires end > 0).

- [ ] 12. **Update `docs/TOOLS.md`** (around line 322): correct the capture mechanism
       reference and add the single-marker enabling rule alongside the existing clip
       description.

## Done When

- [ ] All QA matrix steps (2-10) performed on the Windows portable build with
      evidence attached to or linked from this file.
- [ ] Confirmed: Mark Start/End read the real playback time (non-zero) with video
      thumbnails mounted in the grid; start-only, end-only, and both clips each
      produce correct lossless cuts (ffprobe: codec unchanged, near-instant).
- [ ] `docs/create-clip.md` and `docs/TOOLS.md` describe the corrected capture
      mechanism and the single-marker behavior.
