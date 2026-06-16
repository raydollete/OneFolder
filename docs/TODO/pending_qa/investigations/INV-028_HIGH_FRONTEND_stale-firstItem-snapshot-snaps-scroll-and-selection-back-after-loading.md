---
id: INV-028
title: "Stale firstItem snapshot snaps scroll (and selection) back when a slow fetch's existence-check phase resolves after the user scrolled"
reported_bug: "When a large amount of media thumbnails are still loading, the user is able to scroll to different parts of the library, but ultimately, when the library is done loading, the scroll position is snapped back AND some previously selected media returns, despite the user having moved on."
date: 2026-06-15
status: active # active | tasks-created | superseded
superseded_by:
tasks_spawned: [TASK-106, TASK-107, TASK-108, TASK-109, TASK-110]
root_cause_category: wrong-abstraction
affects:
  - "src/frontend/stores/FileStore.ts (updateFromBackend async existence-check .then() re-anchor; fetchMissingFiles inline list replace; reconcileFirstItemTo)"
  - "src/frontend/stores/UiStore.ts (firstItem observable overloaded as both live scroll cursor and fetch-time anchor)"
  - "src/frontend/containers/ContentView/Masonry/VirtualizedRenderer.tsx (layout-restore scroll effect; selection-scroll effect)"
  - "src/frontend/containers/ContentView/Masonry/MasonryRenderer.tsx (async layout recompute on fileListLastModified drives the scroll-restore)"
  - "src/frontend/containers/ContentView/SlideMode/index.tsx (incrImgIndex calls setFirstItem() with no argument)"
---

<!--
  INV-028 is the scroll-position / firstItem sibling of INV-009.
  INV-009 fixed the fileList/content half of the stale-async-snapshot pattern with a
  fetchGeneration token. This investigation fixes the firstItem/scroll-position half,
  which the generation guard does NOT protect: the same fetcher's own pre-await snapshot
  of firstItem goes stale because the user scrolled DURING the existence-check window,
  while the generation stays current the whole time.
-->

## Bug Report

### Observed Behavior

On a large library where thumbnail/metadata loading takes seconds, the user scrolls away from the top of the gallery while files are still loading. When loading finishes, two things happen against the user's will:

1. **Scroll snaps back.** The viewport jumps back to (approximately) the position it was at when the fetch started.
2. **A previously-selected file "returns."** The highlighted selection that the user had scrolled past is yanked back into view.

The user has "moved on" — scrolled to a different part of the library and/or stopped caring about an earlier selection — and the app overrides that intent the moment the background load resolves.

### Expected Behavior

A background load that resolves after the user has scrolled must NOT move the viewport. The user's live scroll position is the source of truth once they have scrolled. Specifically:

1. If the user scrolls during loading, the final scroll position must be wherever the user left it — not where they were when the fetch began.
2. A refetch that merely changes the file count (e.g. a hide-missing or video-only splice removing some entries) must not re-fire a scroll-to-selection that drags an old selection back into view.
3. The legitimate scroll-restore behaviors must be preserved: switching view modes (grid/list/calendar) must retain the scroll position; returning from SlideMode must scroll the viewed file into view; resizing or changing thumbnail size may re-align. The fix targets ONLY the unwanted snap-back caused by a stale anchor, not these intended restores.

### Reproduction Context

Deterministic on any library large enough that the post-fetch existence check (`fse.pathExists` on every file, N=50 concurrency, in `FileStore.updateFromBackend`) takes longer than the user's time-to-scroll, AND a display filter is active so the async `.then()` actually runs its splice + `fileListLastModified` bump. Concretely the snap-back fires when:

- The initial launch fetch (or any refetch) is in flight, its sync first-pass has already shown files, and its async existence-check `.then()` has not yet resolved; AND
- `hideMissingFilesInBrowsing` is on with some broken files present, OR `showVideosOnly` is on (either condition makes the async `.then()` splice `fileList` and bump `fileListLastModified`); AND
- The user scrolls during that window.

On a library with no broken files and both display filters off, the async `.then()` still calls `reconcileFirstItemTo(anchorFileId)` (writing the stale `firstItem`) but does not bump `fileListLastModified`, so the scroll-restore effect is not retriggered and the snap is far less visible (the stale `firstItem` write still lands and can affect the NEXT layout-driven scroll, e.g. a subsequent view-mode switch or SlideMode return). The selection-return half (§Diagnosis defect C) is independent of the splice and can surface whenever `numImages` changes.

---

