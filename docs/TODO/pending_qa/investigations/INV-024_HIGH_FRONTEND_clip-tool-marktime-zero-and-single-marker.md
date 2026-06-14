---
id: INV-024
title: 'Video clip tool: Mark Start / Mark End always capture 00:00:00 (wrong <video> element selected), and Create Clip should require only ONE time marker (start-only or end-only), passing ffmpeg just -ss or just -to accordingly'
reported_bug: 'Two defects in the INV-022 Mark In/Out → Create Clip video tool. (1) BUG: Clicking Mark Start or Mark End always writes 00:00:00 into the field regardless of the live playback position. The capture reads `document.querySelector(''video'')?.currentTime`, but that selector resolves to a GALLERY THUMBNAIL <video> (paused and reset to currentTime=0 when slide mode opens), not the slide <video> being watched — because the gallery grid stays mounted behind the slide overlay and its videos render earlier in document order. (2) REQUIREMENT CHANGE: Create Clip currently requires BOTH start AND end to be valid and always builds preInputArgs=[-ss start -to end]. The new requirement is that only ONE marker is minimally required: start-only → pass only -ss; end-only → pass only -to; both → pass both; enable Create Clip when AT LEAST ONE field is a valid HH:MM:SS (and, when both present, start < end).'
date: 2026-06-13
status: pending_qa
superseded_by:
tasks_spawned: [TASK-096, TASK-097, TASK-098]
root_cause_category: wrong-mental-model
affects:
  - 'Live-playback-time capture (src/frontend/components/ImageTools.tsx:54-58 captureCurrentTime) — reads `document.querySelector(''video'')`, which returns the FIRST <video> in document order. With the gallery grid still mounted behind the slide overlay, that first match is a gallery thumbnail <video> (GalleryItem.tsx:286, reset to currentTime=0 on slide-mode entry), never the slide <video>. Mark Start/End therefore always write 00:00:00.'
  - 'DOM layout that makes the selector ambiguous (src/frontend/containers/ContentView/LayoutSwitcher.tsx:190-195) — `overviewElem` (the gallery: MasonryRenderer/ListGallery/etc.) and `<SlideMode>` render as SIBLINGS inside `#gallery-content`; the gallery is never unmounted or hidden in slide mode, so its thumbnail <video> elements coexist with the slide <video> and precede it in document order.'
  - 'Gallery thumbnail videos (src/frontend/containers/ContentView/GalleryItem.tsx:228-263, :286) — render a <video data-file-id=…> per visible video file and explicitly `pause(); currentTime = 0` on slide-mode entry (and when not hovered / not auto-play). These are the zero-valued elements the bad selector grabs.'
  - 'The slide <video> itself (src/frontend/containers/ContentView/SlideMode/index.tsx:540-551) — the real, playing element. It is rendered LAST (inside `#zoomable-image` → ZoomPan container), carries NO data-file-id, and is already captured by a callback ref (`setSlideVideoRef`, :466-489) and registered with the MediaReleaseCoordinator. It is the element the capture must read.'
  - 'The proven-correct contrast pattern (src/frontend/containers/ContentView/SlideMode/ZoomPan.tsx:165) — `this.containerRef.current?.querySelector(''video'')` is SCOPED to the ZoomPan container and so already resolves only the slide video for wheel-seek. The ImageTools capture must mirror this scoping rather than querying the whole document.'
  - 'Preview window (src/frontend/Preview.tsx → ContentView) — renders the same gallery+SlideMode sibling structure in its own document, so the same capture bug reproduces there if ImageTools is reachable. Same root cause, fixed by the same change.'
  - 'Renderer Create-Clip gating (src/frontend/components/ImageTools.tsx:180-193, :291-297) — `clipValid` currently requires BOTH fields parse AND start < end. Must become: enabled when AT LEAST ONE field is a valid HH:MM:SS, and (only when both present) start < end. Also the create-clip onClick always sends `{ start, end }`.'
  - 'IPC clip payload (src/ipc/messages.ts:148-163 StartMediaJobMessage.clip; src/ipc/renderer.ts:250-255 startMediaJob) — `clip: { start: string; end: string }` forces both. start/end must each become OPTIONAL so a start-only or end-only clip can be expressed.'
  - 'Main-process clip validation + preInputArgs (src/main.ts:748-776 onStartMediaJob) — currently requires clip.start AND clip.end, rejects if either is null, and unconditionally builds `[-ss start -to end]`. Must validate WHICHEVER are present, require at least one, enforce start < end only when BOTH present, and build preInputArgs by conditionally including `-ss start` and/or `-to end`.'
  - 'ffmpeg argv assembly (src/ReEncodeManager.ts:116-208) — already supports a variable-length preInputArgs spliced before -i; no contract change needed. It simply receives `[-ss start]`, `[-to end]`, or `[-ss start -to end]` depending on which markers were supplied.'
  - 'Time helpers (common/fmt.ts:114-142 parseHmsToSeconds / formatSecondsToHms) — reused unchanged for both the corrected capture and the relaxed validation; no change required.'
  - 'Post-job finalize + delete prompt (src/frontend/stores/FileStore.ts finalizeEncodedOutput; src/frontend/stores/UiStore.ts openDeleteOriginalPrompt; RemovalAlert DeleteOriginalAfterJob) — reused verbatim; no change.'
