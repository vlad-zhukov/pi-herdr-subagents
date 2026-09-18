import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import {
  isTerminalAvailable,
  terminalSetupHint,
  createSubagentPane,
  runScriptInPane,
  closePane,
  interruptPane,
  promptPane,
  shellQuote,
  readPane,
  readPaneAsync,
  inspectPane,
  setPaneTask,
} from "./terminal.ts";
import {
  beginCompletionChannel,
  cancelCompletionChannel,
  waitForCompletion,
} from "./completion.ts";
import { registerChildLifecycle } from "./child-lifecycle.ts";
import {
  buildAuthenticatedModelCatalog,
  resolveRuntimePlan,
  wrapPiModelRegistry,
  type ResolvedRuntimePlan,
  type ThinkingLevel,
} from "./runtime-routing.ts";
import {
  getHarnessDriver,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  launchPiContinuation,
} from "./harness/index.ts";
import {
  getAgentConfigDir,
  loadModelConfig,
  resolveModelDefault,
  resolveThinkingDefault,
  type ModelConfig,
} from "./model-config.ts";
import {
  loadOrchestrationConfig,
  type OrchestrationMode,
} from "./orchestration-config.ts";

import {
  findLastAssistantMessage,
  findObservedSessionRuntime,
  getNewEntries,
  seedSubagentSessionFile,
} from "./session.ts";
import {
  capStatusLines,
  formatElapsedDuration,
  formatStatusAggregate,
  normalizeStatusName,
  loadStatusConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import {
  handlePromptError,
  restoreSubagentHandles,
  saveSubagentHandle,
  type SubagentHandle,
} from "./assignment-handles.ts";
import {
  createLifecycle,
  formatLifecycleTransitionLine,
  lifecycleTransition,
  markCompleted,
  markCompletionDetected,
  markDelivery,
  markFailed,
  markInterruptRequested,
  markProcessRunning,
  observeActivity,
  observePaneInspection,
  projectLifecycle,
  type LifecycleProjection,
  type SubagentLifecycle,
  type PaneInspection,
} from "./lifecycle.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: replace presentation timers while keeping active completion
// watchers and their registry alive. Old module closures continue watching the
// children; the reloaded module adopts the shared registry for status/interrupts.
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const RUNTIME_KEY = Symbol.for("pi-subagents/runtime");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
}

function buildSubagentRoutingGuidelines(
  modelCatalog?: string,
  agentCatalog?: string,
): string[] {
  return [
    "Choose the named agent whose description most closely matches the task; do not use one agent as a generic default.",
    "Use fork: true only when the user explicitly requests a current-session fork (for example /iterate); otherwise omit it. Bare child spawns without agent are rejected unless fork: true is set.",
    agentCatalog ?? "Available named subagent catalog becomes available after session start.",
    modelCatalog ?? "Authenticated subagent model catalog becomes available after session start.",
  ];
}

const subagentRoutingGuidelines = buildSubagentRoutingGuidelines();

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({
      description:
        "Agent name to load role, tools, skills, and lifecycle defaults from the available named subagent catalog.",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Use only when the user explicitly requests a current-session fork (for example /iterate). Force full-context fork mode, overriding any agent session-mode; bare child spawns without agent require fork: true. Omit for normal named-agent calls.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Keep this subagent open after it finishes until /subagent_finalize is run in its pane. Also suppresses parent stalled/recovered notifications. Defaults to the agent's `interactive` frontmatter, otherwise false; independent from `auto-exit`.",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The session ID is returned in details of every claude tool call. Use for retrying cancelled runs.",
    }),
  ),
}, { additionalProperties: false });

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

const BARE_SUBAGENT_FORK_ERROR =
  "Bare subagents require fork: true. Use a named agent, or set fork: true only when the user explicitly requests a current-session fork.";

function validateSubagentRequest(params: Pick<Static<typeof SubagentParams>, "agent" | "fork">): string | null {
  return !params.agent?.trim() && params.fork !== true ? BARE_SUBAGENT_FORK_ERROR : null;
}

interface AgentDefaults {
  tools?: string;
  skills?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  commandTemplate?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "global";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/** Tools controlled by child `spawning` capability. */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_prompt",
]);

/** Child sessions may spawn only when explicitly enabled in agent frontmatter. */
function resolveSpawning(agentDefs: AgentDefaults | null): boolean {
  return agentDefs?.spawning === true;
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return undefined;
  const value = match[1].trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    spawning: parseOptionalBoolean(getFrontmatterValue(frontmatter, "spawning")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    commandTemplate:
      getFrontmatterValue(frontmatter, "command") ??
      getFrontmatterValue(frontmatter, "command-template"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      try {
        const parsed = parseAgentDefinition(
          readFileSync(join(dir, file), "utf8"),
          file.replace(/\.md$/, ""),
        );
        if (!parsed) continue;
        agents.set(parsed.name, { ...parsed, source });
      } catch {
        // Skip unreadable or racy entries rather than aborting discovery
        // for every other agent definition.
      }
    }
  }

  return [...agents.values()];
}

