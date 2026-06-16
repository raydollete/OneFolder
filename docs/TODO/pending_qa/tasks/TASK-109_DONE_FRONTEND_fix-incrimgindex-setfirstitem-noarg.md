---
id: TASK-109
title: "SlideMode incrImgIndex: pass the computed index to setFirstItem instead of calling it with no argument"
investigation: INV-028
status: done # planned | in-progress | blocked | done
priority: low # critical | high | medium | low
blocked_by: []
date_created: 2026-06-15
date_completed: 2026-06-15
files:
  - src/frontend/containers/ContentView/SlideMode/index.tsx
---

## What

In `SlideMode/index.tsx`, `incrImgIndex` (currently ~line 105-112) calls `uiStore.setFirstItem()` with NO argument, which defaults to `0`. Change it to `uiStore.setFirstItem(index)` to match the sibling `decrImgIndex` (~line 100), so advancing to the next image sets `firstItem` to the correct index.

## Why

`setFirstItem(index: number = 0)` (`UiStore.ts:381`) defaults to 0. `incrImgIndex` computes the right `index` (~line 109) but then calls `setFirstItem()` with no arg, transiently setting `firstItem = 0`. It is currently masked because the next line `selectFile(fileStore.fileList[index], true)` re-corrects `firstItem` via `selectFile`'s internal `setFirstItem(getIndex(...))` (`UiStore.ts:791`). But if a concurrent list mutation makes `fileList[index]` undefined, the correction never runs and the viewer jumps to image 0. Same `firstItem`-mishandling family as the main bug; cheap correctness fix.

See [INV-028](../investigations/INV-028_HIGH_FRONTEND_stale-firstItem-snapshot-snaps-scroll-and-selection-back-after-loading.md) (blast-radius #7).

## Implementation Steps

- [x] 1. In `src/frontend/containers/ContentView/SlideMode/index.tsx`, locate `incrImgIndex` (verify ~lines 105-112).
- [x] 2. Change `uiStore.setFirstItem();` (~line 110) to `uiStore.setFirstItem(index);` — using the `index` already computed on the preceding line (`Math.min(uiStore.firstItem + 1, fileStore.fileList.length - 1)`).
- [x] 3. Confirm the result matches `decrImgIndex` (~line 100), which already passes its computed `index`.
- [x] 4. Do NOT change the `isMediaProcessing` guard, the `selectFile` call, or `decrImgIndex`.

## Done When

- [x] `incrImgIndex` calls `uiStore.setFirstItem(index)` with the computed next index.
- [x] No transient `firstItem = 0` write occurs on next-image; behavior is symmetric with `decrImgIndex`.
