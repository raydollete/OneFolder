---
id: TASK-107
title: "VirtualizedRenderer: gate the selection-scroll effect on selection IDENTITY so a count-only refetch doesn't drag the selection back"
investigation: INV-028
status: done # planned | in-progress | blocked | done
priority: high # critical | high | medium | low
blocked_by: [TASK-106]
date_created: 2026-06-15
date_completed: 2026-06-15
files:
  - src/frontend/containers/ContentView/Masonry/VirtualizedRenderer.tsx
---

## What

Rework the selection-scroll `useLayoutEffect` in `VirtualizedRenderer.tsx` (currently lines ~142-151) so it scrolls to the last-selected file only when the SELECTION IDENTITY actually changes (real navigation), not when only `numImages` changed. Derive a `lastSelId` from `fileList[lastSelectionIndex.current]?.id`, keep a `prevSelKeyRef`, and skip `scrollToIndex` when the key is unchanged.

## Why

The selection never leaves across a refetch (selected `ClientFile` objects are reused; `fileSelection` is not persisted but survives). The "selection returns" symptom is the selection-scroll effect re-firing because `lastSelIndex = Math.min(lastSelectionIndex.current, numImages - 1)` (lines ~129-131) changes when a splice changes `numImages`, dragging the surviving selection back into view. Gating on identity makes this robust instead of relying on `LayoutSwitcher`'s cross-component ref reset.

See [INV-028](../investigations/INV-028_HIGH_FRONTEND_stale-firstItem-snapshot-snaps-scroll-and-selection-back-after-loading.md) (Defect C).

## Implementation Steps

- [x] 1. In `src/frontend/containers/ContentView/Masonry/VirtualizedRenderer.tsx`, verify current line numbers for `lastSelIndex` (~129-131) and the selection-scroll `useLayoutEffect` (~142-151) before editing.
- [x] 2. Add a `prevSelKeyRef = useRef<string | undefined>(undefined);` near the other refs (top of the component, alongside `wrapperRef`/`scrollAnchor`, ~line 45-46).
- [x] 3. Compute a stable selection key derived from identity. After `lastSelIndex` is computed, derive:
  ```ts
  const lastSelId =
    lastSelIndex !== undefined ? images[lastSelIndex]?.id : undefined;
  ```
  (Use the `images` prop — the rendered file array — so the id maps to the row that would be scrolled to. Confirm `images` is the correct in-scope file list for this component.)
- [x] 4. Rework the selection-scroll effect so it only scrolls on a genuine selection change. Replace the body of the `useLayoutEffect` (~144-151) with a guard that compares the current selection key against `prevSelKeyRef.current`, and updates the ref:
  ```ts
  useLayoutEffect(() => {
    const selKey = lastSelId; // identity of the last-selected, currently-visible file
    if (
      lastSelIndex !== undefined &&
      fileSelectionSize > 0 &&
      selKey !== prevSelKeyRef.current
    ) {
      scrollToIndex(lastSelIndex);
    }
    prevSelKeyRef.current = selKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastSelId, fileSelectionSize]);
  ```
  Key the effect on `lastSelId` (identity) instead of `lastSelIndex` (a clamped index that moves with list size). This keeps cursor-key navigation scrolling (identity changes when the user moves selection) while suppressing the re-fire when only `numImages` changed and the selected file is the same.
- [x] 5. Do NOT change the layout-restore effect at ~lines 135-140 (`scrollToIndex(uiStore.firstItem, 'start')` on `[layoutUpdateDate]`) or the SlideMode-return effect at ~lines 154-159 (`scrollToIndex(firstItem, 'nearest')`). Those are intended behaviors.
- [x] 6. Do NOT remove the `LayoutSwitcher.tsx` selection-ref reset (lines ~72-75); it stays as defense-in-depth but is no longer load-bearing for this symptom.

## Done When

- [x] The selection-scroll effect fires on real selection/navigation changes (cursor keys, clicks) but NOT when a refetch only changes `numImages` while the selected file is unchanged.
- [x] `prevSelKeyRef` is updated on every run so the next genuine change still scrolls.
- [x] The layout-restore and SlideMode-return scroll effects are unchanged.
- [ ] Behavior is confirmed by the rendered jsdom test in TASK-110 (before: re-fires on count-only refetch; after: does not).
