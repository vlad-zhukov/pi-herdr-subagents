# pi-herdr-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) running exclusively in [herdr](https://herdr.dev). Spawn, orchestrate, and manage sub-agent sessions in dedicated herdr tabs or panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all tracked agents with their projected state — for example `starting`, `active`, `waiting`, `interrupted`, `stalled`, `running`, or `finalizing`. The header summarizes **active** (processing) vs **open** (not processing). When every tracked subagent is open, the border switches to amber. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────── 1 active · 1 open ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Development

Run unit tests and lint locally:

```bash
npm test
npm run lint
```

Run the real end-to-end suite from inside herdr with an explicit test model:

```bash
PI_TEST_MODEL="deepseek/deepseek-v4-flash" PI_TEST_TIMEOUT=180000 npm run test:integration
```

The full suite launches real Pi sessions and can take several minutes. `PI_TEST_TIMEOUT` is the per-test timeout in milliseconds; use at least `180000` for the lifecycle suite.

`PI_TEST_MODEL` is applied to both parent Pi sessions and test subagents created by the harness.

## Install

Install the package from npm:

```bash
pi install npm:pi-herdr-subagents
```

This project does not install or load `HazAT/pi-interactive-subagents` automatically.

Changing the `package.json` version on `main` automatically creates a matching Git tag and GitHub Release, generates release notes, and publishes the package to npm. For authentication, versioning, verification, and troubleshooting, see [RELEASING.md](RELEASING.md).

Start herdr, then run pi inside it:

```bash
herdr
pi
```

herdr is the only supported terminal environment. The extension requires `HERDR_ENV=1` and the `herdr` CLI to be available.

If your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

Subagent tabs and panes are created without stealing keyboard focus. Launch commands target child panes by explicit ID, so focus and command delivery are independent. The `interactive` setting keeps a child session open after it finishes and controls parent status notifications, not terminal focus.

## What's Included

### Extensions

**Subagents** — 4 main-session tools + 3 commands, plus child-only finalization and help controls:

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated herdr pane (`async` returns immediately; `wait-all` returns terminal result) |
| `subagent_interrupt` | Interrupt a running Pi-backed subagent's current turn                                       |
| `subagents_list`     | List available agent definitions                                                            |
| `subagent_prompt`    | Continue prior Pi subagent session by immutable handle                                      |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

Child sessions additionally expose `/subagent_finalize`, which sends an interactive subagent result after Pi is idle.

### Named Agents

Named agents load only from `~/.pi/agent/agents/` (or `$PI_CODING_AGENT_DIR/agents/`). Agent names, descriptions, and runtime defaults are included in subagent tool guidance.

### Supported Harness CLIs

Agents default to running with `pi`, but can run inside any supported harness CLI or custom CLI configured via agent frontmatter:

| Harness CLI | Frontmatter `cli:` | Model format | Notes |
| :--- | :--- | :--- | :--- |
| **Pi** (default) | `pi` (or omitted) | `provider/model` | Full support for thinking levels, turn interrupts, and live activity snapshots |
| **OpenCode** | `opencode` | `provider/model` | Runs `opencode run --model <model> <task>` |
| **Codex** | `codex` | bare model ID | Runs `codex --model <model>` with optional `--reasoning-effort` |
| **Claude Code** | `claude` | bare model ID | Runs `claude --model <model>` with autonomous completion hook |
| **Grok** | `grok` | bare model ID | Runs `grok --model <model> <task>` |
| **Custom / Generic** | any CLI name | bare model ID | Supports custom `command:` template (e.g. `command: "aider --model {model} --message {task}"`) |

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in herdr pane    → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks every agent still in flight:

