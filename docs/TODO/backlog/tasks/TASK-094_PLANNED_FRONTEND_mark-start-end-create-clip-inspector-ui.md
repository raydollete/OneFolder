---
id: TASK-094
title: 'Add Mark Start / Mark End / Create Clip controls to the inspector Tools section: capture live playback time into editable HH:MM:SS fields, gate Create Clip on validity, and run the create-clip media job + finalize + delete-original flow'
investigation: INV-022
status: planned
priority: medium
blocked_by: [TASK-093]
date_created: 2026-06-12
date_completed:
files:
  - 'src/frontend/components/ImageTools.tsx (add the two button+field rows, Create Clip button, validation gating, capture-from-video, orchestration)'
  - 'resources/style/inspector.scss (row/field/button layout for the new controls)'
  - 'src/frontend/containers/ContentView/SlideMode/index.tsx (reference only — the mounted slide <video> read via document.querySelector)'
---

## What

In the inspector Tools section (`src/frontend/components/ImageTools.tsx`), inside
the existing video-only / no-active-job branch, add:

1. **Mark Start** button + an attached editable `HH:MM:SS` text field.
2. **Mark End** button + an attached editable `HH:MM:SS` text field.
3. **Create Clip** button below the fields, enabled ONLY when both fields hold
   valid `HH:MM:SS` values and start < end.

Clicking Mark Start / Mark End writes the current playback time of the open video
(`document.querySelector('video')?.currentTime ?? 0`, formatted with
`formatSecondsToHms`) into the respective field; `00:00:00` when no video is
mounted/stopped. Fields are manually editable. Create Clip runs the existing
media-job orchestration with the new `create-clip` job type (TASK-093), passing the
two times, then reuses `fileStore.finalizeEncodedOutput` (tag replication +
auto-open) and `uiStore.openDeleteOriginalPrompt` (delete-original prompt).

## Why

This is the user-facing tool. The backend job type, IPC threading, validation, and
time helpers land in TASK-093; this task wires the UI and orchestration on top,
reusing the same finalize + delete-original flow the existing two tools use.

See [INV-022](../investigations/INV-022_MEDIUM_FRONTEND_mark-in-out-create-clip-video-tool.md)
(root cause item 3; blast radius items 5-8; behavioral spec "Happy path").

## Implementation Steps

- [ ] 1. Import `parseHmsToSeconds` / `formatSecondsToHms` from `common/fmt` into
      `ImageTools.tsx`. Add local React state: `const [startTime, setStartTime] =
      useState('')` and `const [endTime, setEndTime] = useState('')`.
- [ ] 2. Add a helper to read the live playback position:
      `const captureCurrentTime = (): string => { const v =
      document.querySelector('video') as HTMLVideoElement | null; const sec =
      v && Number.isFinite(v.currentTime) ? v.currentTime : 0; return
      formatSecondsToHms(sec); };`. (The slide `<video>` is the only attached video
      — preload videos are orphan; see SlideMode/index.tsx:157-177 /
      ZoomPan.tsx:165.)
- [ ] 3. Inside the existing `isVideo` block, in the `activeJob === null` branch
      (alongside the Re-encode and Normalize Audio buttons), render two rows:
      a "Mark Start" `<button onClick={() => setStartTime(captureCurrentTime())}>`
      with an adjacent `<input value={startTime} onChange={e =>
      setStartTime(e.target.value)} placeholder="00:00:00" />`, and an identical
      "Mark End" pair bound to `endTime`. Give the inputs an aria-label and
      `disabled={uiStore.isMediaProcessing}`.
- [ ] 4. Compute validity: `const startSec = parseHmsToSeconds(startTime); const
      endSec = parseHmsToSeconds(endTime); const clipValid = startSec !== null &&
      endSec !== null && startSec < endSec;`. Render the **Create Clip** button with
      `disabled={!clipValid || uiStore.isMediaProcessing}` and an `onClick` that
      runs the orchestration in step 5. Optionally show a subtle hint when both
      fields are filled but `startSec >= endSec` ("End must be after start").
- [ ] 5. Orchestration: factor the existing `runMediaJob` so Create Clip reuses the
      same lock/spinner/finalize/delete-prompt machinery. Either parameterize
      `runMediaJob(jobType, clip?)` to forward the clip params, or add a sibling
      `runCreateClip()` that mirrors it. The flow MUST be:
      1. guard on `uiStore.isMediaProcessing || activeJob !== null`;
      2. subscribe to `onMediaJobProgress` (stash jobId for Cancel) BEFORE invoking;
      3. `setActiveJob('create-clip')`; `uiStore.beginMediaProcessing(file.absolutePath)`;
      4. `const { outputPath } = await RendererMessenger.startMediaJob('create-clip',
         file.absolutePath, { start: startTime, end: endTime });`
      5. `await fileStore.finalizeEncodedOutput(file, outputPath);`
      6. `uiStore.openDeleteOriginalPrompt(file);`
      7. `finally { uiStore.endMediaProcessing(); setActiveJob(null); … }` (mirror
         the existing finally block exactly so the lock never leaks).
      On rejection: `MEDIA_JOB_CANCELLED` -> neutral "Create clip cancelled." toast;
      otherwise an error toast with the message + Dev Tools action (reuse the
      existing AppToaster pattern). Do NOT open the delete prompt on failure/cancel.
- [ ] 6. Extend the spinner/progress label + cancel-title `activeJob` switches to
      cover `'create-clip'` (e.g. "Creating clip… {pct}%" / "Cancel clip").
- [ ] 7. After a successful clip (in the success path, before/after finalize as
      appropriate), reset `startTime`/`endTime` to '' so the fields are clear for
      the next clip. (Optional but tidy; do not reset on failure so the user can
      retry.)
- [ ] 8. `resources/style/inspector.scss`: add layout so each Mark button sits
      inline with its field, and the Create Clip button spans the column like the
      other tool buttons. Reuse the existing `.tools` flex column; do not restyle
      the existing buttons.
- [ ] 9. Run `yarn lint` on `ImageTools.tsx` (no unused imports), and verify in
      `yarn dev`: opening a video shows all five controls; opening an image shows
      only the "No tools available" caption; Create Clip stays disabled until both
      fields are valid with start < end.

## Done When

- [ ] For a video, the Tools section shows Mark Start [field], Mark End [field], and
      Create Clip in addition to Re-encode and Normalize Audio; for an image it
      shows only the neutral caption.
- [ ] Clicking Mark Start / Mark End fills the field with the open video's current
      playback time as `HH:MM:SS` (and `00:00:00` when stopped/unavailable); fields
      are manually editable.
- [ ] Create Clip is disabled while either field is empty/invalid or start ≥ end,
      and enabled otherwise; it is also disabled while a media job runs.
- [ ] Clicking Create Clip shows the in-job spinner, runs the stream-copy trim, and
      on success the new `.mp4` is auto-selected/opened in SlideMode with the
      source's tags replicated, then the delete-original prompt appears.
- [ ] On ffmpeg failure or cancel, an appropriate toast shows, the source is
      untouched, no delete prompt appears, and the UI lock is released (no leak).
- [ ] `yarn lint` and `yarn build` pass; the existing Re-encode / Normalize Audio
      tools are unchanged.
