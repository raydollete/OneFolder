## Context

The video info panel (`src/frontend/components/ImageInfo.tsx`) recently gained an
FPS readout. It reads `VideoFrameRate` via `exifTool.readExifTags` in a
`useEffect` keyed on `[file.absolutePath]`, stores it with a bare `.then`, and
swallows all errors with `.catch(() => setVideoFps(''))`. The value is appended to
the Dimensions string. See proposal.md for the full root-cause analysis
(category: silent-failure).

The repo already contains the correct guarded async-read pattern in
`src/frontend/hooks/usePromise.ts`: it captures an `isEffectRunning` flag, ignores
resolutions after the sources change, and returns `Poll<Result<T, E>>` so callers
must handle the error branch explicitly rather than collapsing it into a blank.
`ImageDates.tsx` already uses `usePromise` for its `modified` field — but not for
its exif read — which confirms the pattern is understood in this cluster and was
simply missed for the newer reads.

## Goals / Non-Goals

**Goals:**
- The FPS row renders every time a video reporting a frame rate is selected, and
  never gets stuck blank across selections until an app restart, for causes we can
  prove statically (silent-swallow + stale/out-of-order resolution).
- Read failures are logged (fail-loud), so the runtime cause of any residual
  "stuck" behavior can be confirmed from logs instead of guessed.
- FPS appears on its own `Frame Rate` row directly below `Dimensions`; Dimensions
  reverts to `W x H`; the row is hidden when there is no value.

**Non-Goals:**
- Refactoring the other five inspector panels / nine sibling read sites that share
  the same latent class (see External Review). Tracked as a follow-up change.
- Making the exiftool `-stay_open` process auto-restart / lazy-reopen when it has
  exited. That touches `common/ExifIO.ts` and every reader, and is only warranted
  if the new logging shows a wedged process is the true persistence cause. Gated on
  evidence — deliberately out of scope here.
- Moving metadata reads into a shared MobX store.

## Decisions

**Decision 1 — Use the existing `usePromise` hook for the frame-rate read, rather
than hand-rolling a stale-guard.**
`usePromise(file.absolutePath, file.extension, query)` gives the `isEffectRunning`
stale-guard and the `Result<ok, err>` split for free, matching the pattern already
used elsewhere in the file/cluster. The query returns the raw `VideoFrameRate`
(or `undefined` for non-videos / no value). The component maps: `ok` → formatted
value; `err` → `console.warn(...)` + no row.
- *Alternative considered — hand-rolled `let cancelled` flag in a bespoke effect:*
  works, but reinvents `usePromise` and is easier to get subtly wrong. Rejected in
  favor of the shared hook.
