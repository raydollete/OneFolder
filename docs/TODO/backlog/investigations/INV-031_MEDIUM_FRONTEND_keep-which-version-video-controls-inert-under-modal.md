---
id: INV-031
title: '"Keep which version?" prompt makes the SlideMode video inert — user cannot seek / play-pause / read duration while deciding'
reported_bug: 'After a media tool runs, the "Keep which version?" prompt appears over the video, but the video controls (seek bar, play/pause, duration) are unavailable or non-functional while the prompt is open.'
date: 2026-06-19
status: active
superseded_by:
tasks_spawned: [TASK-116, TASK-117, TASK-118]
root_cause_category: wrong-abstraction
affects:
  - Post-media-job confirmation UX (DeleteOriginalAfterJob)
  - Shared Alert modal widget (widgets/popovers/Alert.tsx)
  - SlideMode video player interactivity (controls + keydown)
---

## Bug Report

### Observed Behavior

After any media tool runs (Re-encode x264, Compress & Normalize Audio, Create
Clip, Subtract Clip, Rotate CW/CCW), the **"Keep which version?"** prompt
(`DeleteOriginalAfterJob`) appears centered over the SlideMode viewer, which is
already showing the freshly-produced output video. The native HTML5 `<video>`
controls (seek/scrub bar, play/pause, current-time / duration readout) are
**visible behind the prompt but non-functional** — clicking the scrubber,
clicking play/pause, or pressing Space/arrow keys does nothing. The user must
decide Keep Modified / Keep Original / Keep Both **without being able to play
or scrub the result** they are being asked to evaluate.

### Expected Behavior

While the "Keep which version?" prompt is open, the user should be able to
**fully interact with the output video** to evaluate it before choosing:

- Drag/click the seek bar to scrub to any point.
- Play / pause (button and/or Space).
- See the duration and current-time readout update.

The prompt itself must remain visible and its three choices clickable, but it
must **not** block interaction with the video it is asking the user to judge.

### Reproduction Context

Deterministic. Reproduces for every media tool that ends in the
`DeleteOriginalAfterJob` prompt, on every video format the SlideMode `<video>`
can play (`mp4`, `webm`, `ogg`). Independent of library state, filter, or
sort. Not a timing/race issue — it is the steady state of the open prompt.

---

## Root Cause Analysis

**Category:** wrong-abstraction

### Diagnosis

The "Keep which version?" prompt is `DeleteOriginalAfterJob`
(`src/frontend/components/RemovalAlert.tsx:275`), which renders through the
shared **`Alert`** widget (`widgets/popovers/Alert.tsx`). `Alert` opens its
content in a native `<dialog>` element and shows it via
**`dialog.current.showModal()`** (`Alert.tsx:37`).

`showModal()` promotes the `<dialog>` into the browser's **top layer** and
renders a `::backdrop` that makes **every other element in the document inert** —
the browser swallows all pointer and keyboard events directed at content behind
the dialog. This is a platform behavior, not a CSS effect; nothing in
`resources/style/controls/popover.scss` (which styles the dialog box but defines
no `::backdrop` / `pointer-events` / `inert` rule) can re-enable it.

Consequently the SlideMode `<video controls autoPlay loop>`
(`src/frontend/containers/ContentView/SlideMode/index.tsx:545`) is rendered but
inert while the prompt is open: its native control bar cannot be clicked, and
the SlideMode keydown handler (`SlideMode/index.tsx:115`) — which implements
Space/arrow/Escape — never fires because the modal eats keyboard events too.

Crucially, this is **not** caused by the media-processing UI lock. The
orchestration in `ImageTools.tsx` opens the prompt
(`uiStore.openDeleteOriginalPrompt(file, outputFile)`, line 143) on the success
path and only releases the lock in the `finally`
(`uiStore.endMediaProcessing()`, line 177), so `isMediaProcessing` is already
`false` by the time the prompt is interactive. The sole blocker is the modal
inertness from `showModal()`.

