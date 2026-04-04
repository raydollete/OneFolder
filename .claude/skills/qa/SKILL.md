---
name: qa
description: Run task-closer on a pending QA investigation or task by ID (e.g. /qa inv-001, /qa task-001)
argument-hint: '<inv-NNN or task-NNN>'
disable-model-invocation: true
---

You are launching the task-closer agent for a pending QA item. The user provided an ID like "inv-001" or "task-001" (case-insensitive). Complete these mandatory steps:

## Step 1 — Resolve the file

Parse the argument to extract the prefix (INV or TASK) and the number. Then find the matching file:

- **INV-\***: Search `docs/TODO/pending_qa/investigations/` for a file starting with `INV-{number}_`
- **TASK-\***: Search `docs/TODO/pending_qa/tasks/` for a file starting with `TASK-{number}_`

Use the Glob tool to find the file. If no match is found, tell the user and stop.

## Step 2 — Launch task-closer

Use the Agent tool with `subagent_type: "task-closer"` and pass a prompt like:

> Review and verify the investigation/task defined in: `{resolved_file_path}`

## Step 3 — Address any Discoveries

For ANY discovered shortcomings or recommendations that the task-closer agent found, use the Agent tool with `subagent_type: "task-writer"` to investigate EACH issue.
