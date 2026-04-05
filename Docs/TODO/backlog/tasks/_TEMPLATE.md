---
id: TASK-XXX
title: ''
investigation: INV-XXX # source investigation that spawned this task
status: planned # planned | in-progress | blocked | done
priority: medium # critical | high | medium | low
blocked_by: [] # e.g. [TASK-001] if this depends on another task
date_created: YYYY-MM-DD
date_completed:
files: # primary files/modules this task touches
  - ''
---

<!--
  TASK TEMPLATE

  A single, self-contained unit of work spawned from an investigation.
  A developer should be able to implement this task by reading ONLY
  this file — no additional context should be needed.

  However, the `investigation` field links back to the full strategic
  analysis for anyone who wants the deeper "why".

  When complete: set status to `done`, fill date_completed, and move
  to pending_qa/.
-->

## What

<!-- 1-3 sentences: what this task accomplishes. Be specific about
     the change, not vague ("Fix block timing" -> "Refactor
     thumbnail cache invalidation to check file modification timestamp
     before serving cached version") -->

## Why

<!-- Brief context connecting this task to the root cause. Reference
     the investigation for full details. -->

See [INV-XXX](../investigations/INV-XXX_description.md).

## Implementation Steps

<!-- Ordered, checkable steps. Each step should:
     - Be a single completable unit of work
     - Name the specific file(s) or module(s) touched
     - State what the step accomplishes
     - Include how to verify it worked

     Order: dependencies first, then dependents, refactoring before
     feature work, tests last. -->

- [ ] 1.
- [ ] 2.
- [ ] 3.

## Done When

<!-- Clear, measurable completion criteria. No ambiguity about whether
     this task is finished. -->

- [ ]
