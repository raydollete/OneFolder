## Context

The full-screen slide-mode viewer renders `uiStore.slideFile`
(`src/frontend/containers/ContentView/SlideMode/index.tsx:55`), which today is
just `firstFileInView` — a raw index lookup
`fileStore.fileList[uiStore.firstItem]` (`UiStore.ts:1260-1272`, `firstItem` at
`UiStore.ts:211`). Because the displayed file's *identity* is derived from a
numeric position, any change to `fileList` that moves a different file into slot
`firstItem` swaps the viewer's content with no code touching `firstItem`. The
triggers are routine: the default `random` sort re-permutes the list on every
refetch (`FileStore.ts:78`), the folder watcher refetches on new files
(`LocationStore.addFile` → `debouncedRefetch`), and media-job output is ingested
via `FileStore.finalizeEncodedOutput` → `refetch()`.

A partial mitigation exists: `reconcileFirstItemTo` (`FileStore.ts:1805-1821`)
captures `fileList[firstItem].id` before a rebuild and re-points `firstItem` to
that id's new index — but only when the file survives the refetch. When the
viewed file is absent, its fallback **clamps `firstItem` into range**
(`FileStore.ts:1814-1820`), silently surfacing whatever now occupies the slot.
There was previously a true identity anchor (`mediaProcessingFile`) that made
`slideFile` immune to this; INV-035 removed it and left a now-false source comment
claiming the immunity still exists (`SlideMode/index.tsx:53-55`).

Constraints: renderer-only, MobX 6, TS strict. The gallery grid legitimately uses
`firstItem` as its viewport anchor and must keep updating live; the fix must not
freeze the list or break grid scrolling.

## Goals / Non-Goals

**Goals:**
- The file shown in slide mode is chosen by stable identity, so an open video/image
  is never swapped by a list re-sort or insertion (the core user-facing invariant).
- Prev/next navigation still works, computed relative to the anchored file's
  current position, and re-anchors to the newly shown file.
- When the anchored file genuinely leaves the list, the viewer shows an explicit
  empty/closed state instead of a silent unrelated-file swap (fail loud).
- Deliberate retargeting (media-queue "show in viewer", replacing the viewed file
  with its processed output) still works.

**Non-Goals:**
- Not changing the gallery grid's use of `firstItem` as its viewport anchor.
- Not restoring the removed `mediaProcessingFile` media-job pin (this is a general
  per-open-file anchor, not job-scoped).
- Not changing sort order, the folder watcher, ingestion, DTOs, IPC, or the backend.
- Not addressing the Inspector's file resolution beyond following `slideFile`
  (it already reads `slideFile`, so it inherits the fix).

## Decisions

### Decision 1: Anchor the viewer on a `slideFileId` identity, resolved against list membership

Add an observable `slideFileId: ID | undefined` to `UiStore`. Change `slideFile`
(`UiStore.ts:1270`) so that **while in slide mode** it resolves by identity via the
existing O(1) lookup `fileStore.get(slideFileId)` (`FileStore.ts:1202-1205`), which
returns the member `ClientFile` for that id or `undefined`. When not in slide mode,
`slideFile` keeps returning `firstFileInView` (grid/inspector behavior unchanged).
`fileStore.get` resolves through `FileStore.index` (a `Map<ID, number>` kept in
lockstep with `fileList`, `FileStore.ts:71`), so this is O(1), not an O(N) scan.
Resolving against list *membership* (a file that is not in `fileList` returns
`undefined`) is deliberate: it makes "the file was filtered out or deleted"
collapse to the same explicit empty state required by the spec, rather than
displaying a file that is no longer in the active view.

Reactivity: the computed reads `fileList[index.get(id)]`, touching the observable
`fileList`, so it re-derives whenever the list changes; the `index` map is updated
synchronously alongside `fileList` inside the same actions/transactions, so the
map is never observed stale. Crucially, `updateFromBackend` replaces the list
inside a MobX `transaction` (`FileStore.ts:1693`), so the swap is atomic — the
computed never observes an intermediate state where the anchored file is
transiently absent, which would otherwise flicker the viewer to the empty state
and remount the `<video>` mid-playback.

- **Why over patching `reconcileFirstItemTo`'s clamp:** patching the clamp fixes
  only the one path that routes through reconcile. Paths that mutate `fileList`
  without a full reconcile (e.g. `ensureFileInListAt` inserting at a middle index,
  `FileStore.ts:1216-1227`) would still swap the viewer, and the index-as-identity
  abstraction would keep re-breaking with each new mutator. Anchoring puts the
  invariant in one computed getter.
- **Why `ID` membership over a held `ClientFile` reference:** a `ClientFile` can be
  disposed/recreated across refetch; an ID + list lookup is the same identity model
  `reconcile` and `selectFile` already use (`getIndex(file.id)`), so it composes
  with existing code.

### Decision 2: Set/clear the anchor at the few real entry points

Set `slideFileId` at exactly the points that intentionally choose the viewed file:
- **Entering slide mode** (`enableSlideMode`, `UiStore.ts:405`): anchor to the
  current `firstFileInView` (the file being opened). `selectFile` runs first in the
  preview flow (`Commands.tsx:188-194`), so `firstItem` already points at it.
- **Prev/next navigation** (`SlideMode/index.tsx:91-102`,
  `incrImgIndex`/`decrImgIndex`): compute the target from the anchored file's
  current index (`getIndex(slideFileId)`) ± 1, clamp to list bounds, then set both
  the anchor and `firstItem` to the target file. Introduce a single
  `uiStore.setSlideFile(file)` action that sets `slideFileId` and `firstItem`
  together, and route navigation + `selectFile`-in-slide-mode through it so the two
  never diverge. **Missing-anchor fallback:** if `getIndex(slideFileId)` is
  `undefined` (the anchored file left the list, so the viewer is in its empty
  state), prev/next SHALL fall back to navigating relative to the retained
  `firstItem` (which `reconcileFirstItemTo` has clamped into range) rather than
  computing from an absent index — this prevents a navigation deadlock and lets the
  user step back into a valid file from the empty state.
