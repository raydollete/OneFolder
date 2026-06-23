---
id: TASK-150
title: 'Extend media-queue jsdom tests and tool docs for the four QA fixes: no auto-open, plain-object clip to startMediaJob, resolved-rows-to-bottom + clearResolved, and correct Dismiss labeling'
investigation: INV-036
status: planned
priority: medium
blocked_by: [TASK-146, TASK-147, TASK-148, TASK-149]
date_created: 2026-06-23
date_completed:
files:
  - 'src/frontend/stores/__tests__/MediaQueueStore.test.ts'
  - 'src/frontend/containers/MediaQueue/__tests__/MediaQueue.test.tsx'
  - 'docs/TOOLS.md'
  - 'docs/create-clip.md'
  - 'docs/subtract-clip.md'
---

## What

Extend the existing INV-035 jsdom test suites to lock in the four INV-036 behaviors, and
update the media-tool docs to describe the always-present default-collapsed full-width
drawer with resolved rows. Tests are agent-reachable; this also serves as the regression
guard for the QA fixes. Run the full suite once as part of the end-of-investigation batch.

## Why

The four QA fixes change observable store/component behavior (clip serialization, drawer
visibility, resolved-row lifecycle/ordering, Dismiss labeling) and the documented UX. The
INV-035 tests cover the original behavior; they must be extended so the fixes can't
silently regress, and the docs must match the new flow. This is the tests/docs task,
implemented after all four code changes (TASK-146–149).

See [INV-036](../investigations/INV-036_HIGH_FRONTEND_media-queue-drawer-qa-fixes-clip-clone-always-visible-resolved-rows-fullwidth.md).

## Implementation Steps

### Store tests — `src/frontend/stores/__tests__/MediaQueueStore.test.ts`

- [ ] 1. **Plain-object clip (Change 2):** enqueue a clip-bearing job; assert
      `RendererMessenger.startMediaJob` was called with a third argument that is a plain
      object (not a MobX proxy) deep-equal to the clip — e.g. assert
      `isObservable(arg) === false` and the value matches `{ start, end }`. A no-clip job
      passes `undefined`.
- [ ] 2. **No auto-open (Change 1):** assert `isDrawerOpen === false` after `enqueue`
      (the drawer no longer opens itself). Update/replace the old INV-035 assertion that
      expected `isDrawerOpen === true` after enqueue.
- [ ] 3. **Resolved lifecycle (Change 3):**
      - `keepNew` → row stays with `status==='resolved'`, `resolution==='Kept new'`, and
        the source was trashed.
      - `keepOriginal` → `resolution==='Kept original'`, output trashed, viewer-on-output
        guard still fires.
      - `keepBoth` → `resolution==='Kept both'`, nothing trashed.
      - `dismiss` → `resolution==='Dismissed'` (and the failed row is now resolved, not
        removed).
      - `resolvedCount` reflects the count; `clearResolved` removes all resolved rows and
        leaves unresolved rows intact.
      - new enqueues land above resolved rows (insertion order preserved in `items`).

### Component tests — `src/frontend/containers/MediaQueue/__tests__/MediaQueue.test.tsx`

- [ ] 4. **Always-present/empty placeholder (Change 1):** render with an empty store;
      assert the header + summary render, the summary reads `0 queued · 0 processing · 0
      done`, and the "No media jobs yet" placeholder shows (no table).
- [ ] 5. **Resolved-to-bottom ordering + branch (Change 3):** seed a mix of unresolved and
      resolved items; assert resolved rows render after all unresolved rows; a resolved row
      shows its `resolution` text, has an empty Actions cell, and a clickable filename.
- [ ] 6. **Clear resolved + summary (Change 3):** assert the "Clear resolved" control shows
      only when `resolvedCount > 0`, clicking it calls `clearResolved`, and the summary
      includes `· {n} resolved`.
- [ ] 7. **Dismiss labeling (Change 3):** on a failed row, clicking Dismiss calls
      `mediaQueueStore.dismiss` (not `keepBoth`) and the row becomes resolved with
      `resolution==='Dismissed'`.

### Docs

- [ ] 8. Update `docs/TOOLS.md` to describe the always-present, default-collapsed,
      full-window-width drawer; resolved rows sinking to the bottom; the "Clear resolved"
      control; and that clip jobs (Create/Subtract Clip) enqueue and run normally.
- [ ] 9. Update `docs/create-clip.md` and `docs/subtract-clip.md` to note the clip jobs run
      through the queue without the prior structured-clone error. Update any INV-035
      wording/screenshots that described the auto-open or content-only width.

### Build/test

- [ ] 10. Run `yarn test` for the two suites and fix until green. Then, as the
      end-of-investigation batch, run `yarn lint` and `yarn build` and confirm both pass.

## Done When

- [ ] All new/updated store + component assertions (steps 1–7) pass under `yarn test` with
      IPC and `finalizeEncodedOutput`/`trashFile` mocked (no real ffmpeg).
- [ ] `docs/TOOLS.md`, `docs/create-clip.md`, and `docs/subtract-clip.md` reflect the four
      QA fixes.
- [ ] End-of-investigation batch: `yarn lint`, `yarn test`, `yarn build` all pass.
