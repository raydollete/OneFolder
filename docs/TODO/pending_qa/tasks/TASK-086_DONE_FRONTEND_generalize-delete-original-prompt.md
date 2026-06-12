---
id: TASK-086
title: 'Generalize the ReEncodeDeleteOriginal prompt to a tool-agnostic "delete original after producing a derived output" modal so both Re-encode and Normalize Audio share one prompt'
investigation: INV-020
status: DONE
priority: medium
blocked_by: [TASK-082]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'src/frontend/components/RemovalAlert.tsx'
  - 'src/frontend/stores/UiStore.ts'
  - 'src/frontend/components/ImageTools.tsx'
  - 'src/frontend/containers/ContentView/index.tsx'
---

## What

Rename the reencode-specific delete-original prompt to a tool-agnostic
equivalent so both Re-encode (x264) and Normalize Audio reuse it: the
`ReEncodeDeleteOriginal` component (RemovalAlert.tsx:266-366), the
`uiStore.reEncodeDeleteOriginalFile` observable + `openReEncodeDeleteOriginal` /
`closeReEncodeDeleteOriginal` actions (UiStore.ts:230, 619-624), and the body
text. The trash-flow logic is unchanged.

## Why

The prompt is logically "delete the source after producing a derived output,"
identical for both tools — only the name and one line of body text are
reencode-specific. Generalizing it avoids a duplicate modal for Normalize Audio.

See [INV-020](../investigations/INV-020_MEDIUM_FRONTEND_normalize-audio-video-tool.md).

## Implementation Steps

- [x] 1. In `src/frontend/stores/UiStore.ts`: rename
      `@observable reEncodeDeleteOriginalFile` (:230) ->
      `deleteOriginalAfterJobFile`; `openReEncodeDeleteOriginal` (:619) ->
      `openDeleteOriginalPrompt`; `closeReEncodeDeleteOriginal` (:622-624) ->
      `closeDeleteOriginalPrompt`. Keep the same `ClientFile | null` shape and
      semantics.
- [x] 2. In `src/frontend/components/RemovalAlert.tsx`: rename the
      `ReEncodeDeleteOriginal` component (:266) ->
      `DeleteOriginalAfterJob`. Update its `uiStore` references to the renamed
      actions/observable. Soften the body text (:338-344) from "The re-encoded
      copy was saved..." to tool-agnostic wording, e.g. "A new copy was saved.
      Delete the original \"<name>\"? It will be moved to the Recycle Bin."
      (keep the permanent-delete variant). Title can stay "Delete original?".
      Keep the entire handle-release -> checkRecyclable ->
      trashFile/deleteFilePermanently -> deleteFiles flow unchanged.
- [x] 3. Update the mount site: find where `ReEncodeDeleteOriginal` is rendered
      (per docs/reencode-x264.md it is mounted in `ContentView/index.tsx`
      alongside `MoveFilesToTrashBin`) and rename the JSX usage + import.
- [x] 4. Update `ImageTools.tsx handleReencode` (:89): replace
      `uiStore.openReEncodeDeleteOriginal(file)` with
      `uiStore.openDeleteOriginalPrompt(file)`. (TASK-087 will add the same call
      for Normalize Audio.)
- [x] 5. Grep the codebase for any remaining `reEncodeDeleteOriginal` /
      `ReEncodeDeleteOriginal` references and update them. `yarn build` to
      confirm no dangling references. (Build deferred — multi-task run; src grep
      returned zero matches.)

## Done When

- [x] The delete-original prompt and its UiStore flag/actions are tool-agnostic
      (`DeleteOriginalAfterJob`, `deleteOriginalAfterJobFile`,
      `openDeleteOriginalPrompt`/`closeDeleteOriginalPrompt`).
- [x] Body text no longer says "re-encoded"; the trash-flow behavior is
      unchanged.
- [x] Re-encode still opens the prompt correctly after the rename; `yarn build`
      deferred (multi-task run); src grep confirmed zero dangling references.
