## Context

Video is viewed fullscreen in **slide mode**. `ZoomableImage`
(`src/frontend/containers/ContentView/SlideMode/index.tsx`) branches on
`isFileExtensionVideo(file.extension)` and renders a native `<video controls autoPlay
loop>` element, captured via the callback ref `setSlideVideoRef` into
`slideVideoRef` (a `useRef<HTMLVideoElement | null>`). `SlideView` is the
single-item host; the `Inspector` (which contains the tag editor) is rendered
alongside the video while in slide mode.

Keyboard shortcuts are dispatched centrally by
`UiStore.processGlobalShortCuts(e)`, registered on `window` in `App.tsx`. It
early-returns when `e.target` matches `'input'`, matches the event against
`hotkeyMap` via `hotkeyParser`, and calls `e.preventDefault()` on a match.

**The blocking conflict:** `defaultHotkeyMap.viewSlide` is already `'space'` and
dispatches `toggleSlideMode()`. So today, pressing Space while viewing a video in
slide mode *exits* slide mode, and because `processGlobalShortCuts` calls
`preventDefault()` on the match, the browser's native `<video>` space-to-toggle is
also suppressed. Any play/pause-on-space feature must therefore intercept Space
*before* the `viewSlide` branch runs.

## Goals / Non-Goals

**Goals:**
- Space toggles Play/Pause for the video shown in slide mode, driven by the
  element's real `paused` state (no separate drift-prone flag).
- Space must NOT toggle playback while a text-entry surface (e.g. the Inspector tag
  editor, search, rename) has focus — it must insert a space normally.
- Do not regress the existing Space→exit-slide behavior for images (non-video
  items).

**Non-Goals:**
- No other transport controls (seek, volume, fullscreen, next/prev) in this change.
- No gallery/grid playback toggling — scope is the focused slide-mode video only.
- No user-remappable binding for this action in this change (see Decisions).

## Decisions

### D1: Intercept Space inside `processGlobalShortCuts`, before the `viewSlide` branch

Add an early branch in `UiStore.processGlobalShortCuts`: when the combo is Space
**and** `isSlideMode` is true **and** the current `slideFile` is a video **and** an
active slide-video element is registered, toggle that element's playback
(`el.paused ? el.play() : el.pause()`), call `preventDefault()`, and return before
the `viewSlide` handling.

Rationale: this reuses the one dispatcher that already owns Space and already calls
`preventDefault()`, and it reuses the existing input-target guard so we do not
re-implement focus handling. It avoids the fragility of two `window` `keydown`
listeners (App.tsx's global listener and SlideView's arrow-key listener both fire
in the bubble phase — relying on registration order + `stopImmediatePropagation`
would be brittle).

- **Alternative — handle in `SlideView.handleUserKeyPress` + `stopImmediatePropagation`:**
  rejected. Both listeners are on `window` in the bubble phase; winning the race
  depends on listener registration order, which is exactly the kind of implicit
  coupling we want to avoid.
- **Alternative — add a remappable `toggleVideoPlayback: 'space'` entry to
  `IHotkeyMap`:** rejected for now. Space is already the `viewSlide` combo; two map
  entries sharing one combo makes resolution order ambiguous. A single explicit
  early branch is clearer. Making it remappable can be a follow-up.

### D2: Register the active slide-video element on the UiStore

The video element lives in the component (`slideVideoRef`), but the dispatcher lives
in `UiStore`. In `setSlideVideoRef`, register the element with the store (e.g.
`uiStore.setActiveVideoElement(el)`), and clear it (`setActiveVideoElement(null)`)
when the ref detaches / on unmount. Store it as a plain (non-observable) field —
it is an imperative DOM handle, not reactive state.

Rationale: GalleryItem already controls a `<video>` imperatively via a ref, so this
pattern is established. Keeping it non-observable avoids spurious MobX reactions.

- **Alternative — `document.querySelector('video')` from the store:** rejected as a
  fallback-first approach; an explicit registered handle is less brittle and matches
  "fail loud" (if the branch runs with no element registered, that is a detectable
  bug rather than a silent wrong-element match).

### D3: Toggle from the element's real state

Read `el.paused` at press time and call `play()`/`pause()` accordingly. No separate
`isPlaying` boolean is introduced, satisfying the spec's "never drift" requirement.
`play()` returns a promise that can reject (autoplay policy) — swallow only its
rejection at the call site (it is the documented browser contract), while keeping
the overall handler fail-loud.

### D4: Preserve the text-entry guard

The gating condition (`isSlideMode && slideFile is video`) plus the existing
`'input'` early-return already prevents hijacking most typing. Because the Inspector
tag editor is visible in slide mode, verify during implementation whether it uses a
plain `<input>` (covered by the existing guard) or a `textarea`/`contenteditable`
(not covered) and extend the guard if needed so a focused editor still receives the
space character.

## Risks / Trade-offs

- **[Tag editor / other editable surfaces not covered by the `'input'` guard]** →
  Verify the tag-editor element type; extend the guard to `textarea`/editable and
  add a rendered-component test that a focused editor receives the space.
- **[Listener-ordering regressions]** → By centralizing in `processGlobalShortCuts`
  we avoid adding a competing `window` listener; SlideView's existing handler is not
  touched.
- **[Autoplay/`play()` promise rejection]** → Catch the `play()` promise rejection
  locally; do not let it surface as an unhandled rejection.
- **[Images must still exit on Space]** → The early branch is gated on the item being
  a video, so image slide mode is unaffected; cover with a test/asserted manual case.

## Migration Plan

Pure additive renderer behavior; no data, IPC, or dependency changes. Rollback is
reverting the branch — no persisted state or schema is touched.

## Open Questions

- Should this action eventually become a user-remappable hotkey (`toggleVideoPlayback`)?
  Deferred; noted as a possible follow-up (D1 alternative).
