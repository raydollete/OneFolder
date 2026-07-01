## 1. Register the active slide-video element on the store

- [x] 1.1 Add a non-observable `activeVideoElement: HTMLVideoElement | null` field and `setActiveVideoElement(el)` method to `UiStore` (`src/frontend/stores/UiStore.ts`).
- [x] 1.2 In `setSlideVideoRef` (`SlideMode/index.tsx`), call `uiStore.setActiveVideoElement(el)` when the element attaches and `setActiveVideoElement(null)` when it detaches/unmounts, without disturbing the existing `mediaReleaseCoordinator` / freeze-recovery / mute wiring.

## 2. Intercept Spacebar for video playback

- [x] 2.1 In `UiStore.processGlobalShortCuts`, add an early branch — before the `viewSlide` handling — that fires when the combo is Space AND `isSlideMode` AND the current `slideFile` is a video (`isFileExtensionVideo`) AND `activeVideoElement` is set.
- [x] 2.2 In that branch, toggle playback from the element's real state: `el.paused ? el.play() : el.pause()`; catch the `play()` promise rejection locally; then `e.preventDefault()` and return so `toggleSlideMode()` does NOT run.
- [x] 2.3 Confirm non-video slide items still fall through to the existing `viewSlide` → `toggleSlideMode()` behavior (Space exits slide mode for images).

## 3. Protect text entry

- [x] 3.1 Inspect the Inspector tag editor (and search/rename) element types; confirm whether the existing `'input'` early-return in `processGlobalShortCuts` covers them, and extend the guard to `textarea`/`contenteditable` if any editable surface is not covered.
- [x] 3.2 Ensure Space still enters a space character when such an editor is focused, even while a video is present in slide mode.

## 4. Tests

- [x] 4.1 Add a rendered-component/unit test: with a video in slide mode and a paused mock `<video>` registered, dispatching a Space keydown calls `play()`, `preventDefault()` is called, and `toggleSlideMode()` is NOT called.
- [x] 4.2 Add a test for the inverse (playing video → `pause()`), plus a test that a focused text editor receives the space and playback is not toggled.
- [x] 4.3 Add/adjust a test asserting Space on a non-video slide item still toggles slide mode (no regression).

## 5. Verification

- [x] 5.1 Run `yarn lint` and `yarn test`; fix issues.
- [x] 5.2 REQUIRES MANUAL EXECUTION (Windows/GUI): open a video in slide mode, press Space to confirm play↔pause toggles from the real state; press Space over an image to confirm it still exits slide mode; focus the tag editor and confirm Space types a space. Capture concrete evidence per the manual-QA gate (`docs/TODO/QA-DISCIPLINE.md`).