---

## Bug Report

### Observed Behavior

The Mark Start / Mark End / Create Clip video tools were added to the inspector
Tools section by INV-022 (TASK-093/094/095). Two distinct problems are reported.

**Problem 1 (defect).** While watching a video in SlideMode, clicking **Mark Start**
or **Mark End** always writes `00:00:00` into the attached `HH:MM:SS` field,
regardless of where the video is currently playing/seeked. The fields are supposed
to capture the live playback time (`video.currentTime`) of the open video.

**Problem 2 (requirement change).** **Create Clip** is currently enabled only when
BOTH the start and end fields hold valid `HH:MM:SS` values (with start < end), and
the main process always builds `preInputArgs = ['-ss', start, '-to', end]`. The user
now wants a single marker to suffice:

- start-only → ffmpeg receives only `-ss <start>` (clip runs to end of video),
- end-only → ffmpeg receives only `-to <end>` (clip runs from start of video),
- both → ffmpeg receives both (current behavior),
- enable Create Clip when AT LEAST ONE field holds a valid `HH:MM:SS` (and, when
  both are present, start < end).

### Expected Behavior

**Problem 1.** Mark Start / Mark End must capture the current playback time of the
video the user is actually watching (the SlideMode `<video>`), formatted `HH:MM:SS`,
or `00:00:00` only if no slide video is mounted/available.

**Problem 2.** As enumerated above — a single valid marker is sufficient to create a
clip, and ffmpeg is given only the corresponding seek flag.

### Reproduction Context

**Problem 1** is deterministic whenever at least one *video* thumbnail is mounted in
the gallery grid that lives behind the slide overlay (the normal case — you reach
SlideMode by opening a video from the grid, so its thumbnail and likely neighbors are
mounted). It reproduces in both the main window and the preview window (same DOM
shape). It would *appear* to work only in the degenerate case where the slide
`<video>` happens to be the first `<video>` in document order — i.e. no video
thumbnails are mounted ahead of it — which is not the normal path.

**Problem 2** is a behavioral/requirements change, not environment-dependent.

---

## Root Cause Analysis

**Category:** wrong-mental-model (Problem 1); the relaxation in Problem 2 is a
requirement change layered on the same clip pipeline.

### Diagnosis

**Problem 1 — the capture reads the wrong `<video>`.**

`captureCurrentTime` (`src/frontend/components/ImageTools.tsx:54-58`) does:

```ts
const v = document.querySelector('video') as HTMLVideoElement | null;
const sec = v && Number.isFinite(v.currentTime) ? v.currentTime : 0;
return formatSecondsToHms(sec);
```

`document.querySelector('video')` returns the **first** `<video>` in *document
order* across the entire document. The INV-022 premise (encoded verbatim in the
ImageTools comment on lines 50-53 and in INV-022 itself at lines 120/206/309) was
that *"the slide video is the ONLY attached `<video>`; preload videos are orphan."*
That premise is **wrong**. It accounted for the orphan preload videos
(`SlideMode/index.tsx:157-199`, created via `document.createElement` and never
mounted) but **forgot the gallery thumbnail videos**:

- `LayoutSwitcher.tsx:190-195` renders `{overviewElem}` (the gallery —
  MasonryRenderer / ListGallery / etc.) and `<SlideMode>` as **siblings** inside
  `#gallery-content`. The gallery is **not unmounted or hidden** when slide mode
  opens (no `isSlideMode`-gated unmount anywhere in MasonryRenderer).
- Each visible *video* file in the gallery renders a real, attached
  `<video data-file-id=…>` (`GalleryItem.tsx:286`).
- On entering slide mode, those gallery videos are explicitly **paused and reset to
  `currentTime = 0`** (`GalleryItem.tsx:252-263`, and `:228-238` for the
  non-hovered case).
