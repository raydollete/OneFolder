---
id: TASK-088
title: 'Document the Normalize Audio tool and QA it end-to-end (REQUIRES MANUAL EXECUTION ON WINDOWS), including from a filtered view to prove the corrected post-encode flow'
investigation: INV-020
status: in-progress
priority: medium
blocked_by: [TASK-087]
date_created: 2026-06-11
date_completed:
files:
  - 'docs/normalize-audio.md'
  - 'docs/index.md'
  - 'docs/TOOLS.md'
---

## What

Add `docs/normalize-audio.md` describing the Normalize Audio tool (command, the
no-`-c:v` video-re-encode risk, the `.mp4` extension decision, the reused
media-job stack), link it from `docs/index.md`, and cite it in `docs/TOOLS.md`
as a second worked example of the reusable media-job stack. Then manually QA the
full matrix in the running portable build, capturing evidence per
`docs/TODO/QA-DISCIPLINE.md`.

## Why

Normalize Audio is the first consumer of the generalized media-job stack and the
corrected INV-019 post-encode flow; it needs its own feature doc and a manual QA
pass (compile + unit tests do not verify cross-process tool behavior — docs/TOOLS.md
rule 5).

See [INV-020](../investigations/INV-020_MEDIUM_FRONTEND_normalize-audio-video-tool.md).

## Implementation Steps

- [x] 1. Write `docs/normalize-audio.md`: user-facing behavior; the exact command
      `ffmpeg -hide_banner -i "<input>" -c:v copy -filter:a dynaudnorm=p=0.9:s=5
      -progress pipe:1 -nostats -y "<output>"` (the `-c:v copy` is the user's
      2026-06-11 amendment — video pass-through, only audio re-encoded); the
      KNOWN LIMITATION that stream-copying into the forced `.mp4` container
      fails for VP8 (`.webm`) / Theora (`.ogg`) sources (ffmpeg exits non-zero;
      the error path surfaces the stderr tail — see INV-020 open question 1);
      the `.mp4` output-extension decision and the reversible alternative
      (preserve source extension, which would make the copied stream always fit
      its own container); the reused stack (parameterized ReEncodeManager/IPC,
      shared finalize helper and delete-original prompt). Link Related:
      TOOLS.md, reencode-x264.md, INV-020, TASK-085..088.
- [x] 2. Link `docs/normalize-audio.md` from `docs/index.md`.
- [x] 3. In `docs/TOOLS.md`, add Normalize Audio as a second worked example
      confirming "a new sibling-file tool needs only the button/orchestration
      layer plus a parameterized manager entry point."

### QA (REQUIRES MANUAL EXECUTION ON WINDOWS — capture evidence per docs/TODO/QA-DISCIPLINE.md)

> NOTE: Steps 4–12 require running the Electron app interactively on Windows.
> They have NOT been executed. The task remains IN-PROGRESS pending manual QA.

- [ ] 4. **Visibility:** Normalize Audio button shown for video files, absent for
      images; both tool buttons coexist.
- [ ] 5. **Happy path from a TAG-FILTERED view** (proves INV-019 fix): tagged
      video, filtered to its tag, run Normalize Audio. VERIFY: output produced
      beside source, tags copied (DB + EXIF/XMP), output auto-opens, no "outside a
      watched folder" toast, delete-original prompt appears. Evidence:
      screenshot + audible/measured loudness change.
- [ ] 6. **`.mp4` source increment** (source already `.mp4`) -> `name 1.mp4`.
- [ ] 7. **Zero-tag source:** no EXIF write; output opens.
- [ ] 8. **ffmpeg failure / cancel / quit-mid-job:** lock releases; partial
      output removed; honest error/cancel toast; quit kills the child.
- [ ] 9. **UI lock:** during a Normalize Audio run, nav/edit/delete and BOTH tool
      buttons are inert; the spinner label reads "Normalizing audio…".
- [ ] 10. **Delete-original via Recycle Bin** works and uses the shared prompt.
- [ ] 11. **No `net::ERR_REQUEST_RANGE_NOT_SATISFIABLE`** (relies on TASK-084
      `awaitWriteFinish`); output row size/dimensions correct.
- [ ] 12. **Non-mp4 source (`webm` or `ogg`):** `-c:v copy` into the forced
      `.mp4` container is expected to FAIL for VP8/Theora streams — verify the
      failure is graceful (honest error toast with stderr tail, partial output
      removed, lock released, source untouched) and characterize the actual
      ffmpeg behavior per codec (INV-020 open question 1; revisit the
      output-extension decision if this case matters in practice).

## Done When

- [x] `docs/normalize-audio.md` exists, is linked from `docs/index.md`, and is
      cited in `docs/TOOLS.md`.
- [ ] The full manual QA matrix is executed on Windows with evidence
      attached/linked here; the tag-filtered-view happy path passes.
- [ ] The `-c:v copy` container-compatibility limitation (webm/ogg sources vs
      forced `.mp4` output) is documented and its QA outcome recorded.
