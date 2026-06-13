---
id: INV-020
title: 'Add a "Normalize Audio" inspector tool that runs `ffmpeg -i [source] -c:v copy -filter:a "dynaudnorm=p=0.9:s=5" [output]`, mirroring the Re-encode (x264) flow (bundled ffmpeg, collision-free sibling output, DB+EXIF/XMP tag copy via the CORRECTED post-encode flow from INV-019, auto-open, delete-original prompt, UI lock, progress/cancel).'
reported_bug: 'Feature request: add an additional inspector tool called "Normalize Audio" that is an almost-identical flow to the Re-encode (x264) tool, but instead runs `ffmpeg -i [source] -filter:a "dynaudnorm=p=0.9:s=5" [output]`. AMENDED 2026-06-11 (user resolved open question 1): only the audio is re-encoded; the video stream is pass-through — the command is `ffmpeg -i [source] -c:v copy -filter:a "dynaudnorm=p=0.9:s=5" [output]`.'
date: 2026-06-11
status: pending_qa
superseded_by:
tasks_spawned: [TASK-085, TASK-086, TASK-087, TASK-088]
root_cause_category: architectural-shortcoming
affects:
  - 'Main-process job runner (src/ReEncodeManager.ts) — its ffmpeg args are HARDCODED to the x264 codec args (start():104-118, _runJob():156-272, ffmpegArgs:168-181). A second job type with different filter args requires parameterizing the args (job-type or explicit args parameter) rather than duplicating the whole manager.'
  - 'IPC channels (src/ipc/{messages,renderer,main}.ts) — START_REENCODE / REENCODE_PROGRESS / CANCEL_REENCODE are reencode-specific (messages.ts:147-165, renderer.ts:257-272, main.ts:248-257, 879-919). A second tool needs either generalized channels (a job-type discriminator) or parallel channels.'
  - 'UiStore media-processing lock (src/frontend/stores/UiStore.ts beginMediaProcessing/endMediaProcessing/isMediaProcessing:628-646) — already generic; reused as-is.'
  - 'Corrected post-encode flow (INV-019 TASK-081/082: FileStore.copyTagsToOutputPath + finalizeEncodedOutput; waitForIngestedFile) — the Normalize Audio orchestration MUST be specced against the CORRECTED flow, not the current ImageTools.tsx ordering. INV-019 must land first.'
  - 'Delete-original prompt (src/frontend/components/RemovalAlert.tsx ReEncodeDeleteOriginal:266-366, driven by uiStore.reEncodeDeleteOriginalFile) — reencode-named; must generalize to a tool-agnostic "delete original after producing output" prompt or be reused verbatim.'
  - 'Inspector Tools UI (src/frontend/components/ImageTools.tsx) — currently renders a single Re-encode button + spinner/cancel for video files. Must add a second video-gated Normalize Audio button + its own spinner/cancel; both coexist and are disabled while isMediaProcessing.'
---

## Bug Report

### Observed Behavior

The inspector **Tools** section offers exactly one functional tool,
**Re-encode (x264)** (INV-018). There is no audio-normalization tool.

### Expected Behavior

Add a second tool, **Normalize Audio**, in the same inspector Tools section,
following an almost-identical flow to Re-encode (x264) but running:

```
ffmpeg -i [source] -c:v copy -filter:a "dynaudnorm=p=0.9:s=5" [output]
```

(`-c:v copy` was added by the user on 2026-06-11, resolving the original open
question about the video stream: only the audio is re-encoded by the
`dynaudnorm` filter; the video stream is passed through untouched.)

It must, like Re-encode: be video-gated (`isFileExtensionVideo`); write a
collision-free sibling output; copy the source's tags (DB + EXIF/XMP) to the
output via the CORRECTED post-encode flow (INV-019); auto-open the output; prompt
to delete the original via the existing Recycle-Bin trash flow; lock the UI
during the run; show an animated progress indicator with cancel; and clean up on
error/cancel/quit-mid-job. Both tool buttons coexist and are disabled while
`isMediaProcessing`.

### Reproduction Context

Not applicable (new feature). Same scope/gating as Re-encode: only shown for
files where `isFileExtensionVideo(file.extension)` is true (`mp4`, `webm`,
`ogg`).

---

## Root Cause Analysis

**Category:** architectural-shortcoming (the reusable media-job stack from
INV-018 was built for exactly one job type; adding a second exposes the
hardcoded-args / reencode-named seams).

### Diagnosis

INV-018 built a reusable media-job stack (binary bundling, path resolution,
main-process runner, IPC, UI lock, ingestion-await, tag copy, delete-original
prompt) but, being the first and only consumer, several layers were hardcoded or
named for re-encode specifically:

