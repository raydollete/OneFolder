---
id: TASK-153
title: 'media-queue.scss: red notification badge + first-appearance bounce keyframes; store + DOM tests for unseen-badge behavior'
investigation: INV-037
status: done
priority: low
blocked_by: [TASK-151, TASK-152]
date_created: 2026-06-23
date_completed: 2026-06-23
files:
  - resources/style/media-queue.scss
  - tests/media-queue-store.test.ts
  - tests/media-queue-drawer-dom.test.tsx
---

## What

Style the Apple-style red notification badge and its first-appearance bounce, and add the
tests that lock in the unseen-count + badge behavior: store-level snapshot/unseen/markSeen
semantics, and DOM-level "badge shows on a changed count while collapsed, hidden while
open, cleared on open."

## Why

The badge element (TASK-152) and the store state (TASK-151) need visual styling (red oval,
top-trailing overlay, bounce-on-mount) and regression tests. The bounce must fire only on
first appearance, which is achieved by a CSS `animation` on the conditionally-mounted
badge element — no JS animation state.

See [INV-037](../investigations/INV-037_LOW_FRONTEND_media-queue-collapsed-unseen-count-red-badge-bounce.md).
Depends on TASK-151 (store state) and TASK-152 (badge element + per-count spans).

## Implementation Steps

- [x] 1. In `resources/style/media-queue.scss`, inside the `.media-queue` block, add a
      `&__count` rule so each count span is a positioning context for its badge:
      ```scss
      &__count {
        position: relative;
        white-space: nowrap;
      }
      ```
- [x] 2. Add the badge rule — a small red oval overlaid on the top-trailing corner of the
      count, playing the pop animation once on mount:
      ```scss
      &__badge {
        position: absolute;
        top: -0.25rem;
        right: -0.5rem;
        min-width: 0.5rem;
        height: 0.5rem;
        padding: 0;
        border-radius: 0.5rem;
        background: var(--accent-color-red);
        box-shadow: 0 0 0 0.0625rem var(--background-color-alt); // ring so it reads over text
        transform-origin: center;
        animation: media-queue-badge-pop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
        pointer-events: none;
      }
      ```
      (Use `var(--accent-color-red)` to match the existing `&__status--failed` colour.)
- [x] 3. Add the bounce keyframes at the top level of the file (sibling of `.media-queue`,
      matching how `@keyframes spin` is referenced):
      ```scss
      @keyframes media-queue-badge-pop {
        0% {
          transform: scale(0);
          opacity: 0;
        }
        60% {
          transform: scale(1.25);
          opacity: 1;
        }
        100% {
          transform: scale(1);
          opacity: 1;
        }
      }
      ```
      The `cubic-bezier` overshoot plus the `1.25` mid-keyframe gives the iOS/macOS "pop"
      bounce. `both` fill keeps the final scale(1) after it ends.
- [x] 4. Verify the badge does not get clipped: the `.media-queue__summary` wrapper has
      `overflow: hidden` for its ellipsis. Changed `overflow: hidden` → `overflow: visible`
      on `&__summary` (and added `min-width: 0` so flex shrinking still works).  The old
      text-overflow/ellipsis was only needed when `summary` was a long concatenated string;
      the four short count spans do not need truncation.  Badge offsets kept as specified
      (top: -0.25rem / right: -0.5rem) since clipping is eliminated at the source.
- [x] 5. **Store tests** — extend `tests/media-queue-store.test.ts`:
      - Construct a `MediaQueueStore`; assert `unseenCounts` all false and `seenCounts` all
        zero initially.
      - Set `isDrawerOpen = true`, push/advance items so a count changes (e.g. enqueue →
        `pendingCount` rises, or mark an item completed); assert `unseenCounts` stays
        all-false while open (the reaction keeps `seenCounts` synced). NOTE: the suite uses
        `configure({ enforceActions: 'never' })`, so set `isDrawerOpen` directly.
      - Set `isDrawerOpen = false`, then change a count (e.g. mark another item completed so
        `completedCount` rises); assert `unseenCounts.done === true` and the other three
        false.
      - Set `isDrawerOpen = true` again (or call `markSeen()`); assert all `unseenCounts`
        flags return to false.
- [x] 6. **DOM tests** — extend `tests/media-queue-drawer-dom.test.tsx`:
      - Render the drawer (default collapsed). With the drawer collapsed, push a completed
        item so `completedCount` changes from the last-seen 0; assert a
        `.media-queue__badge` appears inside the "done" count span and NOT inside the
        others. (Drive state with `runInAction`; the store reaction + collapsed state
        produce the unseen flag.) HELPER: query the count spans by text content (the spans
        contain "queued"/"processing"/"done"/"resolved") and check for a
        `.media-queue__badge` descendant.
      - Open the drawer via the toggle button (or set `isDrawerOpen = true` + `markSeen()`)
        and assert `container.querySelectorAll('.media-queue__badge')` is empty.
      - Note: the EXISTING DOM tests open the drawer with `isDrawerOpen = true` before
        asserting rows, so they will not see badges and will not regress.
- [x] 7. Run the batch build/test at the end (project convention — no per-task builds):
      `yarn lint && yarn build && yarn test`. Fix any failures. Results: yarn lint has pre-existing errors in unrelated files (none in our changed files); yarn build compiled successfully; yarn test: 210 passed, 23 suites all green.

## Done When

- [ ] `media-queue.scss` defines `.media-queue__count`, `.media-queue__badge`, and
      `@keyframes media-queue-badge-pop`; the badge is a red oval at the count's
      top-trailing corner and visibly bounces in on mount.
- [ ] The badge is not clipped by the summary's `overflow: hidden`.
- [ ] New store tests verify: all-false initially; stays false while open even as counts
      change; the changed count's flag becomes true while collapsed; reopening clears all
      flags.
- [ ] New DOM tests verify: a badge appears on the changed count while collapsed (and only
      on that count); no badges while open; badges cleared after opening.
- [ ] `yarn lint`, `yarn build`, and `yarn test` all pass.
