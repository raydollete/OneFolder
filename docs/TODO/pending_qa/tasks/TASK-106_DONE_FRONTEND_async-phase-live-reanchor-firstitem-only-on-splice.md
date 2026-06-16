---
id: TASK-106
title: "updateFromBackend async phase: re-anchor firstItem to the LIVE position, and only when a splice changed the list"
investigation: INV-028
status: done # planned | in-progress | blocked | done
priority: high # critical | high | medium | low
blocked_by: []
date_created: 2026-06-15
date_completed: 2026-06-15
files:
  - src/frontend/stores/FileStore.ts
  - docs/TOOLS.md
---

## What

Fix the primary cause of the scroll snap-back. In `FileStore.updateFromBackend`'s asynchronous existence-check `.then()`, stop unconditionally re-applying the start-of-fetch `firstItem` anchor (line ~1682). Instead: (1) track a `splicedList` flag set inside both async splice blocks; (2) only re-anchor `firstItem` when a splice actually changed the list; (3) when re-anchoring, resolve a LIVE anchor id (`mediaProcessingFile?.id ?? fileList[current uiStore.firstItem]?.id`) read at the moment of reapply, not the stale `anchorFileId` captured at fetch start.

## Why

`uiStore.firstItem` is overloaded as both a live scroll cursor (written on every scroll by VirtualizedRenderer) and a fetch-time anchor. The async `.then()` reapplies the start-of-fetch snapshot after the user scrolled during the slow existence-check window, then the splice's `fileListLastModified` bump drives a `scrollToIndex(firstItem, 'start')` that snaps the viewport back. The INV-009 generation guard does not catch this — it is the same fetcher's own pre-await snapshot going stale, not a competing fetcher.

See [INV-028](../investigations/INV-028_HIGH_FRONTEND_stale-firstItem-snapshot-snaps-scroll-and-selection-back-after-loading.md) (Defects A + B).

## Implementation Steps

- [x] 1. In `src/frontend/stores/FileStore.ts`, locate `updateFromBackend(backendFiles, generation)` and its async `.then()` block following `promiseAllLimit(existenceCheckPromises, N)` (currently lines ~1630-1699). Verify the current line numbers before editing; do not trust these blindly.
- [x] 2. Inside the `transaction(() => { ... })` of the `.then()`, declare a local `let splicedList = false;` at the top of the transaction body (before the broken-file splice block, ~line 1646).
- [x] 3. In the broken-file splice block (`if (shouldHide && brokenCount > 0)`, ~lines 1649-1657), set `splicedList = true;` (alongside the existing `fileListLastModified` bump).
- [x] 4. In the video-only splice block (`if (showVideosOnly)`, ~lines 1663-1675), set `splicedList = true;`.
- [x] 5. Replace the unconditional re-anchor at ~line 1682 (`this.reconcileFirstItemTo(anchorFileId);`) with a splice-gated LIVE re-anchor. Read the live cursor at reapply time and prefer the media-processing pin:
  ```ts
  if (splicedList) {
    const { uiStore } = this.rootStore;
    const curFirst = uiStore.firstItem;
    const liveAnchorId =
      uiStore.mediaProcessingFile?.id ??
      (curFirst >= 0 && curFirst < this.fileList.length
        ? this.fileList[curFirst].id
        : undefined);
    this.reconcileFirstItemTo(liveAnchorId);
  }
  ```
  When no splice occurred, do NOT call `reconcileFirstItemTo` at all in the async phase — the sync first-pass (line ~1626) already anchored correctly and any later movement is the user's own scroll.
- [x] 6. Do NOT change the SYNC first-pass `reconcileFirstItemTo(anchorFileId)` at ~line 1626. Do NOT change the INV-009 generation guards at ~line 1554 (sync) and ~line 1636 (async). Do NOT change `anchorFileId` capture at ~lines 1591-1596 (still used by the sync pass). Do NOT change the media-processing `pinnedFileId` logic at ~line 1580.
- [x] 7. Append the firstItem dual-role invariant to `docs/TOOLS.md` section 6 ("SlideMode + refetch...", ~line 169): note that `firstItem` is both a live scroll cursor and a fetch-time anchor; the async existence-check phase re-anchors only on splice and to the LIVE position (media-processing pin first), never to the start-of-fetch snapshot. Reference INV-028.

## Done When

- [x] The async `.then()` re-anchors `firstItem` only when `splicedList === true`, and uses a live anchor resolved at reapply time (media-processing pin first), not the captured `anchorFileId`.
- [x] No-splice async resolutions leave `firstItem` untouched in the async phase.
- [x] Sync first-pass reconcile, INV-009 generation guards, and the media-processing pin are unchanged.
- [x] `docs/TOOLS.md` section 6 documents the dual-role invariant and references INV-028.
- [ ] Project type-checks (deferred batch `yarn build` covered by TASK-110).
