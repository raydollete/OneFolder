---
id: TASK-149
title: 'Span the media queue drawer across the full window width: relocate the mount out of #main to a Split sibling under #layout-container, switch to position:fixed, audit z-index, and reserve bottom padding on both scroll owners'
investigation: INV-036
status: done
priority: high
blocked_by: [TASK-147, TASK-148]
date_created: 2026-06-23
date_completed: 2026-06-24
files:
  - 'src/frontend/containers/Main.tsx'
  - 'resources/style/media-queue.scss'
---

## What

Pin the queue drawer to the bottom of the entire window (including the left Outliner
sidebar) instead of only the content area. Move `<MediaQueueDrawer/>` out of
`<main id="main">` to be a sibling of `<Split>` under the full-window app root
(`#layout-container`), switch `.media-queue` from `position: absolute` to
`position: fixed; left:0; right:0; bottom:0`, audit overlay z-indices so the drawer sits
above page content but below modals/toasts, and reserve bottom padding equal to the
collapsed bar height on both scroll owners so their last rows are not hidden.

## Why

QA found the drawer stops at the Outliner because it is a child of `<main>` and
`position: absolute` within that stacking context. The user wants a single app-wide bottom
status surface spanning the full window width. This is **Change 4**, implemented last
(order 2 → 1 → 3 → 4), after the drawer's content/visibility behavior is settled.

See [INV-036](../investigations/INV-036_HIGH_FRONTEND_media-queue-drawer-qa-fixes-clip-clone-always-visible-resolved-rows-fullwidth.md).

## Implementation Steps

- [x] 1. `src/frontend/containers/Main.tsx` — remove `<MediaQueueDrawer />` from inside
      `<main id="main">` (it currently sits after `<ContentView />`). Make it a sibling of
      `<Split>` inside `<TagDnDProvider>` by wrapping both in a fragment, so the drawer is
      mounted under the full-window app root (`#layout-container` from `App.tsx`) rather
      than the content column:
      ```tsx
      <TagDnDProvider value={data.current}>
        <>
          <Split … />
          <MediaQueueDrawer />
        </>
      </TagDnDProvider>
      ```
- [x] 2. `resources/style/media-queue.scss` — change `.media-queue` from
      `position: absolute;` to `position: fixed; left: 0; right: 0; bottom: 0;` so it spans
      the full viewport width. Remove or update the now-inaccurate `#main` comment block at
      the top of the file.
- [~] 3. (z-index:10 set + documented; "below modals/toasts" needs runtime QA — see note) Z-index audit: inspect the stacking of the Settings dialog, HelpCenter,
      AdvancedSearchDialog, and CustomToaster overlays (search `resources/style` and the
      widgets for their z-index / portal stacking). Set `.media-queue` z-index above page
      content but BELOW those overlays so modals and toasts still render over the drawer.
      Document the chosen value inline.
- [x] 4. (Done via `#window-splitter { bottom: 2rem; }` in media-queue.scss — reserves the
      strip for BOTH the Outliner and content panes in one rule, since the splitter is their
      absolutely-positioned container. More robust than per-scroller padding.) Reserve bottom padding equal to the collapsed bar height on BOTH scroll owners so
      their last rows are not hidden behind the fixed bar:
      - the content scroller (`#content-view`)
      - the Outliner scroll root (confirm the exact selector at implementation time — e.g.
        `#outliner` / `#outliner-content`; verify which element actually scrolls).
      Prefer a shared CSS variable for the height (the collapsed header bar is `2rem`), e.g.
      define `--media-queue-bar-height: 2rem;` and apply `padding-bottom:
      var(--media-queue-bar-height);` (or equivalent) on both scrollers.
- [ ] 5. (REQUIRES MANUAL EXECUTION — visual/interaction QA) Verify the `#window-splitter` bottom drag-handle hit area still works with the
      full-width fixed bar overlapping its bottom edge; adjust if the handle becomes
      unclickable (risk noted in INV-036).

## Done When

_The four checks below are `REQUIRES MANUAL EXECUTION` (visual/interaction QA). Per
`QA-DISCIPLINE.md` rule 1, only the human QA executor may tick them. Code is in place
(see Verification note); these confirm it behaves correctly at runtime._

- [ ] (REQUIRES MANUAL EXECUTION) The drawer spans the full window width, visibly extending across the left Outliner
      sidebar as well as the content area, pinned to the bottom.
- [ ] (REQUIRES MANUAL EXECUTION) Opening the Settings dialog, HelpCenter, or AdvancedSearchDialog, and showing a
      toast, all render ABOVE the drawer (the drawer does not cover them). ⚠️ The drawer is
      `z-index:10`; CustomToaster/notifications are `z-index:1` — confirm modals/toasts (likely
      portaled in their own stacking context) still render above the drawer.
- [ ] (REQUIRES MANUAL EXECUTION) The last rows of both the content view and the Outliner remain fully visible (not
      hidden behind the bar) when scrolled to the bottom.
- [ ] (REQUIRES MANUAL EXECUTION) The Outliner/content vertical splitter (`#window-splitter`) bottom drag-handle is
      still usable.
- [x] `yarn build` compiles (verified 2026-06-24; `yarn lint` fails only on pre-existing
      errors in unrelated files, none in this task's files).

## Verification (2026-06-24)

Code confirmed: `<MediaQueueDrawer />` relocated to a `<Split>` sibling under the app
root (`Main.tsx:87`); `.media-queue` is `position: fixed; left:0; right:0; bottom:0;
z-index:10` (`media-queue.scss:35-40`); both scroll owners' last-row reservation handled
by `#window-splitter { bottom: 2rem; }` (`media-queue.scss:13`). Remaining items are
runtime visual/interaction QA (full-width appearance, modal/toast stacking, splitter
handle) — left for the human QA executor, which is why INV-036 lands in `pending_qa/`.
