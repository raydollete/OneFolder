---
id: INV-022
title: 'Add Mark Start / Mark End / Create Clip video tools to the inspector that capture the open video''s playback time into HH:MM:SS fields and run `ffmpeg -ss [start] -to [end] -i [src] -c copy [dst]` (stream copy, no re-encode), then replicate tags and prompt to delete the original'
reported_bug: 'Feature request: In the inspector "Tools" section (the same place the existing video tools live — Re-encode (x264) and Normalize Audio), add a "Mark Start" button with an attached HH:MM:SS field, a "Mark End" button with an attached HH:MM:SS field, and a "Create Clip" button. Clicking Mark Start / Mark End fills its field with the CURRENT PLAYBACK TIME of the open video (00:00:00 if stopped); fields are also manually editable. Create Clip is enabled only when both fields hold valid HH:MM:SS values; clicking it spawns ffmpeg `-ss [start] -to [end] -i [source] -c copy [dest]` (stream copy, no re-encode). On completion, mirror the existing tools: auto-open/import the new clip with all source tags replicated, then prompt whether to delete the original.'
date: 2026-06-12
status: tasks-created
superseded_by:
tasks_spawned: [TASK-093, TASK-094, TASK-095]
root_cause_category: architectural-shortcoming
affects:
  - 'Media-job runner contract (src/ReEncodeManager.ts:110-186) — the runner hard-codes the ffmpeg argv as `[-hide_banner, -i, inputPath, ...jobArgs, -progress, pipe:1, -nostats, -y, outputPath]`. All existing jobs (reencode-x264, normalize-audio) only ever need args AFTER `-i`. A clip job needs `-ss [start] -to [end]` BEFORE `-i` (input seeking is required for correct stream-copy trims) and `-c copy` after. The fixed argv template cannot express pre-input args, so the runner contract must be widened (add a `preInputArgs` slot) without changing the existing call sites.'
  - 'Media-job spec map (src/main.ts:35-47 MEDIA_JOB_SPECS) — specs are static `{ args, outputExt }` per job type. A clip job is parameterized at call time by start/end times entered by the user, so the static spec cannot carry them; the START_MEDIA_JOB payload must thread per-invocation args.'
  - 'IPC payload (src/ipc/messages.ts:152-158 MediaJobType / StartMediaJobMessage) — `MediaJobType` must gain `create-clip`; the start payload must carry the clip start/end times (or pre-built pre-input args) from renderer to main.'
  - 'Inspector Tools UI (src/frontend/components/ImageTools.tsx) — currently renders only the two video tool buttons (Re-encode, Normalize Audio) plus a non-video caption; it has no text inputs, no per-field validation state, and no enabled-gating beyond `uiStore.isMediaProcessing`. Mark Start / Mark End / Create Clip add two editable HH:MM:SS fields, button-to-field capture, validation, and a gated Create button.'
  - 'Current-playback-time access from the inspector (src/frontend/containers/ContentView/SlideMode/index.tsx:530-540 — the mounted slide `<video>`; ZoomPan.tsx:165 reads it via `querySelector(''video'')`) — ImageTools lives in the inspector subtree and has no ref to the slide `<video>`. Mark Start/End must read `currentTime` off the live player. The proven mechanism is a `document.querySelector(''video'')` DOM read (the slide video is the ONLY attached `<video>`; preload videos are orphan, never mounted — SlideMode/index.tsx:157-177).'
  - 'Time format helpers (common/fmt.ts) — there is no HH:MM:SS duration parse/format helper (formatDateTime etc. are wall-clock date helpers). A new parse/format/validate pair is needed for the fields and to build ffmpeg `-ss`/`-to` values.'
  - 'Post-job finalization + delete prompt (src/frontend/stores/FileStore.ts:1422 finalizeEncodedOutput, src/frontend/stores/UiStore.ts:621 openDeleteOriginalPrompt, RemovalAlert.tsx DeleteOriginalAfterJob) — already generic and reused by Re-encode and Normalize Audio; Create Clip reuses them unchanged (no blast radius, just wiring).'
---

## Bug Report

### Observed Behavior

The inspector "Tools" section (`src/frontend/components/ImageTools.tsx`) currently
offers exactly two functional, video-only tools — **"Re-encode (x264)"** and
**"Normalize Audio"** — each a single button that fires a parameterless
main-process ffmpeg job through the `START_MEDIA_JOB` IPC channel. There is no way
to trim/cut a clip out of the open video, and there is no UI primitive in the
Tools section for capturing or editing time values, nor any tool whose behavior
depends on the live playback position of the open video.

