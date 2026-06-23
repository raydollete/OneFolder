---
id: TASK-146
title: "Fix 'An object could not be cloned' on Create/Subtract Clip: convert the MobX clip proxy with toJS() at the startMediaJob IPC boundary in runItem"
investigation: INV-036
status: planned
priority: high
blocked_by: []
date_created: 2026-06-23
date_completed:
files:
  - 'src/frontend/stores/MediaQueueStore.ts'
---

## What

Convert the observable `item.clip` to a plain object with `toJS()` exactly where it
crosses the `ipcRenderer.invoke` (structured-clone) boundary in
`MediaQueueStore.runItem` — i.e. at the `RendererMessenger.startMediaJob(...)` call. This
fixes the `An object could not be cloned` error thrown when enqueuing Create Clip or
Subtract Clip jobs. `retry` re-enqueues and routes through `runItem`, so it is covered by
the same single change; no enqueue-side copy is needed.

## Why

`startMediaJob` serializes its arguments via the structured clone algorithm, which cannot
clone a MobX observable proxy. `QueueItem.clip` is `@observable` and holds the proxy
handed in by `ImageTools`, so clip-bearing jobs throw at the boundary while no-clip jobs
(passing `undefined`) succeed. The authoritative fix is a single boundary conversion.
This is **Change 2** and the first change to implement (order 2 → 1 → 3 → 4).

See [INV-036](../investigations/INV-036_HIGH_FRONTEND_media-queue-drawer-qa-fixes-clip-clone-always-visible-resolved-rows-fullwidth.md).

## Implementation Steps

- [ ] 1. In `src/frontend/stores/MediaQueueStore.ts`, add `toJS` to the existing MobX
      import: `import { action, computed, makeObservable, observable, runInAction, toJS } from 'mobx';`.
- [ ] 2. In `runItem`, change the `startMediaJob` call so the third argument is
      `toJS(item.clip)` instead of `item.clip`:
      ```ts
      const { jobId, tempPath, finalPath } = await RendererMessenger.startMediaJob(
        item.jobType,
        item.source.absolutePath,
        toJS(item.clip),
      );
      ```
      `toJS(undefined)` returns `undefined`, so no-clip jobs are unaffected. Leave `retry`
      and `enqueue` untouched (retry is covered because it routes through `runItem`).

## Done When

- [ ] `runItem` passes `toJS(item.clip)` (a plain object or `undefined`) to
      `startMediaJob`; no MobX proxy reaches the IPC boundary.
- [ ] Manual/automated check: enqueuing a Create Clip and a Subtract Clip job no longer
      throws `An object could not be cloned`; the job runs (verified via TASK-150's test
      that asserts `startMediaJob` received a plain-object clip).
- [ ] `yarn lint` / `yarn build` compile (batch test at end of investigation per project
      convention).
