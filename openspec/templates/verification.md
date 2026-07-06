<!-- managed by radflow — re-run adopt.sh to refresh. Skeleton for openspec/changes/<name>/verification.md.
     Written by /opsx-verify (the opsx-verify-auditor subagent for Tier 2+, or the
     inline Tier 1 fast path). Verdict must be PASS | PASS-WITH-FINDINGS | FAIL.
     `openspec archive` is blocked while this file is absent or the Verdict is FAIL. -->
# Verification — <change-name>

Date: <date>
Tier: <from proposal>

## Verdict: <PASS | PASS-WITH-FINDINGS | FAIL>

## Dimensions
- Implemented: <verdict + evidence>
- Reachable: <verdict + evidence>
- Tested: <verdict + what ran, results>
- Optimal: <advisory notes>

## Evidence audited
<!-- One line per verified checked box: open the cited file, quote >=1 line from it.
     If >20 boxes: all production-code boxes plus every 2nd remaining box, and list
     the skipped boxes explicitly. -->
- [<box text>] — <path/to/file.ext:line> — "<line quoted from the file>"

## Findings
1. <numbered, each with file:line evidence and severity — or "none">

## Live UI pass
<what was exercised + artifact paths, or "n/a — no UI surface">