### Expected Behavior

This is a feature request, not a defect. When the currently-viewed file is a video,
the inspector "Tools" section must additionally offer:

1. **"Mark Start"** — a button with an attached editable field holding a time in
   `HH:MM:SS` format. Clicking the button fills the field with the **current
   playback time of the open video**, formatted `HH:MM:SS`. If the video is fully
   stopped/unavailable, use `00:00:00`. The field is also manually editable.
2. **"Mark End"** — an identical button + attached `HH:MM:SS` field, same capture
   behavior.
3. **"Create Clip"** — a button placed below the two fields, **enabled only once
   both fields hold valid `HH:MM:SS` values**. Clicking it spawns an ffmpeg
   subprocess running, in effect:
   `ffmpeg -ss [start time] -to [end time] -i [source file] -c copy [dest file]`
   (stream copy — no re-encode).

On completion, mirror the existing video tools exactly:
- Auto-open/import the newly created clip once ffmpeg finishes, **with all source
  tags replicated** to the new clip.
- Prompt the user whether to **delete the original** source file (via the existing
  Recycle-Bin flow).

### Reproduction Context

Not applicable (new feature). Scope: the tools are offered only when
`isFileExtensionVideo(file.extension)` is true (`common/fs.ts:46-48` — `webm`,
`mp4`, `ogg`), exactly like the existing two tools. Output container is `.mp4`
(the existing tools' output extension; stream-copying playable `webm`/`ogg`/`mp4`
video+audio into MP4 is the safe common target — see Risks for the codec-vs-MP4
caveat).

---

## Root Cause Analysis

**Category:** architectural-shortcoming

### Diagnosis

The feature is *additive* and most of the scaffolding it needs already exists,
built out by INV-018 (Re-encode) and generalized by INV-020 (Normalize Audio):
a main-process ffmpeg **media-job runner** with progress/cancel/before-quit
cleanup (`src/ReEncodeManager.ts`), type-safe `START_MEDIA_JOB` /
`MEDIA_JOB_PROGRESS` / `CANCEL_MEDIA_JOB` IPC (`src/ipc/*`), a parameterized
job-spec map (`src/main.ts:35-47`), a generic post-job finalize that copies tags +
selects + opens the output (`FileStore.finalizeEncodedOutput`), a generic
delete-original prompt (`UiStore.openDeleteOriginalPrompt` ->
`RemovalAlert.DeleteOriginalAfterJob`), and a UI lock (`UiStore.mediaProcessing`).
A third tool should be ~90% wiring on top of this.

There are exactly **two** real architectural gaps, plus one renderer-only
capability the feature introduces:

1. **The runner's argv template cannot express pre-`-i` args.**
   `ReEncodeManager._runJob` (`src/ReEncodeManager.ts:176-186`) builds the ffmpeg
   command as a fixed template:
   `['-hide_banner', '-i', inputPath, ...jobArgs, '-progress', 'pipe:1', '-nostats', '-y', outputPath]`.
   Every existing job only contributes args that belong AFTER the input
   (`-c:a copy -c:v libx264`; `-c:v copy -filter:a dynaudnorm=…`). A trim job is
   different: for a fast, accurate stream-copy cut, `-ss [start]` and `-to [end]`
   must come BEFORE `-i` (input seeking). Putting `-ss` after `-i` would force a
   slow decode-and-re-encode-style seek and is incompatible with the
   "no re-encode / `-c copy`" requirement. The current template has no slot for
   pre-input args. This is the core architectural change: widen the runner's
   `start()` / `_runJob()` contract to accept an optional `preInputArgs: string[]`
   placed before `-i`, defaulting to `[]` so the two existing call sites are
   untouched.

2. **Job parameters are static; a clip is parameterized at click time.**
   `MEDIA_JOB_SPECS` (`src/main.ts:35-47`) maps each `MediaJobType` to a constant
   `{ args, outputExt }`. The clip's `-ss`/`-to` values come from user-entered
   fields and differ per click, so they cannot live in a static spec. The
   `START_MEDIA_JOB` payload (`StartMediaJobMessage`, `src/ipc/messages.ts:154-158`)
   currently carries only `{ inputPath, jobType }`. It must additionally carry the
   clip's start/end (as `HH:MM:SS` strings — the canonical ffmpeg time format —
   validated in main before spawn), which the main handler turns into
   `preInputArgs = ['-ss', start, '-to', end]` for the `create-clip` job. The spec
   map still supplies `outputExt: 'mp4'` and the post-`-i` `args: ['-c', 'copy']`.

