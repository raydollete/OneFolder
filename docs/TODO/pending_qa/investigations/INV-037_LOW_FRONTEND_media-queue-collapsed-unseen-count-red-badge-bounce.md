---
id: INV-037
title: 'Media queue collapsed-drawer unseen-change red badge with first-appearance bounce'
reported_bug: "When the media queue drawer is collapsed, the four summary counts (queued / processing / done / resolved) silently change in the background with no indication that anything new happened since the user last had the drawer open. Requested: while the drawer is collapsed, overlay an Apple-style red notification badge on any count whose value has changed since the last time the drawer was open; when a badge first appears it should bounce like an iOS/macOS app-icon badge. Opening the drawer clears the unseen state and removes all badges."
date: 2026-06-23
status: active
superseded_by:
tasks_spawned: [TASK-151, TASK-152, TASK-153]
root_cause_category: missing-edge-case
affects:
  - 'MediaQueueStore — no notion of "seen" counts vs live counts; no snapshot taken on collapse (src/frontend/stores/MediaQueueStore.ts)'
  - 'MediaQueueDrawer summary rendering — the four counts are concatenated into one plain string with no per-count elements to badge (src/frontend/containers/MediaQueue/index.tsx)'
  - 'media-queue.scss — no badge styles, no bounce keyframes (resources/style/media-queue.scss)'
---

<!--
  Feature request (UI polish) layered on top of the INV-035 / INV-036 media-job
  bottom queue drawer. The drawer is already always-present, default-collapsed,
  full-window-width, and renders four live counts in its header summary. This
  investigation adds unseen-change tracking + a red notification badge + a
  first-appearance bounce to that header.

  NOTE ON CURRENT STATE: the working tree already contains the INV-036 final
  state — MediaQueueStore exposes pendingCount / runningItem / completedCount /
  resolvedCount and isDrawerOpen (default false); the drawer header renders a
  single `summary` string `${pending} queued · ${0|1} processing · ${done} done
  · ${resolved} resolved`. This investigation builds directly on that code.
-->

## Bug Report

### Observed Behavior

The INV-035/036 media queue is a persistent, full-window-width drawer pinned to the
bottom of the app. Its header bar (always visible) shows a single summary line with four
counts:

- **queued** — `mediaQueueStore.pendingCount`
- **processing** — `mediaQueueStore.runningItem !== undefined ? 1 : 0`
- **done** — `mediaQueueStore.completedCount`
- **resolved** — `mediaQueueStore.resolvedCount`

The drawer is collapsed by default and the user controls expand/collapse via the toggle
(`MediaQueueStore.isDrawerOpen`). While the drawer is collapsed, jobs continue to run and
drain in the background (FIFO, one at a time), so all four counts can change at any time —
a job moves pending→running→completed, the user resolves rows elsewhere, etc.

Today, when the drawer is collapsed, **those count changes happen silently**. The summary
text updates live (it is observable), but there is no affordance that draws the eye: the
user has no signal that "something new finished" or "the queue advanced" since they last
looked. The header just quietly shows different numbers. The counts are rendered as one
concatenated string (`MediaQueue/index.tsx:237-239`), so there is no per-count element
that could carry an indicator even if we wanted one.

### Expected Behavior

While the drawer is **collapsed**, OneFolder should track the count values that were
visible the **last time the drawer was open** (the values the user last actually saw). If
any of the four counts changes from its last-seen value while collapsed, overlay an
**Apple-style red notification badge** on that specific count. When a badge **first
appears**, it should **bounce** like an iOS/macOS app-icon badge animating in. Opening the
drawer clears the unseen state (snapshot catches up to the live counts) and removes all
badges. (Apple HIG: a notification badge is a small red oval overlaid on the top-trailing
corner of an item indicating unseen activity; it animates in with a brief scale "pop".)

### Reproduction Context

Deterministic, and entirely renderer-side / cosmetic. Reproduces on every run: collapse
the drawer, enqueue or let a job advance, and observe that nothing in the collapsed header
signals the change. No Electron, IPC, backend, metadata, or media-pipeline involvement.

---

## Root Cause Analysis

**Category:** missing-edge-case — the "drawer is collapsed and the user has unseen count
changes" state was simply never modeled. This is a new feature on a feature, not a defect
in existing logic.

### Diagnosis

