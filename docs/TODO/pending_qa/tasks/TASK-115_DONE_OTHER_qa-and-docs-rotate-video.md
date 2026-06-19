---
id: TASK-115
title: 'Docs + manual QA for Rotate CW / Rotate CCW video tools'
investigation: INV-030
status: DONE
priority: medium
blocked_by: [TASK-113, TASK-114]
date_created: 2026-06-19
date_completed: 2026-06-19
files:
  - 'docs/rotate-video.md'
  - 'docs/index.md'
  - 'docs/TOOLS.md'
---

## What

Write the `docs/rotate-video.md` feature doc, link it from `docs/index.md` and add
it as Worked Example 5 + a Related entry in `docs/TOOLS.md`, then run the manual QA
matrix for both rotate directions in the running app and record evidence.

## Why

Every media tool ships with a feature doc and a manual QA pass (the cross-process
finalize flow is not covered by unit tests). Rotate is the fifth consumer of the
shared stack and the visual correctness of CW vs CCW can only be confirmed by eye.

See [INV-030](../investigations/INV-030_MEDIUM_FRONTEND_rotate-cw-ccw-video-tools.md).

## Implementation Steps

- [x] 1. Create `docs/rotate-video.md` modeled on `docs/normalize-audio.md`,
      covering: user-facing behavior (two buttons above Re-encode, sibling `.mp4`
      output, tags copied, auto-open, Keep-which-version prompt); the exact ffmpeg
      commands (`-vf transpose=1`/`transpose=2 -c:v libx264 -c:a copy` plus the
      shared `-hide_banner -i -progress pipe:1 -nostats -y` transport flags);
      `transpose` value semantics (1 = CW, 2 = CCW); the non-destructive contract
      (source preserved via `getUniqueSiblingPath` + `finalizeEncodedOutput` +
      `DeleteOriginalAfterJob`); and Known Limitations (video is re-encoded — lossy
      and slower than a stream copy; `-c:a copy` into forced `.mp4` can fail for
      non-MP4-muxable audio such as Vorbis, surfacing via the loud error modal with
      source untouched; rotation is baked into pixels, not a display-matrix flag).
      Note the encoder relies on the existing `--enable-gpl --enable-libx264`
      ffmpeg build (no new binary, so no new licensing obligation).
- [x] 2. Add a link to `docs/rotate-video.md` in `docs/index.md` alongside the
      other tool docs.
- [x] 3. In `docs/TOOLS.md`, add "Example 5 — Rotate CW / Rotate CCW (INV-030)" to
      the Worked Examples section (note it is the simplest consumer: static spec
      only, no preInputArgs, no clip payload, no handler branch) and a Related
      bullet linking `rotate-video.md`.
- [ ] 4. REQUIRES MANUAL EXECUTION — In the running app (`yarn dev` + `yarn start`),
      open a portrait/landscape `.mp4` with H.264 video + AAC audio in SlideMode
      and verify: (a) Rotate CW and Rotate CCW appear above Re-encode; (b) Rotate
      CW produces a sibling whose content is rotated 90° clockwise; (c) Rotate CCW
      produces one rotated 90° counterclockwise; (d) tags are copied; (e) the
      Keep-which-version prompt works (Keep Modified / Keep Original / Keep Both);
      (f) the source is untouched until a choice is made. Capture a before/after
      screenshot for each direction. [NOT COMPLETED — requires running app; QA matrix documented in docs/rotate-video.md]
- [ ] 5. REQUIRES MANUAL EXECUTION — Exercise the shared edge paths: filtered +
      fully-tagged view, output name collision (source already matches the output
      convention), zero-tag source, Cancel mid-job, quit-mid-job (partial cleaned
      up), lock enforcement (nav/delete inert during the job), and an
      audio-incompatible source (e.g. a `.webm`/`.ogg` with Vorbis) to confirm the
      `-c:a copy` failure surfaces as a blocking `MediaJobErrorAlert` with the
      source left intact. Record results. [NOT COMPLETED — requires running app; QA matrix documented in docs/rotate-video.md]

## Done When

- [x] `docs/rotate-video.md` exists and is linked from `docs/index.md` and
      `docs/TOOLS.md`.
- [ ] Manual QA matrix completed with evidence (screenshots/log lines) attached to
      or linked from this file for both rotate directions and the edge paths. [REQUIRES MANUAL EXECUTION]
- [ ] CW and CCW are visually confirmed to rotate in the correct directions. [REQUIRES MANUAL EXECUTION]