3. **The inspector cannot currently read the live playback position.**
   The mounted slide `<video>` lives in
   `SlideMode/index.tsx:530-540` and is reached elsewhere via
   `querySelector('video')` (`ZoomPan.tsx:165`). `ImageTools` is in the inspector
   subtree and has no React ref to it. Because the slide `<video>` is the ONLY
   `<video>` ever attached to the document (preload videos are orphan
   `document.createElement('video')` elements that are registered for handle
   release but never mounted — `SlideMode/index.tsx:157-177`), a
   `document.querySelector('video')` read of `currentTime` is unambiguous and is
   the same pattern the codebase already trusts. This is a renderer-only read, not
   an architectural change; it is the verified mechanism the feature depends on.

The unifying root cause is the same shape as INV-018/INV-020: the media-job
capability was built for *post-input, statically-specified* ffmpeg jobs, and a
*pre-input, dynamically-parameterized* trim job exposes the one dimension the
contract didn't generalize. The fix preserves the existing design and widens it by
one optional slot rather than special-casing the clip job.

### Diagnostic Questions Considered

- **Wrong mental model?** No — the playback-time read was verified against a real,
  in-use pattern (`ZoomPan.tsx:165`) and the orphan-preload detail
  (`SlideMode/index.tsx:157-177`) confirms `querySelector('video')` is unambiguous.
- **Architectural shortcoming?** **Yes — primary.** The runner argv template has
  no pre-`-i` slot, and the job-spec/IPC payload has no per-invocation parameters.
  Both are one-line-shaped widenings, but they are genuine contract changes.
- **Incorrect order of operations?** Relevant to ffmpeg correctness: `-ss`/`-to`
  MUST precede `-i` for stream-copy seeking. Getting this wrong silently degrades
  to a slow/inaccurate cut. The runner change makes the correct order expressible.
- **Missing edge case?** Several: start ≥ end (invalid range), end past video
  duration, malformed field text, empty field, fields not yet touched, source
  with zero tags, output-path collision (handled by `getUniqueSiblingPath`),
  ffmpeg failure, cancel, quit-mid-job — all must be handled.
- **Wrong abstraction?** The temptation is a bespoke "clip" IPC channel separate
  from the media-job machinery. Rejected: reuse `START_MEDIA_JOB` + the runner +
  `finalizeEncodedOutput` + the delete prompt; only widen the existing contract.
- **Silent failure?** Risk if validation lives only in the renderer: a bad time
  string could reach ffmpeg and produce a confusing stderr. Mitigation: validate
  `HH:MM:SS` in the renderer (gates the button) AND re-validate in main before
  spawn (defense in depth), reusing the same parse helper.

---

## Blast Radius

Because this is additive, the "blast radius" is the set of subsystems the feature
must touch and the existing behaviors it must not break.

1. **Media-job runner (`src/ReEncodeManager.ts:110-186`).** Widen `start()` and
   `_runJob()` to accept an optional `preInputArgs: string[]` (default `[]`)
   inserted before `-i` in the argv. The two existing callers pass nothing and are
   unaffected. Progress parsing is unchanged (ffprobe still reads the SOURCE
   duration; clip percent is computed against full source duration, so it will
   appear to finish "early" — acceptable, see Risks — or duration can be the clip
   length; choose source-duration to avoid extra probing and document it).
   Cancel/before-quit/partial-cleanup all already cover any job. The
   `re-encode-manager.test.ts` suite must keep passing and gain a `preInputArgs`
   case.

2. **Job-spec map + START_MEDIA_JOB handler (`src/main.ts:35-47`, `:898-934`).**
   Add a `create-clip` entry: `{ args: ['-c', 'copy'], outputExt: 'mp4' }`. In the
   `onStartMediaJob` handler, when `jobType === 'create-clip'`, read the clip
   start/end from the (widened) payload, **validate the HH:MM:SS strings and that
   start < end**, and pass `preInputArgs = ['-ss', start, '-to', end]` to
   `reEncodeManager.start(...)`. Reject with a clear error on invalid input.

3. **IPC payload + types (`src/ipc/messages.ts:152-158`, `src/ipc/renderer.ts:259`,
   `src/ipc/main.ts:249-252`).** Add `'create-clip'` to `MediaJobType`. Extend
   `StartMediaJobMessage` with optional clip params (e.g.
   `clip?: { start: string; end: string }`). Update `RendererMessenger.startMediaJob`
   to accept and forward the optional clip params (keep the existing 2-arg
   signature working for the other tools, or add an options object — pick the
   minimal-diff form). No change to `MEDIA_JOB_PROGRESS` / `CANCEL_MEDIA_JOB`.

