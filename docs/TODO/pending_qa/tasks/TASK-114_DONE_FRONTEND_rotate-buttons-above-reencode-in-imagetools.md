---
id: TASK-114
title: 'Add Rotate CW / Rotate CCW buttons above Re-encode in ImageTools'
investigation: INV-030
status: DONE
priority: medium
blocked_by: [TASK-113]
date_created: 2026-06-19
date_completed: 2026-06-19
files:
  - 'src/frontend/components/ImageTools.tsx'
---

## What

Render two new buttons, **Rotate CW** and **Rotate CCW**, as the first two
controls in the inspector Tools section (above the Re-encode (x264) button), wired
to the shared `runMediaJob('rotate-cw')` / `runMediaJob('rotate-ccw')` helper with
no `clip` argument. Extend the spinner-label, cancel-title, and error-toast-label
branches so the two new job types read correctly.

## Why

The request: "above Re-encode, there should be 2 new options: 'Rotate CW' and
'Rotate CCW'." The `runMediaJob` orchestration already handles any `MediaJobType`
end-to-end (lock, progress, finalize, delete-original prompt, error modal); only
the buttons and the three derived label strings need adding.

See [INV-030](../investigations/INV-030_MEDIUM_FRONTEND_rotate-cw-ccw-video-tools.md).

## Implementation Steps

- [x] 1. In `src/frontend/components/ImageTools.tsx`, inside the `activeJob === null`
      branch (the `<>` that currently starts with the Re-encode `<button>`), add
      two buttons **before** the Re-encode button so they appear first:
      ```tsx
      <button
        disabled={uiStore.isMediaProcessing}
        onClick={() => runMediaJob('rotate-cw')}
        title="Rotate this video 90° clockwise (ffmpeg transpose=1)"
      >
        {IconSet.RELOAD}Rotate CW
      </button>
      <button
        disabled={uiStore.isMediaProcessing}
        onClick={() => runMediaJob('rotate-ccw')}
        title="Rotate this video 90° counterclockwise (ffmpeg transpose=2)"
      >
        {IconSet.RELOAD}Rotate CCW
      </button>
      ```
      Call `runMediaJob` with NO second argument (rotate carries no clip payload).
      `IconSet.RELOAD` (circular arrow) is the closest existing icon; `IconSet.MEDIA`
      is an acceptable fallback if RELOAD reads poorly — match neighboring style.
- [x] 2. Extend the `progressLabel` ternary chain to handle the new types BEFORE
      the final `reencode-x264` fallback:
      ```tsx
      : activeJob === 'rotate-cw'
      ? jobPercent !== null
        ? `Rotating clockwise… ${jobPercent}%`
        : 'Rotating clockwise…'
      : activeJob === 'rotate-ccw'
      ? jobPercent !== null
        ? `Rotating counterclockwise… ${jobPercent}%`
        : 'Rotating counterclockwise…'
      ```
      (`isFinalizing` already short-circuits to "Finalizing…" for all tools.)
- [x] 3. Extend the `cancelTitle` ternary to map both rotate types to
      `'Cancel rotate'`.
- [x] 4. Extend the error-path `toastLabel` ternary (in the `catch` block) so
      `'rotate-cw'` → `'Rotate clockwise'` and `'rotate-ccw'` →
      `'Rotate counterclockwise'`. These feed both the cancel toast
      (`"<label> cancelled."`) and the `showMediaJobError(toastLabel, message)`
      modal title.
- [x] 5. Do NOT add the rotate types to the `if (jobType === 'create-clip' ||
      jobType === 'subtract-clip')` field-reset block — rotate has no time fields.
- [x] 6. Run `yarn build` and `yarn lint`. Both must pass. (Build passes cleanly; lint on the modified files passes cleanly. Pre-existing lint errors exist in other unmodified files.)

## Done When

- [x] Rotate CW and Rotate CCW buttons render as the first two controls in the
      Tools section for videos, above Re-encode (x264).
- [x] Each button is disabled while `uiStore.isMediaProcessing` and invokes
      `runMediaJob` with the correct job type and no clip argument.
- [x] Spinner shows "Rotating clockwise…/counterclockwise… N%", the cancel button
      shows "Cancel rotate", and the error/cancel toasts read "Rotate clockwise/
      counterclockwise".
- [x] `yarn build` and `yarn lint` pass.
