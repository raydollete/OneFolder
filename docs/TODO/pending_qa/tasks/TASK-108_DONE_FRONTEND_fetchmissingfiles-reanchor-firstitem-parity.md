---
id: TASK-108
title: "fetchMissingFiles: re-anchor firstItem by identity after replacing the list (parity with updateFromBackend)"
investigation: INV-028
status: done # planned | in-progress | blocked | done
priority: medium # critical | high | medium | low
blocked_by: [TASK-106]
date_created: 2026-06-15
date_completed: 2026-06-15
files:
  - src/frontend/stores/FileStore.ts
---

## What

In `FileStore.fetchMissingFiles`, after the inline `runInAction` replaces `fileList` with the missing-only subset and rebuilds `index` (currently lines ~1061-1077), re-anchor `uiStore.firstItem` by identity (live anchor: media-processing pin first, else the current `firstItem` file) before/with the `fileListLastModified` bump — mirroring the sync first-pass of `updateFromBackend`. Today this path replaces the list and bumps `fileListLastModified` but never reconciles `firstItem`, leaving it pointing at a stale index from the old full list.

## Why

The Missing-files view is a small filtered subset of the full list. Because `firstItem` is left at its old (full-list) index, the `fileListLastModified` bump (line ~1076) drives the layout-restore effect (`VirtualizedRenderer.tsx` ~135-140) to `scrollToIndex(firstItem, 'start')` at an arbitrary/stale position. Same overloaded-`firstItem` root cause as the primary bug; here the defect is the ABSENCE of any anchoring rather than a stale snapshot.

See [INV-028](../investigations/INV-028_HIGH_FRONTEND_stale-firstItem-snapshot-snaps-scroll-and-selection-back-after-loading.md) (blast-radius #6).

## Implementation Steps

- [x] 1. In `src/frontend/stores/FileStore.ts`, locate `fetchMissingFiles` and its final `runInAction` (currently ~lines 1061-1077). Verify line numbers before editing.
- [x] 2. Confirm the generation guard at the top of that `runInAction` (`if (gen !== this.fetchGeneration) { this.logStaleDrop('missing-inline', gen); return; }`, ~line 1064) stays first — the re-anchor must run only for the current generation.
- [x] 3. After the loop that rebuilds `this.index` (~lines 1072-1075) and before or alongside `this.fileListLastModified = new Date();` (~line 1076), re-anchor `firstItem` by identity to a live anchor (capture the anchor file id from the CURRENT `uiStore.firstItem` against the OLD list BEFORE `fileList.replace`, then reconcile after the index rebuild — mirroring `updateFromBackend`'s sync pass). Concretely:
  - Before `this.fileList.replace(missingClientFiles)` (~line 1069), capture:
    ```ts
    const { uiStore } = this.rootStore;
    const curFirst = uiStore.firstItem;
    const missingAnchorId =
      uiStore.mediaProcessingFile?.id ??
      (curFirst >= 0 && curFirst < this.fileList.length
        ? this.fileList[curFirst].id
        : undefined);
    ```
  - After the `index` rebuild loop, call `this.reconcileFirstItemTo(missingAnchorId);` (it clamps into range when the anchor file is absent from the Missing subset — the common case here, which is correct: clamp rather than jump).
- [x] 4. Do NOT remove or reorder the existing `numMissingFiles`, `index` rebuild, or `fileListLastModified` logic. Only ADD the capture + reconcile.
- [x] 5. Verify `reconcileFirstItemTo` is callable from this scope (it is a private method on the same class) and that calling it inside the existing `runInAction` is consistent with the surrounding code.

## Done When

- [x] Entering the Missing-files view re-anchors `firstItem` (to the media-processing pin if active, else clamps into range) instead of leaving it at a stale full-list index.
- [x] The generation guard still gates the whole block; no behavior change for stale generations.
- [x] `numMissingFiles`, `index`, and `fileListLastModified` handling unchanged.