4. **Time helper (`common/fmt.ts`).** Add `parseHmsToSeconds(s): number | null`
   (null when malformed) and `formatSecondsToHms(sec): string` (zero-padded
   `HH:MM:SS`, clamps negatives to `00:00:00`). Used by the fields (capture +
   validate) and reusable by main-side validation. No existing helper does this.

5. **Inspector Tools UI (`src/frontend/components/ImageTools.tsx`).** Add, inside
   the existing `isVideo` block (and only when no job is active), the Mark Start
   button + field, Mark End button + field, and the Create Clip button. Local
   React state holds the two field strings; a derived `bothValid` (via
   `parseHmsToSeconds` on both, with start < end) gates Create Clip's `disabled`.
   Mark Start/End read `document.querySelector('video')?.currentTime ?? 0` and
   `formatSecondsToHms` it into the field. Create Clip calls the existing
   `runMediaJob`-style orchestration (begin lock -> startMediaJob('create-clip',
   path, {start,end}) -> `fileStore.finalizeEncodedOutput` ->
   `uiStore.openDeleteOriginalPrompt` -> finally endMediaProcessing). All buttons
   `disabled` while `uiStore.isMediaProcessing`. The non-video caption path is
   unchanged.

6. **Current-playback-time read (`SlideMode/index.tsx`, `ZoomPan.tsx:165` —
   reference only).** No change; the inspector reads the live `<video>` via
   `document.querySelector('video')`. Confirmed unambiguous (single attached
   `<video>`; preloads are orphan).

7. **Post-job finalize + delete prompt (`FileStore.finalizeEncodedOutput:1422`,
   `UiStore.openDeleteOriginalPrompt:621`, `RemovalAlert.DeleteOriginalAfterJob`).**
   Reused verbatim — these are already generic across job types (INV-019/INV-020).
   No change beyond being called by the new orchestration.

8. **Styling (`resources/style/inspector.scss`).** Minor: layout for the
   button+field rows and the Create Clip button. Reuse the existing `.tools` flex
   column and the `.reencode-progress` spinner block already present for in-job UI.

9. **Docs (`docs/TOOLS.md`, `docs/index.md`).** Document the new tools alongside
   Re-encode and Normalize Audio, including the `-ss/-to` pre-input ordering, the
   stream-copy (`-c copy`) guarantee, validation rules, and the source-duration
   progress caveat.

---

## UX / Requirements Specification

### Purpose

Give the single user of this fork a one-click way to trim a sub-clip out of the
video they are watching — using the live playback position as the in/out points —
without re-encoding (instant, lossless stream copy), while preserving their
tagging work and reusing the established auto-open + delete-original flow.

### User-Stated Design Decisions

1. **Tools live in the inspector "Tools" section** alongside Re-encode (x264) and
   Normalize Audio. Rationale: that is where per-file video tools already live.
2. **"Mark Start" button + attached `HH:MM:SS` field; "Mark End" button + attached
   `HH:MM:SS` field.** Rationale: a button to capture, a field to show/edit.
3. **Clicking Mark Start / Mark End fills the field with the current playback time
   of the open video, formatted `HH:MM:SS`; `00:00:00` if the video is fully
   stopped/unavailable.** Rationale: capture the in/out points from where the user
   is watching.
4. **Both fields are manually editable.** Rationale: fine-tune the captured times.
5. **"Create Clip" is enabled only once both fields hold valid `HH:MM:SS` values.**
   Rationale: prevent running ffmpeg with malformed/empty times.
6. **Create Clip runs `ffmpeg -ss [start] -to [end] -i [source] -c copy [dest]`
   (stream copy, no re-encode).** Rationale: instant, lossless trim. (Implementation
   note: the runner appends its standard transport flags `-hide_banner -progress
   pipe:1 -nostats -y` around these; `-ss`/`-to` are placed BEFORE `-i` and
   `-c copy` after, exactly as stated.)
7. **On completion, auto-open/import the new clip with all source tags replicated.**
   Rationale: the clip inherits the asset's tagging; reuses `finalizeEncodedOutput`.
8. **Then prompt whether to delete the original.** Rationale: trimming often
   supersedes the source; user decides per-file; reuses the Recycle-Bin delete
   flow (`DeleteOriginalAfterJob`).