- The gallery DOM precedes `<SlideMode>` in document order, so the *first* `<video>`
  `document.querySelector('video')` finds is a **gallery thumbnail at
  `currentTime = 0`** — never the slide `<video>` (which is rendered last, inside
  `#zoomable-image` → the ZoomPan container, and carries no `data-file-id`).

Hence Mark Start / Mark End read `0` every time. The contrast that proves the fix:
`ZoomPan.tsx:165` reads the slide video correctly because it scopes the query to its
own container — `this.containerRef.current?.querySelector('video')` — so it never
sees the gallery videos. The capture in ImageTools must read the slide video by the
same *scoping* discipline (it lives in the inspector subtree and has no ZoomPan ref,
so it must scope to the slide container in the document: `#zoomable-image video`,
i.e. the `<video>` inside the ZoomPan container under `#zoomable-image`). For
defense in depth the selector can also exclude gallery videos by their distinguishing
attribute (`video:not([data-file-id])`), since the slide `<video>` has no
`data-file-id` while every gallery thumbnail video does.

This is a **wrong-mental-model** defect: "the video the user is looking at" was
treated as a *DOM-uniqueness fact* rather than a scoped/identified element. (See
bomb-squad sweep below — every other `querySelector('video')`/`querySelectorAll` in
the codebase is either correctly scoped to a ref, or filters by a unique key, or is
genuinely unique; ImageTools is the lone offender, with the preview window
reproducing it by extension.)

**Problem 2 — the clip pipeline hard-requires both markers.**

The pipeline was built (INV-022) for a *both-markers* clip:

- Renderer gate (`ImageTools.tsx:182-184`): `clipValid = startSec !== null &&
  endSec !== null && startSec < endSec` — requires both.
- onClick (`:293`): always sends `{ start: startTime, end: endTime }`.
- IPC type (`messages.ts:162`): `clip?: { start: string; end: string }` — both
  fields mandatory once `clip` is present.
- `renderer.ts:250-255`: `startMediaJob` forwards `clip?: { start; end }`.
- Main (`main.ts:754-775`): rejects if `clip` undefined, rejects if `start` null,
  rejects if `end` null, then always builds `['-ss', clip.start, '-to', clip.end]`.

ffmpeg itself already does the right thing with a single flag (`-ss` alone trims to
EOF; `-to` alone trims from the start), and `ReEncodeManager` already splices a
variable-length `preInputArgs` before `-i` (`:197-208`). So no runner change is
needed — only the *gating*, the *payload optionality*, and the *conditional
preInputArgs construction* must relax to "at least one marker."

### Diagnostic Questions Considered

- **Wrong mental model?** **Yes — primary (Problem 1).** "Only one attached
  `<video>`" was false; gallery thumbnail videos coexist and win document order.
- **Architectural shortcoming?** No. The runner/IPC/finalize machinery is sound;
  Problem 2 is a controlled relaxation, not a contract redesign.
- **Incorrect order of operations?** Tangential: it is precisely *document order*
  (gallery before slide) that surfaces the wrong element. Fixed by scoping, not
  reordering.
- **Missing edge case?** Problem 2 is the "single marker" edge case that was never
  modeled. Also: start-only with start past EOF (ffmpeg yields an empty/near-empty
  output — acceptable, surfaces via the existing failure path), and end-only equal
  to 00:00:00 (treated as a valid but empty range — gate end-only on end > 0 to avoid
  a zero-length clip; see Behavioral Specs).
- **Wrong abstraction?** Mild: selecting the active media element by DOM-tag rather
  than by tracked state/ref. The minimal fix scopes the selector (mirroring
  ZoomPan); a follow-up could expose the slide `<video>` via state (noted in Risks).
- **Silent failure?** Problem 1 fails silently (writes a plausible `00:00:00`, no
  error). The fix makes the read correct; main-side validation already guards bad
  strings.

---

## Blast Radius

1. **`captureCurrentTime` selector (ImageTools.tsx:54-58).** Replace the
   unscoped `document.querySelector('video')` with a scoped read of the slide video:
   query within the SlideMode container (`#zoomable-image video`), optionally
   hardened to `#zoomable-image video:not([data-file-id])`. Update the now-false
   comment (lines 50-53). This is the core Problem-1 fix.