The deeper error is a **wrong abstraction**: the `Alert` widget bakes
`showModal()` (block-the-whole-page) into the primitive. That contract is
correct for destructive confirmations (delete this file?), where the background
is read-only context. But `DeleteOriginalAfterJob` reused the same widget for a
fundamentally different semantic — *evaluate the live video, then decide* —
where the background is the very thing the user must interact with. The widget
exposes no non-modal variant, so reaching for "show a prompt" inevitably yields
"freeze the page." The prompt's own docstring (`RemovalAlert.tsx:264`) states
"the viewer is already showing the new output. The user chooses which to keep" —
the design intent assumes the user can evaluate the video, which `showModal()`
silently defeats.

### Diagnostic Questions Considered

- **Wrong mental model?** Partly — the controls render with `controls` set, so
  at a glance they "should work"; the author's model of `<dialog>` as a
  positioned box, not a global interaction barrier, is the mental-model slice.
- **Architectural shortcoming?** Yes, secondary — there is no non-blocking
  dialog variant in the widget library, so the only tool available blocks
  everything.
- **Incorrect order of operations?** No — the lock is correctly released before
  the prompt; ordering is fine.
- **Missing edge case?** No — it is the steady state, not an edge.
- **Wrong abstraction?** **Yes, primary** — `Alert` conflates "show a prompt"
  with "make the page inert"; the post-job comparison needs the former without
  the latter.
- **Silent failure?** Yes, in spirit — the controls are present and look
  enabled, but the browser silently swallows their events; nothing logs or
  signals that interaction is disabled.

---

## Blast Radius

1. **`DeleteOriginalAfterJob` prompt** (`RemovalAlert.tsx:275`) — the reported
   defect. The user must judge the output video but cannot play/scrub/seek it.
   This is the **only** "decide-while-viewing-live-media" surface in the app and
   the primary target of the fix.

2. **SlideMode keydown handler** (`SlideMode/index.tsx:115`) — same root cause,
   same fix: `showModal()` also makes Space / arrow keys inert, so even keyboard
   scrubbing/pause is dead while the prompt is open. Resolving the modal
   inertness restores these for free.

3. **Looping audio under the modal** (`SlideMode/index.tsx:561` `loop` +
   `autoPlay`) — a direct symptom of the same mismatch: the output keeps
   playing/looping behind the inert modal and (if unmuted) the user cannot pause
   it. The fix (interactable controls) lets the user pause/mute.

4. **`Alert` / `Dialog` widget contract** (`widgets/popovers/Alert.tsx:37`,
   `widgets/popovers/Dialog.tsx:43`) — the abstraction itself. Adding a
   non-modal option here fixes the class of defect so the next
   "decide-while-viewing" surface cannot reintroduce it.

### Explicitly NOT affected (verified, do not change)

- **`MediaJobErrorAlert`** (`RemovalAlert.tsx:416`) — intentionally blocking and
  correct. It surfaces a hard ffmpeg failure; no output was produced, there is
  nothing to evaluate, the user only reads the error and dismisses. Must remain
  modal.
- **`MoveFilesToTrashBin`, `FileRemoval`, `TagRemoval`, `SubLocationExclusion`,
  `SavedSearchRemoval`, `ManyOpenExternal`,** and the `Dialog`-based
  location/search/library dialogs — destructive or modal-by-nature
  confirmations where blocking the read-only background is correct. Out of
  scope.

---

## UX / Requirements Specification

### Purpose

Let the user evaluate the produced video (scrub, play/pause, read duration)
while the "Keep which version?" prompt is open, so the keep/discard decision is
informed rather than blind.

### User-Stated Design Decisions

1. **The seek bar must work while the prompt is open** — the user can scrub to
   any point in the output video.
2. **Play/pause must work while the prompt is open** — via the native control
   bar (and ideally Space, restored as a side effect).
3. **Video details (duration / current time) must be visible and live** while
   the prompt is open.

### Behavioral Specifications

- The "Keep which version?" prompt remains visible and its three buttons
  (Keep Modified / Keep Original / Keep Both) remain clickable, with the same
  labels, default button, and trash/keep semantics as today.
- The prompt must **not occlude the video's native control bar** (which sits at
  the bottom edge of the `<video>`), so the seek bar and play/pause button are
  reachable. The prompt is repositioned away from the bottom-center of the
  viewer (e.g. anchored to the top, or to a top corner) and is non-modal.
