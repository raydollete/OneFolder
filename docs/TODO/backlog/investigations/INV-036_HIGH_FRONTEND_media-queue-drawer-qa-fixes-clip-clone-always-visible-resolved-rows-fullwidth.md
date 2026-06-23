---
id: INV-036
title: 'Media queue drawer QA fixes: clip structured-clone crash, always-visible/default-collapsed drawer, resolved rows to the bottom + Clear resolved, and full-window-width drawer'
reported_bug: "Manual QA of the INV-035 non-blocking media-job queue drawer surfaced four issues. (1) Create Clip / Subtract Clip jobs crash at the IPC boundary with 'An object could not be cloned' because the MobX observable clip object cannot be structured-cloned across ipcRenderer.invoke; no-clip jobs (rotate/re-encode/normalize) work. (2) The drawer auto-opens on the first enqueue and disappears entirely when the queue is empty, so there is no stable, predictable surface — the user wants it always present, default-collapsed, and never auto-opening. (3) Completed/dismissed rows stay interleaved in chronological order and there is no way to clear them, so the queue clutters with resolved work and new jobs are hard to find. (4) The drawer only spans the content area (#main) and stops at the left Outliner sidebar; the user wants it pinned across the FULL window width."
date: 2026-06-23
status: active
superseded_by:
tasks_spawned: [TASK-146, TASK-147, TASK-148, TASK-149, TASK-150]
root_cause_category: silent-failure
affects:
  - 'Clip IPC boundary — MobX proxy passed to ipcRenderer.invoke (src/frontend/stores/MediaQueueStore.ts runItem/retry)'
  - 'Drawer visibility lifecycle (src/frontend/stores/MediaQueueStore.ts enqueue, src/frontend/containers/MediaQueue/index.tsx early return)'
  - 'Resolved-row lifecycle + ordering (src/frontend/stores/MediaQueueStore.ts keep/dismiss/clearResolved, src/frontend/containers/MediaQueue/index.tsx render-time sort + resolved branch)'
  - 'Failed-row Dismiss mislabeling (keepBoth reused as Dismiss)'
  - 'Drawer mount point + positioning (src/frontend/containers/Main.tsx, resources/style/media-queue.scss)'
  - 'Overlay z-index ordering and scroll-owner bottom padding (#content-view, Outliner scroll root)'
---

<!--
  NOTE: This investigation formalizes an already-approved, fully-designed change set.
  The design was settled and approved this session BEFORE this document was written.
  This is the holistic capture + task decomposition — not a fresh investigation.
  It is a direct follow-up to INV-035 (the non-blocking media-job queue drawer),
  fixing four issues found in that feature's manual QA.
  Approved plan of record: C:\Users\rjdol\.claude\plans\the-process-queue-is-adaptive-hanrahan.md
-->

## Bug Report

Follow-up to **INV-035** (move ffmpeg sub-process operations into a non-blocking
bottom queue drawer). Manual QA of that feature found four issues; the approved fixes
are captured here. Implementation order is **Change 2 → 1 → 3 → 4**.

### Observed Behavior

1. **Change 2 (bug) — "An object could not be cloned" on Create/Subtract Clip.**
   Enqueuing a Create Clip or Subtract Clip job throws `An object could not be cloned`
   and the job never runs. Rotate / re-encode / normalize-audio jobs (which pass no
   clip) work fine.

2. **Change 1 — drawer auto-opens and vanishes when empty.** The drawer auto-opens the
   moment the first job is enqueued (`enqueue` sets `isDrawerOpen = true`), and the
   entire surface unmounts when the queue is empty (`if (!hasItems) return null`). There
   is no stable, predictable place for the queue to live.

3. **Change 3 — resolved rows clutter the queue.** After a Keep New / Keep Original /
   Keep Both decision the row is spliced out entirely (no record), while failed rows that
   are "dismissed" route through `keepBoth` and are also removed. There is no way to see
   what was resolved, resolved rows are not separated from live work, and the failed-row
   Dismiss button is mislabeled (it calls `keepBoth`).

4. **Change 4 — drawer stops at the Outliner.** The drawer is mounted inside
   `<main id="main">` and uses `position: absolute`, so it spans only the content area
   and stops at the left Outliner sidebar instead of pinning across the full window width.

### Expected Behavior