### Behavioral Specifications

**Happy path (watching `lecture.mp4` tagged `[Talks/2025]`, paused at 00:01:30):**

1. Inspector Tools shows Re-encode, Normalize Audio, **Mark Start [field]**,
   **Mark End [field]**, and a disabled **Create Clip** (fields empty).
2. User clicks **Mark Start** -> field = `00:01:30` (current `video.currentTime`).
3. User scrubs to 00:03:00, clicks **Mark End** -> field = `00:03:00`.
4. Both fields valid and start < end -> **Create Clip** becomes enabled.
5. User clicks **Create Clip**: UI lock engages (`beginMediaProcessing`); the
   existing spinner shows; main computes a collision-free `lecture 1.mp4` beside
   the source and runs
   `ffmpeg -hide_banner -ss 00:01:30 -to 00:03:00 -i "lecture.mp4" -c copy
   -progress pipe:1 -nostats -y "lecture 1.mp4"`.
6. On exit 0: `finalizeEncodedOutput` copies `[Talks/2025]` to the output (DB +
   metadata), refetches, waits for ingestion, selects + opens it in SlideMode.
7. UI lock releases (finally); the delete-original prompt asks "Delete the original
   `lecture.mp4`?" -> "Delete Original" routes through the Recycle-Bin flow.

**Video fully stopped / no `<video>` mounted:** Mark Start/End write `00:00:00`.

**Manual edit / invalid input:** Typing a malformed value (e.g. `1:2:3`, `99:99:99`,
empty) keeps Create Clip disabled. Valid is `HH:MM:SS` with `MM`/`SS` in 0–59 and
`HH` ≥ 0 (2+ digits accepted), and start < end. Defense in depth: main re-validates
and rejects with a clear error toast if a bad value still arrives.

**Source already short / end past duration:** ffmpeg `-to` past EOF simply clips at
EOF; no special handling required. start ≥ end is blocked by validation.

**Zero-tag source:** finalize copies nothing; clip simply has no tags (same as the
other tools).

**ffmpeg failure / cancel / quit-mid-job:** identical to existing jobs — partial
output removed, UI lock released, source untouched, cancel shows a neutral toast,
failure shows an error toast with stderr tail; no delete prompt on failure/cancel.

### Explicit Rejections

- **Do not re-encode.** The command is a stream copy (`-c copy`); never substitute
  `libx264`/filters. The whole point is an instant, lossless trim.
- **Do not put `-ss`/`-to` after `-i`.** They must precede `-i` for correct
  stream-copy seeking; this is why the runner gains a `preInputArgs` slot.
- **Do not invent a new IPC channel or a parallel runner.** Reuse `START_MEDIA_JOB`
  + `ReEncodeManager` + `finalizeEncodedOutput` + `openDeleteOriginalPrompt`.
- **Do not change the existing two job call sites' behavior.** `preInputArgs`
  defaults to `[]`; `StartMediaJobMessage.clip` is optional.
- **Do not pass user time strings to ffmpeg without validation.** Validate in the
  renderer (gates Create Clip) AND in main (defense in depth) using one shared
  `parseHmsToSeconds` helper.
- **Do not enable Create Clip when either field is empty/invalid or start ≥ end.**
- **Do not reach into the slide `<video>` via a brittle new ref-threading scheme.**
  Use `document.querySelector('video')` — the established, unambiguous pattern.
- **Do not widen `isFileExtensionVideo`.** Tools stay scoped to playable videos,
  matching the existing two tools.

---

## Holistic Solution

### Approach

Three ordered tasks: widen the plumbing bottom-up (runner + IPC + main spec),
then add the renderer UI/orchestration, then QA + docs. The post-job finalize and
delete-original flows are reused unchanged.

1. **TASK-093 — Backend: pre-input args + `create-clip` job type + validated IPC.**
   - `src/ReEncodeManager.ts`: add `preInputArgs: string[] = []` to `start()` and
     `_runJob()`, inserted before `-i` in the argv. Keep the two existing callers
     working (they pass nothing). Add a `re-encode-manager.test.ts` case asserting
     `-ss/-to` land before `-i`.
   - `src/ipc/messages.ts`: add `'create-clip'` to `MediaJobType`; extend
     `StartMediaJobMessage` with optional `clip?: { start: string; end: string }`.
   - `src/ipc/renderer.ts`: extend `startMediaJob` to forward optional clip params.
   - `src/main.ts`: add `MEDIA_JOB_SPECS['create-clip'] = { args: ['-c','copy'],
     outputExt: 'mp4' }`; in `onStartMediaJob`, for `create-clip` validate
     `clip.start`/`clip.end` (HH:MM:SS, start < end) and pass
     `preInputArgs = ['-ss', clip.start, '-to', clip.end]`; reject on invalid.
   - `common/fmt.ts`: add `parseHmsToSeconds` / `formatSecondsToHms` (used by main
     validation and the renderer).

