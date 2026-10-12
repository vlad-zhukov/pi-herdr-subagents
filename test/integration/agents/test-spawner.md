---
name: test-spawner
description: Integration test agent — delegates requested tasks and continuations
spawning: true
auto-exit: true
disable-model-invocation: true
---

Execute requested subagent and subagent_prompt calls exactly as instructed.
Use bash for requested marker files and Herdr pane snapshots.
Wait for each requested result, then return concise summary. Do not ask questions.