1. **Change 2:** Create Clip / Subtract Clip enqueue and run exactly like the other tools;
   no structured-clone error.

2. **Change 1:** The drawer is **always present** (header bar + summary visible at all
   times, including when empty), **default-collapsed**, and **never auto-opens** on
   enqueue. When empty it shows a muted placeholder ("No media jobs yet"); the summary
   reads `0 queued · 0 processing · 0 done`.

3. **Change 3:** Resolved rows (Kept new / Kept original / Kept both / Dismissed) are
   **kept** and **sorted to the bottom**, below all live (unresolved) rows, with their
   resolution shown as the status. A **"Clear resolved"** control (shown only when there
   are resolved rows) removes them all. The failed-row Dismiss button is correctly
   labeled and recorded as "Dismissed". The summary gains a `· {n} resolved` count.

4. **Change 4:** The drawer spans the **full window width** (including the left Outliner
   sidebar), pinned to the bottom of the app root. Both scroll owners reserve bottom
   padding equal to the collapsed bar height so their last rows are not hidden behind it.
   The drawer sits above page content but below modals/toasts.

### Reproduction Context

Deterministic. Change 2 reproduces on every Create Clip / Subtract Clip enqueue.
Changes 1, 3, 4 are present on every run of the INV-035 drawer.

---

## Root Cause Analysis

**Category:** silent-failure (Change 2, the only true defect) — Changes 1/3/4 are
design refinements of the INV-035 feature surfaced by QA.

### Diagnosis

**Change 2 — the structured-clone crash.** `MediaQueueStore.runItem` passes
`item.clip` straight into `RendererMessenger.startMediaJob(...)`
(`MediaQueueStore.ts:192-196`), which crosses the `ipcRenderer.invoke` boundary. That
boundary serializes its arguments with the **structured clone algorithm**, which cannot
clone a **MobX observable proxy**. `item.clip` is observable (declared
`@observable clip` on `QueueItem`, `MediaQueueStore.ts:28`) and is stored as the
object handed in by `ImageTools` — a MobX-tracked proxy. Jobs with no clip pass
`undefined` (trivially cloneable), which is why only the clip tools fail. The failure is
"silent" in the architectural sense: the code path exists and looks correct, but the
proxy can't survive serialization, so it throws at the boundary instead of at the call
site where the cause is visible. The authoritative fix is at the boundary: convert the
proxy to a plain object with `toJS(item.clip)` exactly where it enters
`startMediaJob`. This also covers `retry`, which re-enqueues and re-routes through
`runItem`, so no separate enqueue-side copy is needed.

**Change 1 — drawer lifecycle.** Two lines encode the unwanted behavior:
`enqueue` sets `this.isDrawerOpen = true` (`MediaQueueStore.ts:137`), and the drawer
short-circuits with `if (!mediaQueueStore.hasItems) return null`
(`MediaQueue/index.tsx:195`). Together they make the surface ephemeral and intrusive.
The fix removes both: default `isDrawerOpen=false` is kept, the auto-open is deleted,
and the root `.media-queue` + header always render (table only when there are rows;
otherwise a muted placeholder).

**Change 3 — resolved-row lifecycle.** The Keep actions and the failed-row Dismiss all
**splice the row out** (`keepNew`/`keepOriginal`/`keepBoth`,
`MediaQueueStore.ts:292-346`), discarding any record of resolution; Dismiss reuses
`keepBoth`, which mislabels its intent. There is no `resolved` status, no resolution
label, no ordering that separates done work from live work, and no bulk clear. The fix
introduces a `resolved` status + `resolution` label on `QueueItem`, repurposes the Keep
actions to mark-resolved (after their existing trash work) instead of splicing, adds a
dedicated `dismiss` action, a `resolvedCount` computed, a `clearResolved` action, a
render-time sort (unresolved first, then resolved, each by `requestedAt`), a resolved
row branch, and a "Clear resolved" header control.

**Change 4 — positioning/mount.** The drawer is a child of `<main id="main">`
(`Main.tsx:76`) and is `position: absolute` within that stacking context
(`media-queue.scss:15`), so it is geometrically confined to the content column and stops
at the Outliner. The fix moves the mount out of `<main>` to a sibling of `<Split>` under
the full-window app root (`#layout-container`) and switches to
`position: fixed; left:0; right:0; bottom:0`, with a z-index audited to sit above content
but below modals/toasts, and bottom padding reserved on both scroll owners.