function buildAvailableAgentCatalog(
  agents: ListedAgentDefinition[],
  limit = 24,
  config: ModelConfig = modelConfig,
): string {
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const visible = sorted.slice(0, limit);
  const lines = [
    "Available named subagents (choose by role; runtime comes from config and parent defaults):",
  ];

  for (const agent of visible) {
    const effectiveModel = resolveModelDefault(agent.name, config);
    const effectiveThinking = resolveThinkingDefault(agent.name, config);
    const defaults = [
      effectiveModel ? `model ${effectiveModel}` : undefined,
      effectiveThinking ? `thinking ${effectiveThinking}` : undefined,
    ].filter(Boolean);
    const runtime = defaults.length > 0 ? `; defaults: ${defaults.join(", ")}` : "";
    const description = agent.description ? ` — ${agent.description}` : "";
    lines.push(`- ${agent.name} [${agent.source}${runtime}]${description}`);
  }

  if (visible.length === 0) lines.push("- none discovered; use a bare spawn");
  if (sorted.length > visible.length) {
    lines.push(`- … ${sorted.length - visible.length} more named subagents omitted`);
  }

  return lines.join("\n");
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "lineage-only";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/** Resolve independent Assignment policies; both default to false. */
function resolveEffectiveAutoExit(
  _params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  return agentDefs?.autoExit ?? false;
}

function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  return params.interactive ?? agentDefs?.interactive ?? false;
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  // Resolve through the same name-keyed map discoverAgentDefinitions() builds
  // for the tool-guidance catalog, so a name advertised there always resolves
  // to the same definition here — even when an agent's frontmatter `name`
  // differs from its filename.
  return discoverAgentDefinitions().find((agent) => agent.name === agentName) ?? null;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require herdr. ${terminalSetupHint()}`,
      },
    ],
    details: { error: "herdr not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();
const modelConfig = loadModelConfig();
const orchestrationConfig = loadOrchestrationConfig();

function buildSubagentCompletionGuidance(mode: OrchestrationMode): string {
  if (mode === "wait-all") {
    return "This call waits for terminal Subagent result; do not poll for completion or invent results.";
  }
  return "This fire-and-forget call returns immediately. Completion is delivered automatically as a steer message; do not poll for completion or invent results.";
}

const subagentCompletionGuidance = buildSubagentCompletionGuidance(orchestrationConfig.mode);

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage"
  >,
  name: string,
  handleId?: string,
): string {
  const sessionRef = result.sessionFile ? `\n\nSession: ${result.sessionFile}` : "";
  const continuation = handleId
    ? `\nContinue: subagent_prompt({ id: "${handleId}", message: "..." })`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent.${continuation}${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${continuation}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${continuation}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  ask?: { question: string };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
function resolveWaitAllResultPresentation(result: SubagentResult, name: string, handleId?: string): string {
  if (result.ask) {
    const continuation = handleId
      ? `\nContinue: subagent_prompt({ id: "${handleId}", message: "..." })`
      : "";
    return `Sub-agent "${name}" asks (${formatElapsed(result.elapsed)}):\n\n${result.ask.question}${continuation}`;
  }
  return resolveResultPresentation(result, name, handleId);
}

interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  lifecycle: SubagentLifecycle;
  /** Last projected kind used to detect stalled/recovered transitions. */
  lastProjectedKind?: LifecycleProjection["kind"];
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
  /** Parent-resolved model/thinking selection and provenance. */
  runtimePlan: ResolvedRuntimePlan | undefined;
  /** Mode captured when this Subagent launched. */
  orchestrationMode: OrchestrationMode;
  autoExit: boolean;
  cwd?: string;
  agentDir?: string;
  spawning?: boolean;
  inputLocked?: boolean;
}

interface SubagentRuntime {
  runningSubagents: Map<string, RunningSubagent>;
  handles: Map<string, SubagentHandle>;
  pi?: ExtensionAPI;
  latestCtx?: ExtensionContext;
  modelCatalog?: string;
  agentCatalog?: string;
}

function createSubagentRuntime(): SubagentRuntime {
  return { runningSubagents: new Map<string, RunningSubagent>(), handles: new Map() };
}

/** Upgrade reload-persisted runtime objects without replacing old watcher references. */
function ensureSubagentRuntime(value: Partial<SubagentRuntime> | undefined): SubagentRuntime {
  const runtime = value ?? createSubagentRuntime();
  runtime.runningSubagents ??= new Map<string, RunningSubagent>();
  runtime.handles ??= new Map<string, SubagentHandle>();
  return runtime as SubagentRuntime;
}

/** Runtime state preserved across /reload. */
const runtime = ensureSubagentRuntime((globalThis as any)[RUNTIME_KEY]);
(globalThis as any)[RUNTIME_KEY] = runtime;
const runningSubagents = runtime.runningSubagents;
const subagentHandles = runtime.handles;

function saveHandle(handle: SubagentHandle): void {
  subagentHandles.set(handle.id, handle);
  if (runtime.pi?.appendEntry) saveSubagentHandle(runtime.pi.appendEntry.bind(runtime.pi), handle);
}

function rememberPiHandle(running: RunningSubagent): void {
  if (running.cli !== "pi") return;
  saveHandle({
    id: running.id,
    name: running.name,
    sessionFile: running.sessionFile,
    surface: running.surface,
    state: "active",
    subscribed: true,
    autoExit: running.autoExit,
    interactive: running.interactive,
    ...(running.agent ? { agent: running.agent } : {}),
    ...(running.agentDir ? { agentDir: running.agentDir } : {}),
    ...(running.cwd ? { cwd: running.cwd } : {}),
    ...(running.spawning != null ? { spawning: running.spawning } : {}),
    createdAt: running.startTime,
  });
}

function updateHandle(
  running: RunningSubagent,
  state: SubagentHandle["state"],
  subscribed = false,
): void {
  const handle = subagentHandles.get(running.id);
  if (handle && handle.state !== "abandoned") {
    if (!subscribed) cancelCompletionChannel(running.sessionFile);
    saveHandle({ ...handle, surface: running.surface, state, subscribed });
  }
}

function restoreHandles(entries: unknown[]): void {
  subagentHandles.clear();
  for (const [id, handle] of restoreSubagentHandles(entries)) subagentHandles.set(id, handle);
}

export function shouldPreserveSubagentsOnShutdown(reason: unknown): boolean {
  return reason === "reload";
}

export function cleanupSubagentsForShutdown(
  reason: unknown,
  agents: Map<string, Pick<RunningSubagent, "abortController" | "lifecycle">>,
): void {
  if (shouldPreserveSubagentsOnShutdown(reason)) return;

  for (const agent of agents.values()) {
    if (agent.lifecycle) {
      agent.lifecycle = markDelivery(agent.lifecycle, "suppressed");
    }
    agent.abortController?.abort();
  }
  agents.clear();
}

export function shouldDeliverSubagentCompletion(
  running: Pick<RunningSubagent, "lifecycle">,
): boolean {
  // Authoritative gate: only pending deliveries may be sent.
  // Missing lifecycle (pre-migration fixtures) defaults to pending/true.
  return (running.lifecycle?.delivery ?? "pending") === "pending";
}

export function selectCompletionApi<T>(previous: T, current: T | undefined): T {
  return current ?? previous;
}

export function waitForCompletionOrAbort<T>(
  completion: Promise<T>,
  signal?: AbortSignal,
): Promise<{ result: T } | { cancelled: true }> {
  if (!signal) return completion.then((result) => ({ result }));
  if (signal.aborted) return Promise.resolve({ cancelled: true });

  return new Promise((resolve, reject) => {
    const onAbort = () => resolve({ cancelled: true });
    signal.addEventListener("abort", onAbort, { once: true });
    completion.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ result });
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// ── Widget management ──

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number, endTime = Date.now()): string {
  const seconds = Math.floor((endTime - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACTIVE_ACCENT = "\x1b[38;2;77;163;255m";
const OPEN_ACCENT = "\x1b[38;2;214;158;46m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${accent}│${RST}${truncRight}${" ".repeat(rightPad)}${accent}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${accent}│${RST}${truncLeft}${" ".repeat(pad)}${right}${accent}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${accent}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number, accent = ACTIVE_ACCENT): string {
  if (width <= 0) return "";
  if (width === 1) return `${accent}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${accent}╰${"─".repeat(inner)}╯${RST}`;
}

function formatLifecycleWidgetLabel(
  projection: ReturnType<typeof projectLifecycle>,
  now: number,
): string {
  const duration = projection.stateDurationSince == null
    ? ""
    : ` ${formatElapsedDuration(now - projection.stateDurationSince)}`;
  if (projection.kind === "active") return projection.label
    ? ` active · ${projection.label}${duration} `
    : ` active${duration} `;
  if (projection.kind === "blocked") return ` blocked${duration} `;
  if (projection.kind === "running") return " running… ";
  if (projection.kind === "waiting") return ` waiting${duration} `;
  if (projection.kind === "interrupted") return ` interrupted${duration} `;
  if (projection.kind === "stalled") return ` stalled${duration} `;
  // completed/failed exist as lifecycle projections for delivery bookkeeping,
  // but the row is removed immediately after result delivery — so the only
  // visible terminal handoff label is finalizing.
  if (
    projection.kind === "finalizing" ||
    projection.kind === "completed" ||
    projection.kind === "failed"
  ) {
    return " finalizing… ";
  }
  return " starting… ";
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const now = Date.now();
  const rendered = agents.map((agent) => ({ agent, projection: projectLifecycle(ensureLifecycle(agent), now) }));
  const activeCount = rendered.filter(({ projection }) =>
    projection.kind === "active" ||
    projection.kind === "starting" ||
    projection.kind === "running" ||
    projection.kind === "blocked"
  ).length;
  const openCount = agents.length - activeCount;
  const info = activeCount > 0
    ? openCount > 0 ? `${activeCount} active · ${openCount} open` : `${activeCount} active`
    : `${openCount} open`;
  const accent = activeCount > 0 ? ACTIVE_ACCENT : OPEN_ACCENT;

  const lines: string[] = [borderTop("Subagents", info, width, accent)];

  for (const { agent, projection } of rendered) {
    const elapsed = formatElapsedMMSS(agent.startTime, projection.runtimeEndedAt ?? now);
    const agentTag = agent.agent ? ` (${agent.agent})` : "";
    const left = ` ${elapsed}  ${agent.name}${agentTag} `;
    const runtimeTag = agent.runtimePlan
      ? `${agent.runtimePlan.modelId}|${agent.runtimePlan.thinking} · `
      : "";
    const right = statusConfig.enabled
      ? ` ${runtimeTag}${formatLifecycleWidgetLabel(projection, now).trim()} `
      : agent.cli && agent.cli !== "pi"
        ? ` ${runtimeTag}running… `
        : ` ${runtimeTag}starting… `;

    lines.push(borderLine(left, right, width, accent));
  }

  lines.push(borderBottom(width, accent));
  return lines;
}

function updateWidget() {
  const latestCtx = runtime.latestCtx;
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */


function ensureLifecycle(running: RunningSubagent): SubagentLifecycle {
  if (running.lifecycle) return running.lifecycle;
  running.lifecycle = markProcessRunning(createLifecycle(running.startTime), running.startTime);
  return running.lifecycle;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  ensureLifecycle(running);
  const driver = getHarnessDriver(running.cli);
  if (!driver.hasActivitySnapshots) return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    if (read.activity.phase === "waiting" || read.activity.phase === "done") {
      running.inputLocked = false;
    }
  }
  running.lifecycle = observeActivity(ensureLifecycle(running), read, observedAt);
}

function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  interruptPaneKey: (surface: string) => void = interruptPane,
): { ok: true } | { error: string } {
  try {
    interruptPaneKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via herdr: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  interruptPaneKey: (surface: string) => void = interruptPane,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  const driver = getHarnessDriver(running.cli);
  if (!driver.supportsTurnInterrupt) {
    return {
      content: [{
        type: "text" as const,
        text:
          `Turn-only Escape interrupt is currently supported only for Pi-backed subagents. ${driver.name}-backed semantics have not been verified yet.`,
      }],
      details: {
        error: `${running.cli ?? "external"} interrupt unsupported`,
        id: running.id,
        name: running.name,
      },
    };
  }

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, interruptPaneKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  running.lifecycle = markInterruptRequested(ensureLifecycle(running), now);
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

function shouldSteerStatusTransition(
  running: Pick<RunningSubagent, "id" | "interactive" | "orchestrationMode">,
): boolean {
  return (subagentHandles.get(running.id)?.subscribed ?? true) &&
    !running.interactive && running.orchestrationMode !== "wait-all";
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const projection = projectLifecycle(ensureLifecycle(running), now);
      const transition = lifecycleTransition(running.lastProjectedKind, projection.kind);
      if (running.lastProjectedKind !== projection.kind) {
        shouldRefreshWidget = true;
      }
      running.lastProjectedKind = projection.kind;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && shouldSteerStatusTransition(running)) {
        transitionLines.push(
          formatLifecycleTransitionLine(
            normalizeStatusName(running.name),
            projection,
            transition,
            now,
            running.startTime,
            formatElapsedDuration,
          ),
        );
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  buildAvailableAgentCatalog,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  validateSubagentRequest,
  resolveEffectiveAutoExit,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  observeRunningSubagent,
  resolveSpawning,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
  resolveResultPresentation,
  resolveWaitAllResultPresentation,
  shouldClosePaneAfterFinalization,
  runningSubagents,
  subagentHandles,
  restoreHandles,
  ensureSubagentRuntime,
  formatElapsed,
  buildSubagentCompletionGuidance,
  shouldSteerStatusTransition,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the herdr pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: {
    sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string };
    cwd: string;
    model?: { provider: string; id: string };
    modelRegistry: {
      find(provider: string, modelId: string): any;
      getAvailable?: () => any[];
      getAll?: () => any[];
      hasConfiguredAuth?: (model: any) => boolean;
    };
  },
  parentThinking: ThinkingLevel,
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  if (!ctx.model) throw new Error("Subagent launch requires a resolved parent model");
  const runtimePlan = resolveRuntimePlan(
    {
      model: resolveModelDefault(params.agent, modelConfig),
      thinking: resolveThinkingDefault(params.agent, modelConfig),
    },
    { provider: ctx.model.provider, modelId: ctx.model.id, thinking: parentThinking },
    wrapPiModelRegistry(ctx.modelRegistry),
  );
  const effectiveThinking = runtimePlan.thinking;
  const effectiveAutoExit = resolveEffectiveAutoExit(params, agentDefs);
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  const cliId = agentDefs?.cli ?? "pi";
  const driver = getHarnessDriver(cliId);
  driver.validateRuntimePlan?.(runtimePlan, parentThinking);

  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSubagentPane(params.name);
  if (params.task) {
    setPaneTask(surface, params.task);
  }
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  if (driver.hasActivitySnapshots) {
    mkdirSync(dirname(activityFile), { recursive: true });
  }
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint = effectiveInteractive
    ? "Complete your task, then wait for further instructions."
    : "Complete your task autonomously.";
  const summaryInstruction = "Your FINAL assistant message should summarize what you accomplished.";
  const spawning = resolveSpawning(agentDefs);
  const identity = agentDefs?.body ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const effectiveModel = driver.formatModel(runtimePlan);

  const built = driver.buildCommand({
    params: { ...params, id },
    agentDefs,
    runtimePlan,
    effectiveModel,
    effectiveThinking,
    parentThinking,
    surface,
    artifactDir,
    sessionDir,
    subagentSessionFile,
    effectiveCwd,
    localAgentDir,
    effectiveAutoExit,
    effectiveInteractive,
    inheritsConversationContext,
    taskDelivery: launchBehavior.taskDelivery,
    spawning,
    identity,
    identityInSystemPrompt: Boolean(identityInSystemPrompt),
    systemPromptMode,
    roleBlock,
    modeHint,
    summaryInstruction,
    subagentsDir: SUBAGENTS_DIR,
    shellQuote,
  });

  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

  if (driver.id === "pi") beginCompletionChannel(built.sessionFile ?? subagentSessionFile);
  runScriptInPane(surface, built.command, {
    scriptPath: launchScriptFile,
    scriptPreamble: (built.launchScriptPreamble ?? [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Surface: ${surface}`,
    ]).join("\n"),
  });

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: built.sessionFile ?? subagentSessionFile,
    launchScriptFile,
    cli: built.cli,
    sentinelFile: built.sentinelFile,
    interactive: effectiveInteractive,
    autoExit: effectiveAutoExit,
    cwd: targetCwdForSession,
    agentDir: effectiveAgentDir,
    spawning,
    runtimePlan,
    orchestrationMode: orchestrationConfig.mode,
    activityFile: driver.hasActivitySnapshots ? activityFile : undefined,
    lifecycle: !driver.hasActivitySnapshots
      ? markProcessRunning(createLifecycle(startTime), Date.now())
      : createLifecycle(startTime),
    // Initial task already owns child input until Pi reports settlement.
    inputLocked: driver.id === "pi",
  };

  runningSubagents.set(id, running);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await waitForCompletion(signal, {
      intervalMs: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      readTerminalTail: () => readPaneAsync(surface, 5),
      inspectPane: async () => inspectPane(surface),
      onPaneInspection: (inspection: PaneInspection, observedAt: number) => {
        ensureLifecycle(running);
        running.lifecycle = observePaneInspection(running.lifecycle, inspection, observedAt);
        updateWidget();
      },
      onTick() {
        observeRunningSubagent(running);
      },
    });

    const detectedAt = Date.now();
    const elapsed = Math.floor((detectedAt - startTime) / 1000);
    if (result.ask) {
      return { name, task, summary: "", sessionFile, exitCode: 0, elapsed, ask: result.ask };
    }
    running.lifecycle = markCompletionDetected(running.lifecycle, result, detectedAt);
    updateWidget();

    const driver = getHarnessDriver(running.cli);
    if (driver.extractResult) {
      const extracted = await driver.extractResult({
        running,
        completionResult: result,
        surface,
        readPane,
        closePane,
        artifactDir: dirname(running.launchScriptFile ?? running.sessionFile),
      });

      if (extracted) {
        if (shouldClosePaneAfterFinalization(running)) closePane(surface);
        running.lifecycle = result.exitCode === 0
          ? markCompleted(running.lifecycle, Date.now())
          : markFailed(running.lifecycle, result.errorMessage ?? extracted.summary, Date.now(), result.exitCode);

        return {
          name,
          task,
          summary: extracted.summary,
          exitCode: result.exitCode,
          elapsed,
          ...(extracted.sessionId ? { claudeSessionId: extracted.sessionId } : {}),
          ...extracted.details,
        };
      }
    }

    // Pi subagent result extraction
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      const observed = findObservedSessionRuntime(allEntries);
      if (running.runtimePlan && observed.provider && observed.modelId) {
        const observedModel = `${observed.provider}/${observed.modelId}`;
        const observedThinking =
          observed.thinking === "off" ||
          observed.thinking === "minimal" ||
          observed.thinking === "low" ||
          observed.thinking === "medium" ||
          observed.thinking === "high" ||
          observed.thinking === "xhigh" ||
          observed.thinking === "max"
            ? observed.thinking
            : undefined;
        const mismatch = observedModel !== running.runtimePlan.model
          ? `Resolved model ${running.runtimePlan.model} but child reported ${observedModel}`
          : undefined;
        running.runtimePlan = {
          ...running.runtimePlan,
          ...(observedThinking ? { thinking: observedThinking } : {}),
          observed: {
            model: observedModel,
            ...(observedThinking ? { thinking: observedThinking } : {}),
          },
          ...(mismatch ? { runtimeMismatch: mismatch } : {}),
        };
      }
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    if (shouldClosePaneAfterFinalization(running)) closePane(surface);
    running.lifecycle = result.exitCode === 0
      ? markCompleted(running.lifecycle, Date.now())
      : markFailed(running.lifecycle, result.errorMessage ?? summary, Date.now(), result.exitCode);

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ask: result.ask,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    };
  } catch (err: any) {
    if (shouldClosePaneAfterFinalization(running)) {
      try {
        closePane(surface);
      } catch {}
    }
    running.lifecycle = markFailed(
      running.lifecycle,
      signal.aborted ? "Subagent cancelled." : err?.message ?? String(err),
      Date.now(),
      1,
    );
    updateWidget();

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

export function shouldClosePaneAfterFinalization(
  running: Pick<RunningSubagent, "autoExit">,
): boolean {
  return running.autoExit;
}

function finishAskDelivery(running: RunningSubagent): void {
  running.lifecycle = markDelivery(running.lifecycle, "delivered");
  running.inputLocked = false;
  updateHandle(running, "awaiting_answer");
  updateWidget();
}

function sendSubagentAsk(pi: ExtensionAPI, running: RunningSubagent, result: SubagentResult): void {
  const question = result.ask?.question ?? "";
  selectCompletionApi(pi, runtime.pi).sendMessage(
    {
      customType: "subagent_ask",
      content: `Sub-agent "${running.name}" asks (${formatElapsed(result.elapsed)}):\n\n${question}\nContinue: subagent_prompt({ id: "${running.id}", message: "..." })`,
      display: true,
      details: { id: running.id, name: running.name, question, agent: running.agent, sessionFile: result.sessionFile },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

function finishPromptCompletion(
  running: RunningSubagent,
  delivery: "delivered" | "suppressed",
): void {
  running.lifecycle = markDelivery(running.lifecycle, delivery);
  if (delivery === "delivered") updateHandle(running, "finalized");
  runningSubagents.delete(running.id);
  updateWidget();
}

function deliverPromptCompletion(
  running: RunningSubagent,
  completion: Promise<SubagentResult>,
  pi: ExtensionAPI,
): void {
  completion.then(
    (result) => {
      if (!shouldDeliverSubagentCompletion(running)) {
        finishPromptCompletion(running, "suppressed");
        return;
      }
      if (result.ask) {
        finishAskDelivery(running);
        sendSubagentAsk(pi, running, result);
        return;
      }
      finishPromptCompletion(running, "delivered");
      const completionApi = selectCompletionApi(pi, runtime.pi);
      completionApi.sendMessage(
        {
          customType: "subagent_result",
          content: resolveResultPresentation(result, running.name, running.id),
          display: true,
          details: {
            id: running.id,
            name: running.name,
            task: running.task,
            exitCode: result.exitCode,
            elapsed: result.elapsed,
            sessionFile: result.sessionFile,
            ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
          },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
    (cause: any) => {
      if (!shouldDeliverSubagentCompletion(running)) {
        finishPromptCompletion(running, "suppressed");
        return;
      }
      finishPromptCompletion(running, "delivered");
      selectCompletionApi(pi, runtime.pi).sendMessage(
        {
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" error: ${cause?.message ?? String(cause)}`,
          display: true,
          details: { id: running.id, name: running.name, task: running.task, error: cause?.message },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    },
  );
}

async function reopenPiSubagent(
  handle: SubagentHandle,
  message: string,
  ctx: Pick<ExtensionContext, "sessionManager">,
): Promise<RunningSubagent> {
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
  beginCompletionChannel(handle.sessionFile);
  const launched = await launchPiContinuation({
    handle,
    message,
    artifactDir,
    shellReadyDelayMs: getShellReadyDelayMs(),
  });
  const startTime = Date.now();
  const running: RunningSubagent = {
    id: handle.id,
    name: handle.name,
    task: message,
    ...(handle.agent ? { agent: handle.agent } : {}),
    surface: launched.surface,
    startTime,
    sessionFile: handle.sessionFile,
    launchScriptFile: launched.launchScriptFile,
    activityFile: launched.activityFile,
    cli: "pi",
    interactive: handle.interactive,
    autoExit: handle.autoExit,
    ...(handle.cwd ? { cwd: handle.cwd } : {}),
    ...(handle.agentDir ? { agentDir: handle.agentDir } : {}),
    ...(handle.spawning != null ? { spawning: handle.spawning } : {}),
    runtimePlan: undefined,
    orchestrationMode: orchestrationConfig.mode,
    lifecycle: createLifecycle(startTime),
    inputLocked: true,
  };
  runningSubagents.set(handle.id, running);
  saveHandle({ ...handle, surface: launched.surface, state: "active", subscribed: true });
  return running;
}

function attachLivePiSubagent(
  handle: SubagentHandle,
  message: string,
  ctx: Pick<ExtensionContext, "sessionManager">,
): RunningSubagent {
  const startTime = Date.now();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
  const running: RunningSubagent = {
    id: handle.id,
    name: handle.name,
    task: message,
    ...(handle.agent ? { agent: handle.agent } : {}),
    surface: handle.surface!,
    startTime,
    sessionFile: handle.sessionFile,
    activityFile: getSubagentActivityFile(artifactDir, handle.id),
    cli: "pi",
    interactive: handle.interactive,
    autoExit: handle.autoExit,
    ...(handle.cwd ? { cwd: handle.cwd } : {}),
    ...(handle.agentDir ? { agentDir: handle.agentDir } : {}),
    ...(handle.spawning != null ? { spawning: handle.spawning } : {}),
    runtimePlan: undefined,
    orchestrationMode: orchestrationConfig.mode,
    lifecycle: createLifecycle(startTime),
    inputLocked: true,
  };
  runningSubagents.set(handle.id, running);
  return running;
}

function startParentSubscription(running: RunningSubagent): void {
  beginCompletionChannel(running.sessionFile);
  updateHandle(running, "active", true);
}

function cancelParentSubscription(running: RunningSubagent, previous: SubagentHandle): void {
  cancelCompletionChannel(running.sessionFile);
  saveHandle({ ...previous, surface: running.surface, subscribed: false });
}

export default function subagentsExtension(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_ID) registerChildLifecycle(pi);
  runtime.pi = pi;

  // Capture the UI context for widget updates and restore presentation for
  // subagents whose watchers survived a reload.
  pi.on("session_start", (_event, ctx) => {
    runtime.latestCtx = ctx;
    restoreHandles(ctx.sessionManager?.getEntries?.() ?? []);
    runtime.modelCatalog = buildAuthenticatedModelCatalog(
      wrapPiModelRegistry(ctx.modelRegistry),
      24,
      ctx.scopedModels?.map(({ model }) => model) ?? [],
    );
    runtime.agentCatalog = buildAvailableAgentCatalog(
      discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation),
    );
    const refreshedGuidelines = buildSubagentRoutingGuidelines(
      runtime.modelCatalog,
      runtime.agentCatalog,
    );
    subagentRoutingGuidelines.splice(0, subagentRoutingGuidelines.length, ...refreshedGuidelines);
    if (runningSubagents.size > 0) {
      startWidgetRefresh();
      startStatusRefresh(pi);
      updateWidget();
    }
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }

    cleanupSubagentsForShutdown((event as any).reason, runningSubagents);
  });

  // Base session retains all lifecycle tools. Child sessions opt in via spawning.
  const spawningEnabled =
    !process.env.PI_SUBAGENT_ID || process.env.PI_SUBAGENT_SPAWNING === "1";
  const shouldRegister = (name: string) => spawningEnabled || !SPAWNING_TOOLS.has(name);

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal herdr pane. " +
        "Use fork: true only when the user explicitly requests a current-session fork (for example /iterate); do not choose it yourself. " +
        "Bare child spawns without agent are rejected unless fork: true is set. " +
        subagentCompletionGuidance,
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal herdr pane. " +
        "Use fork: true only when the user explicitly requests a current-session fork (for example /iterate); do not choose it yourself. " +
        "Bare child spawns without agent are rejected unless fork: true is set. " +
        subagentCompletionGuidance,
      promptGuidelines: subagentRoutingGuidelines,
      parameters: SubagentParams,
      executionMode: "parallel",

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const validationError = validateSubagentRequest(params);
        if (validationError) {
          return {
            content: [{ type: "text", text: validationError }],
            details: { error: validationError },
          };
        }

        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isTerminalAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Launch the subagent (creates pane, sends command)
        const parentThinking = pi.getThinkingLevel();
        if (
          parentThinking !== "off" &&
          parentThinking !== "minimal" &&
          parentThinking !== "low" &&
          parentThinking !== "medium" &&
          parentThinking !== "high" &&
          parentThinking !== "xhigh" &&
          parentThinking !== "max"
        ) {
          throw new Error(`Unsupported parent thinking level: ${parentThinking}`);
        }
        const running = await launchSubagent(params, ctx, parentThinking);
        rememberPiHandle(running);

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        const completion = watchSubagent(running, watcherAbort.signal);

        if (running.orchestrationMode === "wait-all") {
          const waiting = await waitForCompletionOrAbort(completion, _signal);
          if ("cancelled" in waiting) {
            deliverCompletion();
            return {
              content: [{ type: "text" as const, text: "Wait cancelled. Subagent continues; terminal result will arrive through Completion delivery." }],
              details: { id: running.id, name: running.name, status: "wait_cancelled" },
            };
          }
          const result = waiting.result;
          if (result.ask) finishAskDelivery(running);
          else {
            running.lifecycle = markDelivery(running.lifecycle, "delivered");
            updateHandle(running, "finalized");
            runningSubagents.delete(running.id);
            updateWidget();
          }

          return {
            content: [{ type: "text" as const, text: resolveWaitAllResultPresentation(result, running.name, running.id) }],
            details: {
              id: running.id,
              name: running.name,
              task: running.task,
              agent: running.agent,
              exitCode: result.exitCode,
              elapsed: result.elapsed,
              sessionFile: result.sessionFile,
              status: "completed",
            },
          };
        }

        function deliverCompletion(): void {
          completion
            .then((result) => {
            if (!shouldDeliverSubagentCompletion(running)) {
              running.lifecycle = markDelivery(running.lifecycle, "suppressed");
              runningSubagents.delete(running.id);
              updateWidget();
              return;
            }
            if (result.ask) {
              finishAskDelivery(running);
              sendSubagentAsk(pi, running, result);
              return;
            }
            running.lifecycle = markDelivery(running.lifecycle, "delivered");
            updateHandle(running, "finalized");
            runningSubagents.delete(running.id);
            updateWidget();

            const basePresentation = resolveResultPresentation(result, running.name, running.id);
            const presentation = running.runtimePlan?.runtimeMismatch
              ? `${basePresentation}\n\nRuntime warning: ${running.runtimePlan.runtimeMismatch}`
              : basePresentation;

            completionApi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  id: running.id,
                  name: running.name,
                  task: running.task,
                  agent: running.agent,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
                  ...(running.runtimePlan ? { runtimePlan: running.runtimePlan } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            if (!shouldDeliverSubagentCompletion(running)) {
              running.lifecycle = markDelivery(running.lifecycle, "suppressed");
              runningSubagents.delete(running.id);
              updateWidget();
              return;
            }
            running.lifecycle = markDelivery(running.lifecycle, "delivered");
            updateHandle(running, "finalized");
            runningSubagents.delete(running.id);
            updateWidget();
            selectCompletionApi(pi, runtime.pi).sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
            });
        }

        deliverCompletion();

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            model: running.runtimePlan?.model,
            thinking: running.runtimePlan?.thinking,
            runtimePlan: running.runtimePlan,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent = typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          const runtime = details?.model
            ? ` — ${details.model}${details.thinking ? ` · ${details.thinking}` : ""}`
            : " — started";
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", runtime),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      promptSnippet:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  if (shouldRegister("subagents_list"))
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description: "List all available global subagent definitions.",
      promptSnippet: "List all available global subagent definitions.",
      parameters: Type.Object({}),

      async execute() {
        const list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const desc = a.description ? ` — ${a.description}` : "";
          const model = resolveModelDefault(a.name, modelConfig);
          const thinking = resolveThinkingDefault(a.name, modelConfig);
          const runtime = model ? ` [${model}${thinking ? ` · ${thinking}` : ""}]` : "";
          return `• ${a.name}${runtime}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const configuredModel = resolveModelDefault(a.name, modelConfig);
          const configuredThinking = resolveThinkingDefault(a.name, modelConfig);
          const runtime = configuredModel
            ? theme.fg("dim", ` [${configuredModel}${configuredThinking ? ` · ${configuredThinking}` : ""}]`)
            : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${runtime}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_prompt tool ──
  if (shouldRegister("subagent_prompt"))
    pi.registerTool({
      name: "subagent_prompt",
      label: "Continue Subagent",
      description:
        "Continue a Pi-backed subagent session by immutable handle. " +
        "Use after follow-up work, recovery from an interruption or failure, or a reply to its request. " +
        "Live sessions receive the message in their existing pane; closed sessions reopen their saved Pi session with original launch settings.",
      promptSnippet: "Continue a Pi-backed subagent session by immutable handle.",
      parameters: Type.Object({
        id: Type.String({ description: "Immutable subagent handle" }),
        message: Type.String({ description: "Follow-up work, recovery instruction, or answer for the continued session" }),
      }),
      executionMode: "parallel",

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const handle = subagentHandles.get(params.id);
        let running = runningSubagents.get(params.id);
        const error = handlePromptError(handle, running?.inputLocked === true);
        if (error) {
          return { content: [{ type: "text" as const, text: error }], details: { error, id: params.id } };
        }
        if (!handle || !existsSync(handle.sessionFile)) {
          const text = `Subagent handle ${params.id} has no saved session file.`;
          return { content: [{ type: "text" as const, text }], details: { error: text, id: params.id } };
        }

        if (!running && handle.surface) {
          if (!isTerminalAvailable()) return muxUnavailableResult();
          try {
            const inspection = await inspectPane(handle.surface);
            if (inspection.kind === "present") running = attachLivePiSubagent(handle, params.message, ctx);
          } catch {
            // Closed and unavailable panes both fall through to session reopen.
          }
        }

        if (running) {
          running.inputLocked = true;
          running.task = params.message;
          running.lifecycle = createLifecycle(running.startTime);
          try {
            startParentSubscription(running);
            promptPane(running.surface, params.message);
          } catch (cause: any) {
            cancelParentSubscription(running, handle);
            running.inputLocked = false;
            const text = `Could not prompt subagent ${params.id}: ${cause?.message ?? String(cause)}`;
            return { content: [{ type: "text" as const, text }], details: { error: text, id: params.id } };
          }
          const controller = new AbortController();
          running.abortController = controller;
          startWidgetRefresh();
          startStatusRefresh(pi);
          const completion = watchSubagent(running, controller.signal);
          if (running.orchestrationMode === "wait-all") {
            const waited = await waitForCompletionOrAbort(completion, signal);
            if ("cancelled" in waited) {
              deliverPromptCompletion(running, completion, pi);
              return {
                content: [{ type: "text" as const, text: "Wait cancelled. Continued subagent session remains live." }],
                details: { id: running.id, name: running.name, status: "wait_cancelled" },
              };
            }
            if (waited.result.ask) finishAskDelivery(running);
            else finishPromptCompletion(running, "delivered");
            return {
              content: [{ type: "text" as const, text: resolveWaitAllResultPresentation(waited.result, running.name, running.id) }],
              details: { id: running.id, name: running.name, sessionFile: running.sessionFile, status: waited.result.ask ? "awaiting_answer" : "completed" },
            };
          }
          deliverPromptCompletion(running, completion, pi);
          return {
            content: [{ type: "text" as const, text: `Continuation sent to subagent ${params.id}.` }],
            details: { id: params.id, name: handle.name, status: "continued" },
          };
        }

        if (!isTerminalAvailable()) return muxUnavailableResult();
        const resumed = await reopenPiSubagent(handle, params.message, ctx);
        const controller = new AbortController();
        resumed.abortController = controller;
        startWidgetRefresh();
        startStatusRefresh(pi);
        const completion = watchSubagent(resumed, controller.signal);

        if (resumed.orchestrationMode === "wait-all") {
          const waited = await waitForCompletionOrAbort(completion, signal);
          if ("cancelled" in waited) {
            deliverPromptCompletion(resumed, completion, pi);
            return {
              content: [{ type: "text" as const, text: "Wait cancelled. Continued subagent session remains live." }],
              details: { id: resumed.id, name: resumed.name, status: "wait_cancelled" },
            };
          }
          if (waited.result.ask) finishAskDelivery(resumed);
          else finishPromptCompletion(resumed, "delivered");
          return {
            content: [{ type: "text" as const, text: resolveWaitAllResultPresentation(waited.result, resumed.name, resumed.id) }],
            details: { id: resumed.id, name: resumed.name, sessionFile: resumed.sessionFile, status: waited.result.ask ? "awaiting_answer" : "completed" },
          };
        }

        deliverPromptCompletion(resumed, completion, pi);
        return {
          content: [{ type: "text" as const, text: `Subagent ${resumed.id} reopened and is continuing.` }],
          details: { id: resumed.id, name: resumed.name, sessionFile: resumed.sessionFile, status: "continued" },
        };
      },
    });

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork an interactive session. fork: true, interactive: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork an interactive session. fork: true, interactive: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: "${agentName}", name: "${displayName}", task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : failed
            ? `failed (exit ${exitCode})`
            : "completed";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
          if (details.id) {
            contentLines.push(theme.fg("dim", `Continue: subagent_prompt({ id: "${details.id}", message: "..." })`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_ask message renderer ──
  pi.registerMessageRenderer("subagent_ask", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— asks")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.question ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.question ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

}