- *Alternative considered — fold `VideoFrameRate` into the existing main
  `readExifTags(exifTags)` batch read (Gemini's suggestion):* eliminates the extra
  concurrent request, but that main read is itself unguarded (bomb-squad site #2),
  so folding would inherit its race unless that read is also converted — expanding
  scope into the broader refactor we are explicitly deferring. Rejected for this
  change; noted for the follow-up. The extra single-tag read is cheap and now
  guarded, so the concurrency cost is acceptable in the interim.

**Decision 2 — Fail loud on read error.**
Replace `.catch(() => setVideoFps(''))` with an error branch that
`console.warn`s the failing path + error and renders no row. This distinguishes
"video has no frame rate" from "the read failed", satisfies the project's
fail-loud convention, and is the instrument that will confirm the true
persistence cause at runtime.

**Decision 3 — Separate `Frame Rate` row via `CommonMetadata`.**
Add an optional `frameRate` field to `CommonMetadata` and a `Frame Rate` entry to
`commonMetadataLabels` ordered immediately after `dimensions`. Revert `dimensions`
to `` `${file.width || '?'} x ${file.height || '?'}` ``. The common-metadata render
loop currently emits every row unconditionally; `frameRate` must be skipped when
falsy (as the `exifFields` rows already are) so images and frame-rate-less videos
show no row.

## UX / Requirements

Verbatim display strings:
- Row label: `Frame Rate`
- Dimensions row label (unchanged): `Dimensions`
- Dimensions value: `<width> x <height>` (e.g. `1920 x 1080`; `?` for missing dim)
- Frame Rate value: `<n> fps` where `<n>` is the frame rate rounded to ≤2 decimals
  with trailing zeros and any trailing `.` stripped — e.g. `29.97 fps`, `30 fps`.
- Diagnostic log on read failure (developer-facing, exact text not user-visible):
  a `console.warn` identifying the frame-rate read failure and including the error.

Behavior:
- `Frame Rate` row is shown only when a non-empty formatted value exists.
- Non-video files: no `Frame Rate` row, and no frame-rate text on `Dimensions`.

**Explicit Rejections:**
- Do NOT append frame rate to the `Dimensions` value (` · NN fps`) — the user
  explicitly asked for a separate line below Dimensions.
- Do NOT show a `Frame Rate` row with an empty/`?`/`—` placeholder for images or
  videos with no frame rate — hide the row entirely.
- Do NOT keep the silent `.catch(() => setVideoFps(''))` — errors must be logged.

## Risks / Trade-offs

- [The true "stuck until restart" cause is a wedged/closed exiftool process, not
  the swallowed catch] → Then this UI fix makes the failure visible (logged) but
  does not restore the value without a restart. Mitigation: the fail-loud log is
  explicitly the probe for this; if logs show `'exiftool is not open'` recurring,
  a follow-up change hardens `common/ExifIO.ts` (lazy reopen / ensure-open before
  read), which fixes *all* panels, not just FPS. We do not speculatively build that
  now (unconfirmed premise).
- [Sibling sites remain racy] → ImageMap can fly the map to a previous file's GPS;
  ImageDescription can write file A's description into file B. Higher-severity than
  the FPS bug but out of the user's stated scope. Mitigation: recorded as a
  prioritized follow-up change so they are not lost.
- [Extra concurrent exiftool request retained] → minor; a single-tag read, now
  stale-guarded. Acceptable versus expanding scope.

## Migration Plan

Pure UI change in one component; no data/schema/DTO migration. Rollback = revert
the single-file diff.

## Open Questions

- Runtime confirmation (manual QA) of whether the persistence cause is a wedged
  exiftool process. If yes → open the `common/ExifIO.ts` follow-up change.

## External Review

### Gemini brief feedback (verbatim)

> #### 1. Is there a better approach than the stale-guard-in-effect + fail-loud-log fix?
> **Yes.** You should fold `VideoFrameRate` into the main metadata batch read. Even better, **move all metadata fetching into a shared MobX store** keyed by `file.absolutePath`.
> * **Why:** This eliminates redundant concurrent CLI requests from sibling components, provides a single source of truth, and resolves the stale-state problem naturally without needing individual `useEffect` stale-guards in every UI component.
>
> #### 2. Is the blast radius complete, or are we missing a class of sites?
> **The blast radius is incomplete.** You are missing:
> * **The MobX/React boundary:** Sibling components querying the disk independently for the same file.
> * **Electron main/renderer boundaries:** If `readExifTags` spawns child processes directly from the renderer thread, it risks blocking the UI or leaking zombie processes.
> * **Other metadata-dependent UI:** Any list/grid views, search filters, or hover-cards that read EXIF tags will suffer from the same latent race conditions and process crashes.
>
> #### 3. Does NOT ensuring/reopening the exiftool process leave the "stuck until restart" symptom unfixed?
> **Yes, absolutely.** If the underlying `-stay_open` process exits or crashes (e.g., due to a corrupted file, OS sleep/wake cycle, or resource cleanup), the app will remain permanently broken until restart. The proposed fix will only change the symptom from *silent failure* to *verbose failure* (console spam). You **must** implement a lazy-instantiation or auto-restart mechanism for the `exiftool` process when a call rejects with `"exiftool is not open"`.

**Accept/reject per point:**
- **Q1 fold into batch read — Partially accept, defer.** Correct that folding
  removes the extra request, but the main batch read is itself unguarded, so
  folding without converting it inherits the race. Rejected for this scoped fix;
  captured for the follow-up. The shared-MobX-store idea is a larger architectural
  change, explicitly a non-goal here.
- **Q2 blast radius incomplete — Accept.** The bomb-squad hunt (below) enumerated
  the sibling read sites and confirmed 6 panels / 9 sites plus a store method. The
  reported bug is scoped to `ImageInfo`; the rest becomes a follow-up change so the
  evidence is not lost.
- **Q3 exiftool process not reopened — Accept as risk, reject as in-scope work.**
  Agreed this leaves the symptom unfixed *if* a wedged process is the true cause.
  We refuse to build the reopen mechanism on an unconfirmed premise (verify
  root-cause before fixing); the new fail-loud log is precisely the probe. If logs
  confirm it, the `common/ExifIO.ts` hardening is the follow-up — and it fixes all
  readers, so it belongs in its own change, not bolted onto a UI fix.

### Bomb-squad latent-defect hunt (silent-failure / stale-race class)

Root philosophical shortcoming: **silent failure + happy-path thinking propagated
by copy-paste inheritance** across the inspector-panel cluster. The correct guarded
pattern already exists (`usePromise`, SlideMode's `isEffectRunning`,
RemovalAlert/LibrarySelector's `cancelled` flag); the newer inspector reads skipped
it. Findings (ranked):

1. **`ImageMap.tsx:139`** — stale-race, no `.catch`. HIGH. Late resolve flies the
   map to a previously selected file's GPS and drops a marker there.
2. **`ImageInfo.tsx:133-140`** — stale-race, no `.catch`. HIGH. Main EXIF table
   shows the previous file's camera/copyright/GPS after a fast switch.
3. **`ImageDescription.tsx:35-38`** — stale-race. HIGH (data-integrity). Editable
   textarea; a late resolve + save can write file A's description into file B.
4. **`ImageDates.tsx:68-75`** — stale-race, no `.catch`. MEDIUM-HIGH. Wrong dates
   after a fast switch (sibling `modified` field is correctly guarded via
   `usePromise` — direct evidence the pattern was available and missed).
5. **`ImageInfo.tsx:129-131`** — stale-race, no `.catch`. MEDIUM. "View all
   ExifTool" JSON dump shows the prior file's data.
6. **`ImageParameters.tsx:33-47`** — stale-race. MEDIUM.
7. **`ImagePrompt.tsx:29-41`** — stale-race. MEDIUM/LOW.
8. **`FileStore.ts:691`** — `platform.fs.move(...).catch(() => {})` silent-swallow
   on thumbnail move. LOW-MEDIUM; not UI state.

Blast-radius verdict: NOT empty — the class spans the inspector-panel cluster plus
one store method; the rest of the frontend already uses guarded patterns.

**Disposition:** This change fixes the reported `ImageInfo` FPS site (#confirmed)
using `usePromise` + fail-loud. Sites 1–8 are deferred to a dedicated follow-up
change (see tasks.md final item), prioritizing the data-corruption edge
(`ImageDescription`, #3) and the wrong-GPS map fly (`ImageMap`, #1). The recommended
fix template for that follow-up is to route every inspector read through
`usePromise` and render the `err` branch instead of swallowing it.