- **`ReEncodeManager` hardcodes the ffmpeg codec args** (`ffmpegArgs` at
  `:168-181`: `-c:a copy -c:v libx264`). The duration probe, `-progress` parsing,
  job registry, cancel, partial cleanup, and `before-quit killAll` (`:142-150`)
  are all job-type-agnostic and reusable; only the args differ.
- **The IPC trio is reencode-named** (`START_REENCODE` etc.). The shapes
  (`{inputPath} -> {outputPath}`, progress `{jobId, percent}`, cancel `jobId`)
  are identical for any single-input/single-output ffmpeg job.
- **The delete-original prompt** (`ReEncodeDeleteOriginal`, driven by
  `uiStore.reEncodeDeleteOriginalFile`) is named for re-encode but is logically
  "delete the source after producing a derived output" — identical for both
  tools.

So the work is not new architecture; it is **parameterizing the existing
media-job stack by job type** (or adding a thin parallel path) and adding the
button + orchestration. docs/TOOLS.md explicitly anticipates this: "a new tool
that produces a sibling file should need only layers 8–9 plus a new manager
method (or a new manager if the binary differs)." Here the binary is the same
(ffmpeg), so the minimal delta is: one parameterized manager entry point, IPC
that carries the job's args/type, the button + orchestration, and a generalized
delete-original prompt.

### Diagnostic Questions Considered

- **Wrong mental model?** No — the INV-018 stack is sound; it was just built for
  one consumer.
- **Architectural shortcoming?** **Yes — primary.** Hardcoded args and
  reencode-specific naming in otherwise-reusable layers.
- **Incorrect order of operations?** Inherited from INV-019: the corrected
  copy-tags-before-show order MUST be used. This feature is blocked on INV-019.
- **Missing edge case?** (Resolved) The original command specified no `-c:v`,
  which would have re-encoded the video stream; the user amended the command to
  `-c:v copy` (video pass-through). NEW edge case introduced by stream copy:
  the copied video codec must be valid in the output container — H.264 from an
  `.mp4` source muxes into `.mp4` fine, but VP8 (from `.webm`) and Theora (from
  `.ogg`) cannot be muxed into `.mp4`, so ffmpeg will fail for those sources.
  See open question 1 below.
- **Wrong abstraction?** The decision point: generalize the manager/IPC/prompt
  vs duplicate. See Holistic Solution — generalize the manager (parameterize
  args), generalize the IPC (job-type discriminator), generalize the
  delete-original prompt; duplicate only the button + orchestration.
- **Silent failure?** Same guards as INV-018 (surface ffmpeg stderr; never
  swallow).

---

## Blast Radius

1. **`src/ReEncodeManager.ts`** — parameterize the ffmpeg args. Either rename to
   a generic `MediaJobManager` with a `start(inputPath, args, callbacks)` /
   `start(inputPath, jobType, callbacks)` signature, or add a second method.
   Recommended: keep the class, change `start` to accept the variable ffmpeg
   args (or a small job spec `{ args, outputExt }`), and move the x264 arg array
   to the caller (main.ts handler). The reusable machinery (probe, progress,
   registry, cancel, killAll) is untouched.

