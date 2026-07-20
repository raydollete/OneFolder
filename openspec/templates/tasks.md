<!-- managed by radflow — re-run adopt.sh to refresh. Skeleton for openspec/changes/<name>/tasks.md.
     Do NOT create this file until design.md's External Review records an achieved
     peer-review verdict (or the proposal records a Tier 1 waiver) — radflow-lint
     enforces the order.

     Checkboxes are the contract:
     - Each task is self-contained: restate binding CLAUDE.md constraints inline,
       reproduce UX strings verbatim, state a measurable done-when — never
       'basic fix' or 'initial support' (radflow-lint warns on those phrases on
       a task's own lines; this comment is inert by construction).
     - Tick a box ONLY after its verification actually ran, and append an
       evidence line on or directly under it:
         evidence: <path/to/file.ext:line>          (code changes — path must exist)
         evidence: <exact command run> — <result>   (verification steps)
       'evidence: TODO' or an empty payload is a tick without evidence (violation).
     - UI-touching tasks verify in a real browser via the playwright-cli skill.
     - Terminal states: DONE | FAIL | BLOCKED | OBSOLETE. A state is a POSITION:
       a bare UPPERCASE token on the task's own checkbox line, a dash/parenthesis
       marker on it ('— Deferred to next sprint', '(Deferred)'), or a
       'status:'/'state:' value under it. 'Deferred' is not a state — deferred
       work becomes an unchecked follow-up task. The word in ordinary prose (a
       task description, an evidence:/correction:/reframed: payload) is fine: the
       rule bans the state, not the vocabulary.
     - During apply, record each user course-correction on or directly under
       the affected task (same placement as evidence:):
         correction: <one-line summary of what the user corrected>
       An empty/placeholder payload is a violation. When the user corrects the
       same shortcoming a SECOND time: stop implementing and run /opsx-reframe
       before ticking further boxes (>=2 corrections on one live task warn
       until resolved).
     - A reframe resolves by marking superseded tasks OBSOLETE (replaced by
       reframed tasks) or appending to the surviving task, with rewritten
       done-when criteria:
         reframed: <design.md Reframe pointer — one-line summary>
       (empty payload is a violation; design.md records a '## Reframe'
       section: wrong assumption, corrected model, approach delta). -->
# Tasks

- [ ] <task 1 — self-contained, with inline constraints and verbatim strings>.
      Verify: <exact command or browser step>. Done-when: <measurable criterion>.
- [ ] <task 2 ...>

<!-- A completed task looks like:
- [x] <task>. Verify: pnpm test <suite>. DONE
  evidence: src/module/file.ts:42
  evidence: pnpm test auth — 14 passed
-->