2. **TASK-094 — Frontend: Mark Start / Mark End / Create Clip UI + orchestration.**
   - `src/frontend/components/ImageTools.tsx`: inside the `isVideo`, no-active-job
     branch, render the two button+field rows and the Create Clip button. Local
     state for the two field strings; `bothValid` gates Create Clip. Mark
     buttons read `document.querySelector('video')?.currentTime ?? 0` and write
     `formatSecondsToHms(...)`. Create Clip runs the existing media-job
     orchestration (lock -> `startMediaJob('create-clip', path, { start, end })` ->
     `finalizeEncodedOutput` -> `openDeleteOriginalPrompt` -> finally unlock),
     reusing the spinner/cancel UI. All controls disabled while
     `uiStore.isMediaProcessing`.
   - `resources/style/inspector.scss`: minor row/field/button styling.

3. **TASK-095 — QA (REQUIRES MANUAL EXECUTION ON WINDOWS) + docs.** Manual matrix
   in the portable build: capture-from-playback (playing/paused/stopped ->
   `00:00:00`), manual edit + validation gating, start≥end blocked, happy-path
   clip with tags replicated + auto-open, `.mp4`/`webm`/`ogg` sources, collision
   increment, zero-tag source, ffmpeg-failure/cancel/quit-mid-job, delete-original
   via Recycle Bin, and confirmation that `-ss/-to` precede `-i` (stream copy, no
   re-encode — verify near-instant completion + identical codec via ffprobe).
   Update `docs/TOOLS.md` + `docs/index.md`.

### Expected Outcomes

- A working, video-only **Mark Start / Mark End / Create Clip** trio that captures
  the live playback position into editable `HH:MM:SS` fields, runs a lossless
  stream-copy trim, replicates source tags, auto-opens the clip, and offers a
  Recycle-Bin delete of the original.
- A media-job runner that now supports pre-input ffmpeg args, unlocking future
  trim/seek-style tools without further contract changes.
- No regression to Re-encode (x264) or Normalize Audio (their call sites pass no
  `preInputArgs` and no `clip` payload).

### Risks and Tradeoffs

- **Progress percent vs. source duration.** The runner probes the SOURCE duration,
  so a clip that ends at 00:03:00 of a 10:00 video reports ~30% and then jumps to
  done. Accepted: stream copies are near-instant, so progress barely renders;
  computing exact clip-length progress would require extra arithmetic for marginal
  value. Documented in TASK-095.
- **`-ss` before `-i` + `-c copy` cuts on the nearest keyframe.** Stream-copy trims
  snap the start to the preceding keyframe, so the actual cut point may be slightly
  earlier than the requested `-ss`. This is inherent to lossless copy (re-encoding
  would be frame-accurate but violates the "no re-encode" requirement). Documented.
- **Container/codec compatibility.** Output is `.mp4`. Stream-copying a `webm`'s
  VP8/VP9/Opus into MP4 can fail (MP4 doesn't carry those well). For this fork the
  common case is H.264/AAC MP4 sources where `-c copy` -> `.mp4` is correct. If a
  webm/ogg copy fails, the existing ffmpeg-failure path surfaces a clear stderr
  toast and leaves the source intact. A future enhancement could pick the output
  container from the source; out of scope here. Flagged in TASK-093/095.
- **Validation drift.** Two validators (renderer gate + main defense) share one
  `parseHmsToSeconds` helper to stay in sync; do not fork the logic.
- **DOM read coupling.** `document.querySelector('video')` couples the inspector to
  the slide DOM. Mitigated by the verified single-attached-`<video>` invariant and
  a `?? 0` fallback; if the player is ever refactored to mount multiple videos,
  this read (and `ZoomPan.tsx:165`) would need a shared accessor — noted.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: TASK-095 adds the Mark Start / Mark End / Create Clip tools to
      `docs/TOOLS.md` (behavior, `-ss/-to` pre-input ordering, `-c copy` stream-copy
      guarantee, HH:MM:SS validation rules, keyframe-snap + source-duration-progress
      caveats) and links/cross-references from `docs/index.md`.
