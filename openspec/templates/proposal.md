<!-- managed by radflow — re-run adopt.sh to refresh. Skeleton for openspec/changes/<name>/proposal.md.
     Fill every <placeholder>; delete guidance comments. radflow-lint enforces this structure. -->
# <Change title — imperative, one line>

Tier: <1|2|3> — <one-line justification: why this tier, not the one above/below>
Type: <feature|bug>

<!-- Tier 1 only (trivial: copy/style/one-file, no behavior fork) — keep this line and delete it for Tier 2+: -->
External Review: Waived — Tier 1 (<one-line rationale>)

<!-- Bug changes only — delete this whole section for features.
     Name EXACTLY ONE category, diagnosed from code actually read (cite the file/function), never from memory:
     wrong-mental-model | architectural-shortcoming | order-of-operations |
     missing-edge-case | wrong-abstraction | silent-failure -->
## Root Cause

<category>: <diagnosis, citing the code actually read> (<path/to/file.ext:line>)

## Blast Radius

<!-- Number every area affected by the same root cause or touched by the change.
     Every entry needs evidence: a real <path:line> or the grep/search that found it.
     Cited paths are mechanically checked to exist — a made-up path is a violation. -->
1. <path/to/file.ext:line> — <why this site is affected>
2. grepped '<pattern>' across <scope> — <what it found, or 'no further sites'>

<!-- If the blast radius is genuinely empty, keep ONLY the search log:
1. grepped '<pattern>' across <scope>; searched '<other pattern>' — no further sites. -->