### Diagnostic Questions Considered

- **Wrong mental model?** No (Change 2). Changes 1/3 reflect a refined product model of
  the drawer as a persistent, self-curating surface rather than an ephemeral popup.
- **Architectural shortcoming?** Change 3 — there was no first-class notion of a
  "resolved" item, so done work and live work could not be separated or bulk-cleared.
- **Incorrect order of operations?** No.
- **Missing edge case?** Change 2 — the clip-bearing job was the unhandled case at the
  IPC serialization boundary.
- **Wrong abstraction?** Change 4 — the drawer was scoped to the content stacking
  context when it is conceptually an app-level overlay.
- **Silent failure?** Yes — Change 2 is the primary defect: a MobX proxy thrown at the
  structured-clone boundary, far from the call site, with an opaque message.

---

## Blast Radius

All four changes touch the same two INV-035 surfaces — `MediaQueueStore.ts` and
`MediaQueue/index.tsx` — plus `Main.tsx` and `media-queue.scss` for Change 4.

1. **`MediaQueueStore.runItem` IPC call site** — passes a MobX proxy (`item.clip`) into
   `startMediaJob`. Fixed with `toJS(item.clip)` at the boundary. `retry` is covered
   transitively (routes through `runItem`). *(Change 2)*

2. **`MediaQueueStore.enqueue` + drawer early return** — the auto-open assignment and the
   `if (!hasItems) return null` together make the drawer ephemeral and intrusive. Both
   removed; header always renders, table conditional, empty placeholder added. *(Change 1)*

3. **`QueueItem` status model** — gains `'resolved'` in the status union and an
   `@observable resolution: string | null`. *(Change 3)*

4. **Keep actions (`keepNew`/`keepOriginal`/`keepBoth`)** — stop splicing; after their
   existing trash work (keeping the `keepOriginal` viewer-on-output guard) they set
   `status='resolved'` and the appropriate `resolution` label. *(Change 3)*

5. **Failed-row Dismiss** — currently calls `keepBoth` (mislabels as "Kept both"). A new
   `dismiss(item)` action sets `status='resolved'; resolution='Dismissed'`, and the
   Dismiss button is repointed at it. *(Change 3)*

6. **Queue curation** — new `@computed resolvedCount` and `@action.bound clearResolved()`
   (filters resolved items out). The header gains a "Clear resolved" control (shown only
   when `resolvedCount>0`) and the summary gains `· {resolvedCount} resolved`. *(Change 3)*

7. **Drawer row ordering + rendering** — render-time sort (unresolved first by
   `requestedAt`, then resolved by `requestedAt`; the underlying array keeps insertion
   order so new enqueues intentionally appear above resolved rows) and a new
   `status==='resolved'` row branch (status shows `resolution` with class
   `media-queue__status--resolved`; Actions cell empty; filename still clickable). *(Change 3)*

8. **Drawer mount point + CSS positioning** — moved out of `<main id="main">` to a sibling
   of `<Split>` under `#layout-container`; `.media-queue` switches `position: absolute` →
   `position: fixed; left:0; right:0; bottom:0`. *(Change 4)*

9. **Overlay z-index ordering** — drawer must sit above page content but below the
   Settings, HelpCenter, AdvancedSearchDialog, and CustomToaster overlays; their
   z-indices/stacking contexts must be audited and the drawer slotted in correctly.
   *(Change 4)*

10. **Scroll-owner bottom padding** — both the content scroller (`#content-view`) and the
    Outliner scroll root must reserve bottom padding equal to the collapsed bar height
    (2rem, preferably a shared CSS var) so their last rows are not hidden behind the
    full-width fixed bar. Exact selectors confirmed at implementation time. *(Change 4)*

11. **`#window-splitter` bottom drag-handle** — the Outliner/content vertical splitter's
    bottom drag-handle hit area overlaps the new full-width fixed bar; verify the splitter
    remains usable (risk note). *(Change 4)*

---

## UX / Requirements Specification

### Purpose

Polish the INV-035 non-blocking media-job queue drawer per manual-QA findings: fix the
clip crash, make the drawer a stable always-present default-collapsed surface that never
auto-opens, keep resolved work visible-but-out-of-the-way with a one-click clear, and pin
the drawer across the full window width.

### User-Stated Design Decisions

1. **Authoritative fix at the IPC boundary** — convert the clip proxy with
   `toJS(item.clip)` at the `startMediaJob` call site in `runItem`, not via an
   enqueue-side copy. *(Rationale: one place, the actual serialization boundary; `retry`
   routes through `runItem` so it is covered for free; no risk of a second un-converted
   path.)*
2. **Always-present, default-collapsed, no auto-open drawer** — the header bar and
   summary are visible at all times (even empty); the drawer defaults to collapsed and
   never auto-opens on enqueue. *(Rationale: a predictable, non-intrusive surface the user
   controls; jobs run without the drawer jumping open.)*
3. **Resolved rows kept and sunk to the bottom; "Clear resolved" to purge** — Keep/Dismiss
   actions mark a row `resolved` (with a label) instead of removing it; resolved rows sort
   below all live rows; "Clear resolved" removes them in bulk. New enqueues intentionally
   appear above resolved rows. *(Rationale: the user can see what was decided without it
   crowding live work, and clear it when they choose.)*
4. **Full-window-width drawer** — the drawer spans the entire window width, including the
   left Outliner, pinned to the bottom. *(Rationale: a single app-wide status surface
   rather than one confined to the content column.)*

### Behavioral Specifications

- **Change 2:** `runItem` calls `startMediaJob(jobType, source.absolutePath, toJS(item.clip))`.
  `retry` unchanged (covered via `runItem`).
- **Change 1:** default `isDrawerOpen=false`; `enqueue` no longer sets it true; the drawer
  root + header always render; the `<table>` renders only when there are rows, otherwise a
  muted `.media-queue__empty` placeholder reading "No media jobs yet"; empty summary reads
  `0 queued · 0 processing · 0 done`.
- **Change 3:**
  - `QueueItem.status` union adds `'resolved'`; `QueueItem` gains
    `@observable resolution: string | null = null`.
  - `keepNew` → after trashing the source: `status='resolved'; resolution='Kept new'`.
  - `keepOriginal` → after the viewer-on-output guard and trashing the output:
    `status='resolved'; resolution='Kept original'`.
  - `keepBoth` → `status='resolved'; resolution='Kept both'` (no trash).
  - new `@action.bound dismiss(item)` → `status='resolved'; resolution='Dismissed'`; the
    failed-row Dismiss button is repointed from `keepBoth` to `dismiss`.
  - new `@computed resolvedCount`; new `@action.bound clearResolved()` (filter resolved
    items out of `items`).
  - `retry` unchanged.
  - drawer: render-time sort — unresolved first by `requestedAt`, then resolved by
    `requestedAt` (the underlying array keeps insertion order; new enqueues appear above
    resolved rows by design); a `status==='resolved'` row branch (Status shows `resolution`
    with class `media-queue__status--resolved`, Actions cell empty, filename still
    clickable); a header "Clear resolved" control shown only when `resolvedCount>0`; summary
    extended with `· {resolvedCount} resolved`.
  - scss: `.media-queue__status--resolved { color: var(--text-color-muted); }`.
- **Change 4:**
  - `Main.tsx`: move `<MediaQueueDrawer/>` OUT of `<main id="main">` to be a sibling of
    `<Split>` inside `<TagDnDProvider>` (wrap in a fragment) so it sits under the
    full-window app root (`#layout-container`).
  - `media-queue.scss`: `.media-queue` `position: absolute` → `position: fixed; left:0;
    right:0; bottom:0`.
  - Audit overlay z-indices (Settings, HelpCenter, AdvancedSearchDialog, CustomToaster);
    set the drawer above content but below those.
  - Reserve bottom padding = collapsed bar height (2rem, prefer a CSS var) on BOTH scroll
    owners — `#content-view` and the Outliner scroll root — so last rows are not hidden;
    confirm exact selectors at implementation time.

### Explicit Rejections

- Do **not** fix Change 2 with an enqueue-side deep copy — the single boundary
  conversion in `runItem` is authoritative and covers `retry`.
