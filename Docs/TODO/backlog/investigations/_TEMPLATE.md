---
id: INV-XXX
title: ''
reported_bug: ''
date: YYYY-MM-DD
status: active # active | tasks-created | superseded
superseded_by: # INV-XXX if this investigation was replaced
tasks_spawned: [] # e.g. [TASK-001, TASK-002]
root_cause_category: '' # wrong-mental-model | architectural-shortcoming | order-of-operations | missing-edge-case | wrong-abstraction | silent-failure
affects: # high-level systems impacted
  - ''
---

<!--
  INVESTIGATION TEMPLATE

  This document captures the full strategic analysis of a bug report.
  It follows the task-writer's investigation workflow and serves as the
  permanent record of WHY a problem exists, what else it touches, and
  how to fix it holistically.

  Tasks spawned from this investigation live in ../tasks/ and link
  back here via their `investigation` frontmatter field.

  Do NOT delete completed investigations — move them to completed/.
  They are institutional knowledge.
-->

## Bug Report

### Observed Behavior

<!-- What actually happened. Be specific about the context: which files,
     formats, settings, or user actions trigger this. -->

### Expected Behavior

<!-- What should have happened instead. Cite sources if applicable
     (Electron docs, EXIF spec, etc). -->

### Reproduction Context

<!-- Deterministic or conditional? Which image formats, folder structures,
     or system states trigger this? -->

---

## Root Cause Analysis

**Category:** <!-- one of: wrong-mental-model | architectural-shortcoming | order-of-operations | missing-edge-case | wrong-abstraction | silent-failure -->

### Diagnosis

<!-- The deep "why" — not just what's broken, but the conceptual or
     architectural error that made this bug possible. Name specific files,
     functions, data structures. Explain the reasoning, not just the conclusion. -->

### Diagnostic Questions Considered

- **Wrong mental model?**
- **Architectural shortcoming?**
- **Incorrect order of operations?**
- **Missing edge case?**
- **Wrong abstraction?**
- **Silent failure?**

---

## Blast Radius

<!-- Every area affected by the same root cause. List them with a brief
     explanation of HOW each is affected. Think across: file formats, MobX stores,
     IPC handlers, thumbnail generation, metadata operations, UI components. -->

1. **[Area]** — [How it's affected by the same root cause]
2. **[Area]** — [How it's affected by the same root cause]

---

## UX / Requirements Specification

<!--
  CONDITIONAL SECTION — include when the user provided design decisions,
  behavioral specifications, or UX requirements.

  Delete this section (including the heading) if the investigation is purely
  internal with no user-facing changes.
-->

### Purpose

### User-Stated Design Decisions

1. **[Decision]** — [Rationale]

### Behavioral Specifications

### Explicit Rejections

---

## Holistic Solution

### Approach

### Expected Outcomes

### Risks and Tradeoffs

---

## Game Documentation Updates

- [ ] No updates needed
- [ ] Updated: <!-- list files -->