2. **Renderer Create-Clip gating + onClick (ImageTools.tsx:180-193, 291-297).**
   Replace `clipValid` (both-required) with `clipValid` = "at least one valid marker,
   and start < end when both present." Build the `clip` payload to include only the
   provided marker(s). Update the `showRangeHint` logic to only apply when both are
   present (unchanged) and add no hint for the single-marker case.

3. **IPC clip payload (messages.ts:148-163; renderer.ts:250-255).** Make start/end
   each optional: `clip?: { start?: string; end?: string }`. Update the
   `startMediaJob` signature/forwarding to match. Other job types still omit `clip`.

4. **Main clip validation + preInputArgs (main.ts:748-776).** For `create-clip`:
   require `clip` present with at least one of start/end; validate each present value
   with `parseHmsToSeconds` (reject malformed); enforce `start < end` ONLY when both
   present; build `preInputArgs` by conditionally pushing `'-ss', clip.start` and/or
   `'-to', clip.end`. Reject (clear error) when neither is present or a present value
   is malformed.

5. **ffmpeg argv assembly (ReEncodeManager.ts:116-208).** No change — already
   accepts a variable-length `preInputArgs`. Receives 2 or 4 elements depending on
   markers.

6. **Preview window (Preview.tsx → ContentView).** No code change beyond #1; the
   scoped selector fixes the preview reproduction automatically (same `#zoomable-image`
   container exists in that document).

7. **Time helpers (common/fmt.ts).** Reused unchanged.

8. **Post-job finalize + delete prompt (FileStore.finalizeEncodedOutput,
   UiStore.openDeleteOriginalPrompt, RemovalAlert.DeleteOriginalAfterJob).** Reused
   verbatim — no change.

---

## UX / Requirements Specification

### Purpose

Make the clip tool actually capture the live playback position the user is watching,
and let the user trim with a single in- or out-point when that is all they need
(trim off a head, or trim off a tail) without forcing them to mark both ends.

### User-Stated Design Decisions

1. **Mark Start / Mark End capture the LIVE playback time of the open (slide) video**
   via the correct element. Rationale: the buttons exist to grab where you are
   watching; reading a paused gallery thumbnail (always 0) defeats the feature.
