# QA Discipline: Manual-Execution Tasks

Any task or investigation step annotated `REQUIRES MANUAL EXECUTION` (e.g.,
`REQUIRES MANUAL EXECUTION ON WINDOWS`) MUST follow these rules.

## Rules

1. **Only the human QA executor may tick the `[x]` checkbox** for a
   `REQUIRES MANUAL EXECUTION` step. Automated agents may propose that a step
   is ready for testing, but may not record completion on behalf of the human.

2. **A QA task may not be promoted from `backlog/` to `pending_qa/`** until at
   least one of its verification steps has been personally executed and has
   produced concrete evidence — a screenshot, a captured log line, or a recorded
   clip. The evidence must be pasted into the task file or linked from it.

3. **An investigation may not be promoted from `backlog/` to `pending_qa/`**
   until its spawned QA task has been promoted to DONE under rule 2.

4. **If a task is found to have been marked DONE without evidence** (e.g.,
   during a subsequent investigation), it must be reverted to `planned` status
   and re-executed from the first unverified step.

## Rationale

INV-014 documented a case where TASK-042 was marked DONE in the same commit that
shipped the fix it was supposed to verify. Nine `REQUIRES MANUAL EXECUTION ON
WINDOWS` steps were all left unchecked; only the documentation cross-reference
(step 10) had been completed. INV-008 was then promoted to `pending_qa/` on this
false signal. The unverified state allowed three implementation defects (INV-014
Root Causes #1, #2, #3) to escape into user-facing builds and required a full
re-investigation.

The cost of writing these rules down is minutes. The cost of re-shipping an
unverified fix is large (user round-trip, re-investigation, re-QA).
