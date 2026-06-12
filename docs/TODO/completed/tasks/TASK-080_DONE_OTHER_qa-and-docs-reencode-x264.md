---
id: TASK-080
title: 'QA the re-encode (x264) tool end-to-end on the Windows portable build and document the feature'
investigation: INV-018
status: done
priority: medium
blocked_by: [TASK-074, TASK-075, TASK-076, TASK-077, TASK-078, TASK-079]
date_created: 2026-06-11
date_completed: 2026-06-12
files:
  - 'docs/reencode-x264.md (new)'
  - 'docs/index.md (link the new doc)'
  - 'docs/personal-fork-notes.md (cross-reference: second bundled binary + GPL caveat)'
---

## What

Manually verify the complete "Re-encode (x264)" feature in the portable Windows
build with captured evidence, then write the feature documentation.

## Why

Per docs/TODO/QA-DISCIPLINE.md, this investigation may not be promoted to
pending_qa until a QA task is DONE with concrete evidence. The feature spans a
bundled binary, a subprocess, IPC, file ingestion, tag writeback, a UI lock, and
the trash flow — all of which must be exercised against the real packaged app
(not just dev), consistent with the user's "test the portable build" rule.

See [INV-018](../investigations/INV-018_MEDIUM_FRONTEND_reencode-x264-video-tool.md).

## Implementation Steps

> The verification steps below are `REQUIRES MANUAL EXECUTION ON WINDOWS`. Only
> the human QA executor may tick them, and only after capturing evidence
> (screenshot, log line, or short clip). See docs/TODO/QA-DISCIPLINE.md.

- [ ] 1. Build and launch the portable artifact (`yarn package`, run
      `dist/brave.exe`). Confirm `resources/ffmpeg/ffmpeg.exe` is present in the
      extracted/packaged resources.
- [ ] 2. REQUIRES MANUAL EXECUTION ON WINDOWS — **Tool visibility + placeholder
      removal:** open a video in SlideMode; confirm "Re-encode (x264)" appears
      and is enabled in the inspector Tools section, and that NONE of the old
      dormant placeholder buttons (HEIC to JPEG, Optimize JPEG, Fix red eyes,
      Colorize black and white image) nor any canny.io "Let us know" link are
      present. Open an image; confirm the tool is absent and a neutral "no tools
      for this file type" caption is shown (not an empty/broken body).
      Evidence: screenshots of both.
- [ ] 3. REQUIRES MANUAL EXECUTION ON WINDOWS — **Happy path with tags:** tag a
      non-`.mp4` source video (e.g. a `.webm` with `Travel/Italy`), run the
      tool. Confirm: spinner/progress shows; output `<name>.mp4` is created
      beside the source; output auto-opens in the player; output carries the
      tags in the OneFolder UI AND in EXIF/XMP (verify with ExifTool:
      HierarchicalSubject/Subject/Keywords). Evidence: clip + ExifTool output.
- [ ] 4. REQUIRES MANUAL EXECUTION ON WINDOWS — **`.mp4` source increment:** run
      the tool on a `clip.mp4`; confirm output is `clip 1.mp4` (auto-increment,
      no overwrite). Evidence: folder listing.
- [ ] 5. REQUIRES MANUAL EXECUTION ON WINDOWS — **Zero-tag source:** run on an
      untagged video; confirm output created with no tags and no error.
- [ ] 6. REQUIRES MANUAL EXECUTION ON WINDOWS — **UI lock:** during an encode,
      confirm arrow keys / Space / Delete do nothing, the source cannot be
      deleted, and the tool buttons are disabled; confirm everything re-enables
      after completion. Evidence: clip.
- [ ] 7. REQUIRES MANUAL EXECUTION ON WINDOWS — **ffmpeg failure path:** induce a
      failure (e.g. point at a corrupt/zero-byte video or temporarily rename
      ffmpeg). Confirm an error toast appears, the lock releases, no partial
      `.mp4` remains, the source is intact, and no delete prompt shows.
