---
id: TASK-095
title: 'QA the Mark Start / Mark End / Create Clip tools on the Windows portable build and document them in docs/TOOLS.md'
investigation: INV-022
status: planned
priority: medium
blocked_by: [TASK-093, TASK-094]
date_created: 2026-06-12
date_completed:
files:
  - 'docs/TOOLS.md (document the three new tools)'
  - 'docs/index.md (cross-reference)'
---

## What

Manually verify the full Mark Start / Mark End / Create Clip feature in the
packaged Windows portable build, capturing evidence per QA-DISCIPLINE.md, and
document the tools (behavior, ffmpeg command shape, validation rules, and the known
caveats) in `docs/TOOLS.md`.

## Why

The capture-from-playback read, the stream-copy correctness (`-ss/-to` before `-i`,
`-c copy`), the validation gating, and the reuse of the finalize + delete-original
flow can only be confirmed end-to-end in the real app against real video files. The
backend tests (TASK-093) cannot exercise the live `<video>` read or the ingestion
round-trip.

See [INV-022](../investigations/INV-022_MEDIUM_FRONTEND_mark-in-out-create-clip-video-tool.md)
(Behavioral Specifications; Risks and Tradeoffs).

## Implementation Steps

- [ ] 1. Build and launch the portable app (`yarn build` + `yarn package`, then run
      the portable exe), with a watched location containing tagged `.mp4`, `.webm`,
      and `.ogg` videos.
- [ ] 2. **REQUIRES MANUAL EXECUTION** — Capture-from-playback: open a tagged
      `.mp4`, let it play, click Mark Start mid-playback -> field shows a non-zero
      `HH:MM:SS` matching the player position. Pause, scrub, click Mark End ->
      field updates. Stop/seek to 0 (or a state with no mounted video) and confirm
      a capture yields `00:00:00`. Evidence: screenshot of the fields vs. player.
- [ ] 3. **REQUIRES MANUAL EXECUTION** — Validation gating: type malformed values
      (`1:2:3`, `99:99:99`, empty, `aa:bb:cc`) and confirm Create Clip stays
      disabled; set start ≥ end and confirm it stays disabled; set a valid
      start < end and confirm it enables. Evidence: screenshots.
- [ ] 4. **REQUIRES MANUAL EXECUTION** — Happy path: with valid times, click Create
      Clip. Confirm: spinner shows; completion is near-instant (stream copy); the
      new `.mp4` auto-opens in SlideMode; the source's tags are present on the clip
      (check the tag panel); the delete-original prompt appears. Choose "Keep
      Original" once and "Delete Original" once (verify the source goes to the
      Recycle Bin). Evidence: clip file + screenshots + log lines.
- [ ] 5. **REQUIRES MANUAL EXECUTION** — Stream-copy proof: run `ffprobe` on a
      source and its clip and confirm identical video codec/profile (no re-encode),
      and that the clip duration ≈ (end − start). Evidence: ffprobe output pasted
      into this task.
- [ ] 6. **REQUIRES MANUAL EXECUTION** — Edge cases: `.webm`/`.ogg` source (note if
      `-c copy` -> `.mp4` fails and the error toast appears with the source intact —
      this is the documented container caveat, not a bug); collision increment
      (clip beside an existing `name 1.mp4` -> `name 2.mp4`); zero-tag source (clip
      has no tags, no error); cancel mid-job (neutral toast, no partial file, source
      intact); quit mid-job (no orphaned partial). Evidence per case.
- [ ] 7. Write `docs/TOOLS.md` entries for Mark Start, Mark End, and Create Clip:
      the capture-from-playback behavior and `00:00:00` fallback, manual edit +
      `HH:MM:SS` validation rules, the exact ffmpeg command (`-ss/-to` BEFORE `-i`,
      `-c copy`, output `.mp4`), tag replication + auto-open + delete-original reuse,
      and the documented caveats (keyframe-snap on stream-copy start, progress
      computed against source duration, webm/ogg-into-MP4 container limitation).
- [ ] 8. Add a one-line cross-reference in `docs/index.md` next to the existing
      Re-encode / Normalize Audio entries.

## Done When

- [ ] All manual matrix items in steps 2-6 are executed on the Windows portable
      build with evidence (screenshots / ffprobe output / log lines / clip files)
      attached to or linked from this file.
- [ ] Capture-from-playback, validation gating, the happy-path clip with tag
      replication + auto-open + delete-original, and the stream-copy (no re-encode)
      guarantee are all confirmed.
- [ ] `docs/TOOLS.md` documents the three tools (command shape, validation,
      caveats) and `docs/index.md` cross-references them.
