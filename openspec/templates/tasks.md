<!-- managed by radflow — re-run adopt.sh to refresh. Skeleton for openspec/changes/<name>/tasks.md.
     Do NOT create this file until design.md's External Review records an achieved
     peer-review verdict (or the proposal records a Tier 1 waiver) — radflow-lint
     enforces the order.

     Checkboxes are the contract:
     - Each task is self-contained: restate binding CLAUDE.md constraints inline,
       reproduce UX strings verbatim, state a measurable done-when.
     - Tick a box ONLY after its verification actually ran, and append an
       evidence line on or directly under it:
         evidence: <path/to/file.ext:line>          (code changes — path must exist)
         evidence: <exact command run> — <result>   (verification steps)
       'evidence: TODO' or an empty payload is a tick without evidence (violation).
     - UI-touching tasks verify in a real browser via the playwright-cli skill.
     - Terminal states: DONE | FAIL | BLOCKED | OBSOLETE. 'Deferred' is not a
       state — deferred work becomes an unchecked follow-up task. -->
# Tasks

- [ ] <task 1 — self-contained, with inline constraints and verbatim strings>.
      Verify: <exact command or browser step>. Done-when: <measurable criterion>.
- [ ] <task 2 ...>

<!-- A completed task looks like:
- [x] <task>. Verify: pnpm test <suite>. DONE
  evidence: src/module/file.ts:42
  evidence: pnpm test auth — 14 passed
-->
