---
id: TASK-147
title: 'Make the media queue drawer always present, default-collapsed, and never auto-open: drop the enqueue auto-open and the empty-state early return, add an empty placeholder'
investigation: INV-036
status: done
priority: high
blocked_by: []
date_created: 2026-06-23
date_completed: 2026-06-24
files:
  - 'src/frontend/stores/MediaQueueStore.ts'
  - 'src/frontend/containers/MediaQueue/index.tsx'
---

## What

Make the queue drawer a stable, always-present surface: it no longer auto-opens when a
job is enqueued, it defaults to collapsed, and it stays mounted (header + summary visible)
even when the queue is empty. When there are no rows, render a muted placeholder instead of
the table. The empty summary already reads `0 queued · 0 processing · 0 done`.

## Why

QA found the INV-035 drawer auto-opens on first enqueue and unmounts entirely when empty,
so there is no predictable place for the queue to live. The user wants it always visible,
default-collapsed, and never auto-opening. This is **Change 1** (order 2 → 1 → 3 → 4).

See [INV-036](../investigations/INV-036_HIGH_FRONTEND_media-queue-drawer-qa-fixes-clip-clone-always-visible-resolved-rows-fullwidth.md).

## Implementation Steps

- [x] 1. `src/frontend/stores/MediaQueueStore.ts` — in `enqueue`, delete the line
      `this.isDrawerOpen = true;`. Keep the observable's default `isDrawerOpen = false`
      so the drawer starts collapsed and never auto-opens. (Leave `this.items.push(item)`
      and `this.processNext()`.)
- [x] 2. `src/frontend/containers/MediaQueue/index.tsx` — delete the early return
      `if (!mediaQueueStore.hasItems) { return null; }` so the root `.media-queue` div and
      the always-visible header bar render unconditionally. (`useTrashFile()`,
      `handleToggle`, and any other hooks already precede this point — keep them above any
      remaining conditional return so Rules of Hooks are preserved.)
- [x] 3. In the same component, render the `<table>` only when there are rows; otherwise
      render a muted placeholder, e.g.:
      ```tsx
      {items.length > 0 ? (
        <table className="media-queue__table"> … </table>
      ) : (
        <div className="media-queue__empty">No media jobs yet</div>
      )}
      ```
      Keep the existing summary string (`${pendingCount} queued · … · ${completedCount} done`),
      which already reads `0 queued · 0 processing · 0 done` when empty.
- [x] 4. (Optional, cosmetic) Add a `.media-queue__empty { color: var(--text-color-muted);
      padding: 0.5rem 0.75rem; }` rule to `resources/style/media-queue.scss` if the
      placeholder needs muted styling. Not required for correctness.

## Done When

- [x] The drawer header bar + summary are visible at all times, including when the queue is
      empty (no `return null`). (Verified: `MediaQueue/index.tsx` — no early return; covered
      by `tests/media-queue-drawer-dom.test.tsx`.)
- [x] The drawer starts collapsed and does NOT open when a job is enqueued
      (`isDrawerOpen` stays `false` through `enqueue`). (Verified: no `isDrawerOpen = true`
      in `enqueue`.)
- [x] With no rows the body shows the "No media jobs yet" placeholder and the summary reads
      `0 queued · 0 processing · 0 done`; with rows it shows the table. (Verified:
      `media-queue__empty` placeholder, `index.tsx:373`.)
- [x] `yarn build` compiles (verified 2026-06-24; `yarn lint` pre-existing unrelated errors).
