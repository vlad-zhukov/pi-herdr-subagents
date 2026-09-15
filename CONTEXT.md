# Herdr Subagents

Async child-agent orchestration for Pi sessions running in Herdr.

## Language

**Orchestrator**:
Parent Pi agent that delegates bounded work and decides next work from delivered child results.
_Avoid_: parent agent, main agent

**Subagent**:
Child agent launched by orchestrator in a dedicated Herdr pane.
_Avoid_: worker, child

**Interactive Subagent**:
Subagent driven by user input in its own pane and terminated only by explicit completion or session exit.
_Avoid_: autonomous subagent

**Fan-in**:
Orchestrator resumes only after every subagent launched in one tool batch reaches terminal completion. Config calls this mode `wait-all`.
_Avoid_: join

**Wait-all mode**:
Global orchestration mode where each `subagent` or `subagent_resume` tool call returns terminal result rather than an immediate acknowledgement.
_Avoid_: synchronous mode, blocking mode

**Completion delivery**:
Single handoff of a completed subagent result into orchestrator session.
_Avoid_: completion notification, result ping
