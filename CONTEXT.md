# Herdr Subagents

Async child-agent orchestration for Pi sessions running in Herdr.

## Language

**Orchestrator**:
Parent Pi agent that delegates bounded work and decides next work from delivered child results.
_Avoid_: parent agent, main agent

**Orchestrator halt**:
Failure safety state. Current Orchestrator agent loop aborts; parent Pi TUI/session
remains for human review. Other running Subagents and their watchers continue;
their Reportable events persist and display without triggering an Orchestrator
turn. Any later human prompt clears halt and starts its normal Pi turn.

**Subagent**:
Child agent launched by orchestrator in a dedicated Herdr pane.
_Avoid_: worker, child

**Subagent handle**:
Immutable generated Subagent ID. Handle records persist in parent session and
resolve to session file, lifecycle state, and Auto-exit policy. Display name is
presentation only; control operations take ID.

**Agent settlement**:
Pi `agent_settled`: current agent run has fully ended, including automatic retries,
compaction retries, and queued continuations. Pi is idle and awaits another prompt.
_Avoid_: end

**Assignment finalization**:
Subagent has completed assigned work and submitted a candidate result to its
Orchestrator. It does not imply Orchestrator acceptance. Noninteractive Subagents
finalize automatically on Agent settlement; Interactive Subagents require their
Operator to run `/subagent_finalize`. Operator may finalize while Subagent is
awaiting an answer; resulting candidate records that state.
_Avoid_: end, session finalization

**Orchestrator acceptance**:
Orchestrator accepts finalized assignment. Accepted Subagent is permanently
detached from Orchestrator and emits no further messages or results to it.

**Automatic abandonment**:
System terminal handling for provider failure after retries, unexpected Pi exit,
Herdr-pane disappearance, or explicit pane closure. It shuts down Pi and closes
pane regardless of Auto-exit, reports failure once, and requires no Orchestrator
cleanup action. Operator Escape is not abandonment.

**Operator**:
Human controlling an Interactive Subagent in its Herdr pane.

**Interactive Subagent**:
Subagent whose Agent settlement does not automatically finalize its assignment.
Its Operator gates Assignment finalization and may steer it locally without
Orchestrator involvement. Defaults to false independently of Auto-exit.
_Avoid_: autonomous subagent

**Auto-exit**:
Policy that, on Assignment finalization, shuts down Pi and closes its Herdr pane.
When false, Pi and pane remain open for Operator review and steering. Defaults to
false independently of Interactive Subagent mode.

**Subagent ask**:
Nonterminal structured question from any Subagent to Orchestrator. It leaves Pi
and Herdr pane live; Orchestrator may answer or reroute question to Operator.

**Input lock**:
One-input-at-a-time rule for a Subagent. First accepted prompt owns its next
turn; concurrent prompt fails and caller retries.

**Reportable event**:
One-time handoff from Subagent to Orchestrator: a result, Subagent ask, Assignment
finalization, or failure.

**Fan-in**:
Orchestrator resumes only after every Subagent launched in one tool batch reaches
one Reportable event. Config calls this mode `wait-all`.
_Avoid_: join

**Wait-all mode**:
Global orchestration mode where each `subagent` call returns its next Reportable
event rather than an immediate acknowledgement.
_Avoid_: synchronous mode, blocking mode

**Completion delivery**:
Single handoff of a finalized Subagent result into orchestrator session.
_Avoid_: completion notification, result ping
