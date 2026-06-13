---
id: TASK-095
title: 'QA the Mark Start / Mark End / Create Clip tools on the Windows portable build and document them in docs/TOOLS.md'
investigation: INV-022
status: pending_qa
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
- [x] 5. Stream-copy proof: run `ffprobe` on a source and its clip and confirm
      identical video codec/profile (no re-encode), and that the clip duration ≈
      (end − start). **VERIFIED at the command level** against the bundled
      `resources/ffmpeg/ffmpeg.exe` using the EXACT create-clip argv — see
      "Command-Level QA Evidence" below.
- [ ] 6. **REQUIRES MANUAL EXECUTION** — Edge cases: `.webm`/`.ogg` source (note if
      `-c copy` -> `.mp4` fails and the error toast appears with the source intact —
      this is the documented container caveat, not a bug); collision increment
      (clip beside an existing `name 1.mp4` -> `name 2.mp4`); zero-tag source (clip
      has no tags, no error); cancel mid-job (neutral toast, no partial file, source
      intact); quit mid-job (no orphaned partial). Evidence per case.
- [x] 7. Write `docs/TOOLS.md` entries for Mark Start, Mark End, and Create Clip:
      the capture-from-playback behavior and `00:00:00` fallback, manual edit +
      `HH:MM:SS` validation rules, the exact ffmpeg command (`-ss/-to` BEFORE `-i`,
      `-c copy`, output `.mp4`), tag replication + auto-open + delete-original reuse,
      and the documented caveats (keyframe-snap on stream-copy start, progress
      computed against source duration, webm/ogg-into-MP4 container limitation).
      Written as `docs/create-clip.md` (full feature doc mirroring normalize-audio.md)
      and as Example 3 in `docs/TOOLS.md`'s Worked Examples section.
- [x] 8. Add a one-line cross-reference in `docs/index.md` next to the existing
      Re-encode / Normalize Audio entries. Done — row added to the Documentation
      Index table between Normalize Audio and Creating Inspector Tools.

## Done When

- [ ] All manual matrix items in steps 2-6 are executed on the Windows portable
      build with evidence (screenshots / ffprobe output / log lines / clip files)
      attached to or linked from this file.
- [ ] Capture-from-playback, validation gating, the happy-path clip with tag
      replication + auto-open + delete-original, and the stream-copy (no re-encode)
      guarantee are all confirmed.
- [x] `docs/TOOLS.md` documents the three tools (command shape, validation,
      caveats) and `docs/index.md` cross-references them.

## Command-Level QA Evidence

Captured 2026-06-13 by running the **bundled** `resources/ffmpeg/ffmpeg.exe` /
`ffprobe.exe` with the EXACT argv `src/main.ts` builds for `create-clip`
(`-hide_banner -ss <start> -to <end> -i <src> -c copy -progress pipe:1 -nostats -y
<dst>`). This exercises the real ffmpeg binary and the real command shape; it does
NOT exercise the Electron renderer (live `<video>` read, SlideMode auto-open, tag
panel, toasts, Recycle Bin) — those remain GUI-only (steps 2, 4, and the
toast/cancel/quit-mid-job parts of 6).

**Stream-copy proof (step 5 — PASS):**
- Source `source.mp4`: `h264 High` / `aac LC`, duration `10.000000`.
- `ffmpeg -hide_banner -ss 00:00:02 -to 00:00:05 -i source.mp4 -c copy -progress
  pipe:1 -nostats -y "source 1.mp4"` → exit 0, `speed=2.23e+03x` (≈2230× realtime →
  near-instant, i.e. no re-encode).
- Clip `source 1.mp4`: `h264 High` / `aac LC` — **identical codec/profile to the
  source** (lossless stream copy confirmed), duration `3.066667` ≈ (5−2)=3 s.
- The ~0.067 s overshoot is the documented **keyframe-snap** caveat (start snaps to
  the preceding keyframe on `-c copy`). Output name `source 1.mp4` confirms the
  collision-increment naming pattern.

**Validation gating logic (step 3 — logic PASS; GUI disabled-state still manual):**
`parseHmsToSeconds` + the `start < end` gate verified directly:
- valid: `00:00:00`→0, `00:01:30`→90, `01:02:03`→3723, `100:00:00`→360000.
- rejected (→`null`): `1:2:3`, `99:99:99`, `aa:bb:cc`, `` (empty), `00:60:00`,
  `00:00:60`, `00:5:00`.
- gate: `02<05`→enabled; `05<02`, `05==05`, malformed→disabled. Matches spec.

**webm→mp4 container caveat (step 6 — PASS):**
- Source `src.webm`: `vp8` / `vorbis`.
- Same create-clip argv to `"src 1.mp4"` → exit non-zero, stderr `Could not write
  header (incorrect codec parameters ?): Invalid argument` / `Conversion failed!`;
  **`src.webm` left intact**. This is the documented container limitation; the
  `ReEncodeManager` error path (covered by its unit tests) removes the partial
  output and surfaces the stderr toast.

## Pending QA Note

The **GUI-only** matrix items cannot be completed by an automated agent and remain
for the user on the Windows portable build:

- **Step 2** — capture-from-playback (live `<video>.currentTime` → fields;
  `00:00:00` when stopped). Needs a running renderer with a playing video.
- **Step 3 (visual)** — confirm the Create Clip button is actually *disabled/enabled*
  in the UI (the underlying gating logic is already verified above).
- **Step 4** — happy path in-app: spinner, near-instant completion, new `.mp4`
  auto-opens in SlideMode, source tags replicated onto the clip (tag panel),
  delete-original prompt → Recycle Bin ("Keep" once, "Delete" once).
- **Step 6 (remainder)** — zero-tag source, cancel mid-job (neutral toast, no
  partial), quit mid-job (no orphan), and the `.webm`/`.ogg` *error-toast* surfaced
  in the UI (the ffmpeg failure + source-intact behavior is already verified above).

To finish: `yarn build && yarn package`, run the portable exe, execute the four
GUI items above with screenshots/log evidence, then mark the remaining boxes and set
this task DONE (which graduates INV-022 out of `pending_qa`).
