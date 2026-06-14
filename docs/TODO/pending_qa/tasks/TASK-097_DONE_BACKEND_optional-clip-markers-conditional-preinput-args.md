---
id: TASK-097
title: 'Make clip start/end optional in the IPC payload and build ffmpeg preInputArgs from whichever marker(s) are present (start-only -ss, end-only -to, both)'
investigation: INV-024
status: done
priority: high
blocked_by: []
date_created: 2026-06-13
date_completed: 2026-06-13
files:
  - src/ipc/messages.ts
  - src/ipc/renderer.ts
  - src/main.ts
  - src/ReEncodeManager.ts
---

## What

Relax the create-clip backend so a single time marker suffices. Make `clip.start` and
`clip.end` each optional in the IPC payload, widen `RendererMessenger.startMediaJob`
to forward them, and change `onStartMediaJob` to validate whichever markers are
present, require at least one, enforce `start < end` only when both are present, and
build `preInputArgs` by conditionally including `-ss <start>` and/or `-to <end>`.
`ReEncodeManager` already supports a variable-length `preInputArgs` — verify, no
change.

## Why

The clip pipeline was built (INV-022) requiring BOTH markers: `messages.ts` types
`clip?: { start: string; end: string }`, and `main.ts onStartMediaJob` rejects unless
both are present and always builds `['-ss', start, '-to', end]`. ffmpeg natively
handles a single flag (`-ss` alone trims to EOF; `-to` alone trims from the start),
and `ReEncodeManager.start/_runJob` already splice a variable-length `preInputArgs`
before `-i` (`ReEncodeManager.ts:197-208`). So only the payload optionality, the
validation, and the conditional `preInputArgs` construction need to change.

See [INV-024](../investigations/INV-024_HIGH_FRONTEND_clip-tool-marktime-zero-and-single-marker.md).

## Implementation Steps

- [x] 1. **Make clip markers optional in the IPC type** (`src/ipc/messages.ts:158-163`).
      Change:
      ```ts
      clip?: { start?: string; end?: string };
      ```
      Update the doc comment: "`clip` is present when `jobType === 'create-clip'`;
      at least one of `start`/`end` (HH:MM:SS) must be set. Main validates each
      present value and, when both are present, that start < end."

- [x] 2. **Widen `startMediaJob` forwarding** (`src/ipc/renderer.ts:250-255`). Change
      the `clip` parameter type to `clip?: { start?: string; end?: string }` and keep
      forwarding it verbatim into the `StartMediaJobMessage`. No other change.

- [x] 3. **Rework create-clip validation + preInputArgs in `onStartMediaJob`**
      (`src/main.ts:748-776`). Replace the both-required block with at-least-one
      logic:
      ```ts
      const preInputArgs: string[] = [];
      if (jobType === 'create-clip') {
        if (clip === undefined || (clip.start === undefined && clip.end === undefined)) {
          return Promise.reject(new Error('create-clip job requires at least one of start/end'));
        }
        let startSec: number | null = null;
        let endSec: number | null = null;
        if (clip.start !== undefined) {
          startSec = parseHmsToSeconds(clip.start);
          if (startSec === null) {
            return Promise.reject(
              new Error(`create-clip: invalid start time "${clip.start}" — expected HH:MM:SS`),
            );
          }
        }
        if (clip.end !== undefined) {
          endSec = parseHmsToSeconds(clip.end);
          if (endSec === null) {
            return Promise.reject(
              new Error(`create-clip: invalid end time "${clip.end}" — expected HH:MM:SS`),
            );
          }
        }
        if (startSec !== null && endSec !== null && startSec >= endSec) {
          return Promise.reject(
            new Error(`create-clip: start time (${clip.start}) must be before end time (${clip.end})`),
          );
        }
        if (clip.start !== undefined) {
          preInputArgs.push('-ss', clip.start);
        }
        if (clip.end !== undefined) {
          preInputArgs.push('-to', clip.end);
        }
      }
      ```
      The rest of the handler (the `reEncodeManager.start(... , preInputArgs)` call
      at `:779-802`) is unchanged. Note: `let` changed to `const` per eslint prefer-const
      (array is mutated via `.push`, not reassigned).

- [x] 4. **Verify `ReEncodeManager` needs no change** (`src/ReEncodeManager.ts:116-208`).
      Confirmed: `start()` accepts `preInputArgs: string[] = []` (line 121) and `_runJob`
      splices it before `-i` via `...preInputArgs` (lines 197-208). A 2-element
      (`['-ss', s]` or `['-to', e]`) or 4-element array both work. No edit made.

- [x] 5. **Build + typecheck.** `npx tsc --noEmit` — all errors are pre-existing
      node_modules dom+webworker lib conflicts; none in project files. `npx eslint` on
      changed files — clean. `npx jest re-encode-manager` — 11/11 pass. Full
      `npx jest` — 117/117 pass across 15 suites.

## Done When

- [x] `StartMediaJobMessage.clip` is `{ start?: string; end?: string } | undefined`
      and `RendererMessenger.startMediaJob` forwards optional start/end.
- [x] `onStartMediaJob` for `create-clip`: rejects when neither marker is present or a
      present marker is malformed; enforces `start < end` only when both present;
      builds `preInputArgs` = `['-ss', start]`, `['-to', end]`, or
      `['-ss', start, '-to', end]` to match the markers supplied.
- [x] `ReEncodeManager` is confirmed unchanged and produces the correct argv for the
      2-element and 4-element `preInputArgs` cases.
- [x] `yarn build`, `yarn lint`, and `yarn test` pass; the other two job types
      (no `clip`) are unaffected.
