## Context

Slide-mode video playback lives in two files:

- `SlideMode/index.tsx` renders the `<video controls autoPlay loop>` inside a
  `ZoomPan` and already owns a viewer-scoped **global `keydown`** listener
  (`:139`) for arrow-key nav / Escape and holds the video element via
  `setSlideVideoRef` (`:564`). This is the existing "focused video" model.
- `ZoomPan.tsx` binds a React `onWheel` (`:345`) to its container. Its
  `handleMouseWheel` (`:161`) currently does double duty: for videos under a
  non-Alt wheel it seeks the timeline; otherwise it runs the zoom path. Because
  it is a React `onWheel` on the ZoomPan element, seek only fires while the
  pointer is physically over the video.

Two independent bothers, addressed together because both are slide-mode video
viewer polish:

1. A gradient scrim sits behind the native scrub controls. There is currently
   **no** app CSS for `::-webkit-media-controls-*` (grepped `resources/style`),
   so the scrim is Chromium's default `::-webkit-media-controls-panel`
   background gradient — removable with a targeted style rule.
2. Wheel-seek should follow the focused video, not the cursor.

The gallery container `#gallery-content` has its own React `onWheel`
(`ContentView/index.tsx:112`, bound `:137`) that resizes thumbnails on
Ctrl+wheel. Today ZoomPan's handler `stopPropagation()`s Ctrl/Shift wheels
(`:186`) so they do not reach that handler. Any re-scoping must preserve this.

## Goals / Non-Goals

**Goals:**
- Remove the scrim behind the scrub controls with a scoped CSS rule; controls
  stay visible and usable.
- Fire wheel-seek whenever a video is the focused viewer item, regardless of
  pointer position, keeping today's step sizes and modifier semantics exactly.
- Keep Alt+wheel zoom working and keep Ctrl+wheel from resizing gallery
  thumbnails while a video is focused.

**Non-Goals:**
- No change to keyboard controls (Spacebar, arrows), zoom math, or image
  wheel-zoom behavior.
- No replacement of the native `controls` with a custom scrub bar.
- No change to seek step sizes or which modifier does what.

## Decisions

### Decision: Drive wheel-seek from a viewer-scoped global listener, mirroring the existing keydown listener

Add a `wheel` listener registered in a `useEffect` in `SlideMode/index.tsx`,
active only while slide mode is open **and** the focused item is a video —
exactly the lifecycle the arrow-key `keydown` listener already uses. The handler
reads the video element from the existing slide video ref and applies the seek.
The element-scoped seek branch is removed from `ZoomPan.handleMouseWheel`, which
keeps only the zoom path; the seek step computation is extracted into a small
pure helper so both the old callsite's semantics and the new listener share one
source of truth.

- *Why over keeping it on the ZoomPan element:* the element only receives wheel
  events when hovered — the exact limitation being removed. The focused-video
  model already exists for keyboard; wheel should use the same model.
- *Alternative considered — attach to the slide-mode container instead of
  window:* simpler propagation story, but the inspector panel and other chrome
  can sit outside the viewer container, so "wheel over the inspector seeks" (a
  stated requirement) would not hold. Rejected in favor of the viewer-scoped
  global listener.

### Decision: Register in capture phase; consume only non-Alt wheels, let Alt fall through

Register with `{ capture: true, passive: false }`. Capture fires from window
down before the event reaches React's root listener, so the handler can
`preventDefault()` (kill page scroll) and `stopPropagation()` to keep the wheel
from reaching both the gallery Ctrl+wheel thumbnail-resize handler and ZoomPan.
The handler consumes only non-Alt wheels (the seek cases); for Alt+wheel it does
nothing and does not stop propagation, so the event still reaches ZoomPan's
`onWheel` and drives zoom as before.

- *Why capture, not bubble:* React attaches its handlers at the root; a bubble
  window listener would run **after** the gallery's Ctrl+wheel resize had
  already fired. Capture lets us pre-empt it, replacing the old
  `stopPropagation()` guard that ZoomPan performed.

### Decision: Remove the scrim via a scoped `::-webkit-media-controls` rule in content.scss

Add, next to the existing slide-mode `video` rules in `resources/style/content.scss`,
a rule that clears the default control-panel gradient (e.g.
`video::-webkit-media-controls-panel { background-image: none; }`, plus the
enclosure if needed). Scoped to the slide-mode video so gallery/thumbnail video
elements are unaffected.