- The video continues to autoplay/loop as today; the user may now pause/scrub
  it.

### Explicit Rejections

- **Do NOT** make `MediaJobErrorAlert` non-modal — it should keep blocking.
- **Do NOT** add a separate embedded video player inside the prompt — the
  SlideMode `<video>` is already on screen behind it; the fix is to stop
  blocking it, not to duplicate it.
- **Do NOT** widen the change to the other (correctly-blocking) confirmation
  dialogs.
- **Do NOT** re-introduce or rely on the `isMediaProcessing` lock to gate the
  video here — the lock is already released and is not the cause.

---

## Holistic Solution

### Approach

Make non-modal a first-class, opt-in capability of the `Alert` widget, then have
only `DeleteOriginalAfterJob` use it and position itself clear of the video's
control bar.

1. **`Alert` widget — add a `modal` option (default `true`).**
   In `widgets/popovers/Alert.tsx`, branch the open effect:
   `props.modal === false ? dialog.current.show() : dialog.current.showModal()`.
   `show()` opens the `<dialog>` **without** the top-layer/backdrop, so the rest
   of the page (the video) stays interactive. Default `true` preserves every
   existing consumer's behavior verbatim. Expose a hook to position the
   non-modal dialog (e.g. an extra class / `data-nonmodal` attribute) so CSS can
   move it out of the bottom-center.
   - Note: `show()` does not trap focus or auto-handle Escape; that is fine here
     because the prompt's actions are explicit buttons and there is no
     destructive default beyond the user's own choice. Keep the existing
     `cancel`-preventDefault listener harmless under `show()`.

2. **`DeleteOriginalAfterJob` — pass `modal={false}` and reposition.**
   In `src/frontend/components/RemovalAlert.tsx`, render its `Alert` with
   `modal={false}` and a positioning class/attribute so the prompt anchors to
   the **top** (or top-corner) of the viewer, leaving the video frame and its
   bottom control bar reachable. All three button handlers and the recyclability
   logic are unchanged.

3. **SCSS — style the non-modal dialog position.**
   In `resources/style/controls/popover.scss`, add a rule for the non-modal /
   positioned alert (keyed on the new attribute/class) that anchors it to the
   top (overriding the centered `top/bottom: 0; margin-top: 10vh` so it does not
   sit over the control bar), keeps it visually distinct, and ensures the video
   control bar at the bottom is never covered. The default modal dialog styling
   is untouched.

The keydown-inertness (blast item 2) and looping-audio (item 3) issues are
resolved automatically once the modal no longer makes the page inert — no extra
code.

### Expected Outcomes

- With the prompt open, the user can click/drag the seek bar, click play/pause,
  and watch the duration/current-time update on the output video.
- The three keep choices behave exactly as before.
- Every other `Alert`/`Dialog` consumer is byte-for-byte unchanged (default
  `modal=true`).
- `MediaJobErrorAlert` still blocks.

### Risks and Tradeoffs

- **Focus / Escape:** a non-modal `<dialog>` does not trap focus or auto-close on
  Escape. Acceptable — the buttons are explicit. If desired, the prompt can keep
  a lightweight Escape→Keep Both binding, but this is optional and must not
  re-block the video.
- **Click-through occlusion:** wherever the (now non-modal) prompt box overlaps
  the video, clicks land on the prompt, not the video. Mitigated by positioning
  the prompt at the top/corner so the control bar (bottom) and most of the frame
  stay clickable. This is a positioning concern verified in manual QA.
- **Stacking / z-index:** a non-modal `<dialog>` is not in the top layer, so it
  participates in normal stacking. It is mounted in `#gallery-content`
  (`ContentView/index.tsx:146`) above the viewer, so it should still render on
  top; QA confirms it is not hidden behind the video or toolbar.

---

## Documentation Updates

- [ ] Update `docs/reencode-x264.md` (and/or `docs/TOOLS.md`) to note that the
      "Keep which version?" prompt is non-modal so the output video can be
      evaluated (scrub/play-pause/duration) while it is open.
