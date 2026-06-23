---
id: TASK-151
title: 'MediaQueueStore: add seen-count snapshot, unseen-count computeds, and open-clears-unseen reaction'
investigation: INV-037
status: done
priority: low
blocked_by: []
date_created: 2026-06-23
date_completed: 2026-06-23
files:
  - src/frontend/stores/MediaQueueStore.ts
---

## What

Add the "last-seen counts" state to `MediaQueueStore` so the drawer can tell which of the
four header counts (queued / processing / done / resolved) have changed since the user last
had the drawer open. Adds an observable snapshot (`seenCounts`), computeds for the live
counts and the per-count unseen flags, a `markSeen()` action, and a MobX reaction that
keeps the snapshot equal to live counts whenever the drawer is open (which also clears the
unseen state the instant the drawer opens).

## Why

The header is "always live, always seen" today — there is no record of what the user last
saw, so there is no way to compute a delta to badge while collapsed. The store owns both
`isDrawerOpen` and all four count sources, so it is the authoritative place to model the
seen-vs-live distinction.

See [INV-037](../investigations/INV-037_LOW_FRONTEND_media-queue-collapsed-unseen-count-red-badge-bounce.md).

## Implementation Steps

- [x] 1. In `src/frontend/stores/MediaQueueStore.ts`, ensure `reaction` (or `autorun`) is
      imported from `mobx` (alongside the existing `action, computed, makeObservable,
      observable, runInAction, toJS`).
- [x] 2. Define a small type for the count shape near the top of the file (not exported is
      fine, but exporting is convenient for the view/tests):
      `export interface MediaQueueCounts { queued: number; processing: number; done: number; resolved: number }`.
- [x] 3. Add an observable snapshot field on `MediaQueueStore`:
      `@observable seenCounts: MediaQueueCounts = { queued: 0, processing: 0, done: 0, resolved: 0 };`
      (zero matches the construction-time live counts — an empty queue).
- [x] 4. Add `@computed get liveCounts(): MediaQueueCounts` returning
      `{ queued: this.pendingCount, processing: this.runningItem !== undefined ? 1 : 0,
      done: this.completedCount, resolved: this.resolvedCount }`.
- [x] 5. Add `@computed get unseenCounts(): { queued: boolean; processing: boolean; done:
      boolean; resolved: boolean }` returning, per key, `this.liveCounts[key] !==
      this.seenCounts[key]`. Add `@computed get hasUnseen(): boolean` = any of the four
      flags true.
- [x] 6. Add `@action.bound markSeen(): void` that copies live → seen:
      `this.seenCounts = { ...this.liveCounts };` (assigning a fresh object keeps it a
      tracked observable replacement).
- [x] 7. In the constructor, AFTER `makeObservable(this)`, create a reaction that clears
      unseen whenever the drawer is open and keeps the snapshot tracking live counts while
      open:
      `this.disposeSeenReaction = reaction(() => ({ open: this.isDrawerOpen, live: this.liveCounts }), ({ open }) => { if (open) { this.markSeen(); } }, { fireImmediately: true });`
      Store the disposer in a `private disposeSeenReaction: () => void;` field. (Tracking
      `liveCounts` in the expression means that while open, every count change re-runs the
      effect and re-syncs the snapshot, so on the next collapse `seenCounts` equals exactly
      what was last on screen.)
- [x] 8. `yarn lint` the file; confirm no MobX strict-mode warnings (the reaction effect
      calls the `@action.bound markSeen`, so mutations are inside an action). [deferred to batch build/test at end per project convention]

## Done When

- [ ] `MediaQueueStore` exposes `seenCounts`, `liveCounts`, `unseenCounts`, `hasUnseen`,
      and `markSeen()`.
- [ ] While `isDrawerOpen` is true, `seenCounts` equals `liveCounts` (verified by a unit
      test in TASK-153): mutating a count while open leaves `unseenCounts` all-false.
- [ ] After the drawer is open then set collapsed, changing a count flips exactly that
      key's `unseenCounts` flag to true and leaves the others false.
- [ ] Re-opening the drawer (set `isDrawerOpen = true`) returns all `unseenCounts` flags to
      false.
- [ ] `yarn lint` passes for the file.
