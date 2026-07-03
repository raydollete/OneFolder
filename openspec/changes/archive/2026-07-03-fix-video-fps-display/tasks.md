## 1. Reliable frame-rate read (fix the reported bug)

- [x] 1.1 In `src/frontend/components/ImageInfo.tsx`, replace the ad-hoc
  `useState('') + useEffect(...readExifTags(['VideoFrameRate']).then().catch(() => setVideoFps('')))`
  frame-rate read with the repo's guarded `usePromise` hook from
  `src/frontend/hooks/usePromise.ts`. Call it unconditionally (hooks can't be
  conditional): `usePromise(file.absolutePath, file.extension, async (path, ext) => isFileExtensionVideo(ext) ? (await exifTool.readExifTags(path, ['VideoFrameRate']))[0] : undefined)`.
  Keep reading via the existing `exifTool` from `useStore()` (the platform `ExifIO`
  seam) — do NOT import `common/ExifIO`, `fs-extra`, `electron`, or node `path`
  directly (breaks the web bundle at compile time).
  Done-when: `videoFps` `useState` and its old effect are gone; the value derives
  from the `usePromise` `Poll<Result<...>>`. evidence: src/frontend/components/ImageInfo.tsx:102-108 (usePromise read, import at :8); old `videoFps` state + effect block removed.

- [x] 1.2 Handle the `Result` branches explicitly (fail-loud, no silent swallow):
  on `ok`, derive the display value with the existing `formatFps` helper; on `err`,
  call `console.warn('[ImageInfo] frame-rate read failed', file.absolutePath, err)`
  and produce no value. Do NOT collapse error and "no value" into the same silent
  blank. Done-when: a rejected read logs a warning and yields no row; a video with
  no `VideoFrameRate` yields no row and no warning. evidence: src/frontend/components/ImageInfo.tsx:111-119 (ok→formatFps; err→console.warn); tests (b) no-warning and (d) warning pass.