The media queue header was designed (INV-036) to be **always live**: it renders the
current counts directly from MobX computeds every render. There is no second piece of
state representing "what the user last saw," and therefore no way to compute a *delta*
between live and seen. The collapsed/expanded distinction exists only as a single boolean
(`isDrawerOpen`) that gates the body `<Collapse>`; nothing reacts to the *transition*
open→closed to freeze a snapshot, and nothing reacts to open to clear it.

Concretely, the two things that must exist do not:

1. **A "seen snapshot" of the four counts in the store.** There is no observable holding
   the last-seen `{ queued, processing, done, resolved }`. The store
   (`MediaQueueStore.ts`) is the correct owner because it already owns both
   `isDrawerOpen` and all four count sources, so it can deterministically (a) refresh the
   snapshot to match live counts whenever the drawer is open, and (b) freeze it when the
   drawer closes. Computing "unseen" requires comparing live vs snapshot, which only the
   store can do authoritatively.

2. **Per-count DOM elements to attach a badge to.** The header concatenates all four
   counts into one string (`summary`), so there is no element to position a badge over.
   The summary must be decomposed into four labeled count spans so each can carry its own
   badge overlay (`MediaQueue/index.tsx`).

The bounce-on-first-appearance requirement is a pure CSS concern (a keyframed scale "pop")
but depends on the badge element only being mounted when a count is unseen — React mounting
the badge element *is* the "first appearance," so a CSS `animation` on the badge element
fires exactly once when it mounts, which is the natural, correct hook. No JS animation
state is needed.

### Diagnostic Questions Considered

- **Wrong mental model?** Mild — the header was modeled as "always live, always seen,"
  which is wrong once the drawer can hide. The fix introduces the missing "seen vs live"
  distinction.
- **Architectural shortcoming?** Minor — no first-class "last-seen" state and no per-count
  render elements. Both are added here.
- **Incorrect order of operations?** No.
- **Missing edge case?** Yes, primary — the collapsed-with-unseen-changes state was never
  modeled.
- **Wrong abstraction?** No — the store rightly owns count + drawer state; the badge is
  rightly a view concern. The single concatenated `summary` string is the only abstraction
  that must change (decompose into four count spans).
- **Silent failure?** No runtime failure — the silence here is literal (no UI signal),
  which is the feature gap, not a swallowed error.

---

## Blast Radius

This feature is intentionally narrow — three files, all renderer-side. There is no shared
"unseen/badge" abstraction elsewhere in the app that this could/should generalize, so the
blast radius is the media-queue surface only.

1. **`MediaQueueStore` count + drawer state** (`src/frontend/stores/MediaQueueStore.ts`) —
   gains a `seenCounts` observable snapshot, a `@computed liveCounts`, a `@computed
   unseenCounts` (the per-count changed-flags), a `markSeen()` action that copies live →
   seen, and the wiring that calls `markSeen()` whenever the drawer is open. The
   `isDrawerOpen` toggle becomes the trigger for clearing unseen state on open.

2. **Drawer header rendering** (`src/frontend/containers/MediaQueue/index.tsx`) — the
   single `summary` string is decomposed into four count spans (queued / processing /
   done / resolved), each of which conditionally renders a `MediaQueueBadge` overlay when
   `unseenCounts[key]` is true AND the drawer is collapsed. The toggle handler must also
   call `markSeen()` (belt-and-suspenders with the open reaction).

3. **media-queue.scss** (`resources/style/media-queue.scss`) — gains
   `.media-queue__count` (positioning context for the badge), `.media-queue__badge` (the
   red oval, top-trailing absolute overlay), and a `@keyframes media-queue-badge-pop`
   bounce that the badge plays once on mount. The existing `&__summary { flex: 1; ... }`
   block is repurposed to host the four count spans.

4. **Tests** (`tests/media-queue-store.test.ts`, `tests/media-queue-drawer-dom.test.tsx`)
   — store-level tests for snapshot/unseen/markSeen semantics; DOM tests for badge
   presence on a changed count while collapsed, badge absence while open, and badge
   clearing on open. (The existing DOM tests open the drawer with `isDrawerOpen = true`,
   so they will not regress — badges only show while collapsed.)

No effect on: IPC, Electron main, backend/Dexie, ExifTool/metadata, thumbnailing, the
ffmpeg media-job pipeline, FIFO draining, or the resolved-row history logic.

---

## UX / Requirements Specification

### Purpose

Give the user a glanceable, Apple-style signal that media-queue activity occurred while
the drawer was collapsed, so they know when to reopen it — without forcing the drawer open
(INV-036 deliberately removed auto-open) and without any always-on noise when nothing has
changed.