```
╭─ Subagents ──────────────────── 1 active · 2 open ─╮
│ 01:23  Scout: Auth (scout)            active · write 7m │
│ 00:45  Researcher (researcher)               stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path. Completed rows are removed from the widget as soon as their result is delivered or suppressed.

### In-progress status updates

The widget projects each sub-agent from a **process + turn lifecycle**:

- **Herdr pane inspection** is the coarse authority for whether the child process is present and whether Herdr reports it as idle, working, blocked, or done.
- **Child activity snapshots** enrich the label with Pi-only detail (tool name, streaming, etc.) when available.
- Session JSONL is still used for transcript, resume, lineage, and result extraction — not for liveness.

Projected labels include:

- `starting` — launched; pane/activity confirmation is still settling
- `active` — processing work (agent turn, provider request, streaming, or tool execution)
- `blocked` — Herdr reports the child as blocked
- `waiting` — turn finished; the process is intentionally open for more input or another stage
- `interrupted` — the current turn was cancelled (Escape / `subagent_interrupt`); the process stays open and is **not** treated as active processing
- `stalled` — pane inspection is unhealthy long enough that the parent can no longer trust the run
- `running` — fallback when only coarse process presence is known (e.g. non-Pi backends)
- `finalizing` — completion was observed and delivery is in progress; the process elapsed timer freezes here

The widget header counts **active** vs **open**:

- **active** — `active`, `starting`, `running`, or `blocked`
- **open** — everything else still tracked (`waiting`, `interrupted`, `stalled`, `finalizing`, …)

When `activeCount === 0` (every tracked row is open), the border uses an amber accent. Process elapsed time (`MM:SS` on the left) freezes when the process reaches finalizing/completed/failed. Interrupt does **not** freeze that process clock; the interrupted state shows its own duration on the right while the process remains open.

A fixed internal watchdog marks a run as `stalled` when pane inspection fails or the pane disappears without a completion sidecar; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay open.** Run child-only `/subagent_finalize` after Pi is idle to send their result. Interactive subagents also suppress parent `stalled`/`recovered` notifications. `interactive` defaults to `false` independently of `auto-exit`.

#### Configuration

Status and model routing config live beside named agent definitions. Copy the example into your global agent directory:

```bash
mkdir -p ~/.pi/agent/agents
cp agents/config.json ~/.pi/agent/agents/config.json
```

If `PI_CODING_AGENT_DIR` is set, use `$PI_CODING_AGENT_DIR/agents/config.json` instead. Configure models with exact IDs from your authenticated model catalog:

```json
{
  "status": {
    "enabled": true
  },
  "models": {
    "default": "your-provider/your-default-model",
    "agents": {
      "scout": "your-provider/your-fast-model#low",
      "reviewer": "your-provider/your-review-model"
    }
  },
  "orchestration": {
    "mode": "async"
  }
}
```

`orchestration.mode` defaults to `async`: calls return immediately and Completion delivery arrives as a steer message. Set it to `wait-all` to make each `subagent` and `subagent_prompt` call return its terminal result; calls in one tool batch launch concurrently and Orchestrator reasoning resumes after every result. Interactive Subagents participate until explicit completion. Escape cancels only Orchestrator wait: Subagent continues and its incomplete or buffered terminal result reverts to Completion delivery exactly once. Mode is captured when Subagent launches; config changes apply after extension reload or new session.

`status.enabled` controls live status supervision. Status notifications cap at four lines (`lineLimit: 4`); extra lines collapse into an overflow summary. This limit is fixed.

`models.default` sets the model for subagents without a per-agent entry. `models.agents` sets per-agent models, keyed by the name passed to `subagent({ agent: ... })`. Append `#off`, `#minimal`, `#low`, `#medium`, `#high`, `#xhigh`, or `#max` to set thinking (for example, `openai-codex/gpt-5.6-line#xhigh`). Model values must be exact authenticated `provider/model-id` references, optionally followed by a thinking suffix. Subagent tool calls do not accept runtime or prompt overrides.

The model config is optional. Missing config makes model and thinking inherit the parent runtime.

---

## Spawning Subagents

