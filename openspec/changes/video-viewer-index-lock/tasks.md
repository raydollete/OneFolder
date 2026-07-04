## 1. Identity anchor in UiStore

- [x] 1.1 Add `@observable slideFileId: ID | undefined = undefined` to `UiStore` (`src/frontend/stores/UiStore.ts` near `firstItem` at line 211); import the `ID` type. Do NOT add it to `PersistentPreferenceFields` — it is transient session state.
  - evidence: `UiStore.ts:211-219` adds `@observable slideFileId: ID | undefined = undefined` directly after `firstItem`; `ID` already imported at `UiStore.ts:6`; not present in `PersistentPreferenceFields`.
- [x] 1.2 Add a single `@action.bound setSlideFile(file: ClientFile): void` that sets both `this.slideFileId = file.id` and `this.setFirstItem(fileStore.getIndex(file.id))`, so the anchor and grid index can never diverge.
  - evidence: `UiStore.ts:356-366` `setSlideFile` sets `slideFileId = file.id` then `setFirstItem(getIndex(file.id))` in one action.
- [x] 1.3 Change `slideFile` (`UiStore.ts:1270`) so that when `isSlideMode` is true it resolves by identity via the existing O(1) lookup: `return this.slideFileId !== undefined ? fileStore.get(this.slideFileId) : undefined;` (`FileStore.get` at `FileStore.ts:1202` returns the member `ClientFile` or `undefined`). When not in slide mode it keeps returning `firstFileInView`. Leave `firstFileInView` itself unchanged (the grid still uses it). Do not scan `fileList` — rely on `FileStore.index`.
  - evidence: `UiStore.ts:1284-1296` `slideFile` returns `fileStore.get(this.slideFileId)` when `isSlideMode`, else `firstFileInView`; `firstFileInView` unchanged; `FileStore.get` (`FileStore.ts:1202-1205`) resolves through the O(1) `index` map.
- [x] 1.4 In `enableSlideMode` (`UiStore.ts:405`), set the anchor to the file being opened: `this.slideFileId = this.firstFileInView?.id`. In `disableSlideMode` (`UiStore.ts:409`), clear it: `this.slideFileId = undefined`.
  - evidence: `UiStore.ts:enableSlideMode` sets `slideFileId = this.firstFileInView?.id` before `isSlideMode = true`; `disableSlideMode` sets `slideFileId = undefined`.
- [x] 1.5 Make `selectFile` (`UiStore.ts:683-689`) keep the anchor in sync when already in slide mode (set `slideFileId = file.id` alongside the existing `setFirstItem`), so selection-driven navigation re-anchors too.
  - evidence: `UiStore.ts:selectFile` now sets `this.slideFileId = file.id` guarded by `if (this.isSlideMode)` after the existing `setFirstItem`.

## 2. SlideMode component

- [x] 2.1 In `src/frontend/containers/ContentView/SlideMode/index.tsx`, route prev/next through the anchor: rewrite `incrImgIndex`/`decrImgIndex` (lines 91-102) to compute the target from the anchored file's current index (`fileStore.getIndex(uiStore.slideFileId)`) ± 1, clamp to `[0, fileList.length - 1]`, then call `uiStore.setSlideFile(fileList[target])` instead of setting `firstItem` alone. Missing-anchor fallback: if `getIndex(slideFileId)` is `undefined` (anchored file gone), step relative to the retained `uiStore.firstItem` instead, so navigation still works from the empty state (no deadlock).
  - evidence: `SlideMode/index.tsx` adds `currentNavIndex()` = `getIndex(slideFileId) ?? uiStore.firstItem`; `decrImgIndex`/`incrImgIndex` clamp `currentNavIndex()±1` to `[0, len-1]` and call `uiStore.setSlideFile(target)`.
- [x] 2.2 Handle the anchored-file-gone case: when `uiStore.slideFile` is `undefined` while `isSlideMode` is true, render an explicit empty/closed state (match existing viewer guard/empty patterns) instead of falling through to a stale/unrelated file. Fail loud, not silent.
  - evidence: `SlideMode/index.tsx` renders a `#slide-mode-empty` block ("File no longer available") via the `file ? <ZoomableImage/> : <empty>` ternary; nav buttons retained for the fallback path.
- [x] 2.3 Remove the stale pin comment at lines 53-55 that claims immunity "to fileList/firstItem churn"; replace it with an accurate one-line description of the `slideFileId` identity-anchor model.
  - evidence: `SlideMode/index.tsx` comment above `const file = uiStore.slideFile` now describes the `slideFileId` identity anchor and the `undefined`→empty-state behavior; the "immune to fileList/firstItem churn" wording is gone.

## 3. FileStore / reconcile interaction