### User-Stated Design Decisions

1. **Track the counts visible the last time the drawer was OPEN.** The baseline for
   "changed" is the last-seen value, captured while the drawer was open. *(Rationale: the
   user has "seen" whatever was on screen while the drawer was open; only changes since
   then are news.)*
2. **Badge only while COLLAPSED.** Badges are a collapsed-state affordance. While the
   drawer is open the user sees the live table, so no badges. *(Rationale: badges signal
   unseen activity; an open drawer means it is being seen.)*
3. **Red badge overlay on the specific changed count** (Apple-style notification badge).
   *(Rationale: per-count precision tells the user *what* changed — e.g. a new "done" — not
   just "something.")*
4. **Bounce on FIRST appearance.** When a badge first appears it animates with a bounce
   (iOS/macOS app-icon badge "pop"). *(Rationale: the motion is what catches the eye; a
   static badge that was already there should not re-bounce on every count tick.)*
5. **Opening the drawer clears the unseen state / badges.** *(Rationale: opening = seeing;
   the snapshot catches up to live and all badges clear.)*

### Behavioral Specifications

- **Seen snapshot.** `MediaQueueStore` holds `@observable seenCounts: { queued: number;
  processing: number; done: number; resolved: number }`, initialized to the current live
  counts (all zero at construction).
- **Live counts.** `@computed get liveCounts()` returns `{ queued: pendingCount,
  processing: runningItem !== undefined ? 1 : 0, done: completedCount, resolved:
  resolvedCount }`.
- **Keeping seen in sync while open.** While `isDrawerOpen === true`, `seenCounts` tracks
  `liveCounts` (so when the drawer later closes, the snapshot equals exactly what was on
  screen). Implement with a MobX `autorun`/`reaction` created in the constructor: when
  `isDrawerOpen` is true, copy `liveCounts` into `seenCounts` (this also fires on every
  live-count change while open, keeping them equal). This single reaction satisfies both
  "track while open" and "clear on open."
- **Unseen flags.** `@computed get unseenCounts(): { queued: boolean; processing: boolean;
  done: boolean; resolved: boolean }` returns, per key, `liveCounts[key] !==
  seenCounts[key]` — but ONLY meaningful while collapsed (the view gates display on
  `!isDrawerOpen`). A `@computed get hasUnseen(): boolean` (any flag true) is provided for
  convenience.
- **markSeen action.** `@action.bound markSeen()` copies `liveCounts` → `seenCounts`.
  Called by the reaction while open; also called directly in the drawer's toggle handler
  when opening, so the clear is immediate and testable without relying on reaction timing.
- **Header decomposition.** The header replaces the single `summary` string with four
  `.media-queue__count` spans, each rendering its label + value, e.g.
  `<span className="media-queue__count">{pendingCount} queued{badge}</span>`, joined by the
  existing ` · ` separators (kept as literal separator spans or CSS). Each span
  conditionally renders a `<MediaQueueBadge/>` (a small `<span className="media-queue__badge"
  aria-hidden="true"/>`, or with the count of changes — see below) when
  `!isDrawerOpen && unseenCounts[key]`.
- **Badge content.** Per the request ("the number should have a red badge overlay"), the
  badge is a small red dot/oval overlaid on the top-trailing corner of the changed count.
  Render it as an empty oval dot (no text) — a dot is the simplest faithful Apple badge and
  avoids ambiguity about what number to show when a count can both rise and fall. (If a
  numeric badge is later desired, the natural value is `Math.abs(live - seen)`; left out of
  scope here to keep the first cut clean.)
- **Bounce.** `.media-queue__badge` declares `animation: media-queue-badge-pop 0.3s
  cubic-bezier(0.34, 1.56, 0.64, 1) both;` (an overshoot/back ease so it visibly bounces).
  Because the element is only mounted when its count is unseen, the animation runs exactly
  once on mount = first appearance. A badge that stays mounted across re-renders does NOT
  re-run the animation (CSS animations fire on element mount/append, not on re-render),
  satisfying "bounce only on first appearance."
- **Accessibility.** The badge is decorative (`aria-hidden="true"`); the count text itself
  already conveys the value to screen readers.

### Explicit Rejections

- Do **not** auto-open the drawer on activity (INV-036 deliberately removed auto-open).
  The badge is the entire signal.
- Do **not** show badges while the drawer is open.
- Do **not** re-bounce an already-present badge on every count tick — bounce is
  first-appearance only (achieved by mounting the badge element only when unseen).