```typescript
// Named agent with role from definition and runtime from config.json
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Full-context fork only when user explicitly requests it (e.g. /iterate)
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Agent defaults can choose a different session-mode via frontmatter
subagent({ name: "Planner", agent: "planner", task: "Work through the design with me" });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Display name (shown in widget and pane title)                                                     |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `agent`                | string  | —              | Load role, tools, skills, and lifecycle defaults from agent definition                           |
| `fork`                 | boolean | `false`        | Use only for an explicitly requested current-session fork; overrides agent `session-mode`; bare calls without `agent` require `fork: true` |
| `interactive`          | boolean | `false`        | Keep child session open until `/subagent_finalize` runs in its pane; also suppress parent stall/recovery notifications. Agent frontmatter can set the default. |
| `cwd`                  | string  | —              | Working directory for the sub-agent (see [Role Folders](#role-folders))                           |

Runtime and role prompts come from `config.json` and named agent definitions. `model`, `thinking`, `systemPrompt`, `skills`, and `tools` are not valid `subagent()` parameters; old calls fail schema validation.

---

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running Pi-backed subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Scout" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately labels the child as `interrupted` (counted as **open**, not active processing). Stale pre-interrupt activity snapshots are ignored so a lagging Herdr/`active` reading cannot overwrite the interrupt. The process elapsed timer keeps running because the pane is still open; only the interrupted-state duration freezes relative to the interrupt request. If the child starts work later, newer observations return it to `active`; completion, failure, and `subagent_ask` still flow through normally.

This is a turn-level interrupt, not a method for forcibly terminating a subagent session.

> **Note:** Only Pi-backed subagents are supported. Claude-backed runs will return an error.

---

## Continue a Subagent Session

Every Pi-backed `subagent` result includes immutable `id`. Use `subagent_prompt`
when existing session needs another turn: follow-up work, recovery after an
interruption or failure, or answer to a child help request. Start unrelated work
with `subagent` instead.

```typescript
subagent_prompt({ id: "child-handle", message: "Use v2 and continue." });
```

Each spawn or `subagent_prompt` observes one child turn. Its next result or
question ends that observation; retained child sessions can then continue locally
without waking this session. Another `subagent_prompt` observes one new turn.

Live child receives continuation in same pane. Closed Pi child reopens same session
with its original working directory, agent directory, identity, spawning
capability, and auto-exit setting. Display name and raw session path are never
targets. Unknown, abandoned, and busy handles fail without changing session state.

`subagent_ask({ question })` reports a structured question without closing child Pi
or pane while parent is observing that turn. Local questions remain in child pane.
Answer a reported question with original handle ID using `subagent_prompt`.


---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

The parent workspace and tab names stay unchanged. Subagents are created in newly named tabs or panes for each phase.

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. It does not inherit an agent default `session-mode`. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `~/.pi/agent/agents/` (or `$PI_CODING_AGENT_DIR/agents/`). Keep filename and frontmatter `name` aligned (for example, `researcher.md` must declare `name: researcher`) so discovery and direct invocation agree:

```markdown
---
name: my-agent
description: Does something specific
tools: read, bash, edit, write
session-mode: lineage-only
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Agent name (used in `agent: "my-agent"`)                                                                                                                                                                                                                                    |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `tools`       | string  | Comma-separated **native pi tools only**: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`                                                                                                                                                                             |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `session-mode` | string | Default child-session mode: `lineage-only` when omitted; `standalone`, `lineage-only`, or `fork` |
| `spawning`    | boolean | Defaults to `false` for child sessions; set `true` to allow nested subagent-spawning tools                                                                                                                                                                                        |
| `auto-exit`   | boolean | `false` | Close Pi and its Herdr pane after the result is sent. Independent from `interactive`. |
| `interactive` | boolean | `false` | Keep session open until `/subagent_finalize` runs in its pane; also suppress stall/recovery notifications. |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide this agent from discovery surfaces like `subagents_list`. The agent still remains directly invokable by explicit name via `subagent({ agent: "name", ... })`. |

Runtime model selection belongs in `config.json` under `models.agents`; append a thinking suffix to the selected model value when needed. `model` and `thinking` frontmatter fields are ignored.

---

### `session-mode`

Choose how a subagent session starts:

- `standalone` — fresh session with no lineage link to the caller
- `lineage-only` — default fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn. `/iterate` uses this explicit override on purpose.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### Finishing sessions

`interactive` and `auto-exit` are independent, false-by-default settings.

- Noninteractive subagents send their result when work finishes. Interactive subagents remain open until `/subagent_finalize` runs in their pane; that command waits for Pi to become idle and can send a result while Pi awaits an answer.
- `auto-exit: true` shuts down Pi and closes its Herdr pane after sending a result. With `auto-exit: false`, both remain open for review and follow-up work.

```yaml
---
name: planner
interactive: true
auto-exit: false
---
```

`/subagent_finalize` is available only in child sessions. `subagent_ask` sends a question to parent session without closing child session.

---

## Tool Access Control

By default, child sessions cannot spawn further sub-agents. Set `spawning: true` when nested delegation is intentional:

### `spawning: true`

Allows child sessions to use subagent lifecycle tools.

### `spawning: false`

Denies all subagent lifecycle tools (`subagent`, `subagent_interrupt`, `subagents_list`, `subagent_prompt`):

```yaml
---
name: worker
spawning: false
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | `true`      | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- [herdr](https://herdr.dev) — the required terminal workspace

```bash
herdr
pi
```

Other multiplexers and terminal backends are not supported.

---

## Acknowledgements

The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT
