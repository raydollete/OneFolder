---
name: inv
description: Launch task-writer to investigate a bug or issue (e.g. /inv thumbnails not generating for HEIC files)
argument-hint: '<description of the bug or issue>'
disable-model-invocation: true
---

You are launching the task-writer agent to investigate an issue. The user provided a topic description.

## Step 1 — Launch task-writer

Use the Agent tool with `subagent_type: "task-writer"` and pass the user's topic as the prompt:

> Investigate: {user's topic description}