- Do **not** snapshot on every count change while collapsed — the snapshot is frozen at
  the last-open moment; only opening (or being open) refreshes it.
- Do **not** drive the animation from JS timers/state — rely on CSS `animation` firing on
  element mount.
- Do **not** generalize this into an app-wide badge system; it is scoped to the media
  queue header.

---

## Holistic Solution

### Approach

Three ordered edits, store → view → style, plus a tests task:

1. **TASK-151 (store)** — `MediaQueueStore.ts`: add `@observable seenCounts`, `@computed
   liveCounts`, `@computed unseenCounts`, `@computed hasUnseen`, `@action.bound markSeen()`,
   and a constructor `reaction`/`autorun` that calls `markSeen()` whenever `isDrawerOpen`
   is true (keeps seen == live while open, and clears unseen the instant the drawer opens).
   Initialize `seenCounts` to the current (zero) live counts.
2. **TASK-152 (view)** — `MediaQueue/index.tsx`: decompose the single `summary` string into
   four `.media-queue__count` spans (queued / processing / done / resolved) with ` · `
   separators; each renders a `MediaQueueBadge` overlay when `!isDrawerOpen &&
   unseenCounts[key]`. Add `markSeen()` to the toggle handler's open branch. Add a small
   `MediaQueueBadge` presentational element.
3. **TASK-153 (style + tests)** — `media-queue.scss`: `.media-queue__count` (relative
   positioning), `.media-queue__badge` (absolute top-trailing red oval, plays the pop
   animation), `@keyframes media-queue-badge-pop` (scale overshoot bounce). Extend
   `tests/media-queue-store.test.ts` (snapshot/unseen/markSeen semantics) and
   `tests/media-queue-drawer-dom.test.tsx` (badge shown on a changed count while collapsed,
   hidden while open, cleared on open).

### Expected Outcomes

- With the drawer collapsed, when any of the four counts changes from its last-open value,
  a red badge appears on exactly that count and bounces once on appearance.
- Opening the drawer removes all badges and resets the baseline; collapsing again with no
  further change shows no badges.
- A count that changes again while still collapsed (badge already present) does not
  re-bounce; the badge simply persists.
- No badges ever show while the drawer is open.
- `yarn lint` and `yarn build` compile; `yarn test` green (batch build/test at end per
  project convention).

### Risks and Tradeoffs

- **Reaction lifecycle / disposal.** The constructor `reaction`/`autorun` lives for the
  app session (the store is a session singleton), so a disposer is not strictly required,
  but capture the disposer in a field for cleanliness/testability. In jsdom tests the
  reaction will run; tests should drive `isDrawerOpen` explicitly and assert via
  `markSeen` effects rather than relying on reaction timing where possible.
- **"Changed" includes decreases.** `clearResolved` lowers `resolved`, finishing a job
  lowers `queued`. Per the spec any change (up or down) badges. This is intended — a dot,
  not a signed delta — so a decrease is still "news." Documented in the spec so it is not
  mistaken for a bug.
- **CSS-mount animation assumption.** The "bounce only on first appearance" guarantee
  relies on the badge element being unmounted when seen and remounted when next unseen.
  Keep the badge strictly conditional (`{cond && <Badge/>}`), never merely hidden via CSS,
  or the mount-fires-once behavior breaks.
- **`processing` is 0/1 only.** A job that starts and finishes entirely while collapsed
  could leave `processing` back at 0 (no net change → no badge) while `done` rose (badge).
  That is acceptable and arguably correct: the meaningful news is the completed job, which
  `done` already badges.

### User-requirement verification

- "track counts visible the last time the drawer was open" → `seenCounts` + open-reaction
  (TASK-151). ✓
- "red badge overlay on the specific changed count while collapsed" → per-count spans +
  conditional `MediaQueueBadge` gated on `!isDrawerOpen && unseenCounts[key]` (TASK-152),
  `.media-queue__badge` red oval (TASK-153). ✓
- "bounce on first appearance (Apple-style)" → CSS `@keyframes media-queue-badge-pop` on a
  conditionally-mounted badge (TASK-153). ✓
- "opening the drawer clears unseen state / badges" → `markSeen()` via open-reaction and
  the toggle handler (TASK-151/152). ✓

---

## Documentation Updates

- [ ] Updated: `docs/TOOLS.md` (note the collapsed-drawer unseen-activity badge on the
      media queue header), if it documents the drawer header — confirm at implementation
      time; add a one-line note if the header is described there.
