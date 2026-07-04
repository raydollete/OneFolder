Tier: 2 — Bounded renderer-only MobX change: the fix lives in one computed getter (`slideFile`) plus a small identity-anchor observable in `UiStore` and the two prev/next handlers in the SlideMode component. No backend/DTO/IPC/dependency changes and no cross-cutting refactor, but it changes a load-bearing viewer invariant (which file is shown) and interacts with the list-reconcile path, so it needs a design and store-level tests.

Type: bug

## Why

When a user has a file open in the full-screen slide-mode viewer (especially a
playing video), the viewer can silently jump to a *different* file whenever the
underlying gallery list is re-sorted or a new file is inserted — most commonly
when a media-processing job (re-encode/normalize/clip) finishes and its output is
ingested. The viewer resolves the displayed file by **numeric index** into an
observable list (`fileStore.fileList[uiStore.firstItem]`), so any reordering or
insertion changes what that index points at. This interrupts the user, loses
in-progress work (scrub position, playback), and reads as the app "opening a
random video" on its own. Nothing should ever pull a user off the file they are
actively viewing.

## Root Cause

Category: **wrong-abstraction**

The slide-mode viewer uses a **numeric list index (`uiStore.firstItem`) as its
durable reference to "the file being viewed"** — a positional coordinate standing
in for a stable identity. `slideFile` resolves as
`fileStore.fileList[uiStore.firstItem]`
(`src/frontend/stores/UiStore.ts:1260-1272`), so the *identity* of the displayed
file is an emergent property of "whatever currently sits at that slot," not a
thing the viewer actually holds onto. A media job completing, a folder-watcher
refetch, or the default `random` sort (`src/frontend/stores/FileStore.ts:78`)
re-permutes or grows `fileList`, and the same index now denotes a different file
— no code has to touch `firstItem` for the viewer to jump.

There *was* an identity anchor (`mediaProcessingFile`) that made `slideFile`
immune to this churn; INV-035 removed it, leaving only the index and a partial
mitigation, `reconcileFirstItemTo` (`src/frontend/stores/FileStore.ts:1805-1821`).
That mitigation re-points `firstItem` by captured ID *when the file survives the
refetch*, but its fallback (lines 1814-1820) merely **clamps the index into range**
when the file is absent — silently surfacing whatever now occupies the slot. The
fix restores identity as the primary abstraction rather than patching every
current and future `fileList` mutator to remember to reconcile.

## What Changes

- Make the slide-mode viewer resolve the displayed file by **stable identity
  (file ID)** instead of by list index, so an open file is never swapped out from
  under the user when `fileStore.fileList` is re-sorted or has files inserted.
- Anchor the viewer on the file's ID at the moment slide mode is entered and on
  every explicit prev/next navigation; keep the numeric `firstItem` index in sync
  for grid scrolling and navigation, derived from the anchored ID while in slide
  mode.
- When the anchored file genuinely leaves the list (e.g. it is deleted or an
  active filter now excludes it), **fail loud / show an explicit empty-or-close
  state** rather than silently displaying whichever file happens to occupy the old
  index slot. The deliberate case where a media job *replaces* the viewed file
  with its output is preserved: the viewer follows the intended file by identity.
- Remove the now-false source comment in the SlideMode component that still claims
  an identity pin exists ("immune to fileList/firstItem churn"), which was true
  before INV-035 removed `mediaProcessingFile` and is now misleading.

## Capabilities

### New Capabilities
- `viewer-file-anchoring`: Defines how the full-screen slide-mode viewer decides
  which file to display and keeps that choice stable across changes to the
  underlying file list (re-sort, insert, ingest of media-job output), including
  how prev/next navigation and the not-in-list case behave.

### Modified Capabilities
<!-- None. video-playback covers keyboard playback control only; it does not
     govern which file the viewer resolves to. No existing spec's requirements change. -->

## Blast Radius

1. `src/frontend/stores/UiStore.ts:1260-1272` — `slideFile` and `firstFileInView`
   computed getters (the index→file resolution that must become ID→file); plus
   `firstItem` observable (line 211) and `setFirstItem` (lines 349-353). This is
   the primary fix site: `slideFile` must resolve by an identity anchor.
2. `src/frontend/stores/UiStore.ts:688` — `selectFile` sets `firstItem` via
   `setFirstItem(getIndex(file.id))`; the identity anchor must be set here (and in
   `enableSlideMode`) so entering the viewer records the file ID.
3. `src/frontend/containers/ContentView/SlideMode/index.tsx:53-55` — the stale
   pin comment to remove; lines 91-102 (`incrImgIndex`/`decrImgIndex` prev/next
   handlers) must update the identity anchor, not only `firstItem`; line 55
   (`const file = uiStore.slideFile`) and the anchored-file-gone render path.
4. `src/frontend/stores/FileStore.ts:1805-1821` — `reconcileFirstItemTo`, whose
   fallback currently **clamps the index** (the silent-swap bug) when the viewed
   file is absent from the refetched list; must defer to the identity anchor.
   `updateFromBackend` (1623/1693-1702) and its transaction wrap the reconcile.
5. `src/frontend/stores/FileStore.ts:1543-1591` (`finalizeEncodedOutput`),
   `src/frontend/stores/FileStore.ts:1216-1227` (`ensureFileInListAt`),
   `src/frontend/stores/MediaQueueStore.ts:608-614` (`focusFileInViewer`), and
   `src/frontend/stores/LocationStore.ts:595-627` (`addFile` → `debouncedRefetch`)
   — interacting insert/refetch paths verified but not expected to change.
6. Bounding searches: `grep -rn "firstItem\|slideFile\|firstFileInView" src` to
   confirm every reader of the viewed-file index; `grep -rn "mediaProcessingFile"
   src tests` to confirm the old pin is fully gone (only the retired-pin test
   references it).

## Impact

- **Code (frontend, MobX, renderer-only):**
  - `src/frontend/stores/UiStore.ts` — add an identity anchor (e.g.
    `slideFileId`), resolve `slideFile` by ID, set the anchor in `selectFile` /
    `enableSlideMode`, keep `firstItem` in sync for grid use.
  - `src/frontend/containers/ContentView/SlideMode/index.tsx` — prev/next set the
    anchor; remove the stale comment; render an explicit state when the anchored
    file is gone.
  - `src/frontend/stores/FileStore.ts` — `reconcileFirstItemTo` defers to the
    anchor as the source of truth for the viewed file; reconcile still maintains
    grid `firstItem`.
- **Tests:** `tests/sub-process-viewer-pin.test.ts` documents the removed
  `mediaProcessingFile` pin; new identity-anchoring behavior needs its own
  jsdom store-level coverage (re-sort and insert must not change `slideFile`).
- **No API/DTO/IPC changes; no dependency changes.** Renderer-only.
