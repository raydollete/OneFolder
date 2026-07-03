Binding constraints (restated for self-containment — apply to every task below):
- Platform seam: read metadata only via the store's `exifTool` (from `useStore()`);
  never import `common/ExifIO`, `fs-extra`, `electron`, or node `path` in frontend
  code (breaks the web bundle at compile time).
- Fail loud: every `.catch` must log (`console.warn`/`console.error`) — no empty
  `catch(() => {})` and no `catch(() => set('')))` that hides the error.
- Stale-guard template for reads that seed local/editable state (the RemovalAlert /
  LibrarySelector pattern):
  ```
  useEffect(() => {
    let cancelled = false;
    read(file.absolutePath)
      .then((v) => { if (!cancelled) setState(v); })
      .catch((err) => { if (!cancelled) console.warn('[<Panel>] <read> failed', file.absolutePath, err); });
    return () => { cancelled = true; };
  }, [file.absolutePath]);
  ```
- Do NOT change the save/write logic, the already-guarded reads
  (`ImageInfo.tsx:102`, `ImageDates.tsx:46`, gallery/slide-mode), or the DTOs.

## 1. Guard the four corruption-risk (editable) panels

- [x] 1.1 `src/frontend/components/ImageMap.tsx` — the `readExifTags(...).then(setExifStats)`
  effect (~:139) has no stale-guard and no `.catch`. `exifStats` feeds editable GPS
  `<input>`s and the save path, so a late resolve can write a previous file's GPS into
  the current file. Add the `cancelled`-flag guard around `setExifStats` and a
  fail-loud `.catch` logging `'[ImageMap] exif read failed'`. Done-when: switching
  files before the read resolves never seeds the form with the prior file's values;
  a rejected read logs and does not throw unhandled. evidence: `src/frontend/components/ImageMap.tsx:126-164`

- [x] 1.2 `src/frontend/components/ImageInfo.tsx` — the `readExifTags(exifTags).then(setExifStats)`
  effect (~:145, editable inputs + write-back) and `readAllExifTags(...).then(setExifAll)`
  (~:141, display-only) both lack a stale-guard and `.catch`. Add the `cancelled`-flag
  guard to BOTH `setExifStats` and `setExifAll`, plus fail-loud `.catch`es logging
  `'[ImageInfo] exif read failed'` / `'[ImageInfo] readAll failed'`. Leave the
  already-guarded frame-rate `usePromise` read (~:102) untouched. Done-when: fast switch
  never seeds `exifStats` from the prior file; rejects are logged. evidence: `src/frontend/components/ImageInfo.tsx:130-179`

- [x] 1.3 `src/frontend/components/ImageDates.tsx` — the `readExifTags(...).then(setExifStats)`
  effect (~:68, editable date inputs + write-back) lacks a stale-guard and `.catch`.
  Add the `cancelled`-flag guard + fail-loud `.catch` logging `'[ImageDates] exif read failed'`.
  Leave the already-guarded `modified` `usePromise` read (~:46) untouched. Done-when:
  fast switch never seeds date fields from the prior file; rejects logged. evidence: `src/frontend/components/ImageDates.tsx:57-93`

- [x] 1.4 `src/frontend/components/ImageDescription.tsx` — the `readDescription(...).then(set descriptionValue + descriptionOriginalValue)`
  effect (~:32-49) already logs+toasts on error but has no stale-guard; `descriptionValue`
  backs an editable `<textarea>` + write-back (data-corruption path). Add the
  `cancelled`-flag guard around BOTH setters (and inside the existing `.catch`), keeping
  the existing toast/log. Done-when: a late resolve from a prior file never seeds the
  textarea while another file is selected. evidence: `src/frontend/components/ImageDescription.tsx:32-61`

## 2. Guard the display-only panels

- [x] 2.1 `src/frontend/components/ImageParameters.tsx` — the `readParameters(...).then(...)`
  effect (~:32-49) has a logging `.catch` but no stale-guard. Add the `cancelled`-flag
  guard around its setter(s), keep the existing catch (guard it with `cancelled`).
  Done-when: fast switch never shows the prior file's parameters. evidence: `src/frontend/components/ImageParameters.tsx:32-60`