2. **Read the currently-playing slide `<video>` reliably**, not "the first `<video>`
   in the document." Rationale: gallery thumbnail videos coexist behind the slide
   overlay and precede it in document order. (User: "find the correct, reliable
   mechanism to read the currently-playing video's currentTime from the inspector.")
3. **Only ONE time marker is minimally required to run Create Clip.** Rationale:
   trimming off just a head (start-only) or just a tail (end-only) is common and
   should not require marking the other end.
4. **start-only → pass ffmpeg only `-ss <start>`** (ffmpeg assumes end = end of
   video). Rationale: lossless trim of the head.
5. **end-only → pass ffmpeg only `-to <end>`** (ffmpeg assumes start = beginning).
   Rationale: lossless trim of the tail.
6. **both → pass both `-ss <start> -to <end>`** (unchanged). Rationale: the existing
   middle-section trim.
7. **Create Clip enabled when AT LEAST ONE field holds a valid `HH:MM:SS`**, and when
   both are present, `start < end`. Rationale: gate against malformed/empty input
   while permitting the single-marker case.

### Behavioral Specifications

- **Capture (playing/paused/seeked):** Mark Start/End write the slide video's
  `currentTime` as `HH:MM:SS`. **No slide video mounted/available:** write
  `00:00:00`.
- **Gating:**
  - start valid, end empty → Create Clip **enabled** (start-only).
  - end valid, start empty → Create Clip **enabled** (end-only). Require end > 0
    (`00:00:00` end-only is a zero-length clip → keep disabled / no `-to` of zero).
  - both valid, start < end → **enabled** (both).
  - both valid, start ≥ end → **disabled**, show "End must be after start." hint.
  - the lone present field malformed → **disabled** (no hint needed beyond empty
    output styling).
  - both empty → **disabled**.
- **ffmpeg argv:**
  - start-only: `-hide_banner -ss <start> -i <src> -c copy -progress pipe:1 -nostats -y <dst>`
  - end-only:   `-hide_banner -to <end>   -i <src> -c copy -progress pipe:1 -nostats -y <dst>`
  - both:       `-hide_banner -ss <start> -to <end> -i <src> -c copy …`
- **Defense in depth:** main re-validates each present marker and the start < end
  relation (only when both present); rejects malformed/empty-both with a clear error
  surfaced via the existing `MediaJobErrorAlert` modal.
- **Finalize / delete prompt / cancel / failure / quit-mid-job:** identical to the
  existing clip flow; on success reset both fields.

### Explicit Rejections

- **Do NOT keep `document.querySelector('video')`** for the capture — it is the bug.
  Scope to the slide container (`#zoomable-image video`), mirroring `ZoomPan.tsx:165`.
- **Do NOT require both markers.** At least one valid marker enables Create Clip.
- **Do NOT pass an empty/placeholder `-ss 00:00:00` or `-to <huge>` to stand in for a
  missing marker.** Omit the flag entirely so ffmpeg applies its natural default
  (start = 0 / end = EOF).
- **Do NOT change the runner contract** (`ReEncodeManager` already supports
  variable-length `preInputArgs`) or invent a new IPC channel.
- **Do NOT break the other two job types** — they still send no `clip`; making
  start/end optional must not change their path.
- **Do NOT re-encode** — the clip remains `-c copy` (stream copy).

---

## Holistic Solution

### Approach

Three ordered tasks. Fix the capture (Problem 1) and the renderer gating (Problem 2
front half) in the renderer; relax the IPC payload + main validation/preInputArgs
(Problem 2 back half) in the backend; then QA both problems together.

1. **TASK-096 — Renderer: correct slide-video capture + single-marker gating.**
   - `ImageTools.tsx`: rewrite `captureCurrentTime` to read
     `document.querySelector('#zoomable-image video')` (hardened
     `#zoomable-image video:not([data-file-id])`), keeping the `?? 0` /
     `Number.isFinite` fallback; replace the false comment. Replace `clipValid` with
     the at-least-one-valid-marker logic (start < end only when both present;
     end-only requires end > 0). Build the `clip` onClick payload to include only the
     provided marker(s) (`{ start }`, `{ end }`, or `{ start, end }`).

2. **TASK-097 — Backend: optional clip start/end + conditional preInputArgs.**
   - `src/ipc/messages.ts`: `clip?: { start?: string; end?: string }`.
   - `src/ipc/renderer.ts`: widen `startMediaJob`'s `clip` param to optional
     start/end and forward as-is.
   - `src/main.ts onStartMediaJob`: for `create-clip`, require `clip` present with at
     least one marker; validate each present marker via `parseHmsToSeconds`; enforce
     `start < end` only when both present; build `preInputArgs` conditionally
     (`['-ss', start]` and/or `['-to', end]`). Reject malformed / neither-present.
   - `src/ReEncodeManager.ts`: no change (verify variable-length `preInputArgs`).

3. **TASK-098 — QA (REQUIRES MANUAL EXECUTION ON WINDOWS) + docs.** Verify the
   capture reads the real playback time at various seek positions (playing, paused,
   scrubbed) with video thumbnails mounted in the grid behind the slide; verify
   start-only, end-only, and both clips produce correct lossless cuts (ffprobe: codec
   unchanged, near-instant); verify gating matrix; verify finalize + delete-original;
   update `docs/create-clip.md` and `docs/TOOLS.md` (correct capture mechanism +
   single-marker behavior).

### Expected Outcomes

- Mark Start / Mark End capture the actual playback time of the watched video.
- Create Clip works with a single marker (start-only or end-only) or both, passing
  ffmpeg only the relevant `-ss`/`-to` flag(s); enabled when ≥1 valid marker.
- No regression to Re-encode / Normalize Audio (no `clip` payload) or to the
  both-markers clip path.

### Risks and Tradeoffs

- **Selector still couples ImageTools to the slide DOM** (`#zoomable-image video`).
  Mitigated by mirroring the already-trusted `ZoomPan.tsx:165` scoping and the
  `:not([data-file-id])` guard. A more robust follow-up would expose the active slide
  `<video>`/`currentTime` via UiStore (the element is already captured by
  `setSlideVideoRef`); out of scope here, noted for future hardening.
- **`-ss` before `-i` with `-c copy` snaps the start to the preceding keyframe**
  (inherent to lossless copy) — unchanged from INV-022, documented.
- **end-only `00:00:00`** would be a zero-length clip; gated out in the renderer and
  (defense in depth) main rejects start ≥ end only when both present, so end-only
  must additionally require end > 0 in the renderer gate.
- **Progress percent vs. source duration** caveat unchanged from INV-022.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: TASK-098 corrects `docs/create-clip.md` (and `docs/TOOLS.md`) — the
      capture mechanism (scoped `#zoomable-image video`, NOT
      `document.querySelector('video')`) and the new single-marker behavior
      (start-only → `-ss`, end-only → `-to`, both → both; enabled when ≥1 valid
      marker).