## Root Cause Analysis

**Category:** wrong-abstraction

### Diagnosis

`uiStore.firstItem` is overloaded with two semantically incompatible roles, and a slow fetch re-applies a stale snapshot of it after the user has scrolled.

#### The overloaded observable

`uiStore.firstItem` (`UiStore.ts`, setter `setFirstItem` at line 381) is used as BOTH:

- **A live scroll cursor.** `VirtualizedRenderer.tsx` `determineRenderRegion` / `handleScroll` (lines 52-103) call `uiStore.setFirstItem(firstImageIndex)` (line 71) on essentially every scroll (throttled 100 ms, line 78-84). So `firstItem` tracks the user's instantaneous scroll position.
- **A fetch-time / view-restore anchor.** `FileStore.updateFromBackend` reads `uiStore.firstItem` at fetch START to capture an anchor file id, and `VirtualizedRenderer.tsx`'s layout-restore effect reads `uiStore.firstItem` to decide where to scroll after a layout change.

These two roles have opposite lifetimes. The cursor must reflect the user's *instantaneous* position; the anchor must be a *stable identity captured at one moment*. Conflating them in one observable is the abstraction mismatch that makes the snapshot-then-reapply pattern dangerous.

#### Defect A — async re-anchor with a stale start-of-fetch snapshot (primary)

In `FileStore.updateFromBackend(backendFiles, generation)` (lines 1550-1700):

1. The anchor is captured at fetch START (lines 1591-1596):
   ```ts
   const anchorFirstItem = this.rootStore.uiStore.firstItem;
   const anchorFileId =
     pinnedFileId ??
     (anchorFirstItem >= 0 && anchorFirstItem < this.fileList.length
       ? this.fileList[anchorFirstItem].id
       : undefined);
   ```
2. The SYNC transaction calls `reconcileFirstItemTo(anchorFileId)` at line 1626. This is **correct** — it runs synchronously before any await, so the user cannot have scrolled yet, and it keeps the viewed file in view across sort/filter/search. Leave it.
3. The ASYNC `.then()` (after `promiseAllLimit(existenceCheckPromises, N)`, lines 1630-1631) is the slow "still loading" window (50-500 ms+ on a large library). Inside it, line 1682 calls `reconcileFirstItemTo(anchorFileId)` **again, unconditionally, with the same start-of-fetch `anchorFileId`** — discarding any scroll the user performed during the existence check.

`reconcileFirstItemTo` (lines 1722-1738) does `uiStore.firstItem = this.index.get(anchorId)` when the anchor file is still present. So the user's live `firstItem` (updated by their scroll) is overwritten with the index of the file that was at the top when the fetch began.

