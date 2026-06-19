---
id: INV-030
title: 'Add Rotate CW / Rotate CCW video tools (non-destructive ffmpeg transpose)'
reported_bug: "In the tools menu, above Re-encode, there should be 2 new options: 'Rotate CW' and 'Rotate CCW' which correspond to rotating 90 degrees clockwise and rotating 90 degrees counterclockwise, respectively. Use non-destructive ffmpeg commands such as `ffmpeg -i [input] -vf \"transpose=1\" [output]` to accomplish this."
date: 2026-06-19
status: active
superseded_by:
tasks_spawned: [TASK-113, TASK-114, TASK-115]
root_cause_category: missing-edge-case
affects:
  - 'Inspector Tools section (src/frontend/components/ImageTools.tsx)'
  - 'Media-job spec map + IPC handler (src/main.ts)'
  - 'MediaJobType discriminator (src/ipc/messages.ts)'
  - 'Tool documentation (docs/)'
---

## Feature Request

### Observed Behavior

The inspector **Tools** section currently offers four video tools for files where
`isFileExtensionVideo(file.extension)` is true, in this on-screen order:

1. Re-encode (x264)
2. Compress & Normalize Audio
3. Mark Start / Mark End + Create Clip
4. Subtract Clip

There is no way to rotate a video 90°.

### Expected Behavior

Two new buttons — **Rotate CW** (rotate 90° clockwise) and **Rotate CCW** (rotate
90° counterclockwise) — must appear in the Tools section **above** the Re-encode
(x264) button (i.e. they become the first two controls in the section). Each runs
a non-destructive ffmpeg job that produces a rotated copy beside the source —
exactly like the other four tools — leaving the original untouched until the user
chooses in the post-job "Keep which version?" prompt.

The user specified the ffmpeg approach explicitly:

> Use non-destructive ffmpeg commands such as `ffmpeg -i [input] -vf "transpose=1" [output]`.

ffmpeg's `transpose` video filter values (per the ffmpeg `transpose` filter docs):

| Value | Effect |
|---|---|
| `transpose=1` | 90° **clockwise** |
| `transpose=2` | 90° **counterclockwise** |

So **Rotate CW** uses `-vf transpose=1` and **Rotate CCW** uses `-vf transpose=2`.

### Reproduction Context

Deterministic. The tools are shown for any video open in SlideMode
(`mp4`, `webm`, `ogg` per `isFileExtensionVideo`). This is a pure feature
addition; nothing is currently broken.

---

## Root Cause Analysis

**Category:** missing-edge-case (a missing tool, not a defect)

### Diagnosis

This is a feature gap, not a bug. The interesting finding is that the media-job
subsystem has already been generalized over three prior tools (INV-018 Re-encode,
INV-020 Normalize Audio, INV-022 Create Clip) and a fourth (Subtract Clip), so
adding a rotate tool that emits a sibling file requires **only the two cheapest
layers** of the documented stack (see `docs/TOOLS.md`): a static entry in
`MEDIA_JOB_SPECS` plus a button in `ImageTools.tsx`.

Rotate is in fact **simpler than every prior tool**:

- Unlike Create Clip, it has **no `preInputArgs`** (no `-ss`/`-to` before `-i`).
- Unlike Create Clip / Subtract Clip, it carries **no `clip` payload** and needs
  **no per-invocation validation** in the `onStartMediaJob` handler — the args are
  fully static.
- Unlike Subtract Clip, it needs **no dynamic `-filter_complex` builder** — `-vf
  transpose=N` is a constant string in the spec.

Concretely the only places that must change:

1. `src/ipc/messages.ts` — widen the `MediaJobType` union with `'rotate-cw'` and
   `'rotate-ccw'`.
2. `src/main.ts` — two new entries in `MEDIA_JOB_SPECS`. The existing
   `onStartMediaJob` handler already falls through to `spec.args` with empty
   `preInputArgs` for any job type it does not special-case, so rotate needs **no
   handler branch**.
3. `src/frontend/components/ImageTools.tsx` — two buttons placed above the
   Re-encode button, plus spinner-label / cancel-title / error-toast-label
   branches for the two new job types. The shared `runMediaJob(jobType)` helper
   already handles arbitrary job types end-to-end (lock, progress, finalize,
   delete-original prompt, error modal) with no `clip` argument.

### Codec / non-destructive detail

`transpose` is a video filter, so the **video stream must be re-encoded** — it
cannot be stream-copied (a rotated frame is a new frame). The audio stream can and
should be stream-copied. Therefore the spec args are:

```
-vf transpose=1 -c:v libx264 -c:a copy   (Rotate CW)
-vf transpose=2 -c:v libx264 -c:a copy   (Rotate CCW)
```