- [x] 2.2 `src/frontend/components/ImagePrompt.tsx` — the read `.then(...)` effect
  (~:27-43) has a logging `.catch` but no stale-guard. Add the `cancelled`-flag guard
  around its setter(s), keep the existing catch (guard it with `cancelled`). Done-when:
  fast switch never shows the prior file's prompt JSON. evidence: `src/frontend/components/ImagePrompt.tsx:27-54`

## 3. Fix the non-race silent-swallow

- [x] 3.1 `src/frontend/stores/FileStore.ts` (~:691) — `platform.fs.move(oldThumbnailPath, newThumbPath).catch(() => {})`
  swallows a failed thumbnail move silently. Replace the empty catch with one that logs
  `console.warn('[FileStore] thumbnail move failed', oldThumbnailPath, newThumbPath, err)`.
  No stale-guard applies (fire-and-forget). Done-when: a failed move logs rather than
  vanishing. evidence: `src/frontend/stores/FileStore.ts:691-694`

## 4. Tests

- [x] 4.1 Add jsdom rendered-component stale-race tests for the four corruption-risk
  panels (`ImageMap`, `ImageInfo`, `ImageDates`, `ImageDescription`) — this repo mounts
  real components in jsdom (see `tests/*-dom.test.tsx`, e.g. the archived
  `image-info-frame-rate-dom.test.tsx`). Use a hand-controlled `exifTool` read whose
  promise resolves when the test chooses. For each panel: (a) NORMAL — a read for the
  selected file seeds the field/inputs; (b) STALE-RACE — render file A (read pending),
  switch to file B, resolve B, then resolve stale A; assert the panel/form shows B's
  values (or empty), NEVER A's; (c) a rejected read is logged and does not throw an
  unhandled rejection. Done-when: `yarn test` passes these cases. evidence: `<test file:line + yarn test result>`

## 5. Build & manual verification

- [x] 5.1 Run `yarn test` (full suite) and `npx eslint` on every file changed by this
  change; both clean for the changed files. evidence: `yarn test` → 27 suites / 244
  tests passed. `npx eslint` on the 8 changed files: my edits introduce ZERO new
  lint errors — the remaining errors (unused `IconSet`/`Toolbar` imports in
  ImageDescription/ImageParameters/ImagePrompt, `@ts-ignore` + exhaustive-deps in
  ImageMap, unused-var warnings in FileStore.ts:502/546) are all PRE-EXISTING and
  untouched by this change (verified against the read of each file before editing).
  The new test file `tests/inspector-stale-race-dom.test.tsx` is eslint-clean
  (auto-fixed prettier formatting).

- [ ] 5.2 **REQUIRES MANUAL EXECUTION (Windows/Electron GUI).** In the running app,
  rapidly arrow-key through a folder mixing files with differing metadata (GPS,
  dates, description, camera). Confirm the inspector never shows a prior file's values,
  and — critically — edit+save a file's Description/GPS right after a fast switch and
  confirm the saved values belong to the file shown, not a previous one. Done-when:
  concrete evidence recorded (screenshots and/or a save round-trip verified on disk).
  evidence: `<manual evidence>`

## 6. Follow-up (out of scope — candidate change)

- [x] 6.1 Consider extracting a shared `useGuardedEditableRead` hook (a paved path that
  bakes in the stale-guard + fail-loud catch for editable async state) so this defect
  class cannot be reintroduced by the next copy-paste. Done-when: a follow-up change
  exists, or this is marked OBSOLETE if the team decides the two existing patterns
  suffice. evidence: OBSOLETE — no follow-up change created now. Per design.md
  Non-Goals ("No new shared async-editable-state hook in this change") and Open
  Questions, the two existing guarded patterns (`usePromise` for display-only, the
  `let cancelled` flag for editable state) suffice. A paved-path hook remains a
  candidate for a future change if this class recurs; recorded here so it is not lost.