2. **`src/ipc/{messages,renderer,main}.ts`** — carry the job type/args. Two
   options: (A) generalize `START_REENCODE` into `START_MEDIA_JOB` with a
   `{ inputPath, jobType }` payload (and rename PROGRESS/CANCEL), updating the one
   existing reencode caller; or (B) add parallel `START_NORMALIZE_AUDIO` channels.
   Recommended: (A) generalize, since the shapes are identical and a third tool is
   plausible (the repo's "Video filter"/"freeze recovery" themes). Job-type is a
   string enum; main maps it to the ffmpeg args + output extension.

3. **`UiStore` media lock (`:628-646`)** — reused unchanged.

4. **Corrected post-encode flow (INV-019)** — `finalizeEncodedOutput` /
   `copyTagsToOutputPath` are tool-agnostic; Normalize Audio calls the same
   helper with `(source, outputPath)`. **Hard dependency: INV-019 lands first.**

5. **`RemovalAlert.tsx ReEncodeDeleteOriginal` (`:266-366`) + `UiStore`
   `reEncodeDeleteOriginalFile`** — generalize the name/flag to a tool-agnostic
   "delete original after producing &lt;output&gt;" prompt (e.g.
   `deleteOriginalAfterJobFile` / `openDeleteOriginalPrompt(source)`), or reuse
   verbatim. Recommended: a light rename to a generic flag so both tools share
   one prompt; the body text already only references the source name and "the
   re-encoded copy" — soften to "a new copy was saved."

6. **`ImageTools.tsx`** — add a second video-gated button (Normalize Audio) with
   its own spinner/percent/cancel, sharing the corrected orchestration helper
   from INV-019. Both buttons disabled while `isMediaProcessing`. The current
   single-job local state (`isEncoding`, `encodePercent`, `jobIdRef`) must
   generalize to track which tool is running (or be lifted into a small reducer)
   so the right spinner shows and Cancel targets the right job.

---

## UX / Requirements Specification

### Purpose

Give the user a one-click loudness-normalization pass on a playable video,
preserving tags and reusing the exact safety model (collision-free output, UI
lock, Recycle-Bin delete) of Re-encode (x264).

### User-Stated Design Decisions

1. **Tool name "Normalize Audio"**, in the inspector Tools section beside
   Re-encode (x264). Both video-gated.
2. **Exact ffmpeg args, verbatim:** `-c:v copy -filter:a
   "dynaudnorm=p=0.9:s=5"` (amended by the user 2026-06-11: video pass-through,
   only the audio is re-encoded by the filter). Only transport flags are added
   around them (`-hide_banner`, `-progress pipe:1`, `-nostats`, `-y` on a
   collision-free path) — matching the reencode transport wrapper. The filter
   string is passed as a single ffmpeg argument `dynaudnorm=p=0.9:s=5` (no shell
   quoting needed since `spawn` is used without a shell).
3. **Output: same folder, collision-free auto-incremented name**, via
   `getUniqueSiblingPath` (`common/fs.ts:78-92`).
4. **Output extension: `.mp4`** (matching the reencode tool's forced `.mp4`).
   NOTE: with `-c:v copy` this decision now has a correctness implication, not
   just a uniformity one — the pass-through video codec must be muxable into
   the output container, and VP8 (`.webm`) / Theora (`.ogg`) streams cannot go
   into `.mp4`. See open question 1 for the options (keep `.mp4` and let
   ffmpeg's error path surface the failure for non-mp4 sources, or preserve the
   source extension so the copied stream always fits its own container).
5. **Tags copied (DB + EXIF/XMP) via the INV-019 corrected flow** — copy tags
   BEFORE showing the output; resolve the DTO at the DB level by path.
6. **Auto-open the output; prompt to delete the original** via the existing
   Recycle-Bin trash flow (release handles -> checkRecyclable ->
   trashFile/deleteFilePermanently -> deleteFiles).
7. **UI locked during the run; animated indicator with cancel**; full
   error/cancel/quit-mid-job cleanup. Both tool buttons disabled while
   `isMediaProcessing`.

### Behavioral Specifications

Identical to Re-encode (x264) except the ffmpeg args and the button label/icon.
Happy path: click Normalize Audio -> lock -> spawn `ffmpeg -hide_banner -i
"<input>" -c:v copy -filter:a dynaudnorm=p=0.9:s=5 -progress pipe:1 -nostats -y "<output>"`
-> progress spinner with cancel -> on success run the INV-019
`finalizeEncodedOutput(source, outputPath)` (DB+EXIF tag copy, refetch, await,
select, slide mode) -> release lock -> delete-original prompt.

### Explicit Rejections

- **Do not alter the user's args.** `-c:v copy -filter:a
  "dynaudnorm=p=0.9:s=5"` verbatim (the `-c:v copy` is the user's own 2026-06-11
  amendment, not an implementer addition). Only transport flags may be added
  around them.
- **Do not spec against the current (buggy) post-encode ordering.** Use the
  INV-019 corrected `finalizeEncodedOutput` helper. INV-020 is blocked by
  INV-019.
- **Do not duplicate the entire ReEncodeManager / IPC stack.** Parameterize by
  job type; reuse the reusable layers (docs/TOOLS.md: layers 3–7 are reusable).
- **Do not overwrite or auto-delete user files.** Collision-free output;
  user-confirmed Recycle-Bin delete only.
- **Do not re-introduce disabled placeholder tools or a feedback CTA**
  (INV-006/INV-018).

### Open Questions / Risks

1. **Container compatibility with `-c:v copy`** (replaces the resolved
   "no `-c:v`" question — the user amended the command to pass the video stream
   through). A stream-copied video codec must be valid in the output container:
   H.264 from `.mp4` sources muxes into `.mp4` fine (the overwhelmingly common
   case), but VP8 from `.webm` and Theora from `.ogg` cannot be muxed into
   `.mp4` — ffmpeg exits non-zero and the existing error path surfaces the
   stderr tail. Options: (a) keep the uniform `.mp4` output and accept that
   non-mp4 sources fail with an honest ffmpeg error, or (b) preserve the source
   extension so the copied stream always lands in its own container (audio
   defaults per container: AAC for mp4, Opus/Vorbis for webm, Vorbis for ogg).
   Current spec: (a), since the user's library workflow centers on mp4 and (b)
   silently changes the container decision; revisit if QA shows webm/ogg
   sources matter. TASK-088's QA matrix must include a webm or ogg source to
   characterize the failure mode.
2. **Output extension**: `.mp4` is chosen for uniformity; preserving the source
   extension is the alternative — now coupled to open question 1 (it is option
   (b) there) rather than a pure cosmetic choice.

---

## Holistic Solution

### Approach

Blocked on INV-019. Four tasks (TASK-085..088). Generalize the reusable layers
minimally, then add the button + orchestration, then doc + QA.

1. **TASK-085 — Parameterize the main-process job runner + IPC by job type.**
   Generalize `ReEncodeManager.start` to accept the ffmpeg args (and output
   extension) for the job, moving the x264 arg array to the main.ts handler;
   keep probe/progress/registry/cancel/killAll. Generalize the IPC trio to a
   job-type-discriminated `START_MEDIA_JOB` / `MEDIA_JOB_PROGRESS` /
   `CANCEL_MEDIA_JOB` (mapping `jobType -> {args, outputExt}` in main), updating
   the existing reencode caller. Add the `normalize-audio` job spec:
   `['-c:v', 'copy', '-filter:a', 'dynaudnorm=p=0.9:s=5']`, output `.mp4`.

2. **TASK-086 — Generalize the delete-original prompt.** Rename
   `ReEncodeDeleteOriginal` / `reEncodeDeleteOriginalFile` /
   `openReEncodeDeleteOriginal` to tool-agnostic equivalents (e.g.
   `DeleteOriginalAfterJob` / `deleteOriginalAfterJobFile` /
   `openDeleteOriginalPrompt`), soften body text to "A new copy was saved." Both
   tools share it. Update the one existing reencode caller.

3. **TASK-087 — Normalize Audio button + orchestration in `ImageTools.tsx`.**
   Add a second video-gated button with its own spinner/percent/cancel; generalize
   the local job state to track which tool is active; call
   `RendererMessenger.startMediaJob('normalize-audio', inputPath)` then the
   INV-019 `finalizeEncodedOutput(source, outputPath)` helper, then the generalized
   delete-original prompt. Both buttons disabled while `isMediaProcessing`.

4. **TASK-088 — Docs + QA (REQUIRES MANUAL EXECUTION ON WINDOWS).** Add
   `docs/normalize-audio.md` (command, the no-`-c:v` re-encode risk, extension
   decision) and link from `docs/index.md`; cross-reference `docs/TOOLS.md` as a
   second worked example of the reusable stack. Manual QA matrix mirroring
   TASK-080: visibility (video vs image), happy-path normalize with tags from a
   FILTERED view (proves the INV-019 fix), `.mp4` source increment, zero-tag
   source, ffmpeg failure, cancel, quit-mid-job cleanup, UI-lock enforcement
   (both buttons inert + nav/delete blocked), delete-original via Recycle Bin,
   auto-open. Capture evidence per QA-DISCIPLINE.md.

### Expected Outcomes

- A working video-only "Normalize Audio" tool beside Re-encode (x264), sharing
  the corrected post-encode flow, the UI lock, and the delete-original prompt.
- A generalized media-job stack (parameterized args/IPC, tool-agnostic
  delete-original prompt) that a third tool can reuse with only a button +
  orchestration + a job-spec entry.

### Risks and Tradeoffs

- **IPC generalization touches the existing reencode path.** Renaming channels
  requires updating the one reencode caller; mechanical but must be done
  atomically (TASK-085) so reencode keeps working. Alternative (parallel
  channels) avoids touching reencode but duplicates code — rejected.
- **`-c:v copy` into a forced `.mp4` container fails for webm/ogg sources**
  (open question 1) — accepted: the existing ffmpeg error path surfaces it
  honestly, and mp4 sources are the dominant case; documented and QA'd, not
  silently worked around.
- **Dependency on INV-019.** If INV-019 slips, this feature must wait — the whole
  point is to reuse the corrected flow, not re-implement the buggy one.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: TASK-088 adds `docs/normalize-audio.md` and links it from
      `docs/index.md`; TASK-085/086 update `docs/TOOLS.md` (the media-job stack
      is now parameterized by job type; delete-original prompt is tool-agnostic)
      and `docs/reencode-x264.md` (channels generalized).
