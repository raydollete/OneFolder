---
id: TASK-062
title: 'Document QA discipline: manual-execution steps may not be marked DONE without evidence'
investigation: INV-014
status: planned
priority: medium
blocked_by: []
date_created: 2026-05-04
date_completed:
files:
  - docs/TODO/backlog/tasks/_TEMPLATE.md
  - docs/TODO/backlog/investigations/_TEMPLATE.md
---

## What

Add a short, prescriptive section to the task and investigation templates (and/or the
top-level `docs/TODO/README.md` if one exists, otherwise create a brief
`docs/TODO/QA-DISCIPLINE.md`) stating:

1. Any task step annotated `REQUIRES MANUAL EXECUTION` (on any platform) may NOT be
   marked `[x]` complete by an automated agent. Only the human QA executor may tick
   such boxes, after they have personally executed the step.
2. A task whose primary purpose is QA verification (typically named `qa-...` and
   tagged with verification steps) may not be promoted from `backlog/` to
   `pending_qa/` until at least one of its verification steps has been executed AND
   has produced concrete evidence (screenshot, log line, or recorded clip) that is
   either pasted into the task file or linked from it.
3. An investigation may not be promoted from `backlog/` to `pending_qa/` until its
   spawned QA task has been promoted to DONE under rule 2 above.

## Why

INV-014 Root Cause #4: TASK-042 was marked DONE in the same commit that shipped the
fix it was supposed to verify. None of its 9 manual Windows verification steps were
executed; only the docs cross-reference (step 10) was completed. INV-008 was then
promoted to `pending_qa/` based on this false signal. The QA gate was effectively
nonexistent, which is what allowed the three implementation defects (Root Causes #1,
#2, #3) to escape into user-facing builds.

Without a documented rule, this failure mode is structurally likely to recur on any
investigation whose remediation requires platform-specific (Windows-only or
macOS-only) QA. The cost of writing this discipline down is minutes; the cost of
re-shipping a broken fix is much larger (cf. the user round-trip + re-investigation
that INV-014 itself represents).

See [INV-014](../investigations/INV-014_HIGH_FRONTEND_video-delete-ebusy-recurs-fix-incomplete.md).

## Implementation Steps

- [ ] 1. Decide the canonical home for the rule. Inspect `docs/TODO/` for an existing
      README or workflow doc:
  - If `docs/TODO/README.md` or `docs/TODO/WORKFLOW.md` exists, add a new section
    "QA Discipline" there.
  - If not, create `docs/TODO/QA-DISCIPLINE.md` with the content below.
  - In addition to the canonical doc, add a short `## Manual-execution discipline`
    paragraph to BOTH `docs/TODO/backlog/tasks/_TEMPLATE.md` and
    `docs/TODO/backlog/investigations/_TEMPLATE.md` so the rule is visible at
    file-creation time.

- [ ] 2. The text to add (adjust wording to match the project's voice; this is a
      starting point):
  ```markdown
  ## QA Discipline (Manual-Execution Tasks)

  Any task or investigation step annotated `REQUIRES MANUAL EXECUTION` (e.g.,
  "REQUIRES MANUAL EXECUTION ON WINDOWS") MUST follow these rules:

  1. Only the human QA executor may tick the `[x]` checkbox for that step. Automated
     agents may PROPOSE the step is ready for testing, but may not record completion.
  2. A QA task (typically named `qa-...`) may not be promoted from `backlog/` to
     `pending_qa/` until at least one verification step has been executed and has
     produced concrete evidence: a screenshot, a captured log line, or a recorded
     clip. The evidence must be pasted into the task file or linked from it.
  3. An investigation may not be promoted from `backlog/` to `pending_qa/` until its
     spawned QA task has been promoted to DONE under rule 2.
  4. If a task is found to have been marked DONE without evidence (e.g., during a
     subsequent investigation), it must be reverted to `planned` and re-executed.

  These rules exist because INV-014 documented a fix that shipped without manual
  Windows QA, allowing three implementation defects to escape into user-facing
  builds. The cost of writing the rule down is small; the cost of re-shipping
  unverified fixes is large.
  ```

- [ ] 3. Cross-reference: at the top of TASK-058, TASK-059, TASK-060, TASK-061 (i.e.,
      the tasks INV-014 spawns), add a brief `> Adheres to QA-DISCIPLINE` note under
      the title or in the description. (Optional but useful — it signals to future
      readers that this batch was specifically planned with the discipline in mind.)

- [ ] 4. (Optional, lower priority — separate task if scoped out) Audit any other
      task in `docs/TODO/pending_qa/tasks/` whose body contains
      `REQUIRES MANUAL EXECUTION` checkboxes that are unticked but whose `status: DONE`
      header is set. Flag each such task as a candidate for re-verification. Out of
      scope here unless the team wants the audit included.

## Done When

- [ ] The QA-discipline rule is documented in a canonical location under `docs/TODO/`.
- [ ] Both `_TEMPLATE.md` files (tasks and investigations) reference the rule so it is
      visible at file-creation time.
- [ ] (If step 3 is done) TASK-058, TASK-059, TASK-060, TASK-061 carry a brief
      forward-reference to the discipline doc.
