# QA Discipline: Manual-Execution Tasks

Any task or investigation step annotated `REQUIRES MANUAL EXECUTION` (e.g.,
`REQUIRES MANUAL EXECUTION ON WINDOWS`) MUST follow these rules.

## State model

`pending_qa/` means **"implementation complete, awaiting QA execution."** A QA
task or investigation lands here as soon as all non-QA (implementation and
documentation) work is done and the only remaining work is manual verification.
The evidence gate is on the **next** boundary: promotion from `pending_qa/` to
`completed/` is what requires executed verification.

Downstream work must depend on `completed/`, never on `pending_qa/` — a
`pending_qa` item is implemented but **not yet verified**.

## Rules

1. **Only the human QA executor may tick the `[x]` checkbox** for a
   `REQUIRES MANUAL EXECUTION` step. Automated agents may propose that a step
   is ready for testing, but may not record completion on behalf of the human.

2. **Promote to `pending_qa/` when only QA remains.** Once every
   implementation/documentation task in an investigation is DONE and the only
   open task is its `REQUIRES MANUAL EXECUTION` QA task, promote BOTH the QA task
   and the investigation from `backlog/` to `pending_qa/` (status `pending_qa`).
   No evidence is required for this move — `pending_qa` precisely denotes
   "waiting for QA to run," not "QA passed."

3. **Promotion from `pending_qa/` to `completed/` is evidence-gated.** A QA task
   may not be marked DONE / moved to `completed/` until at least one of its
   verification steps has been personally executed and has produced concrete
   evidence — a screenshot, a captured log line, or a recorded clip — pasted into
   or linked from the task file. An investigation may not be promoted to
   `completed/` until its spawned QA task is DONE under this rule.

4. **If a task is found to have been marked DONE without evidence** (e.g.,
   during a subsequent investigation), it must be reverted to `planned` status
   and re-executed from the first unverified step.

## Rationale

`pending_qa` is read literally as "pending QA": work that is implemented but not
yet verified. The promotion that must never happen on a false signal is
`pending_qa → completed` (declaring a fix verified when it was not).

INV-014 documented that failure mode: TASK-042 was marked DONE in the same commit
that shipped the fix it was supposed to verify — nine `REQUIRES MANUAL EXECUTION
ON WINDOWS` steps left unchecked, only the documentation cross-reference (step
10) completed — and three implementation defects escaped into user-facing builds,
forcing a full re-investigation. The lesson is preserved here by rules 1, 3, and
4, which keep the evidence gate on **completion**. Rule 2 simply lets the queue
reflect reality (work whose only remaining step is QA sits in `pending_qa`)
without weakening that gate — provided nothing downstream treats `pending_qa` as
"verified."

The cost of writing these rules down is minutes. The cost of re-shipping an
unverified fix is large (user round-trip, re-investigation, re-QA).
