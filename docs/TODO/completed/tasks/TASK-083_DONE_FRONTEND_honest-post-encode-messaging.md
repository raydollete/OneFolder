---
id: TASK-083
title: 'Make the post-encode timeout/edge messaging honest — stop asserting "outside a watched folder" as fact in the toast and in waitForIngestedFile''s rejection; state the observable fact and offer causes as possibilities (docs/TOOLS.md rule 4)'
investigation: INV-019
status: DONE
priority: high
blocked_by: [TASK-082]
date_created: 2026-06-11
date_completed: 2026-06-11
files:
  - 'src/frontend/stores/FileStore.ts'
  - 'src/frontend/components/ImageTools.tsx'
  - 'docs/TOOLS.md'
  - 'docs/reencode-x264.md'
---

## What

Replace the two messages that assert "outside a watched folder" as a verified
cause: (1) the `waitForIngestedFile` rejection text
(`FileStore.ts:1247-1252`), and (2) the fallback toast shown by
`finalizeEncodedOutput` (the wording inherited from `ImageTools.tsx:74-77`).
Both must report the observable fact ("the encoded file was not detected in the
current view within 10 s") and offer possible causes as possibilities, noting
that tagging already succeeded (TASK-082 copies tags before the wait).

## Why

The "outside a watched folder" wording asserted a diagnosis the code had not
verified — and which is usually wrong (the file IS in a watched folder; it was
just filtered out of `fileList`). docs/TOOLS.md rule 4: report the observable
fact, offer the possible cause as a possibility, not a verdict. This wording
previously sent debugging in the wrong direction.

See [INV-019](../investigations/INV-019_HIGH_FRONTEND_post-encode-tag-copy-race-filtered-view.md).

## Implementation Steps

- [x] 1. In `FileStore.ts:1247-1252`, change the `waitForIngestedFile` rejection
      message from "...The file may be outside a watched location." to a
      fact-based wording, e.g.: `waitForIngestedFile: "<path>" was not detected
      in the current view within <timeoutMs> ms. It may not match the active
      filter, or it may be outside a watched location.` Keep it a single Error.
- [x] 2. In the `finalizeEncodedOutput` graceful-fallback path (TASK-082 step 6),
      the user-facing toast (shown only when the file is still not visible after
      clearing the search) must: (a) confirm the encode + tag copy succeeded;
      (b) state the observable fact; (c) offer causes as possibilities. Example:
      `Re-encoded to <path> and copied your tags, but it is not visible in the
      current view. It may be excluded by the active filter, or outside a watched
      folder.` No assertion of a single cause.
- [x] 3. Ensure the message includes the output path and is dismissible
      (`timeout: 8000` consistent with the existing toast).
- [x] 4. Update `docs/TOOLS.md` rule 4 section to cite this as the corrected
      example (the old "outside a watched folder" verdict replaced with a
      fact + possibilities wording), and note that since tags are now copied
      before the wait, the message reflects that tagging succeeded.
- [x] 5. Update `docs/reencode-x264.md` "Ingestion-Await and Tag Copy" /
      "Error Handling Summary" sections to reflect the corrected order
      (DB tag copy first) and the new honest wording for the
      not-visible-in-view case.

## Done When

- [x] Neither `waitForIngestedFile`'s rejection nor the post-encode fallback
      toast asserts "outside a watched folder" as the sole/verified cause.
- [x] Both messages state the observable fact and offer causes as possibilities,
      and the toast confirms tagging succeeded.
- [x] `docs/TOOLS.md` and `docs/reencode-x264.md` reflect the corrected wording
      and order.
