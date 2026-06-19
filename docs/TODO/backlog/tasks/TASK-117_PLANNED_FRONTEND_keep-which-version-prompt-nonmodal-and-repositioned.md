---
id: TASK-117
title: 'Make the "Keep which version?" prompt non-modal so the output video stays interactive'
investigation: INV-031
status: planned
priority: medium
blocked_by: [TASK-116]
date_created: 2026-06-19
date_completed:
files:
  - src/frontend/components/RemovalAlert.tsx
---

## What

Make the `DeleteOriginalAfterJob` ("Keep which version?") prompt render its
`Alert` with `modal={false}` so the native HTML5 `<video>` controls in SlideMode
behind it (seek bar, play/pause, duration/current-time) remain fully
interactive while the prompt is open. The prompt's three choices (Keep
Modified / Keep Original / Keep Both), their handlers, labels, default button,
and recyclability logic are unchanged.

## Why

`DeleteOriginalAfterJob` asks the user to evaluate the freshly-produced output
video and decide whether to keep it, but it opens through the modal `Alert`,
whose `showModal()` makes the video inert. The user must decide blind. Making
only this prompt non-modal lets the user scrub/play/pause the output to make an
informed choice. `MediaJobErrorAlert` in the same file must stay modal and is
NOT touched.

See [INV-031](../investigations/INV-031_MEDIUM_FRONTEND_keep-which-version-video-controls-inert-under-modal.md).

## Implementation Steps

- [ ] 1. In `src/frontend/components/RemovalAlert.tsx`, locate the `Alert`
      rendered by `DeleteOriginalAfterJob` (the one with
      `title="Keep which version?"`, `primaryButtonText="Keep Modified"`,
      `secondaryButtonText="Keep Original"`, `closeButtonText="Keep Both"`).
- [ ] 2. Add the `modal={false}` prop to that `Alert` (the prop added in
      TASK-116). Do not change any of the button handlers (`handleKeepModified`,
      `handleKeepOriginal`, `handleKeepBoth`), the `onClick` dispatch, the
      `open` gating (`source !== null && output !== null`), the recyclability
      `useEffect`, the body text, the icon, or the `type`.
- [ ] 3. Leave `MediaJobErrorAlert` (same file) exactly as-is — it must remain
      modal (`showModal`). Do not add `modal` to it.
- [ ] 4. Confirm the prompt is still mounted in `ContentView/index.tsx` over the
      viewer (no mount change needed); the non-modal dialog renders above the
      `<video>` via normal stacking.

## Done When

- [ ] The "Keep which version?" prompt opens non-modally: with it open, the
      SlideMode video's seek bar, play/pause, and duration/current-time readout
      respond to user input (verified manually in TASK-118).
- [ ] Keep Modified / Keep Original / Keep Both still perform their existing
      trash/keep/switch behavior with unchanged labels and default button.
- [ ] `MediaJobErrorAlert` still blocks the page (unchanged).
- [ ] `yarn build` succeeds and `yarn test` passes.
