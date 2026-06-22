---
id: TASK-141
title: 'New MediaQueue bottom drawer component (+ scss): collapsible, FIFO oldest-on-top, four columns, per-status Status/Actions, mounted in Main.tsx after ContentView'
investigation: INV-035
status: done
priority: high
blocked_by: [TASK-140]
date_created: 2026-06-22
date_completed: 2026-06-22
files:
  - 'src/frontend/containers/MediaQueue/index.tsx'
  - 'resources/style/media-queue.scss'
  - 'src/style.scss'
  - 'src/frontend/containers/Main.tsx'
---

## What

Build the persistent, collapsible bottom drawer that renders `MediaQueueStore.items`
(oldest on top) as a four-column table with per-status Status and Actions cells, and
mount it in `Main.tsx` inside `<main id="main">` AFTER `<ContentView />`. The drawer
auto-opens on the first enqueue (store sets `isDrawerOpen`); the header bar is always
visible and toggles the body.

## Why

This is the user-visible surface of the non-blocking queue: the place where jobs queue,
show progress, wait for a Keep decision, or report failure — all without interrupting
viewing/tagging. It reuses `Collapse.tsx`, `IconSet`, `.loading-spinner`, and
`AppToaster`.

See [INV-035](../investigations/INV-035_HIGH_FRONTEND_media-job-bottom-queue-drawer-non-blocking.md).

## Implementation Steps

- [x] 1. Create `src/frontend/containers/MediaQueue/index.tsx` as an `observer`
      component reading `const { mediaQueueStore } = useStore();`. Render nothing extra
      when `!mediaQueueStore.hasItems` (or render a thin idle bar — match neighboring
      UI; the header bar is the always-visible element once there are items).
- [x] 2. Always-visible header bar: title (e.g. "Media queue") + summary
      `{pendingCount} queued · {runningItem ? '1 processing' : '0 processing'} · {completedCount} done`
      + a chevron (`IconSet`) that toggles `mediaQueueStore.isDrawerOpen`.
- [x] 3. Body wrapped in `Collapse` (`src/frontend/components/Collapse.tsx`) keyed on
      `isDrawerOpen` for the open/close height animation. Inside, a table with columns
      **Original filename | Operation | Status | Actions**, rows in `items` order
      (oldest on top — do NOT reverse).
- [x] 4. Filename cell: clickable control → `mediaQueueStore.focusFileInViewer(item.source)`
      (opens the ORIGINAL). Operation cell: `item.label`.
- [x] 5. Status + Actions per `item.status`:
      - `pending`: Status text `Queued`; Actions `[Cancel]` → `cancel(item.id)`.
      - `running`: Status `Processing… {item.percent ?? '…'}%` with the existing
        `.loading-spinner`; Actions `[Cancel]` → `cancel(item.id)`.
      - `completed`: Status is a `View Completed` control →
        `focusFileInViewer(item.output)` (opens the NEW file); Actions
        `[Keep New] [Keep Original] [Keep Both]` → the matching store actions. Row
        persists until a Keep action (rows may stack).
      - `failed`: Status `Failed`; clicking it toggles inline display of
        `item.errorMessage` (local `useState` per-row); Actions `[Retry] [Dismiss]` →
        `retry(item.id)` / `keepBoth(item)` (keepBoth is a plain row-splice; cancel()
        is a no-op on failed status, so keepBoth is used for Dismiss instead).
- [x] 6. Create `resources/style/media-queue.scss` for the drawer (all project SCSS
      lives in `resources/style/` — no per-component SCSS file mechanism exists in
      this codebase). Imported via `src/style.scss`. Contains: fixed positioning to
      bottom of `#main`, header bar, scrollable body (max-height 14rem), table column
      layout, status colors (queued/processing/done/failed), inline spinner.
- [x] 7. Mount in `Main.tsx`: render `<MediaQueueDrawer />` inside `<main id="main">`
      AFTER `<ContentView />`. Import added.

## Done When

- [x] The drawer renders all `items` oldest-on-top with the four columns and correct
      per-status Status/Actions; the header summary shows live counts.
- [x] Auto-opens on first enqueue; the chevron collapses/expands the body via
      `Collapse`; collapsed state still shows the summary bar.
- [x] Filename opens the original; `View Completed` opens the new file; `Failed` reveals
      the error on click; all action buttons call the corresponding store methods.
- [ ] `yarn lint` / `yarn build` pass (compiles; batch test at end of investigation).
