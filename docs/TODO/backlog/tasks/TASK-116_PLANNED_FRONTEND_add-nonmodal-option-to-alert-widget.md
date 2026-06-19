---
id: TASK-116
title: 'Add an opt-in non-modal mode to the Alert widget (show() vs showModal())'
investigation: INV-031
status: planned
priority: medium
blocked_by: []
date_created: 2026-06-19
date_completed:
files:
  - widgets/popovers/Alert.tsx
---

## What

Add a `modal?: boolean` prop (default `true`) to the shared `Alert` widget so a
caller can open the underlying `<dialog>` with `show()` (non-modal — no top
layer, no `::backdrop`, background stays interactive) instead of `showModal()`
(modal — makes the rest of the page inert). Default `true` preserves the exact
behavior of every existing consumer. Also emit a positioning hook (a
`data-nonmodal` attribute) so SCSS can place a non-modal alert clear of content
behind it.

## Why

The "Keep which version?" prompt uses `Alert`, which always calls
`showModal()`. That puts the dialog in the browser top layer and renders a
backdrop that makes the SlideMode `<video>` behind it inert — the user cannot
seek/play/pause the output they are being asked to evaluate. The root cause is
that `Alert` hard-codes the blocking (modal) behavior with no opt-out. This task
adds the opt-out at the widget level so the class of defect is fixed in the
abstraction.

See [INV-031](../investigations/INV-031_MEDIUM_FRONTEND_keep-which-version-video-controls-inert-under-modal.md).

## Implementation Steps

- [ ] 1. In `widgets/popovers/Alert.tsx`, add `modal?: boolean` to `AlertProps`
      (document: `@default true`). Destructure it in the `Alert` component with a
      default of `true`.
- [ ] 2. In the `open`-effect (the `useEffect` keyed on `[open]`, currently
      `dialog.current.showModal()`), branch:
      `open ? (modal ? el.showModal() : el.show()) : el.close()`. Add `modal` to
      that effect's dependency array so a runtime change is reflected. Keep the
      existing `cancel`-event preventDefault listener unchanged (harmless under
      `show()`).
- [ ] 3. On the `<dialog>` element, set `data-nonmodal={modal === false ? '' : undefined}`
      (or `data-nonmodal={String(!modal)}`) so SCSS can target the non-modal
      case for positioning (consumed by TASK-118). Do not add positioning styles
      in this task.
- [ ] 4. Verify no existing consumer passes `modal` (grep `<Alert` across
      `src/`), so all current call sites keep `modal=true` and are unchanged.

## Done When

- [ ] `Alert` accepts `modal?: boolean` defaulting to `true`; passing
      `modal={false}` opens the dialog via `show()` (no backdrop, background
      interactive), and omitting it / passing `true` opens via `showModal()`
      exactly as before.
- [ ] The non-modal case exposes a `data-nonmodal` hook on the `<dialog>` for
      CSS positioning.
- [ ] `yarn build` succeeds and `yarn test` passes with no behavior change to
      existing `Alert` consumers.
