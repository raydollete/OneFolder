## Context

The file inspector is a cluster of near-identical panel components
(`ImageInfo`, `ImageDates`, `ImageMap`, `ImageDescription`, `ImageParameters`,
`ImagePrompt`) plus `ImageTools`. Each was forked from the same template: a
`useEffect(() => { asyncRead(file.absolutePath).then(setState) }, [file.absolutePath])`.
None of the reads flagged in the Blast Radius guard against the selected file
changing mid-read, and several have no `.catch`. See proposal.md for the full
site inventory and root cause (architectural-shortcoming). This is the systemic
follow-up to `fix-video-fps-display`.

The repo already contains the two correct patterns:
- `src/frontend/hooks/usePromise.ts` — `isEffectRunning` stale-guard + `Result<T,E>`;
  returns a read-only poll. Ideal for **display-only** reads.
- `RemovalAlert.tsx` / `LibrarySelector.tsx` — a `let cancelled` flag checked before
  every `setState`, with an error branch. Ideal for reads that seed **local editable
  state** (because the value must land in mutable component state, not a read-only poll).

## Goals / Non-Goals

**Goals:**
- Every inspector async read is stale-guarded: displayed values and form seeds match
  the currently selected file only.
- No save can write a previously selected file's metadata into the current file.
- Reads with no error branch get a fail-loud logged `.catch`.
- The one non-race silent-swallow (`FileStore.ts:691`) logs its failure.

**Non-Goals:**
- No new shared "async editable state" hook / abstraction. (Tempting, but out of
  scope; the two existing patterns suffice. A paved-path hook can be a later change.)
- No change to the write/save logic itself, the DTOs, or persistence.
- No change to the already-guarded reads (`ImageInfo.tsx:102`, `ImageDates.tsx:46`,
  gallery/slide-mode) — leave working code alone.
- Not touching `ImageTools` or non-read UI in these panels.

## Decisions

**Decision 1 — Pattern per panel by state shape, not one-size-fits-all.**
- Panels whose read seeds **local editable state** that backs form inputs + write-back
  (`ImageMap` exif, `ImageInfo` exifStats, `ImageDates` exif, `ImageDescription`):
  use the **`let cancelled` flag** in the existing effect. The value must live in
  mutable state (the user edits it), so `usePromise`'s read-only poll doesn't fit,
  and seeding editable state *from* a poll via a second effect risks clobbering
  in-progress edits when the poll re-resolves.
- Panels that are **display-only** (`ImageInfo` exifAll, `ImageParameters`,
  `ImagePrompt`): the `cancelled` flag is still the minimal change and keeps the
  cluster consistent; `usePromise` is acceptable but would restructure more than
  needed. Prefer the `cancelled` flag for a uniform, low-risk diff.
- *Alternative considered — migrate everything to `usePromise`:* rejected for the
  editable panels (clobber risk, per both external reviews) and as unnecessary churn
  for the display-only ones.

**Decision 2 — Add the missing `.catch` as fail-loud.**
`ImageMap.tsx:139`, `ImageInfo.tsx:141` & `:145`, `ImageDates.tsx:68` have no `.catch`
(so a rejection is an unhandled promise). Add a `.catch` guarded by the same
`cancelled` flag that `console.warn`s the failing read. Panels that already log+toast
(`ImageDescription`, `ImageParameters`, `ImagePrompt`) keep their existing catch; they
only need the stale-guard added.

**Decision 3 — `FileStore.ts:691` handled as its own sub-class.**
`platform.fs.move(oldThumbnailPath, newThumbPath).catch(() => {})` is fire-and-forget,
not a read-into-state race. Replace the empty catch with one that logs the failure
(fail-loud); no stale-guard applies.

## UX / Requirements

No new user-visible strings. User-observable behavior changes:
- After a fast file switch, the inspector never shows the previous file's metadata.
- Saving after a fast switch never writes another file's values.
- Failed reads log a `console.warn`/`console.error` (developer-facing, not shown to user).

Verbatim log convention (developer-facing): a `console.warn`/`console.error` that
names the panel and the failing read, e.g. `'[ImageMap] exif read failed'`,
`'[ImageInfo] exif read failed'`, `'[FileStore] thumbnail move failed'`.

**Explicit Rejections:**
- Do NOT convert the editable panels to `usePromise` (clobbers in-progress edits).
- Do NOT introduce a new shared async-editable-state hook in this change.
- Do NOT silence any read with an empty `.catch(() => {})` — every catch logs.
- Do NOT alter the already-guarded reads or the save logic.

## Risks / Trade-offs