- [x] 1.3 Confirm the stale-guard: because `usePromise` ignores resolutions after
  its sources (`file.absolutePath`, `file.extension`) change, switching files
  before a read resolves must not apply the stale value. Done-when: verified by the
  test in 3.1 (rapid switch shows the current file's value, never the prior one).
  evidence: usePromise stale-guard at src/frontend/hooks/usePromise.ts:21-45 (isEffectRunning); test (c) in tests/image-info-frame-rate-dom.test.tsx:149-171 passes (shows 60 fps, never 24).

## 2. Move FPS to its own line below Dimensions

- [x] 2.1 In `src/frontend/components/ImageInfo.tsx`, revert the `dimensions` value
  to `` `${file.width || '?'} x ${file.height || '?'}` `` (remove the appended
  `` ` · ${videoFps} fps` ``). Done-when: the `Dimensions` value is `W x H` with no
  frame-rate text. evidence: src/frontend/components/ImageInfo.tsx:125 (dimensions is `W x H`, no fps); test (a) asserts Dimensions == "1920 x 1080".

- [x] 2.2 Add an optional `frameRate?: string` field to the `CommonMetadata` type
  and a `frameRate: 'Frame Rate'` entry to `commonMetadataLabels`, ordered
  immediately after `dimensions`. Populate `fileStats.frameRate` from the formatted
  value as `` `${formatted} fps` `` (e.g. `29.97 fps`, `30 fps`) when present, else
  `undefined`/empty. The label text MUST be exactly `Frame Rate`. evidence: src/frontend/components/ImageInfo.tsx:16 (type), :24 (label after dimensions), :126 (populate); test (a) shows "29.97 fps" directly below Dimensions.

- [x] 2.3 In the common-metadata render loop (currently emits every row
  unconditionally), skip the `frameRate` row when its value is falsy — matching how
  the `exifFields` rows already skip empty values. Done-when: images and
  frame-rate-less videos render no `Frame Rate` row; the `Dimensions` row is
  unaffected. evidence: src/frontend/components/ImageInfo.tsx:203-216 (skip row when field==='frameRate' && !value); tests (b) image+silent-video assert no Frame Rate row.

## 3. Tests

- [x] 3.1 Add a jsdom rendered-component test for `ImageInfo` (this repo can mount
  real components and drive real interactions in jsdom — see the inspector-panel
  test patterns). Use a hand-controlled/mocked `exifTool.readExifTags` whose
  promise resolves only when the test chooses, to cover:
  (a) a video reporting `29.970030` renders a `Frame Rate` row showing `29.97 fps`
  directly below the `Dimensions` row, and `Dimensions` shows `W x H` only;
  (b) an image / a video with no `VideoFrameRate` renders no `Frame Rate` row;
  (c) STALE-RACE: switch the `file` prop to a second video before the first read's
  promise resolves, then resolve the first — assert the panel shows the second
  file's value (or no row), never the first file's value;
  (d) a rejected read renders no row and does not throw an unhandled rejection.
  Done-when: `yarn test` passes these cases. evidence: tests/image-info-frame-rate-dom.test.tsx (cases a–d); `yarn jest tests/image-info-frame-rate-dom.test.tsx` → 4 passed.

## 4. Build & manual verification

- [x] 4.1 Run `yarn lint` and `yarn test`; both pass. evidence: `yarn test` → 26 suites / 232 tests passed. `npx eslint src/frontend/components/ImageInfo.tsx tests/image-info-frame-rate-dom.test.tsx` → exit 0 (clean). NOTE: full `yarn lint` reports 45 pre-existing errors in untouched files (workers/*, src/ipc/main.ts, widgets/menus/menus.tsx) — none in this change's files (git diff touches only ImageInfo.tsx + the new test).

- [ ] 4.2 **REQUIRES MANUAL EXECUTION (Windows/Electron GUI).** In the running app,
  select several videos in succession and confirm the `Frame Rate` row appears on
  its own line below `Dimensions` each time, with a sensible value; select images
  and confirm no `Frame Rate` row. Then exercise the original repro (rapid
  selection / extended session) and confirm the row no longer gets stuck blank. If
  it DOES still get stuck, capture the new `[ImageInfo] frame-rate read failed`
  warning from the devtools console — a recurring `'exiftool is not open'` there
  confirms the wedged-process cause and triggers the `common/ExifIO.ts` follow-up
  (see 5.1). Done-when: concrete evidence recorded (screenshot and/or console log).
  evidence: `<manual evidence>`

- [ ] 4.3 (verification finding — advisory) Move the `console.warn('[ImageInfo] frame-rate read failed', …)`
  out of the render body (`ImageInfo.tsx:118`) into a `useEffect` keyed on the
  frame-rate poll result (or dedupe), so an errored read logs once rather than on
  every unrelated re-render (edit-mode / show-exiftool toggles). Done-when: toggling
  `isEditing`/`viewAllExifTool` while a video's read is errored does not emit
  repeated warnings. evidence: `<file:line>`

## 5. Follow-up (out of this change's scope — becomes its own change)

- [ ] 5.1 File a follow-up OpenSpec change for the sibling latent sites of the same
  silent-failure / stale-race class identified in design.md's bomb-squad hunt —
  `ImageMap.tsx:139` (wrong-GPS map fly, HIGH), `ImageInfo.tsx:133-140` &
  `129-131`, `ImageDescription.tsx:35-38` (data-corruption on save, HIGH),
  `ImageDates.tsx:68-75`, `ImageParameters.tsx:33-47`, `ImagePrompt.tsx:29-41`,
  `FileStore.ts:691` — routing each inspector read through `usePromise` and
  rendering the `err` branch instead of swallowing it. Also file the
  `common/ExifIO.ts` process-reopen change IF task 4.2 confirms a wedged process.
  Done-when: the follow-up change(s) exist (OBSOLETE if the team folds them here
  instead). evidence: `<change name(s)>`
