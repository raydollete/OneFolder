---
id: TASK-148
title: 'Keep resolved rows and sink them to the bottom: add resolved status + resolution label, mark-resolved Keep/Dismiss actions, resolvedCount, clearResolved, render-time sort, and a "Clear resolved" control'
investigation: INV-036
status: planned
priority: high
blocked_by: [TASK-147]
date_created: 2026-06-23
date_completed:
files:
  - 'src/frontend/stores/MediaQueueStore.ts'
  - 'src/frontend/containers/MediaQueue/index.tsx'
  - 'resources/style/media-queue.scss'
---

## What

Stop discarding rows when the user resolves them. Add a `resolved` status and a
`resolution` label to `QueueItem`; make `keepNew`/`keepOriginal`/`keepBoth` mark the row
resolved (after their existing trash work) instead of splicing it; add a dedicated
`dismiss` action for failed rows (replacing the mislabeled `keepBoth` reuse); add a
`resolvedCount` computed and a `clearResolved` bulk action. In the drawer, sort
unresolved rows above resolved rows at render time, render a resolved row branch, add a
"Clear resolved" header control (shown only when there are resolved rows), and extend the
summary with the resolved count.

## Why

QA found resolved/dismissed rows are spliced away (no record), interleaved with live work,
and the failed-row Dismiss button mislabels its action by calling `keepBoth`. The user
wants resolved rows kept, sorted to the bottom, labeled, and clearable in bulk, with new
enqueues appearing above resolved rows. This is **Change 3** (order 2 → 1 → 3 → 4) and
depends on the store/component existing and the always-visible drawer (TASK-147).

See [INV-036](../investigations/INV-036_HIGH_FRONTEND_media-queue-drawer-qa-fixes-clip-clone-always-visible-resolved-rows-fullwidth.md).

## Implementation Steps

### Store — `src/frontend/stores/MediaQueueStore.ts`

- [ ] 1. Extend the `QueueItem.status` union to include `'resolved'`:
      `'pending' | 'running' | 'completed' | 'failed' | 'resolved'`.
- [ ] 2. Add `@observable resolution: string | null = null;` to `QueueItem` (initialize to
      `null` in the constructor).
- [ ] 3. `keepNew`: after the existing `await trashFile(item.source)`, instead of splicing
      the row, set (in a `runInAction`) `item.status = 'resolved'; item.resolution = 'Kept new';`.
- [ ] 4. `keepOriginal`: keep the existing viewer-on-output guard
      (`if (uiStore.firstFileInView === item.output) this.focusFileInViewer(item.source)`)
      and the `await trashFile(item.output)`; then instead of splicing, set (in
      `runInAction`) `item.status = 'resolved'; item.resolution = 'Kept original';`.
- [ ] 5. `keepBoth`: instead of splicing, set
      `item.status = 'resolved'; item.resolution = 'Kept both';` (no trash).
- [ ] 6. Add `@action.bound dismiss(item: QueueItem): void` that sets
      `item.status = 'resolved'; item.resolution = 'Dismissed';`. (This is the correct
      action for the failed-row Dismiss button, which currently mislabels via `keepBoth`.)
- [ ] 7. Add `@computed get resolvedCount(): number` →
      `this.items.filter((it) => it.status === 'resolved').length`.
- [ ] 8. Add `@action.bound clearResolved(): void` that filters resolved items out of the
      array, e.g. `this.items = this.items.filter((it) => it.status !== 'resolved');`.
- [ ] 9. Leave `retry` unchanged. Do NOT reorder the `items` array anywhere — insertion
      order is preserved so new enqueues naturally sit above resolved rows once the
      render-time sort is applied.

### Drawer — `src/frontend/containers/MediaQueue/index.tsx`

- [ ] 10. Render-time sort: before mapping rows, derive a sorted copy —
      unresolved (`status !== 'resolved'`) first ordered by `requestedAt`, then resolved
      ordered by `requestedAt`. Do NOT mutate the store array; sort a shallow copy. Example:
      ```ts
      const ordered = [...items].sort((a, b) => {
        const ar = a.status === 'resolved' ? 1 : 0;
        const br = b.status === 'resolved' ? 1 : 0;
        return ar - br || a.requestedAt - b.requestedAt;
      });
      ```
- [ ] 11. Add a `status === 'resolved'` branch in `QueueRow`: Status cell shows
      `item.resolution` with class `media-queue__status--resolved`; Actions cell is empty;
      the filename cell stays clickable (`focusFileInViewer(item.source)`).
- [ ] 12. Repoint the failed-row Dismiss button from `mediaQueueStore.keepBoth(item)` to
      `mediaQueueStore.dismiss(item)`. Remove the stale comment that explained the
      `keepBoth`-as-Dismiss workaround.
- [ ] 13. Add a "Clear resolved" control to the header, shown only when
      `mediaQueueStore.resolvedCount > 0`, wired to `mediaQueueStore.clearResolved()`.
- [ ] 14. Extend the summary string with `· ${resolvedCount} resolved`, e.g.
      `${pendingCount} queued · ${runningItem !== undefined ? '1' : '0'} processing · ${completedCount} done · ${resolvedCount} resolved`.

### Styles — `resources/style/media-queue.scss`

- [ ] 15. Add `&__status--resolved { color: var(--text-color-muted); }` under the
      `.media-queue` block (alongside the other `&__status--*` rules).

## Done When

- [ ] Choosing Keep New / Keep Original / Keep Both marks the row `resolved` with the
      matching label ("Kept new" / "Kept original" / "Kept both") and performs the same
      trash side-effects as before; the row is NOT removed.
- [ ] The failed-row Dismiss button records `resolution === 'Dismissed'` (not "Kept both").
- [ ] Resolved rows render below all unresolved rows; within each group, oldest-first by
      `requestedAt`; new enqueues appear above resolved rows.
- [ ] "Clear resolved" appears only when `resolvedCount > 0` and removes all resolved rows;
      the summary shows `· {n} resolved`.
- [ ] Resolved rows show their resolution in muted color and have an empty Actions cell; the
      filename remains clickable.
- [ ] `yarn lint` / `yarn build` compile (batch test at end of investigation).