- **Exiting slide mode** (`disableSlideMode`): clear `slideFileId` (return to pure
  grid behavior).
- **Deliberate retarget** (`MediaQueueStore.focusFileInViewer` and any output-
  replacement flow): call `setSlideFile(targetFile)` so intentional retargeting is
  explicit and distinct from incidental churn.

- **Alternative considered — derive `firstItem` from `slideFileId` via a MobX
  reaction:** rejected as more machinery than needed and harder to reason about
  (reaction ordering vs. the transaction in `updateFromBackend`). Setting both in
  one action at the handful of real call sites is simpler and deterministic.

### Decision 3: `reconcileFirstItemTo` stays; the viewer is decoupled from its fallback

Leave `reconcileFirstItemTo` as the grid's `firstItem` maintainer. Once `slideFile`
resolves via `slideFileId`, the clamp fallback (`FileStore.ts:1814-1820`) can no
longer swap the *viewer* — at worst it repositions the grid viewport, which is
acceptable. This keeps the change small and avoids destabilizing the grid's
existing reconcile behavior. (If we later want the grid viewport to also follow the
anchor while in slide mode, that is a follow-up, not required for the fix.)

### Decision 4: Explicit empty state in the SlideMode component

When `slideFile` is `undefined` while `isSlideMode` is true (anchored file gone),
`SlideMode/index.tsx` SHALL render an explicit empty/closed state rather than
falling through to render a stale or unrelated file. Remove the stale pin comment
at `SlideMode/index.tsx:53-55` and replace it with an accurate description of the
identity-anchor model. Match existing empty-state / guard patterns in the viewer;
fail loud rather than silently.

## Risks / Trade-offs

- [Anchor set on entry misses the file that was opened] → Route entry through the
  same `getIndex`/`firstItem` value the preview flow already sets; add a store-level
  jsdom test that entering slide mode anchors to the opened file's id.
- [`firstItem` and `slideFileId` drift after navigation] → Funnel every viewer file
  change through one `setSlideFile(file)` action that sets both; never set one
  without the other.
- [Grid viewport jumps when the anchored file is filtered out] → Accepted: the grid
  clamp is cosmetic; the viewer's explicit empty state is the user-facing contract.
- [Intentional retarget accidentally blocked] → The anchor is only protected against
  *list churn*; deliberate `setSlideFile` calls always win. Covered by the
  "intentional retargeting is still permitted" requirement and a focus-in-viewer test.
- [Inspector behavior changes] → Inspector already reads `slideFile`; it inherits
  the same identity resolution, which is the desired consistency (verify no
  inspector test regresses).

## Migration Plan

Renderer-only, no persisted-state or schema change. `slideFileId` is transient
(not added to `PersistentPreferenceFields`), so there is nothing to migrate and
rollback is a straight revert. Ship behind no flag; validate via store-level jsdom
tests plus a manual GUI pass (open a video, trigger a media job / refetch, confirm
the video stays open) — the manual pass is `REQUIRES MANUAL EXECUTION` per the
QA-discipline gate.

## External Review

Reviewer: Gemini (`gemini-3.5-flash`) via the `mcp__gemini__query_gemini` brief.
Verdict: decoupling the viewer from the list index is the correct architecture;
four concerns raised, three folded into the design, two dismissed with evidence.

- **O(N) resolution in the computed getter** (raised) → **Dismissed with a change.**
  The concern assumed a linear scan. `FileStore` already maintains an O(1)
  `index: Map<ID, number>` (`FileStore.ts:71`) and `get(id)` (`FileStore.ts:1202`)
  resolves through it. Design updated to resolve `slideFile` via `fileStore.get`
  rather than a bare `getIndex` compare, making the O(1)-ness explicit.
- **Transient file-drop during refetch flickers the viewer to empty / remounts the
  `<video>` mid-playback** (raised) → **Dismissed with evidence.** `updateFromBackend`
  replaces the list inside a MobX `transaction` (`FileStore.ts:1693`); observers
  never see an intermediate state, so the computed cannot transiently resolve to
  `undefined` during the swap. Noted explicitly in Decision 1.
- **Prev/next deadlock when the anchor is missing** (raised) → **Accepted.** Added a
  missing-anchor fallback in Decision 2: when `getIndex(slideFileId)` is `undefined`,
  navigation falls back to `firstItem`-relative stepping (the retained, reconcile-
  clamped index), so the user can step out of the empty state instead of being stuck.
- **`firstItem` (grid) vs `slideFileId` (viewer) divergence** (raised) → **Accepted as
  intended, clarified.** In slide mode `slideFileId` is the sole authority for the
  viewer, so background `firstItem` drift (virtualized grid scroll, inserts) is
  harmless to what the user sees; `setSlideFile` seeds `firstItem` only so the grid
  has a sensible position on exit. Whether to actively re-sync the grid to the anchor
  on exit is captured in Open Questions, not forced by this fix.
- **Random-sort "Next" shows a re-permuted neighbor** (raised) → **Out of scope.**
  Gemini agreed this is a pre-existing UX property of `random` sort, not a regression
  of this change; the fix's contract is only that the *currently viewed* file is
  never swapped without user action.

## Open Questions

- Should the grid viewport also follow the anchored file while in slide mode (so
  exiting the viewer lands the grid on the file you were viewing), or is preserving
  today's grid behavior sufficient? Proposed: keep today's behavior for this change;
  revisit only if QA finds the grid position jarring on exit.