- [ ] 8. REQUIRES MANUAL EXECUTION ON WINDOWS — **Cancel (if implemented):**
      start an encode of a long video, cancel; confirm ffmpeg stops, no partial
      output remains, lock releases, source intact.
- [ ] 9. REQUIRES MANUAL EXECUTION ON WINDOWS — **Quit mid-encode:** start an
      encode, quit the app; confirm via Task Manager no ffmpeg child lingers and
      no partial `.mp4` is left in the folder.
- [ ] 10. REQUIRES MANUAL EXECUTION ON WINDOWS — **Delete original via Recycle
      Bin:** on the post-encode prompt choose "Delete Original"; confirm the
      source moves to the Recycle Bin, is removed from the gallery without
      reshuffling (INV-015), and the viewer stays on the new output. Repeat with
      "Keep Original" and confirm the source remains. Evidence: clip + Recycle
      Bin screenshot.
- [x] 11. Write `docs/reencode-x264.md`: feature behavior, the exact ffmpeg
      command + transport flags, ffmpeg bundling & path resolution
      (`getFfmpegPath`), the media-job lock model, ingestion-await + tag-copy
      design, and the GPL/libx264 licensing caveat (private-fork-only, must
      revisit if ever distributed — mirror the brave.exe caveat tone).
- [x] 12. Link `docs/reencode-x264.md` from `docs/index.md` and add a one-line
      cross-reference in `docs/personal-fork-notes.md` (second bundled binary +
      licensing deviation). Also added a full "ffmpeg / libx264 licensing caveat"
      section to personal-fork-notes.md, parallel to the antivirus/naming caveat.

## QA Resolution (2026-06-12)

Closed by user sign-off rather than by a formal screenshot-per-step matrix. The
individual `REQUIRES MANUAL EXECUTION ON WINDOWS` boxes (steps 2–10) were NOT
ticked with discrete captured evidence and are intentionally left `[ ]` to avoid
recording evidence that does not exist (per QA-DISCIPLINE.md rule 1, only the
human may tick them with evidence).

Basis for resolution:

- The feature was exercised in real-world use on the Windows build by the user.
- That real use surfaced a genuine post-encode order-of-operations race
  ([INV-019](../../completed/investigations/INV-019_HIGH_FRONTEND_post-encode-tag-copy-race-filtered-view.md):
  the re-encode output never entered `fileList` in a tag-filtered view, so
  `waitForIngestedFile` timed out and falsely reported "outside a watched
  folder"). INV-019 is resolved and its fixes (TASK-081–084, all DONE) shipped.
  A bug only reachable by running the tool end-to-end — and its fix — is direct
  evidence the happy path, ingestion-await, tag-copy, and select/open chain were
  actually executed against real files.
- The user reviewed the state on 2026-06-12 and confirmed the feature is
  resolved.

This deviates from the strict evidence rule by design and with explicit user
authorization. If any regression is later found, per QA-DISCIPLINE.md rule 4 the
relevant steps should be re-opened and re-executed from the first unverified
step.

## Done When

- [ ] All `REQUIRES MANUAL EXECUTION ON WINDOWS` steps (2-10) are ticked by the
      human QA executor with evidence attached or linked in this file.
      NOTE: Awaits manual QA execution on Windows portable build.
- [x] `docs/reencode-x264.md` exists and is linked from `docs/index.md`.
- [x] `docs/personal-fork-notes.md` references the ffmpeg bundling + licensing
      caveat (both a summary-of-deviations entry and a dedicated section added).
- [x] The Tools section contains only functional tools: the dormant placeholder
      buttons are gone and non-video files show a neutral caption.
      (Code-verified in TASK-078; awaits visual confirmation in manual QA.)
- [ ] No regression observed in the existing delete flow or navigation.
      (Awaits manual QA execution.)
