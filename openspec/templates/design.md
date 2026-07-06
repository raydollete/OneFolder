<!-- managed by radflow — re-run adopt.sh to refresh. Skeleton for openspec/changes/<name>/design.md.
     Fill every <placeholder>; delete guidance comments. radflow-lint enforces the External Review structure. -->
# Design — <change name>

## Approach

<file-level plan: what changes where, and why this shape>

<!-- UI-touching changes only — delete otherwise: -->
## UX / Requirements

- <verbatim display strings: labels, options, errors, empty states>

### Explicit Rejections

- <alternative considered> — rejected because <reason>

<!-- Tier 2+ only. Before tasks.md exists:
     1. Write a <=600-word BLIND brief: problem, root cause + category, blast
        radius, and three questions — how would you approach this? what blast
        radius would you expect? what risks would you guard? The brief MUST
        NOT contain the drafted approach — peers answer blind.
     2. Call the config's review tool (review: block — default
        mcp__peer-review__peer_review) once, with the brief as `prompt`, the
        drafted file-level approach as `callerAnswer` (peers never see it —
        the arbiter rates it against their independent consensus), and `tier`
        set to the config's tierN_escalation for this change's tier
        (omit `tier` when the key is unset — full escalation).
     3. Transcribe the result below EXACTLY in this grammar — radflow-lint
        parses the Quorum/Certainty/Caller Agreement/Arbiter/Sources lines
        (column-0, keyed). Caller Agreement is the returned callerAgreement;
        record `n/a` when the tool returned no rating (older server or a tool
        without callerAnswer support) — never a fabricated number.
        'Quorum: not achieved' is an honest record, not a pass: revise the
        design per the response and re-run until achieved. A failed arbiter or
        a certainty below the config's min_certainty is a degraded result —
        prefer re-running over transcribing it. A Caller Agreement below the
        config's min_caller_agreement means independent peers diverge from
        the draft — reconcile the divergence in Review Feedback or revise
        the design.
     4. Record the consensus feedback verbatim under '### Review Feedback',
        each point marked ACCEPTED (with the follow-up) or REJECTED (with why).
        An empty or single-line Review Feedback section does not pass review.
     If the peer-review MCP server is genuinely unavailable, record instead
     (verbatim): External Review: Unavailable — peer-review (mcp__peer-review__peer_review) missing -->
## External Review

### Peer Review Verdict

Quorum: achieved (weight <agreeingWeight>/<requiredWeight>, escalated to tier <quorum.tier>)
Certainty: <certaintyScore>
Caller Agreement: <callerAgreement|n/a>
Arbiter: ok
Sources:
- <name> (<model>) — <status>, agreement <agreement>
- <name> (<model>) — <status>, agreement <agreement>

### Review Feedback

Consensus feedback recorded verbatim:
- <point 1> — ACCEPTED: <what was added/changed in response>
- <point 2> — REJECTED: <why>

<!-- Tier 3, and Tier 2 bugs with a systemic root cause (wrong-mental-model,
     architectural-shortcoming, silent-failure): dispatch bomb-squad IN THE SAME
     MESSAGE as the peer-review call (parallel tool calls) and record its
     findings. Delete this section otherwise. -->
## Bomb-squad findings

- <finding with file:line, or 'hunt completed — no latent defects of this class found'>