- Do **not** keep the auto-open on enqueue, and do **not** unmount the drawer when empty.
- Do **not** splice Keep/Dismiss rows away — resolved rows are kept until "Clear
  resolved" (or quit). Do **not** reorder the underlying `items` array to sink resolved
  rows; do the ordering at render time only.
- Do **not** leave the failed-row Dismiss pointed at `keepBoth` (it mislabels as "Kept
  both").
- Do **not** confine the drawer to `<main>` / `position: absolute`.

---

## Holistic Solution

### Approach

Five small, ordered edits to the four INV-035 critical files, in the approved order
**2 → 1 → 3 → 4**, plus a tests/docs task:

1. **TASK-146 (Change 2)** — `MediaQueueStore.ts`: `import { toJS } from 'mobx'`; pass
   `toJS(item.clip)` into `startMediaJob` in `runItem`. (Covers `retry`.)
2. **TASK-147 (Change 1)** — `MediaQueueStore.ts`: delete the `isDrawerOpen = true` in
   `enqueue` (keep default `false`). `MediaQueue/index.tsx`: delete the
   `if (!hasItems) return null`; always render root + header; render `<table>` only with
   rows, else a muted `.media-queue__empty` placeholder.
3. **TASK-148 (Change 3)** — `MediaQueueStore.ts`: `'resolved'` status + `resolution`
   field; Keep actions mark-resolved instead of splicing; new `dismiss`, `resolvedCount`,
   `clearResolved`. `MediaQueue/index.tsx`: render-time sort, resolved row branch,
   "Clear resolved" control, summary `· {n} resolved`, Dismiss → `dismiss`.
   `media-queue.scss`: `.media-queue__status--resolved`.
4. **TASK-149 (Change 4)** — `Main.tsx`: relocate the drawer mount to a `<Split>` sibling
   under `#layout-container`. `media-queue.scss`: `position: fixed`; z-index audit;
   bottom padding on both scroll owners (CSS var). Verify `#window-splitter` handle.
5. **TASK-150 (tests + docs)** — extend the `tests/media-queue-*` jsdom suites and update
   the INV-035 tool docs to the new behavior.

### Expected Outcomes

- Create Clip / Subtract Clip enqueue and run with no structured-clone error.
- The drawer is always visible, starts collapsed, never auto-opens; empty state shows the
  placeholder and `0 queued · 0 processing · 0 done`.
- Resolved rows sink to the bottom with their resolution label; "Clear resolved" purges
  them; Dismiss is correctly labeled; the summary shows the resolved count.
- The drawer spans the full window width over the Outliner and content; last rows of both
  scrollers stay visible; modals/toasts still render above the drawer; the splitter handle
  still works.
- `yarn lint` and `yarn build` compile (batch test at the end per project convention).

### Risks and Tradeoffs

- **z-index vs modals/toasts (Change 4):** the full-window fixed bar must not cover the
  Settings / HelpCenter / AdvancedSearchDialog dialogs or CustomToaster. Mitigation: audit
  and slot the drawer above content but below those overlays.
- **`#window-splitter` bottom drag-handle (Change 4):** the Outliner/content splitter's
  bottom handle hit area overlaps the new fixed bar; verify it stays usable.
- **Exact scroll-owner selectors (Change 4):** the Outliner scroll root selector must be
  confirmed at implementation time so the reserved bottom padding lands on the real
  scroller.

### User-requirement verification

- "fix clip clone crash at the IPC boundary via `toJS`, covering retry" → TASK-146. ✓
- "drawer always visible, default-collapsed, no auto-open, empty placeholder + 0/0/0
  summary" → TASK-147. ✓
- "resolved rows kept + sunk to bottom; Clear resolved; correct Dismiss label; resolved
  count in summary; new enqueues above resolved" → TASK-148. ✓
- "drawer spans full window width incl. Outliner; padding on both scrollers; z-index below
  modals/toasts" → TASK-149. ✓
- "tests/docs for the four changes" → TASK-150. ✓

---

## Documentation Updates

- [ ] Updated: `docs/TOOLS.md` (always-present default-collapsed full-width drawer;
      resolved rows + Clear resolved; clip jobs fixed)
- [ ] Updated: `docs/create-clip.md`, `docs/subtract-clip.md` (clip jobs now enqueue/run
      without the structured-clone error)
- [ ] Updated: any INV-035 drawer screenshots/wording describing the auto-open or
      content-only width
