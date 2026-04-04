---
name: run
description: Run task-runner on a backlog investigation or task by ID (e.g. /run inv-001, /run task-001)
argument-hint: '<inv-NNN or task-NNN>'
disable-model-invocation: true
---

You are launching the task-runner agent for a backlog item. The user provided an ID like "inv-001" or "task-001" (case-insensitive).

## Step 1 — Resolve the file

Parse the argument to extract the prefix (INV or TASK) and the number. Then find the matching file:

- **INV-\***: Search `docs/TODO/backlog/investigations/` for a file starting with `INV-{number}_`
- **TASK-\***: Search `docs/TODO/backlog/tasks/` for a file starting with `TASK-{number}_`

Use the Glob tool to find the file. If no match is found, tell the user and stop.

## Step 2 — Launch task-runner

Use the Agent tool with `subagent_type: "task-runner"` and pass a prompt like:

> Implement the investigation/task defined in: `{resolved_file_path}`
>
> **SCOPE CONSTRAINT:** Only implement the tasks belonging to this specific investigation/task. When all tasks from this investigation are complete (or this single task is complete), stop. Do NOT continue to other investigations or unrelated tasks.
