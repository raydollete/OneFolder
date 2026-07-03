Tier: 3 — Systemic/cross-cutting: the same defective async-read template is duplicated across the whole inspector-panel cluster (~7 files); the fix touches all of them and carries a data-corruption risk, so it gets the full external-review + latent-defect-hunt treatment.

Type: bug

## Why

The file inspector panels share a copy-pasted async-read template — an ExifTool/fs
read whose Promise result is written into React state inside a `useEffect` keyed on
`[file.absolutePath]`, with **no guard** against the selected file changing before
the read resolves, and frequently a `.catch` that swallows or no `.catch` at all.
When the user switches files faster than a read completes (ExifTool serializes
reads, so out-of-order resolution is routine), the panel shows a *previous* file's
metadata. For the panels whose values seed editable form inputs, this is worse than
a visual glitch: **saving then writes the previous file's metadata into the current
file** — silent data corruption. This is the systemic follow-up promised by the
archived `fix-video-fps-display` change (its bomb-squad hunt enumerated these sites).

## Root Cause

Category: **architectural-shortcoming**.

The inspector-panel cluster was built by copying a happy-path read template that
lacks two structural guards the rest of the codebase already has: a stale-guard
(cancellation on file change) and an explicit error branch. The correct abstractions
exist and are used elsewhere — `src/frontend/hooks/usePromise.ts` (an
`isEffectRunning` flag + `Result<T,E>`), and the `let cancelled` flag in
`RemovalAlert.tsx` / `LibrarySelector.tsx`. The gallery, slide-mode, and hover
surfaces all adopt them; the inspector cluster did not. Direct evidence the pattern
was available but skipped: `ImageDates.tsx:46` and `ImageInfo.tsx:102` already route
*one* read through `usePromise` while the sibling `exifStats` read next to it
(`ImageDates.tsx:68`, `ImageInfo.tsx:145`) was left unguarded — a half-applied fix.

## What Changes

- Guard every inspector async read against file-switch staleness so the panel only
  ever shows / saves metadata for the currently-selected file. Use the `let cancelled`
  flag pattern (not `usePromise`) for panels that seed **local editable state**, to
  avoid clobbering in-progress user edits when a read re-resolves.
- Add a fail-loud error branch (a logged warning) to the reads that currently have
  **no** `.catch` (`ImageInfo.tsx:141,145`, `ImageDates.tsx:68`, `ImageMap.tsx:139`),
  so an unhandled rejection is neither a silent blank nor an uncaught promise.
- Fix the one different-sub-class site, `FileStore.ts:691`
  (`platform.fs.move(...).catch(() => {})`), by logging the swallowed thumbnail-move
  error rather than discarding it (no stale-guard applies — it is fire-and-forget).

## Capabilities

### New Capabilities
- `inspector-metadata-reliability`: cross-cutting guarantees for the file inspector's
  asynchronous metadata reads/writes — displayed values always match the selected
  file (never stale after a fast switch), saves never write another file's values,
  and read failures are logged rather than silently swallowed.

### Modified Capabilities
<!-- None. `video-metadata-display` already states a video-frame-rate-specific
     reliability requirement; this new capability generalizes the guarantee to all
     inspector metadata (images + video, all panels) without changing that spec. -->

## Blast Radius

Confirmed by a bomb-squad sweep of the whole frontend (`components/`,
`containers/ContentView` gallery/grid/slide/hover, `Outliner`, `hooks/`, `stores/`)
for `.then(set*`, `.catch(() =>`, the `read*` calls, and file-keyed `useEffect`
async reads. Current line numbers:

1. `src/frontend/components/ImageMap.tsx:139` — stale-race **+ no `.catch`**; `exifStats`
   feeds editable GPS `<input>`s + write-back. HIGH (corruption + wrong-map fly).
2. `src/frontend/components/ImageInfo.tsx:145` — stale-race + no `.catch`; `exifStats`
   feeds editable inputs (Software/Artist/Copyright…) + write-back. HIGH (corruption).
   And `:141` — `readAllExifTags`→`exifAll`, display-only, no `.catch`. MEDIUM.
   (The frame-rate read at `:102` is already guarded — leave it.)
3. `src/frontend/components/ImageDates.tsx:68` — stale-race + no `.catch`; editable
   date inputs + write-back. HIGH (corruption). (`modified` read at `:46` already guarded.)
4. `src/frontend/components/ImageDescription.tsx:32-49` — stale-race (has a logging
   `.catch`); `descriptionValue` backs an editable `<textarea>` + write-back. HIGH (corruption).
5. `src/frontend/components/ImageParameters.tsx:32-49` — stale-race (has logging `.catch`);
   seeds local state, display-only `<p>`. MEDIUM.
6. `src/frontend/components/ImagePrompt.tsx:27-43` — stale-race (has logging `.catch`);
   display-only. MEDIUM/LOW.
7. `src/frontend/stores/FileStore.ts:691` — **different sub-class**: silent-swallow
   `platform.fs.move(...).catch(() => {})`, fire-and-forget thumbnail move. LOW; fix = log.

Searches proving the radius bounded: the sweep found **no other sites** of the
stale-race-into-state class. Gallery/grid/hover (`GalleryItem.tsx:133-184`) and
slide-mode (`SlideMode/index.tsx:147-171,317-324`) already use `usePromise` /
`isEffectRunning`; `LibrarySelector.tsx:81` and `RemovalAlert.tsx:211` use the
`cancelled` flag; the remaining `.then(set*)` hits (`Outliner` tag/location creates,
`Settings` one-time mount reads, `UiStore.ts:992` autoplay swallow) are user-action or
one-time-startup, not keyed on a fast-changing selection.

## Impact

- 6 inspector components + `FileStore.ts` — add stale-guards and fail-loud logging.
  No DTO/schema/persistence changes; the write paths themselves are unchanged (only
  guarded against acting on stale reads). UI/reliability only, non-breaking.