- [The `cancelled` flag is added but a `setState` path is missed] → a stale update
  slips through. Mitigation: per-panel jsdom stale-race tests (switch file before the
  first read resolves; assert current-file value, never stale) for at least the four
  corruption-risk panels.
- [Behavioral change to editable panels could regress normal (non-race) loading] →
  Mitigation: tests also assert the normal load path still seeds the fields.
- [Inconsistency: some reads use `usePromise`, others the `cancelled` flag, sometimes
  in the same file] → accepted; both are correct guarded patterns, and forcing
  uniformity would mean rewriting working code. Noted for a future paved-path hook.

## Migration Plan

Per-file edits; no schema/data migration. Rollback = revert the diff. Each panel is
independent, so the change can land as one PR but be reviewed/reverted per file.

## Open Questions

- Whether to later extract a shared `useGuardedEditableRead` hook (paved path) so this
  class cannot be reintroduced. Out of scope here; candidate follow-up.

## External Review

### Gemini brief feedback (verbatim)

> #### 1. Best Approach for Editable Panels (ImageDescription)
> **Use the `cancelled` flag pattern.**
> * **The Pitfall of `usePromise`:** If you seed local editable state by syncing from a `usePromise` hook's return value, you create a dependency loop. When the user types, the local state changes. If `usePromise` triggers a re-evaluation (due to an unrelated re-render or a file-reference identity change without a path change), it will re-resolve and silently **clobber the user's in-progress edits**.
> * **The Cleanest Pattern:** Use a standard `useEffect` with a cleanup function setting `cancelled = true` [read → `if (!cancelled) setState`].
>
> #### 2. Blast Radius Evaluation (Sites Outside the Inspector Cluster)
> **Yes, the blast radius likely extends beyond the inspector.** ... grep hover cards/tooltips, thumbnail loaders in grid/list views, search filters/facets.
>
> #### 3. Risk of Batch Conversion & Root Cause Categorization
> * **Risk of Batch Conversion:** **Low, provided you split the strategies.** ... safe *if* you have automated tests covering metadata loading.
> * **Root Cause Category:** **Architectural-Shortcoming** is the correct primary category ... a **lack of a paved path** ... and the failure to enforce the existing `usePromise` abstraction during code reviews.

**Accept/reject per point:**
- **Q1 cancelled-flag for editable panels — Accept.** Adopted as Decision 1; the
  clobber-in-progress-edits pitfall is exactly why editable panels avoid `usePromise`.
- **Q2 blast radius may extend beyond inspector — Accept, then verified closed.** The
  bomb-squad sweep (below) actually grepped those exact surfaces (gallery/grid/hover,
  thumbnail loaders, search) and found them already guarded — so the radius is
  confirmed bounded to the 7 sites, not expanded.
- **Q3 batch is low-risk with split strategies + tests; architectural-shortcoming —
  Accept.** Drives the per-panel tests in tasks.md and the split in Decision 1;
  category confirmed.

### Bomb-squad latent-defect hunt (stale-race / silent-swallow class)

Confirmed all 7 sites at current line numbers and added the key finding that
**`exifStats` in `ImageMap`, `ImageInfo`, and `ImageDates` also feeds editable inputs
+ write-back** — so the corruption path is not unique to `ImageDescription`; it covers
four panels. Sequence: select A → read A; select B → blank stats, read B; A resolves
after B (ExifTool serializes reads → out-of-order is routine) → `setExifStats(A)` runs
while `file` is B → form shows A under B → save writes A's metadata into B.

Sites 3 & 4 are **half-applied fixes**: one read already uses `usePromise`
(`ImageInfo.tsx:102`, `ImageDates.tsx:46`) while the sibling `exifStats` read next to
it (`:145`, `:68`) is unguarded — easy to overlook.

Widened sweep verdict: **beyond the 7 sites, the class is EMPTY.** Already-correct:
`GalleryItem.tsx:133-184` (`usePromise` + `fileIdRef` identity check),
`SlideMode/index.tsx:147-171,317-324` (`isEffectRunning`), `LibrarySelector.tsx:81` &
`RemovalAlert.tsx:211` (`cancelled` flag). Out-of-class (user-action / one-time /
benign): `useCustomTheme.tsx:89`, `Outliner/LocationsPanel:567`,
`TagsPanel/ContextMenu:96` & `TagsTree:598`, `Settings/Advanced:20` &
`ImportExport:23`, `UiStore.ts:992`. `FileStore.ts:691` confirmed as a different
sub-class (fire-and-forget swallow) → log-only fix.