The INV-009 `fetchGeneration` guard does NOT catch this: the generation is still current (it is the SAME fetcher's own continuation, not a competing one), so both guards (sync at 1554, async at 1636) pass. The generation token protects against a *different* fetcher winning the race; it does nothing about the *same* fetcher's own pre-await snapshot going stale because the user scrolled.

#### Defect B — the stale `firstItem` write is weaponized into a visible snap by the layout-restore effect

The async `.then()` bumps `fileListLastModified` inside its splice blocks: the broken-file splice (line 1656, default `hideMissingFilesInBrowsing === true`) and the video-only splice (line 1674). Each bump flows through:

- `MasonryRenderer.tsx` layout-recompute effect, deps `[numImages, fileStore.fileListLastModified]` (lines 117-141) → `await worker.compute(...)` → `setLayoutTimestamp(new Date())` (line 133).
- `VirtualizedRenderer.tsx` layout-restore effect `useLayoutEffect([layoutUpdateDate])` (lines 135-140) → `scrollToIndex(uiStore.firstItem, 'start')` (line 137).

So immediately after Defect A overwrote `firstItem` with the stale anchor, the layout recompute fires a `scrollToIndex` to that stale `firstItem` with `'start'` alignment — the visible snap-back. The layout-restore effect runs on EVERY layout recompute (every `fileListLastModified` bump), which is what turns the stale write into a forced re-align rather than a harmless internal value.

#### Defect C — selection "returns" because selection is never lost, only re-scrolled-to

The selection does not actually leave. It is NOT persisted (`fileSelection` is absent from `UiStore.getPersistentPreferences`, lines 1286-1326 — note `firstItem` IS persisted at line 1322, `fileSelection` is not), and across a refetch the selected `ClientFile` objects survive because `filesFromBackend` reuses existing instances by id and `cleanFileSelection` only drops files missing from the new `index`. So the highlighted file is still selected the whole time — the user merely scrolled past it.

What yanks it back: the VirtualizedRenderer selection-scroll effect (lines 142-151), deps `[lastSelIndex, fileSelectionSize]`, calls `scrollToIndex(lastSelIndex)`. `lastSelIndex` (lines 129-131) is `Math.min(lastSelectionIndex.current, numImages - 1)`. When a splice changes `numImages`, the clamped value can change and re-fire the effect, scrolling the surviving selection back into view.

There is a mitigating mechanism that must be accounted for: `LayoutSwitcher.tsx` resets both selection refs to `undefined` whenever `fileStore.fileList.length` changes (lines 72-75). Because `numImages === fileList.length`, that reset makes `lastSelectionIndex.current` undefined → `lastSelIndex` undefined → the selection effect's guard at line 147 skips, on a length-changing refetch. This means Defect C, as a length-changing-splice trigger, is partially defended TODAY — but the defense is fragile (it depends on the cross-component effect-ordering between `LayoutSwitcher`'s passive `useEffect` and `VirtualizedRenderer`'s `useLayoutEffect`, and on the `numImages === length` identity). The fix must make the selection effect robust on its own terms (gate on selection IDENTITY, not on a clamped index that moves with the list size) rather than rely on a reset in a sibling component. This must be validated with a rendered jsdom test before/after, since the exact firing depends on render/effect ordering.

#### Conceptual mistake

Fetchers (and the layout-restore effect) treat a value captured before a long await as if it were still authoritative when the await resolves. The correct rule, already followed by `pinViewedFileAcrossRefetch` (lines 943-967) and `handleKeepOriginal` (`RemovalAlert.tsx`), is: **never re-apply a pre-await snapshot of a live, user-mutable cursor; re-read the live value (or anchor by stable identity captured at a deliberate interaction point) at the moment of reapplication.** The media-processing pin (`pinnedFileId = uiStore.mediaProcessingFile?.id`, line 1580) is the correct identity-anchor case and must keep winning.

### Diagnostic Questions Considered

- **Wrong mental model?** Secondary. The async `.then()` was written as if "the file that was on top when I started is still the file the user wants on top." That is a mental-model error about user interaction during a load.
- **Architectural shortcoming?** Corroborating. `firstItem` has no separation between "live scroll cursor" and "restore anchor," and the layout-restore effect fires on every list mutation rather than only on intentional layout changes.
- **Incorrect order of operations?** No. Within each path the ordering is fine; the bug is the cross-time staleness of a captured value.
- **Missing edge case?** No — this is the default loading path on any large library, not an edge.
- **Wrong abstraction?** PRIMARY. One observable carries two roles with opposite lifetimes; the async re-anchor reapplies a stale snapshot of it. This is the same wrong-abstraction class as INV-009, applied to scroll position instead of fileList.
- **Silent failure?** Corroborating. No error, no log — the stale apply succeeds from the code's perspective; the user simply sees their scroll undone.

### Relationship to INV-009

INV-009 (`completed/investigations/INV-009`) fixed the `fileList`/`content` half of the stale-async-snapshot pattern with `fetchGeneration`. The generation guards at `FileStore.ts:1554` (sync) and `:1636` (async) are correct and must remain unchanged. INV-028 is the `firstItem`/scroll-position half: a flaw the generation token cannot reach because the staleness is within a single fetcher's own lifetime, driven by user scroll rather than by a competing fetcher.

---

## Blast Radius

Every site that captures `firstItem` (or a value derived from it) before an async boundary and reapplies it after, plus every site that force-scrolls to a stale `firstItem`/selection index after a list mutation. Verified against current source.

1. **`src/frontend/stores/FileStore.ts:1630-1699` — `updateFromBackend` async existence-check `.then()` (PRIMARY).** Line 1682 `reconcileFirstItemTo(anchorFileId)` reapplies the start-of-fetch anchor after the user may have scrolled. `fileListLastModified` bumped at 1656 (broken splice) and 1674 (video-only splice) turns this into a visible snap. This is the reported bug.

2. **`src/frontend/stores/UiStore.ts` — `firstItem` observable + `setFirstItem` (line 381).** The overloaded value. Root of the abstraction problem; all other findings flow from it.

3. **`src/frontend/containers/ContentView/Masonry/VirtualizedRenderer.tsx:135-140` — layout-restore effect.** `scrollToIndex(uiStore.firstItem, 'start')` on every `layoutUpdateDate` change. The mechanism that converts a stale `firstItem` write into a forced viewport re-align. Fires on every list mutation, not only on intentional layout changes (view method / thumbnail size / resize).

4. **`src/frontend/containers/ContentView/Masonry/VirtualizedRenderer.tsx:142-151 + 128-131 — selection-scroll effect.** `scrollToIndex(lastSelIndex)` keyed on a clamped `lastSelIndex` that moves when `numImages` changes. Defect C — the "selection returns" half. Currently partially masked by `LayoutSwitcher`'s ref reset (`LayoutSwitcher.tsx:72-75`); needs an identity-based gate to be robust.

5. **`src/frontend/containers/ContentView/Masonry/MasonryRenderer.tsx:117-141` — async layout recompute.** Awaits `worker.compute` then `setLayoutTimestamp`, the async boundary that schedules the scroll-restore after `fileListLastModified` changes. The engine behind Defect B.

6. **`src/frontend/stores/FileStore.ts:1061-1077 — `fetchMissingFiles` inline list replace.** Replaces `fileList`, rebuilds `index`, bumps `fileListLastModified` (line 1076), but NEVER calls `reconcileFirstItemTo`. Unlike `updateFromBackend`, the Missing view leaves `firstItem` pointing at an index from the OLD (full) list. Combined with the layout-restore effect (#3), entering the Missing view scrolls to an arbitrary/stale position. Same overloaded-`firstItem` root; different symptom (no anchoring at all vs. stale anchoring).

7. **`src/frontend/containers/ContentView/SlideMode/index.tsx:110 — `incrImgIndex` calls `uiStore.setFirstItem()` with NO argument.** `setFirstItem`'s default is `index = 0` (`UiStore.ts:381`), so this transiently sets `firstItem = 0` before the following `selectFile(...)` (line 111) re-corrects it via `selectFile`'s internal `setFirstItem(getIndex(...))` (`UiStore.ts:791`). Currently self-healing, but a concurrent list mutation that makes `fileList[index]` undefined leaves the viewer jumped to image 0. The sibling `decrImgIndex` (line 100) correctly passes `index`. Same `firstItem`-mishandling family; cheap correctness fix.

### Cleared (audited by bomb-squad, NOT defects — do not touch)

- **`pinViewedFileAcrossRefetch` (`FileStore.ts:943-967`)** — re-derives `index.get(pinFile.id)` AFTER the await by identity. Correct; the model to emulate. INV-021/INV-023 invariant: keep it.
- **Media-processing pin (`pinnedFileId = uiStore.mediaProcessingFile?.id`, `FileStore.ts:1580`)** — identity anchor; must keep winning in the live-anchor resolution (INV-021/INV-023). Leave it.
- **SYNC reconcile (`FileStore.ts:1626`)** — runs before any await; correct cross-sort/filter/search anchoring. Leave it.
- **`removeFilesFromListInPlace` (`FileStore.ts:716-822`)** — synchronous SlideMode auto-advance; no stale-closure window. Leave it.
- **INV-009 generation guards (`FileStore.ts:1554` sync, `:1636` async)** — unchanged.
- **SlideMode image-preload `.then()` handlers** — guarded with `isEffectRunning`. Correct.
- **`SlideMode` return-to-gallery effect (`VirtualizedRenderer.tsx:154-159`)** — `scrollToIndex(firstItem, 'nearest')` on `[isSlideMode, firstItem]`; intended behavior. Must remain working.
- **`GalleryItem.tsx` hover-preview / off-DOM preload `<video>`** — unrelated.

---

## UX / Requirements Specification

### Purpose

A background load that finishes after the user has scrolled must respect the user's current scroll position and current focus. Loading completion is a background event; it must never override live user navigation.

### User-Stated Design Decisions

1. **Track a `splicedList` flag in the async phase and re-anchor only when a splice actually changed the list.** Set the flag in both splice blocks (broken-file ~1656, video-only ~1674). Net: no splice → leave the viewport untouched (do not call `reconcileFirstItemTo` at all in the async `.then()`); splice → re-anchor. Rationale: the async re-anchor is only needed when the splice changed indices; if nothing was spliced, the sync first-pass already anchored correctly and any later movement is the user's scroll.

2. **Re-anchor to a LIVE anchor, not the stale start-of-fetch snapshot.** When a splice did occur, resolve `liveAnchorId = mediaProcessingFile?.id ?? fileList[current uiStore.firstItem]?.id` at the moment of the async reapply (clamped into range), and call `reconcileFirstItemTo(liveAnchorId)`. Rationale: the media-processing pin must still win (INV-021/INV-023); otherwise honor the user's current scroll position, not where they started.

3. **Gate the selection-scroll effect on selection IDENTITY, not on the clamped index.** Derive `lastSelId` from `fileList[lastSelectionIndex.current]?.id` and keep a prev-key ref so a refetch that only changes `numImages` does not re-fire `scrollToIndex`. Cursor-key navigation (a real selection change) must still scroll. Rationale: the selection never left; only a list-size change must not be mistaken for a navigation event.

4. **Preserve all intended scroll-restore behaviors.** View-mode switch retains scroll; SlideMode return scrolls the viewed file into view; resize / thumbnail-size change may re-align. The fix must not regress these.

### Behavioral Specifications

- Scroll during loading on a filtered large library → when the existence check resolves, the viewport stays where the user scrolled (does not snap back).
- A surviving selection the user scrolled past is NOT dragged back into view by a count-only refetch.
- The media-processing viewer pin still anchors the viewer by identity across the refetch (INV-021/INV-023).
- Switching grid↔list↔calendar still retains scroll position. Returning from SlideMode still scrolls the viewed file into view.

### Explicit Rejections

- **Do not remove the SYNC `reconcileFirstItemTo` at line 1626.** It is correct and keeps the viewed file in view across sort/filter/search.
- **Do not change the INV-009 generation guards** (1554, 1636) or the generation token mechanism.
- **Do not break the media-processing pin** (`pinnedFileId`/`mediaProcessingFile` identity anchor, INV-021/INV-023) or `pinViewedFileAcrossRefetch`.
- **Do not "solve" this by persisting `fileSelection`.** Selection persistence is orthogonal and out of scope; the selection is not lost, it is mis-scrolled.
- **Do not add a loading-state UI gate** that blocks scrolling while loading. The user must be able to scroll freely; the fix is to honor that scroll when the load resolves.
- **Do not eliminate the layout-restore effect** wholesale — view-mode switch and SlideMode return depend on scroll restoration. Scope any change to not re-applying STALE anchors, not to removing restoration.

### Uncertainty resolution

- **Does the async `.then()` reconcile truly run unconditionally?** YES — line 1682 runs on every non-stale async resolution regardless of whether a splice occurred. `fileListLastModified`, however, is bumped only inside the two splice blocks (1656, 1674) plus the empty-list early return (1561) and the sync transaction (1627). So a no-splice async resolution writes a stale `firstItem` (Defect A) but does not retrigger the layout-restore scroll (Defect B) by itself. Confirmed against source.
- **Is Defect C (selection return) currently fully reproducible?** Partially defended today by `LayoutSwitcher.tsx:72-75` resetting the selection refs on `fileList.length` change. The exact firing depends on cross-component effect ordering; the rendered jsdom test in TASK-110 must establish the actual current behavior before and after the fix. The identity-gate fix in TASK-108 is the robust correctness measure regardless.

---

## Holistic Solution

### Approach

Five tasks, ordered fix → fix → defensive cleanups → tests.

1. **TASK-106 — FileStore async-phase live re-anchor (Fix A, primary).** In `updateFromBackend`'s async `.then()`: introduce a `splicedList` flag set `true` inside both splice blocks (broken-file ~1656, video-only ~1674). Replace the unconditional `reconcileFirstItemTo(anchorFileId)` at line 1682 with: if `splicedList`, resolve `liveAnchorId = this.rootStore.uiStore.mediaProcessingFile?.id ?? (curFirst within range ? fileList[curFirst].id : undefined)` reading `uiStore.firstItem` LIVE at that moment, and call `reconcileFirstItemTo(liveAnchorId)`; if not spliced, do not touch `firstItem`. Keep the sync reconcile at 1626 unchanged. Keep INV-009 guards and the media-processing pin. Net: no splice → viewport untouched; splice → re-anchor to the user's live position (clamped), pin still wins.

2. **TASK-107 — VirtualizedRenderer selection-scroll identity gate (Fix B).** Rework the selection-scroll effect (lines 142-151): derive `lastSelId` from `fileList[lastSelectionIndex.current]?.id`, keep a `prevSelKeyRef`, and only `scrollToIndex` when the selection identity (or `fileSelectionSize` for a genuine change) actually changed — not when only `numImages` changed. Preserve cursor-key navigation scrolling.

3. **TASK-108 — `fetchMissingFiles` re-anchor parity (related defect, blast-radius #6).** In `fetchMissingFiles`'s inline `runInAction` (lines 1061-1077), after rebuilding `index` and before/with the `fileListLastModified` bump, re-anchor `firstItem` by identity to a live anchor (mirroring the sync pass of `updateFromBackend`) so entering the Missing view does not scroll to a stale index from the old full list. Use the same `reconcileFirstItemTo`-style logic. Guarded by the existing generation check at line 1064.

4. **TASK-109 — Fix `incrImgIndex` `setFirstItem()` no-arg call (blast-radius #7).** In `SlideMode/index.tsx:110`, change `uiStore.setFirstItem()` to `uiStore.setFirstItem(index)` to match `decrImgIndex` (line 100). Removes the transient `firstItem = 0` write and the latent jump-to-zero when `fileList[index]` is undefined.

5. **TASK-110 — Tests (jest + rendered jsdom + manual portable QA).** A FileStore unit test that moves `firstItem` between the sync and async phases of `updateFromBackend` (artificially delayed existence check, filter active) and asserts `firstItem` reflects the post-scroll position, not the start-of-fetch snapshot. A rendered VirtualizedRenderer test (jsdom — this fork CAN render real components + clicks per project memory) establishing the selection-scroll behavior on a count-only refetch before/after Fix B. Plus a manual portable-build QA procedure for the scroll-during-load snap-back and the SlideMode/view-switch restore regressions.

Order: 106 (primary fix) → 107 (selection fix) → 108 (Missing parity) and 109 (slide-mode no-arg) can run in parallel after 106 → 110 (tests, last, depends on 106-109). Single `yarn build` + `yarn test` at the end of the batch per project discipline.

### Expected Outcomes

- Scrolling during a slow load no longer snaps back when the existence check resolves (Defects A+B fixed by TASK-106).
- A count-only refetch no longer drags a surviving selection back into view (Defect C fixed by TASK-107).
- Entering the Missing view anchors sensibly instead of scrolling to a stale index (TASK-108).
- No transient jump-to-zero on slide-mode next-image (TASK-109).
- View-mode switch scroll-retention, SlideMode-return scroll-into-view, resize/thumbnail-size re-align, and the media-processing viewer pin (INV-021/INV-023) all still work.
- INV-009 generation guards unchanged; `yarn build` and `yarn test` pass.

### Risks and Tradeoffs

- **Live-read timing in the async `.then()`.** Reading `uiStore.firstItem` inside the splice-conditional reapply assumes it reflects the user's latest throttled scroll (100 ms throttle in VirtualizedRenderer). A scroll in the last <100 ms before resolution might not yet be flushed; acceptable — worst case is a ≤1-row error vs. today's full snap-back. The media-processing pin short-circuits this entirely when a job is active.
- **Selection-effect identity gate vs. range selection.** Gating on `lastSelId` must still scroll on real cursor-key navigation and range extension. TASK-110's rendered test must cover cursor-key nav to prevent a regression where navigation stops auto-scrolling.
- **`fetchMissingFiles` anchoring.** Adding re-anchor to the Missing path changes its scroll behavior on entry; verify it does not regress the (rare) case of refreshing the Missing view while already in it.
- **Fragile cross-component reset.** `LayoutSwitcher.tsx:72-75` currently masks part of Defect C. After TASK-107 the selection effect no longer depends on that reset; do not remove the reset in this work (out of scope) but note the dependency is now defensive rather than load-bearing.
- **Deeper refactor deferred.** The cleanest fix is to split `firstItem` into a live `scrollCursorIndex` and an identity `scrollAnchorFileId`. That is a larger change; these tasks fix the user-visible bug and the directly-related defects without the full split. The split is noted as a follow-up in the docs update.

---

## Game Documentation Updates

- [ ] No updates needed
- [x] Updated: append to `docs/TOOLS.md` section 6 ("SlideMode + refetch: keep the viewed file anchored by identity, never by index", line ~169 — the canonical INV-021/INV-023 firstItem invariant) a note: "`firstItem` is BOTH a live scroll cursor (written on every scroll by VirtualizedRenderer) and a fetch-time anchor; never reapply a pre-await snapshot of it. The async existence-check phase of `updateFromBackend` re-anchors firstItem only when a splice changed the list, and re-anchors to the LIVE position (`mediaProcessingFile?.id ?? fileList[firstItem]?.id`), not the start-of-fetch snapshot. See INV-028." (TASK-106 performs this edit.)