- [x] 3.1 Verify `reconcileFirstItemTo` (`src/frontend/stores/FileStore.ts:1805-1821`) still maintains the grid `firstItem` and that, with `slideFile` now resolving via `slideFileId`, its clamp fallback (lines 1814-1820) can no longer swap the viewer. Add a short code comment noting the viewer is decoupled from `firstItem`. No behavior change expected here — do not alter reconcile logic unless a test proves it necessary.
  - evidence: `FileStore.ts` reconcile docstring gains a NOTE that the viewer now resolves by `uiStore.slideFileId`, so the clamp fallback only moves the grid viewport; reconcile body unchanged.
- [x] 3.2 Point `MediaQueueStore.focusFileInViewer` (`src/frontend/stores/MediaQueueStore.ts:608-614`) at `uiStore.setSlideFile(file)` for deliberate retargeting, so a "show in viewer" action re-anchors explicitly (verify it still lands on the intended file).
  - evidence: `MediaQueueStore.ts:focusFileInViewer` now calls `ensureFileInListAt(file)` then `uiStore.setSlideFile(file)` (replacing the bare `setFirstItem`) before `selectFile`/`enableSlideMode`.

## 4. Tests (jsdom store-level)

- [x] 4.1 Add a test: enter slide mode on a file, re-sort/replace `fileList` so the file moves to a different index, assert `uiStore.slideFile.id` is unchanged (re-sort does not interrupt).
  - evidence: `tests/viewer-file-anchoring.test.ts` "4.1 re-sort … does not change slideFile" reverses the list so `b` moves 1→2 and asserts `slideFile?.id === 'b'`.
- [x] 4.2 Add a test: enter slide mode on a file, insert a new file ahead of it in `fileList` (simulating media-job ingest), assert `uiStore.slideFile.id` is unchanged (insert does not interrupt).
  - evidence: `tests/viewer-file-anchoring.test.ts` "4.2 inserting a file ahead …" ingests `new` at head, `b` shifts 1→2, asserts `slideFile?.id === 'b'`.
- [x] 4.3 Add a test: enter slide mode, then remove the anchored file from `fileList`, assert `uiStore.slideFile` is `undefined` (no silent swap to the file now at the old index).
  - evidence: `tests/viewer-file-anchoring.test.ts` "4.3 removing the anchored file …" deletes `b`, asserts `fileList[1].id === 'c'` yet `slideFile` is `undefined`.
- [x] 4.4 Add a test: prev/next re-anchors — trigger next, assert `slideFileId` and `firstItem` both point at the adjacent file, and that next at the last item stays on the last item (bounded).
  - evidence: `tests/viewer-file-anchoring.test.ts` "4.4 prev/next re-anchors …" plus "4.4b missing-anchor fallback …" assert re-anchoring, end-bounding, and empty-state escape.
- [x] 4.5 Add a test: `setSlideFile`/`focusFileInViewer` deliberately re-anchors to an arbitrary target file. Reconcile/rename the existing `tests/sub-process-viewer-pin.test.ts` context if it conflicts with the new anchor model.
  - evidence: `tests/viewer-file-anchoring.test.ts` "4.5 setSlideFile deliberately re-anchors …" retargets to `d`; `tests/media-queue-store.test.ts` now asserts `focusFileInViewer` calls `setSlideFile(srcFile)`. No conflict with `sub-process-viewer-pin.test.ts` (it never references the anchor model); it passes unchanged.

## 5. Verification

- [x] 5.1 Run `yarn lint` and `yarn test`; fix any type or test failures introduced by the anchor field/getter changes.
  - evidence: `yarn test` → "Test Suites: 30 passed, 30 total; Tests: 263 passed, 263 total". `yarn lint` shows the changed files clean (SlideMode empty-list guard removed the 2 new warnings); the remaining 45 errors are all pre-existing in untouched files (thumbnailGenerator.worker.ts, ipc/main.ts, LocationCreationDialog.tsx, …). Fixed `tests/ui-store-video-spacebar.test.ts` helper to anchor via `slideFileId` + `fileStore.get` for the new model.
- [x] 5.2 `yarn build` once at the end (batch build) and confirm no TS/webpack errors.
  - evidence: Manually validated by the user (build + app run confirmed working).
- [x] 5.3 **REQUIRES MANUAL EXECUTION** — manual GUI pass: open a video in slide mode, start playback, then trigger a media-processing job (or otherwise force a refetch/re-sort) so a new file is ingested; confirm the video stays open and keeps playing, prev/next still work, and deleting the viewed file shows an empty state rather than jumping to another file. Capture evidence per the QA-discipline gate.
  - evidence: Manually validated by the user (Ray) on Windows — confirmed the open video stays put and keeps playing across list churn, prev/next work, and the deleted-file case shows the empty state instead of swapping.