"Non-destructive" here means **non-destructive to the original file** (a new
sibling `.mp4` is produced; the source is only removed if the user picks "Keep
Modified" in the existing trash-flow prompt) — exactly the contract every other
media tool already honors via `getUniqueSiblingPath` + `finalizeEncodedOutput` +
`DeleteOriginalAfterJob`. It does not mean lossless; the user's own example
(`-vf "transpose=1"`) re-encodes, and `-c:v libx264` matches Re-encode (x264)'s
encoder choice for consistency. The user did not specify the audio codec; `-c:a
copy` preserves audio bit-for-bit and avoids an unnecessary audio re-encode (the
same choice Re-encode (x264) makes).

### Diagnostic Questions Considered

- **Wrong mental model?** No. The media-job stack is already correctly abstracted.
- **Architectural shortcoming?** No — the opposite: the stack absorbs this tool
  with two static lines + UI. This investigation validates that generalization.
- **Incorrect order of operations?** N/A — the shared finalize flow is reused
  verbatim.
- **Missing edge case?** Yes, in the product sense: rotation is a missing tool.
- **Wrong abstraction?** No.
- **Silent failure?** No — codec/container failures (e.g. a source whose audio
  cannot be muxed into `.mp4` when stream-copied) surface through the existing
  loud `MediaJobErrorAlert` modal; the source is left untouched.

---

## Blast Radius

These are the areas touched by the single change "add two static media-job tool
types and surface them in the inspector." There is no latent-defect blast radius
(this is additive), but every integration point of the shared stack must be
covered so the new tools behave identically to the existing four.

1. **`MediaJobType` union (`src/ipc/messages.ts`)** — must gain `'rotate-cw'` and
   `'rotate-ccw'`. Because `MEDIA_JOB_SPECS` is typed `Record<MediaJobType, …>`,
   TypeScript will fail to compile until both spec entries exist — a useful
   compile-time guard that the spec map stays exhaustive.

2. **`MEDIA_JOB_SPECS` map (`src/main.ts`)** — two new entries with the
   `-vf transpose=N -c:v libx264 -c:a copy` args and `outputExt: 'mp4'`.

3. **`onStartMediaJob` handler (`src/main.ts`)** — needs verification (not
   change): the handler must correctly default `jobArgs = spec.args` and leave
   `preInputArgs` empty for the rotate types. It already does this for any type it
   does not branch on, so no new branch is required. Confirm no code path assumes
   a `clip` payload for unknown types.

4. **`ImageTools.tsx` buttons** — two new buttons rendered **above** the Re-encode
   button (first in the Tools list, per the request). Both gated by
   `isFileExtensionVideo` (already the wrapping condition) and disabled while
   `uiStore.isMediaProcessing`.

5. **`ImageTools.tsx` label/title/toast branches** — three derived strings must
   learn the new job types so the spinner, cancel button, and error toast read
   correctly:
   - `progressLabel`: "Rotating clockwise… N%" / "Rotating counterclockwise… N%".
   - `cancelTitle`: "Cancel rotate".
   - error `toastLabel`: "Rotate clockwise" / "Rotate counterclockwise".
   These are the only spots that enumerate job types by name; missing one yields a
   wrong-but-not-broken label (e.g. a rotate job mislabeled "Re-encoding…").

6. **Shared reused layers (verify, do not change)** — `FfmpegRunner`,
   `MediaJobService`, the three IPC channels, `UiStore.beginMediaProcessing`/
   `endMediaProcessing`, `FileStore.finalizeEncodedOutput`, `getUniqueSiblingPath`,
   and `DeleteOriginalAfterJob` all operate on the generic job and need no edits.
   Rotate is the fifth consumer and confirms the layer-3–6 reuse claim again.

7. **Documentation (`docs/`)** — a new `docs/rotate-video.md` feature doc, a link
   from `docs/index.md`, and a "Worked Example 5" / Related entry in
   `docs/TOOLS.md`. The bundled-ffmpeg licensing note in
   `docs/personal-fork-notes.md` already covers the binary (no new binary is
   added), so no licensing change is needed — but the doc should state that
   `-c:v libx264` relies on the existing `--enable-gpl --enable-libx264` build.

---

## UX / Requirements Specification

### Purpose

Let the user rotate a video 90° clockwise or counterclockwise from the inspector,
producing a corrected sibling file without manually invoking ffmpeg, and following
the same safe, tag-preserving, non-destructive flow as every other video tool.

### User-Stated Design Decisions

1. **Two distinct buttons, "Rotate CW" and "Rotate CCW"** — corresponding to 90°
   clockwise and 90° counterclockwise respectively. (Verbatim from the request.)
2. **Placed above Re-encode** — the rotate controls are the first two items in the
   Tools section. (Verbatim: "above Re-encode".)
3. **Non-destructive ffmpeg** — use a command of the shape
   `ffmpeg -i [input] -vf "transpose=1" [output]`, writing a new output file and
   leaving the input intact. (Verbatim, including the `transpose` example.)

### Behavioral Specifications

- **Rotate CW** → ffmpeg `-vf transpose=1` (90° clockwise).
- **Rotate CCW** → ffmpeg `-vf transpose=2` (90° counterclockwise).
- Output is a collision-free sibling `.mp4` (`getUniqueSiblingPath`), consistent
  with the other tools.
- All source tags (DB + EXIF/XMP) copied to the output via
  `finalizeEncodedOutput`; output auto-opens in SlideMode; the
  "Keep which version?" prompt (Keep Modified / Keep Original / Keep Both) appears.
- Spinner label: "Rotating clockwise… N%" / "Rotating counterclockwise… N%"
  (indeterminate "Rotating clockwise…" when duration probing fails; "Finalizing…"
  during the post-ffmpeg phase, shared with all tools).
- Both buttons disabled while `uiStore.isMediaProcessing`; shown only for videos.
- Cancel, app-quit-mid-job, ffmpeg-failure, and output-not-visible paths are
  handled by the shared stack identically to the other tools.

### Explicit Rejections

- Do **not** introduce a new binary — reuse the bundled ffmpeg.
- Do **not** add per-invocation parameters, a `clip` payload, or a handler branch
  — the rotate args are fully static (this is what keeps it simpler than Create
  Clip).
- Do **not** add a disabled placeholder or a combined "Rotate" dropdown — the
  request is two concrete, functional buttons (consistent with the TOOLS.md rule
  against dead stubs).
- Do **not** stream-copy the video (`-c:v copy`) — a rotation re-encodes the video
  by necessity. (Audio is stream-copied with `-c:a copy`.)

---

## Holistic Solution

### Approach

Add Rotate CW / Rotate CCW as the fifth and sixth consumers of the existing
media-job stack, touching only the spec/type/UI/doc layers:

1. **Type (TASK-113):** add `'rotate-cw' | 'rotate-ccw'` to `MediaJobType` and two
   entries to `MEDIA_JOB_SPECS` (`-vf transpose=1`/`transpose=2` `-c:v libx264
   -c:a copy`, `outputExt: 'mp4'`). Verify `onStartMediaJob` handles them via the
   default (no-clip, no-preInputArgs) path with no new branch.

2. **UI (TASK-114):** render two buttons above Re-encode in `ImageTools.tsx`, wire
   each to `runMediaJob('rotate-cw')` / `runMediaJob('rotate-ccw')` (no clip arg),
   and extend the `progressLabel`, `cancelTitle`, and error `toastLabel` branches
   for the two new types.

3. **Docs + QA (TASK-115):** write `docs/rotate-video.md`, link it from
   `docs/index.md` and `docs/TOOLS.md` (Worked Example 5 + Related), and record the
   manual QA matrix (happy path CW + CCW, filtered/tagged view, name collision,
   zero-tag source, cancel, ffmpeg failure on an audio-incompatible source,
   quit-mid-job, lock enforcement, and visual verification that CW vs CCW rotate in
   the correct directions).

### Expected Outcomes

- Two functional rotate buttons at the top of the Tools section for videos.
- CW and CCW produce correctly-rotated sibling `.mp4` files with tags copied,
  source preserved until the user chooses, and identical lock/finalize/error UX to
  the other tools.
- `yarn build` and the test suite pass; the `Record<MediaJobType, …>` typing
  guarantees the spec map stays exhaustive.

### Risks and Tradeoffs

- **Re-encode is lossy and slower than a stream copy.** Inherent to rotation via
  `transpose`; matches the user's stated command and Re-encode (x264)'s encoder.
  Documented as a known limitation.
- **`-c:a copy` into a forced `.mp4`** can fail if the source audio codec is not
  MP4-muxable (e.g. Vorbis in a `.webm`/`.ogg` source). Same caveat already
  documented for Normalize Audio / Create Clip; surfaced via the loud error modal,
  source untouched. Documented, not pre-validated.
- **No frame-accurate orientation-metadata-only rotation.** A `transpose` re-encode
  bakes the rotation into pixels (robust across players) rather than setting a
  display-matrix rotation flag. This is what the user asked for and is the most
  compatible choice; noted in the doc.

### User-requirement verification

- "2 new options 'Rotate CW' and 'Rotate CCW'" → TASK-114 (two buttons). ✓
- "90° clockwise / counterclockwise respectively" → `transpose=1` / `transpose=2`
  in TASK-113; visual QA in TASK-115. ✓
- "above Re-encode" → TASK-114 places them as the first two controls. ✓
- "non-destructive ffmpeg … `transpose=1`" → sibling-file output + source
  preserved via the shared finalize/delete-prompt flow; exact `transpose` filter
  used. ✓

---

## Documentation Updates

- [ ] New: `docs/rotate-video.md` (feature doc)
- [ ] Updated: `docs/index.md` (link), `docs/TOOLS.md` (Worked Example 5 + Related)
