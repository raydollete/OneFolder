---
id: TASK-152
title: 'MediaQueue drawer: decompose summary into per-count spans with a conditional red badge while collapsed'
investigation: INV-037
status: done
priority: low
blocked_by: [TASK-151]
date_created: 2026-06-23
date_completed: 2026-06-23
files:
  - src/frontend/containers/MediaQueue/index.tsx
---

## What

Replace the single concatenated `summary` string in the media-queue drawer header with
four labeled count spans (queued / processing / done / resolved), each of which renders a
small red notification badge overlay when the drawer is COLLAPSED and that count has
changed since the user last had the drawer open. Wire the toggle handler to clear the
unseen state on open.

## Why

The header concatenates all four counts into one string, so there is no per-count element
to attach a badge to. Decomposing into spans gives each count its own positioning context
for an Apple-style badge that only shows while collapsed.

See [INV-037](../investigations/INV-037_LOW_FRONTEND_media-queue-collapsed-unseen-count-red-badge-bounce.md).
Depends on TASK-151 (provides `unseenCounts` and `markSeen()`).

## Implementation Steps

- [x] 1. In `src/frontend/containers/MediaQueue/index.tsx`, add a small presentational
      badge component near the top (above `MediaQueueDrawer`):
      `const MediaQueueBadge = () => (<span className="media-queue__badge" aria-hidden="true" />);`
      (decorative; the count text already conveys the value to screen readers).
- [x] 2. In `MediaQueueDrawer`, destructure the new store members alongside the existing
      ones: add `unseenCounts` to the existing
      `const { pendingCount, runningItem, completedCount, resolvedCount, isDrawerOpen, items } = mediaQueueStore;`
      → `const { pendingCount, runningItem, completedCount, resolvedCount, isDrawerOpen, items, unseenCounts } = mediaQueueStore;`.
- [x] 3. Compute the processing display value once:
      `const processing = runningItem !== undefined ? 1 : 0;`.
- [x] 4. DELETE the `const summary = ...` template string.
- [x] 5. Replace the `<span className="media-queue__summary">{summary}</span>` element with
      a container that renders four `.media-queue__count` spans separated by ` · `. Each
      span shows `{value} {label}` and, when `!isDrawerOpen && unseenCounts[key]`, also
      renders `<MediaQueueBadge/>`. For example:
      ```tsx
      <span className="media-queue__summary">
        <span className="media-queue__count">
          {pendingCount} queued
          {!isDrawerOpen && unseenCounts.queued && <MediaQueueBadge />}
        </span>
        {' · '}
        <span className="media-queue__count">
          {processing} processing
          {!isDrawerOpen && unseenCounts.processing && <MediaQueueBadge />}
        </span>
        {' · '}
        <span className="media-queue__count">
          {completedCount} done
          {!isDrawerOpen && unseenCounts.done && <MediaQueueBadge />}
        </span>
        {' · '}
        <span className="media-queue__count">
          {resolvedCount} resolved
          {!isDrawerOpen && unseenCounts.resolved && <MediaQueueBadge />}
        </span>
      </span>
      ```
      Keep the wrapper class `media-queue__summary` so the existing `flex: 1` ellipsis
      layout still applies; the count spans live inside it.
- [x] 6. Update the toggle handler so opening clears the unseen state immediately (belt-and
      -suspenders with the store reaction, and makes DOM tests deterministic):
      ```tsx
      const handleToggle = useAction(() => {
        const opening = !mediaQueueStore.isDrawerOpen;
        mediaQueueStore.isDrawerOpen = opening;
        if (opening) {
          mediaQueueStore.markSeen();
        }
      });
      ```
- [x] 7. Confirm the badge JSX uses strict conditional mounting (`{cond && <MediaQueueBadge/>}`),
      NOT a CSS `hidden` toggle, so the element mounts/unmounts and the CSS pop animation
      (TASK-153) fires once on appearance.
- [x] 8. `yarn lint` the file. [deferred to batch build/test at end per project convention]

## Done When

- [ ] The header renders four distinct `.media-queue__count` spans with the same visible
      text as before (`N queued · N processing · N done · N resolved`).
- [ ] Each count span renders a `.media-queue__badge` child ONLY when `!isDrawerOpen` and
      that count's `unseenCounts` flag is true.
- [ ] Opening the drawer (toggle) calls `markSeen()` so badges disappear.
- [ ] No badges render while `isDrawerOpen` is true.
- [ ] `yarn lint` passes for the file.