- *Why CSS over swapping controls:* the scrim is a default UA style; a one-rule
  override removes it without reimplementing the native scrub bar.

## Risks / Trade-offs

- **[Wheel over a scrollable side panel no longer scrolls it while a video is
  focused]** → By design the user asked for seek "any time the video is focused,
  regardless of cursor." The capture handler consuming non-Alt wheels means a
  scrollable inspector list will not wheel-scroll while a video is the focused
  viewer item. Accepted per the explicit request; if it proves annoying, the
  handler can be narrowed to skip events whose target is inside a known
  scrollable panel. Recorded as an open question below.
- **[Double-seek if both the old ZoomPan seek branch and the new listener run]**
  → Mitigated by removing the seek branch from ZoomPan entirely; only the new
  listener seeks.
- **[Capture handler leaks or fires outside slide mode]** → Mitigated by the
  same mount/unmount lifecycle as the existing keydown effect; the listener is
  added only when a video is focused and removed on cleanup.
- **[UA control-panel pseudo-element names change across Chromium versions]** →
  Low risk on the pinned Electron/Chromium; the rule is purely cosmetic and
  degrades to "scrim still shown," never to broken controls.

## External Review

### Peer Review Verdict

Quorum: achieved (weight 2/2, escalated to tier 1)
Certainty: 1
Caller Agreement: 1
Arbiter: ok
Sources:
- gemini-flash (google/gemini-3.5-flash) — ok, agreement 1
- qwen (qLLM) — ok, agreement 1

### Review Feedback

Consensus feedback recorded verbatim (blind brief; `tier2_escalation: 1`):

> To make wheel-seek respond to the focused video regardless of pointer
> position, register a native `wheel` event listener on the `window` in the
> capture phase (`{ capture: true, passive: false }`) within the `SlideMode`
> component (or a custom hook). This capture-phase listener intercepts the event
> before it bubbles up to React's root listener, allowing you to call
> `e.stopPropagation()` and `e.preventDefault()` to prevent the gallery's
> Ctrl+wheel handler from firing. If `e.altKey` is true, the listener should
> return early without stopping propagation, allowing the event to reach
> `ZoomPan` for zooming. The blast radius includes `SlideMode/index.tsx` (to add
> the listener), `ZoomPan.tsx` (to remove the legacy seek logic and keep only
> Alt+wheel zoom), and `content.scss` (to target Chromium's shadow DOM
> pseudo-elements like `::-webkit-media-controls-panel` to remove the scrim). It
> must deliberately NOT touch `ContentView/index.tsx`. Top risks include event
> listener leaks (mitigated by proper `useEffect` cleanup), breaking Alt+wheel
> zoom, side-panel scroll hijacking, and cross-Chromium CSS drift for the native
> controls.

Point-by-point:

- Capture-phase `window` wheel listener with `{ capture: true, passive: false }`,
  pre-empting React's root bubble handlers — ACCEPTED: this is exactly the
  implemented design (`SlideMode/index.tsx` `useEffect`).
- Alt+wheel returns early WITHOUT `stopPropagation`, so it reaches ZoomPan zoom —
  ACCEPTED: `computeVideoSeekStep` returns `null` for Alt, and the listener
  returns before calling `stopPropagation`.
- Blast radius = `SlideMode/index.tsx` + `ZoomPan.tsx` (remove legacy seek) +
  `content.scss`, and deliberately NOT `ContentView/index.tsx` — ACCEPTED and
  matched: the gallery resize handler is left untouched; the only addition is the
  extracted pure helper `videoSeek.ts` + its unit test.
- Risks: listener leaks (useEffect cleanup), breaking Alt+wheel zoom, side-panel
  scroll hijacking, cross-Chromium CSS drift — ACCEPTED: cleanup removes the
  capture listener on unmount/defocus; Alt zoom preserved; side-panel scroll
  suppression is the documented accepted trade-off (see Open Questions); the CSS
  rule degrades harmlessly if the UA pseudo-element name drifts.

No feedback points were rejected; independent peer consensus fully matched the
drafted approach (callerAgreement 1.0).

## Open Questions

- Should the capture handler exempt wheel events targeted inside scrollable side
  panels (inspector/outliner) so those keep native scroll, or is full seek
  capture (current plan) the desired behavior? Proceeding with full capture per
  the stated requirement; revisit if QA finds it disruptive.
