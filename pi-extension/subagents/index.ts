import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import {
  isTerminalAvailable as defaultIsTerminalAvailable,
  terminalSetupHint,
  createSubagentPane as defaultCreateSubagentPane,
  runScriptInPane,
  closePane as defaultClosePane,
  promptPane as defaultPromptPane,
  focusPane as defaultFocusPane,
  shellQuote,
  readPane,
  readPaneAsync,
  inspectPane,
  inspectPaneStrict as defaultInspectPaneStrict,
  setPaneTask,
} from "./terminal.ts";
import {
  beginCompletionChannel,
  cancelCompletionChannel,
  removeEmptyCompletionChannel,
  waitForCompletion,
  type CompletionPayload,
} from "./completion.ts";
import { registerChildLifecycle } from "./child-lifecycle.ts";
import {
  finalizeAssignment,
  type AssignmentFinalizationEvent,
  type AssignmentFinalizationOutcome,
} from "./assignment-finalization.ts";
import {
  resolveRuntimePlan,
  wrapPiModelRegistry,
  type ResolvedRuntimePlan,
  type ThinkingLevel,
} from "./runtime-routing.ts";
import {
  SUBAGENT_TOOL_BLURB,
  buildAsyncAcknowledgement,
  buildSubagentGuidelines,
  resolveSubagentName,
} from "./orchestrator-prompt.ts";
import { buildTaskHints } from "./child-prompt.ts";
import { parseAgentMarkdown } from "./agent-markdown.ts";
import {
  getHarnessDriver,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  launchPiContinuation as defaultLaunchPiContinuation,
} from "./harness/index.ts";
import {
  getAgentConfigDir,
  loadModelConfig,
  resolveModelDefault,
  resolveThinkingDefault,
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
  formatElapsedDuration,
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
  presentationFromRecordedDetails,
  renderSubagentPresentation,
  subagentMouseRegion,
  type SubagentPresentation,
} from "./subagent-ui.ts";
import {
  createLifecycle,
  markCompleted,
  markCompletionDetected,
  markDelivery,
  markFailed,
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
// children; the reloaded module adopts the shared registry for status.
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

const SubagentParams = Type.Object({
  name: Type.Optional(Type.String({ description: "Display label; defaults to agent name." })),
  task: Type.String({ description: "Expected result in plain text, plus context the subagent cannot see." }),
  agent: Type.Optional(
    Type.String({
      description:
        "Subagent to delegate to; pick by description from available subagents.",
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
        "Only when the user explicitly asks to fork this session (e.g. /iterate).",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Keep the subagent open for hands-on human work after it finishes. Only when the user asks for it.",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Claude Code only: resume that session by ID.",
    }),
  ),
}, { additionalProperties: false });

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

const BARE_SUBAGENT_FORK_ERROR =
  "Bare subagents require fork: true. Use a named agent, or set fork: true only when the user explicitly requests a current-session fork.";

function validateSubagentRequest(params: Pick<Static<typeof SubagentParams>, "agent" | "fork">): string | null {
  return !params.agent?.trim() && params.fork !== true ? BARE_SUBAGENT_FORK_ERROR : null;
}

/** Reject misspelled names; hidden agents count as known but are not listed. */
function validateAgentKnown(agent: string | undefined): string | null {
  if (!agent?.trim()) return null;
  const agents = discoverAgentDefinitions();
  if (agents.some((candidate) => candidate.name === agent)) return null;
  const available = agents.filter(isCatalogAgent).map((candidate) => candidate.name);
  return `Unknown agent "${agent}". Available: ${available.join(", ") || "none"}`;
}

function errorResult(errorMessage: string) {
  return { content: [{ type: "text" as const, text: errorMessage }], details: { errorMessage } };
}

interface AgentDefaults {
  tools?: string;
  skills?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  commandTemplate?: string;
  body?: string;
  file?: string;
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
  "subagent_prompt",
]);

/** Child sessions may spawn only when explicitly enabled in agent frontmatter. */
function resolveSpawning(agentDefs: AgentDefaults | null): boolean {
  return agentDefs?.spawning === true;
}

function getFrontmatterValue(frontmatter: Record<string, unknown>, key: string): string | undefined {
  const value = frontmatter[key];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint" || typeof value === "symbol") return String(value).trim();
  if (typeof value === "function") return value.toString().trim();
  return undefined;
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
  const parsed = parseAgentMarkdown(content);
  if (!parsed) return null;
  const { frontmatter, body } = parsed;

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    description: getFrontmatterValue(frontmatter, "description"),
    tools: getFrontmatterValue(frontmatter, "tools"),
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

function discoverAgentDefinitions(onError?: (message: string) => void): ListedAgentDefinition[] {
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
        if (!parsed) {
          onError?.(`${file}: missing YAML frontmatter`);
          continue;
        }
        agents.set(parsed.name, { ...parsed, file: resolve(dir, file), source });
      } catch (error) {
        // Skip bad entries rather than aborting discovery for every other agent.
        onError?.(`${file}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
    }
  }

  return [...agents.values()];
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Model-visible agents: not hidden, and never the current child's own agent. */
function isCatalogAgent(agent: ListedAgentDefinition): boolean {
  return !agent.disableModelInvocation && agent.name !== process.env.PI_SUBAGENT_AGENT;
}

const CATALOG_LIMIT = 24;

function buildAvailableAgentCatalog(agents: ListedAgentDefinition[]): string {
  const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));
  const visible = sorted.slice(0, CATALOG_LIMIT);
  const lines = ["<available_subagents>"];

  for (const agent of visible) {
    const description = escapeXml((agent.description ?? "").replace(/\s+/g, " ").trim());
    lines.push(`  <agent name="${escapeXml(agent.name)}">${description}</agent>`);
  }

  if (visible.length === 0) lines.push("  none; do the work yourself");
  if (sorted.length > visible.length) {
    lines.push(`  … ${sorted.length - visible.length} more named subagents omitted`);
  }
  lines.push("</available_subagents>");

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
    details: { errorMessage: "herdr not available" },
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

  if (hasErrorMessage(result.errorMessage)) {
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)}.\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent.${continuation}${sessionRef}`
    );
  }

  return isSubagentFailure(result)
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${continuation}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${continuation}${sessionRef}`;
}

function hasErrorMessage(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSubagentFailure(details: object): boolean {
  const errorMessage = Reflect.get(details, "errorMessage");
  const exitCode = Reflect.get(details, "exitCode");
  return hasErrorMessage(errorMessage) || (typeof exitCode === "number" && exitCode !== 0);
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
  /** Failure reason from agent, watcher, or parent completion handling. */
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
  agentFile?: string;
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
  /** Last projected kind, used to refresh the widget when it changes. */
  lastProjectedKind?: LifecycleProjection["kind"];
  /** Long-running agent the user drives in its own pane. */
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
  abandoned?: boolean;
  /** Parent tool-call identity for the current assignment. */
  initialToolCallId?: string;
}

interface SubagentRuntime {
  runningSubagents: Map<string, RunningSubagent>;
  handles: Map<string, SubagentHandle>;
  pi?: ExtensionAPI;
  latestCtx?: ExtensionContext;
  halted?: boolean;
  stopTerminalInput?: () => void;
  launchGates: Map<string, Promise<void>>;
  shuttingDown?: boolean;
}

function createSubagentRuntime(): SubagentRuntime {
  return { runningSubagents: new Map<string, RunningSubagent>(), handles: new Map(), launchGates: new Map() };
}

/** Upgrade reload-persisted runtime objects without replacing old watcher references. */
function ensureSubagentRuntime(value: Partial<SubagentRuntime> | undefined): SubagentRuntime {
  const runtime = value ?? createSubagentRuntime();
  runtime.runningSubagents ??= new Map<string, RunningSubagent>();
  runtime.handles ??= new Map<string, SubagentHandle>();
  runtime.halted ??= false;
  runtime.launchGates ??= new Map();
  runtime.shuttingDown ??= false;
  return runtime as SubagentRuntime;
}

/** Runtime state preserved across /reload. */
const runtime = ensureSubagentRuntime((globalThis as any)[RUNTIME_KEY]);
(globalThis as any)[RUNTIME_KEY] = runtime;
const runningSubagents = runtime.runningSubagents;
const subagentHandles = runtime.handles;

function initialRunningSubagent(toolCallId: string): RunningSubagent | undefined {
  return Array.from(runningSubagents.values()).find((running) => running.initialToolCallId === toolCallId);
}

function saveHandle(handle: SubagentHandle): void {
  if (runtime.pi?.appendEntry) saveSubagentHandle(runtime.pi.appendEntry.bind(runtime.pi), handle);
  subagentHandles.set(handle.id, handle);
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
    ...(running.agentFile ? { agentFile: running.agentFile } : {}),
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

function userAbandonmentOutcome(running: RunningSubagent): AssignmentFinalizationOutcome {
  return finalizeAssignment(
    {
      cli: running.cli,
      autoExit: running.autoExit,
      abandoned: running.abandoned,
      delivery: running.lifecycle.delivery,
    },
    { kind: "abandonment", reason: "user" },
  );
}

/** User Escape abandons every running Assignment; pane closure remains best effort. */
export function abandonAllSubagents(
  ctx: Pick<ExtensionContext, "abort"> | undefined = runtime.latestCtx,
  agents: Map<string, RunningSubagent> = runningSubagents,
  close: (surface: string) => void = closePane,
): number {
  const pi = runtime.pi;
  if (!pi && Array.from(agents.values()).some((running) => userAbandonmentOutcome(running).disposition === "abandoned")) {
    throw new Error("Subagent outcome requires an initialized extension runtime.");
  }

  let abandoned = 0;
  for (const running of Array.from(agents.values())) {
    const outcome = userAbandonmentOutcome(running);
    applyAssignmentOutcome(running, outcome, "Abandoned by user.", ctx, close, agents);
    if (outcome.disposition === "abandoned" && pi) {
      pi.appendEntry("subagent_outcome", resultDetails(running, {
        sessionFile: running.sessionFile,
        elapsed: Math.floor((Date.now() - running.startTime) / 1000),
        errorMessage: "Abandoned by user.",
      }, "abandoned"));
      abandoned += 1;
    }
  }
  updateWidget();
  return abandoned;
}

/** Observe Escape without consuming it so Pi also aborts current parent turn. */
export function handleParentTerminalInput(
  data: string,
  ctx: Pick<ExtensionContext, "abort"> | undefined = runtime.latestCtx,
): boolean {
  if (!matchesKey(data, "escape")) return false;
  return abandonAllSubagents(ctx) > 0;
}

export function haltOrchestrator(ctx: Pick<ExtensionContext, "abort"> | undefined = runtime.latestCtx): boolean {
  if (runtime.halted) return false;
  runtime.halted = true;
  ctx?.abort();
  return true;
}

export function clearOrchestratorHalt(source: "interactive" | "rpc" | "extension" | undefined): boolean {
  if (source !== "interactive" || !runtime.halted) return false;
  runtime.halted = false;
  return true;
}

function completionDeliveryOptions() {
  return { triggerTurn: !runtime.halted, deliverAs: "steer" as const };
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

function startStatusRefresh() {
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

    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const projection = projectLifecycle(ensureLifecycle(running), now);
      if (running.lastProjectedKind !== projection.kind) shouldRefreshWidget = true;
      running.lastProjectedKind = projection.kind;
    }

    if (shouldRefreshWidget) updateWidget();
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
  resolveResultPresentation,
  resolveWaitAllResultPresentation,
  shouldClosePaneAfterFinalization,
  applyAssignmentFinalization,
  runningSubagents,
  subagentHandles,
  restoreHandles,
  ensureSubagentRuntime,
  formatElapsed,
  abandonAllSubagents,
  handleParentTerminalInput,
  haltOrchestrator,
  clearOrchestratorHalt,
  completionDeliveryOptions,
  deliverInitialCompletion,
  deliverPromptCompletion,
  completionResultMetadata,
  presentationFromDetails,
  setFocusTestAdapter(focus?: typeof focusPane): void {
    focusPane = focus ?? defaultFocusPane;
  },
  setExecutionTestAdapters(
    launch: typeof launchSubagent | undefined,
    watch: typeof watchSubagent | undefined,
    terminalAvailable: (() => boolean) | undefined,
    prompt?: typeof promptPane,
    continuationLaunch?: typeof launchPiContinuation,
  ): void {
    launchSubagent = launch ?? defaultLaunchSubagent;
    watchSubagent = watch ?? defaultWatchSubagent;
    isTerminalAvailable = terminalAvailable ?? defaultIsTerminalAvailable;
    promptPane = prompt ?? defaultPromptPane;
    launchPiContinuation = continuationLaunch ?? defaultLaunchPiContinuation;
  },
  setInspectionTestAdapters(adapters: {
    inspectPaneStrict?: typeof inspectPaneStrict;
    createSubagentPane?: typeof createSubagentPane;
    closePane?: typeof closePane;
  } = {}): void {
    inspectPaneStrict = adapters.inspectPaneStrict ?? defaultInspectPaneStrict;
    createSubagentPane = adapters.createSubagentPane ?? defaultCreateSubagentPane;
    closePane = adapters.closePane ?? defaultClosePane;
  },
  activateSubagent,
  runtime,
};

function startWidgetRefresh() {
  updateWidget();
  if (widgetInterval) return;
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
/** Tool params with the display name already resolved. */
type LaunchParams = Static<typeof SubagentParams> & { name: string };

async function defaultLaunchSubagent(
  params: LaunchParams,
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
  options?: { surface?: string; toolCallId?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  if (params.agent && !agentDefs) throw new Error(`Agent definition disappeared: ${params.agent}`);
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
  const { modeHint, summaryInstruction } = buildTaskHints(effectiveInteractive);
  const spawning = resolveSpawning(agentDefs);
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
    agentFile: agentDefs?.file,
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
    ...(options?.toolCallId ? { initialToolCallId: options.toolCallId } : {}),
  };

  runningSubagents.set(id, running);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
function completionResultMetadata(
  running: Pick<RunningSubagent, "cli">,
  result: CompletionPayload,
): { exitCode: number; errorMessage?: string } {
  const unexpectedPiExit = running.cli === "pi" && result.reason === "sentinel";
  return {
    exitCode: unexpectedPiExit ? 1 : result.exitCode,
    ...(unexpectedPiExit
      ? { errorMessage: "Subagent Pi process exited before completion evidence was recorded." }
      : "errorMessage" in result ? { errorMessage: result.errorMessage } : {}),
  };
}

async function defaultWatchSubagent(
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
    // A Pi child normally publishes its sidecar before leaving. Its bare shell
    // sentinel means Pi disappeared without settlement evidence, even at exit 0.
    const { exitCode, errorMessage } = completionResultMetadata(running, result);
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
        return {
          name,
          task,
          summary: extracted.summary,
          exitCode: exitCode,
          elapsed,
          ...(extracted.sessionId ? { claudeSessionId: extracted.sessionId } : {}),
          ...extracted.details,
          ...(hasErrorMessage(errorMessage) ? { errorMessage } : {}),
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
        (errorMessage
          ? `Subagent error: ${errorMessage}`
          : exitCode !== 0
            ? `Sub-agent exited with code ${exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = errorMessage
        ? `Subagent error: ${errorMessage}`
        : exitCode !== 0
          ? `Sub-agent exited with code ${exitCode}`
          : "Sub-agent exited without output";
    }

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: exitCode,
      elapsed,
      ask: result.ask,
      ...(hasErrorMessage(errorMessage) ? { errorMessage } : {}),
    };
  } catch (err: any) {
    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        errorMessage: "cancelled",
        sessionFile,
      };
    }
    return subagentErrorResult(running, err);
  }
}

let launchSubagent = defaultLaunchSubagent;
let watchSubagent = defaultWatchSubagent;
let isTerminalAvailable = defaultIsTerminalAvailable;
let promptPane = defaultPromptPane;
let focusPane = defaultFocusPane;
let inspectPaneStrict = defaultInspectPaneStrict;
let createSubagentPane = defaultCreateSubagentPane;
let closePane = defaultClosePane;
let launchPiContinuation = defaultLaunchPiContinuation;

export function shouldClosePaneAfterFinalization(
  running: Pick<RunningSubagent, "autoExit">,
): boolean {
  return finalizeAssignment(
    { autoExit: running.autoExit, delivery: "pending" },
    { kind: "result", exitCode: 0 },
  ).pane === "close";
}

function applyAssignmentOutcome(
  running: RunningSubagent,
  outcome: AssignmentFinalizationOutcome,
  reason: string,
  ctx?: Pick<ExtensionContext, "abort">,
  close: (surface: string) => void = closePane,
  agents: Map<string, RunningSubagent> = runningSubagents,
  exitCode = 1,
): AssignmentFinalizationOutcome {
  running.initialToolCallId = undefined;
  if (outcome.lifecycle === "completed") running.lifecycle = markCompleted(running.lifecycle, Date.now());
  if (outcome.lifecycle === "failed") running.lifecycle = markFailed(running.lifecycle, reason, Date.now(), exitCode);
  if (outcome.delivery === "suppress") running.lifecycle = markDelivery(running.lifecycle, "suppressed");
  else if (outcome.delivery === "deliver") running.lifecycle = markDelivery(running.lifecycle, "delivered");

  if (outcome.handle !== "unchanged") {
    if (outcome.handle === "abandoned") {
      running.abandoned = true;
      running.inputLocked = false;
      running.abortController?.abort();
    }
    updateHandle(running, outcome.handle);
  }
  if (outcome.parentSubscription === "cancel") cancelCompletionChannel(running.sessionFile);
  if (outcome.pane === "close") {
    try {
      close(running.surface);
    } catch {
      // Pane closure is best effort after terminal Assignment state persists.
    }
  }
  if (outcome.haltOrchestrator) haltOrchestrator(ctx);
  if (outcome.removeFromRunning) agents.delete(running.id);
  if (outcome.disposition === "awaiting_answer") running.inputLocked = false;
  updateWidget();
  return outcome;
}

function applyAssignmentFinalization(
  running: RunningSubagent,
  result: SubagentResult,
  ctx?: Pick<ExtensionContext, "abort">,
): AssignmentFinalizationOutcome {
  const event: AssignmentFinalizationEvent = result.ask
    ? { kind: "ask" }
    : { kind: "result", exitCode: result.exitCode, ...(hasErrorMessage(result.errorMessage) ? { errorMessage: result.errorMessage } : {}) };
  const outcome = finalizeAssignment(
    {
      cli: running.cli,
      autoExit: running.autoExit,
      abandoned: running.abandoned,
      delivery: running.lifecycle.delivery,
    },
    event,
  );
  return applyAssignmentOutcome(running, outcome, hasErrorMessage(result.errorMessage) ? result.errorMessage : result.summary, ctx, closePane, runningSubagents, result.exitCode);
}

function subagentErrorResult(running: RunningSubagent, cause: unknown): SubagentResult {
  const errorMessage = (cause as any)?.message ?? String(cause);
  return {
    name: running.name,
    task: running.task,
    summary: `Subagent error: ${errorMessage}`,
    sessionFile: running.sessionFile,
    exitCode: 1,
    elapsed: Math.floor((Date.now() - running.startTime) / 1000),
    errorMessage,
  };
}

function resultDetails(
  running: RunningSubagent,
  result: Partial<Pick<SubagentResult, "elapsed" | "sessionFile" | "errorMessage" | "claudeSessionId" | "exitCode">>,
  status?: string,
) {
  return {
    id: running.id,
    name: running.name,
    task: running.task,
    ...(running.agent ? { agent: running.agent } : {}),
    ...(running.cwd ? { cwd: running.cwd } : {}),
    ...(running.orchestrationMode ? { async: running.orchestrationMode === "async" } : {}),
    ...(running.surface ? { surface: running.surface } : {}),
    ...(typeof result.exitCode === "number" ? { exitCode: result.exitCode } : {}),
    ...(typeof result.elapsed === "number" ? { elapsed: result.elapsed } : {}),
    ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
    ...(hasErrorMessage(result.errorMessage) ? { errorMessage: result.errorMessage } : {}),
    ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
    ...(status ? { status } : {}),
  };
}

function sendSubagentAsk(pi: ExtensionAPI, running: RunningSubagent, result: SubagentResult): void {
  const question = result.ask?.question ?? "";
  selectCompletionApi(pi, runtime.pi).sendMessage(
    {
      customType: "subagent_ask",
      content: `Sub-agent "${running.name}" asks (${formatElapsed(result.elapsed)}):\n\n${question}\nContinue: subagent_prompt({ id: "${running.id}", message: "..." })`,
      display: true,
      details: { ...resultDetails(running, result), question },
    },
    completionDeliveryOptions(),
  );
}

function deliverInitialCompletion(
  running: RunningSubagent,
  completion: Promise<SubagentResult>,
  pi: ExtensionAPI,
): void {
  void (async () => {
    try {
      const result = await completion;
      const outcome = applyAssignmentFinalization(running, result);
      if (outcome.delivery === "suppress") return;
      if (result.ask) {
        sendSubagentAsk(pi, running, result);
        return;
      }

      const basePresentation = resolveResultPresentation(result, running.name, running.id);
      const presentation = running.runtimePlan?.runtimeMismatch
        ? `${basePresentation}\n\nRuntime warning: ${running.runtimePlan.runtimeMismatch}`
        : basePresentation;

      selectCompletionApi(pi, runtime.pi).sendMessage(
        {
          customType: "subagent_result",
          content: presentation,
          display: true,
          details: {
            ...resultDetails(running, result),
            ...(running.runtimePlan ? { runtimePlan: running.runtimePlan } : {}),
          },
        },
        completionDeliveryOptions(),
      );
    } catch (err: unknown) {
      const result = subagentErrorResult(running, err);
      const outcome = applyAssignmentFinalization(running, result);
      if (outcome.delivery === "suppress") return;
      selectCompletionApi(pi, runtime.pi).sendMessage(
        {
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" error: ${result.errorMessage}`,
          display: true,
          details: resultDetails(running, result),
        },
        completionDeliveryOptions(),
      );
    }
  })();
}

function deliverPromptCompletion(
  running: RunningSubagent,
  completion: Promise<SubagentResult>,
  pi: ExtensionAPI,
): void {
  completion.then(
    (result) => {
      if (applyAssignmentFinalization(running, result).delivery === "suppress") return;
      if (result.ask) {
        sendSubagentAsk(pi, running, result);
        return;
      }
      selectCompletionApi(pi, runtime.pi).sendMessage(
        {
          customType: "subagent_result",
          content: resolveResultPresentation(result, running.name, running.id),
          display: true,
          details: resultDetails(running, result),
        },
        completionDeliveryOptions(),
      );
    },
    (cause: any) => {
      const result = subagentErrorResult(running, cause);
      if (applyAssignmentFinalization(running, result).delivery === "suppress") return;
      selectCompletionApi(pi, runtime.pi).sendMessage(
        {
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" error: ${result.errorMessage}`,
          display: true,
          details: resultDetails(running, result),
        },
        completionDeliveryOptions(),
      );
    },
  );
}

// ponytail: process-local gates; separate parent processes need external coordination.
async function acquireLaunchGate(id: string): Promise<() => void> {
  const previous = runtime.launchGates.get(id);
  let unlock!: () => void;
  const barrier = new Promise<void>((done) => { unlock = done; });
  runtime.launchGates.set(id, barrier);
  if (previous) await previous;
  return () => {
    if (runtime.launchGates.get(id) === barrier) runtime.launchGates.delete(id);
    unlock();
  };
}

function ownsParentSession(parentId: string | undefined): boolean {
  // Captured context getters invalidate on reload; only the current native id owns work.
  try {
    return typeof parentId === "string" && !!parentId.trim() && !runtime.shuttingDown &&
      runtime.latestCtx?.sessionManager?.getSessionId?.() === parentId;
  } catch {
    return false;
  }
}

function requireParentSession(parentId: string | undefined): void {
  if (!ownsParentSession(parentId)) throw new Error("Parent session changed or is shutting down.");
}

/** Pi owns format validation; missing or empty files would create a fresh session. */
function validateSavedPiSession(handle: SubagentHandle): void {
  if (!handle.cwd?.trim() || !isAbsolute(handle.cwd) || !isAbsolute(handle.sessionFile) || !statSync(handle.cwd).isDirectory()) {
    throw new Error("Saved Pi session or working directory is unavailable.");
  }
  const file = statSync(handle.sessionFile);
  if (!file.isFile() || file.size === 0) throw new Error("Saved Pi session is unavailable or empty.");
}

function closeOwnedEmptyPane(surface: string): void {
  try { closePane(surface); } catch { /* Never broaden cleanup to another target. */ }
}

function cancelOwnedCompletionChannel(sessionFile: string): void {
  try { cancelCompletionChannel(sessionFile); } catch { /* Keep the original pre-dispatch failure. */ }
}

/** Caller owns the new target only until the synchronous send boundary. */
async function launchSavedPiSession(
  handle: SubagentHandle,
  parentId: string | undefined,
  message?: string,
): Promise<Awaited<ReturnType<typeof launchPiContinuation>> | { failure: unknown }> {
  let surface: string | undefined;
  let channelOpened = false;
  let dispatchAttempted = false;
  try {
    requireParentSession(parentId);
    if (runningSubagents.has(handle.id)) throw new Error("Subagent still has a running owner.");
    validateSavedPiSession(handle);
    if (message === undefined) removeEmptyCompletionChannel(handle.sessionFile);
    surface = createSubagentPane(handle.name, message === undefined);
    requireParentSession(parentId);
    const fresh = subagentHandles.get(handle.id);
    if (!fresh || fresh.sessionFile !== handle.sessionFile || fresh.cwd !== handle.cwd || fresh.surface !== handle.surface || runningSubagents.has(handle.id)) {
      throw new Error("Subagent target changed.");
    }
    if (!runtime.pi?.appendEntry) throw new Error("Cannot persist subagent target.");
    const saved = { ...fresh, surface };
    saveHandle(saved);
    if (message !== undefined) {
      beginCompletionChannel(saved.sessionFile);
      channelOpened = true;
    }
    const launched = await launchPiContinuation({
      handle: saved,
      message,
      surface,
      artifactDir: getArtifactDir(runtime.latestCtx!.sessionManager.getSessionDir(), parentId!),
      shellReadyDelayMs: getShellReadyDelayMs(),
      beforeSend() {
        requireParentSession(parentId);
        const current = subagentHandles.get(saved.id);
        if (!current || current.surface !== surface || current.sessionFile !== saved.sessionFile || current.cwd !== saved.cwd || runningSubagents.has(saved.id)) {
          throw new Error("Subagent target changed.");
        }
        validateSavedPiSession(current);
        if (message !== undefined) {
          const error = handlePromptError(current, false);
          if (error) throw new Error(error);
        }
        dispatchAttempted = true;
      },
    });
    return launched;
  } catch (cause) {
    if (dispatchAttempted) throw cause;
    if (surface !== undefined) closeOwnedEmptyPane(surface);
    if (channelOpened) cancelOwnedCompletionChannel(handle.sessionFile);
    return { failure: cause };
  }
}

async function reopenPiSubagent(
  handle: SubagentHandle,
  message: string,
  parentId: string | undefined,
): Promise<RunningSubagent | { failure: unknown }> {
  const launched = await launchSavedPiSession(handle, parentId, message);
  if ("failure" in launched) return launched;
  requireParentSession(parentId);
  const fresh = subagentHandles.get(handle.id);
  if (!fresh || fresh.surface !== launched.surface) throw new Error("Subagent target changed.");
  const error = handlePromptError(fresh, false);
  if (error) throw new Error(error);
  const startTime = Date.now();
  const running: RunningSubagent = {
    id: handle.id,
    name: handle.name,
    task: message,
    ...(handle.agent ? { agent: handle.agent } : {}),
    ...(handle.agentFile ? { agentFile: handle.agentFile } : {}),
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
  saveHandle({ ...fresh, state: "active", subscribed: true });
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
    ...(handle.agentFile ? { agentFile: handle.agentFile } : {}),
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

function presentationFromRunning(running: RunningSubagent): SubagentPresentation {
  const projection = projectLifecycle(ensureLifecycle(running), Date.now());
  return {
    name: running.name,
    agent: running.agent,
    cwd: running.cwd,
    state: projection.kind,
    elapsed: formatElapsed(Math.floor((Date.now() - running.startTime) / 1000)),
    async: running.orchestrationMode !== "wait-all",
  };
}

function presentationFromDetails(details: object, toolCallId?: string, isError = false): SubagentPresentation {
  const failed = isError || isSubagentFailure(details);
  const status = Reflect.get(details, "status");
  const id = Reflect.get(details, "id");
  const running = (status === "started" || status === "continued") && typeof id === "string" && toolCallId
    ? runningSubagents.get(id)
    : undefined;
  if (!failed && toolCallId && running?.initialToolCallId === toolCallId) return presentationFromRunning(running);

  const exitCode = Reflect.get(details, "exitCode");
  return presentationFromRecordedDetails(details, {
    failed,
    hasTerminalEvidence: isError || typeof exitCode === "number" || hasErrorMessage(Reflect.get(details, "errorMessage")),
    formatElapsed,
  });
}

function currentSubagentPane(details: object): string | undefined {
  const id = Reflect.get(details, "id");
  if (typeof id !== "string" || !id.trim()) return undefined;
  const running = runningSubagents.get(id);
  const handle = subagentHandles.get(id);
  const pending = running?.lifecycle.delivery === "pending" &&
    (!handle || running.cli !== "pi" || (handle.state === "active" && handle.subscribed !== false));
  const association = pending ? running : handle ?? running ?? details;
  const surface = association && Reflect.get(association, "surface");
  return typeof surface === "string" && surface.trim() ? surface : undefined;
}

/** False means a newer association must be resolved by the gate-owning click. */
async function reopenForInspection(
  details: object,
  id: string,
  pane: string,
  parentId: string | undefined,
  notify: (text: string, level?: "warning" | "error") => void,
): Promise<boolean> {
  try {
    const handle = subagentHandles.get(id);
    if (!handle?.surface || handle.surface !== pane || runningSubagents.has(id) || !ownsParentSession(parentId)) {
      notify("Subagent pane no longer exists."); return true;
    }
    const inspection = await inspectPaneStrict(pane);
    if (currentSubagentPane(details) !== pane) return false;
    if (inspection.kind !== "missing") { notify("Could not confirm missing subagent pane."); return true; }
    requireParentSession(parentId);
    const fresh = subagentHandles.get(id);
    if (!fresh || fresh.surface !== pane) return false;
    const launched = await launchSavedPiSession(fresh, parentId);
    if ("failure" in launched) throw launched.failure;
    return true;
  } catch {
    notify("Could not reopen saved subagent session.", "error");
    return true;
  }
}

async function activateSubagent(details: object): Promise<void> {
  const ctx = runtime.latestCtx;
  const parentId = ctx?.sessionManager?.getSessionId?.();
  if (ctx?.mode !== "tui") return;
  const id = Reflect.get(details, "id");
  if (typeof id !== "string" || !id.trim() || !currentSubagentPane(details)) {
    ctx.ui.notify("No current subagent pane is available.", "warning");
    return;
  }
  const release = await acquireLaunchGate(id);
  const notify = (text: string, level: "warning" | "error" = "warning") => {
    if (ownsParentSession(parentId)) runtime.latestCtx?.ui.notify(text, level);
  };
  try {
    if (!ownsParentSession(parentId)) return;
    while (true) {
      if (!ownsParentSession(parentId)) return;
      const pane = currentSubagentPane(details);
      if (!pane) { notify("No current subagent pane is available."); return; }
      const outcome = await focusPane(pane);
      if (!ownsParentSession(parentId)) return;
      if (currentSubagentPane(details) !== pane) continue;
      if (outcome.kind === "focused") return;
      if (outcome.kind === "unavailable") { notify("Herdr is unavailable."); return; }
      if (outcome.kind === "error") {
        notify(outcome.code === "agent_not_found" && outcome.panePresent
          ? "Pane exists, but no focusable agent was found." : "Could not focus subagent pane.", "error");
        return;
      }
      if (await reopenForInspection(details, id, pane, parentId, notify)) return;
    }
  } catch {
    notify("Could not focus subagent pane.", "error");
  } finally {
    release();
  }
}

function renderInitialToolCall(
  args: Static<typeof SubagentParams>,
  theme: Theme,
  toolCallId: string,
  executionStarted: boolean,
  state: Record<string, unknown>,
): Component {
  return subagentMouseRegion({
    invalidate() {},
    render: (width: number) => {
      // Pi constructs call before result; defer ownership check until rendering.
      if (state.resultRendered === true) return [];
      const running = initialRunningSubagent(toolCallId);
      if (executionStarted && !running) return [];
      const presentation = running
        ? presentationFromRunning(running)
        : { name: args.name, agent: args.agent, cwd: args.cwd, state: "starting" };
      return renderSubagentPresentation(presentation, theme, width);
    },
  }, () => { void activateSubagent(initialRunningSubagent(toolCallId) ?? {}); });
}

export default function subagentsExtension(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT_ID) registerChildLifecycle(pi);
  runtime.pi = pi;

  // Capture the UI context for widget updates and restore presentation for
  // subagents whose watchers survived a reload.
  pi.on("session_start", (_event, ctx) => {
    runtime.latestCtx = ctx;
    runtime.shuttingDown = false;
    if (!process.env.PI_SUBAGENT_ID) {
      for (const message of agentLoadErrors) ctx.ui?.notify?.(`Skipped agent ${message}`, "warning");
    }
    restoreHandles(ctx.sessionManager?.getEntries?.() ?? []);
    if (runningSubagents.size > 0) {
      startWidgetRefresh();
      startStatusRefresh();
      updateWidget();
    }
    if (!process.env.PI_SUBAGENT_ID && ctx.ui?.onTerminalInput) {
      runtime.stopTerminalInput?.();
      runtime.stopTerminalInput = ctx.ui.onTerminalInput((data) => {
        handleParentTerminalInput(data, ctx);
        return undefined;
      });
    }
  });

  if (!process.env.PI_SUBAGENT_ID) {
    pi.on("input", (event) => {
      clearOrchestratorHalt((event as any).source);
    });
  }

  // Clean up on session shutdown
  pi.on("session_shutdown", (event, _ctx) => {
    if (!shouldPreserveSubagentsOnShutdown(event.reason)) runtime.shuttingDown = true;
    runtime.stopTerminalInput?.();
    runtime.stopTerminalInput = undefined;
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
  // Built once at load (catalog, mode, and child-ness are fixed per process); Pi snapshots guidelines at registration.
  const agentLoadErrors: string[] = [];
  const isChildOrchestrator = Boolean(process.env.PI_SUBAGENT_ID);
  const subagentGuidelines = buildSubagentGuidelines(
    buildAvailableAgentCatalog(
      discoverAgentDefinitions((message) => agentLoadErrors.push(message)).filter(isCatalogAgent),
    ),
    orchestrationConfig.mode,
    isChildOrchestrator,
  );

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description: SUBAGENT_TOOL_BLURB,
      promptSnippet: SUBAGENT_TOOL_BLURB,
      promptGuidelines: subagentGuidelines,
      parameters: SubagentParams,
      executionMode: "parallel",
      renderShell: "self",

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const validationError = validateSubagentRequest(params) ?? validateAgentKnown(params.agent);
        if (validationError) return errorResult(validationError);

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
            details: { errorMessage: "self-spawn blocked" },
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
            details: { errorMessage: "no session file" },
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
          throw new Error(`Unsupported parent thinking level: ${String(parentThinking)}`);
        }
        const name = resolveSubagentName(params.name, params.agent);
        const running = await launchSubagent({ ...params, name }, ctx, parentThinking, { toolCallId: _toolCallId });
        rememberPiHandle(running);

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh();

        const completion = watchSubagent(running, watcherAbort.signal);

        if (running.orchestrationMode === "wait-all") {
          const waiting = await waitForCompletionOrAbort(completion, _signal);
          if ("cancelled" in waiting) {
            deliverInitialCompletion(running, completion, pi);
            return {
              content: [{ type: "text" as const, text: "Wait cancelled. Subagent continues; terminal result will arrive through Completion delivery." }],
              details: resultDetails(running, { sessionFile: running.sessionFile }, "wait_cancelled"),
            };
          }
          const result = waiting.result;
          const outcome = applyAssignmentFinalization(running, result, ctx);
          return {
            content: [{
              type: "text" as const,
              text: outcome.delivery === "deliver"
                ? resolveWaitAllResultPresentation(result, running.name, running.id)
                : "Subagent completion suppressed.",
            }],
            details: resultDetails(running, result, outcome.disposition),
          };
        }

        deliverInitialCompletion(running, completion, pi);

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text: buildAsyncAcknowledgement(name),
            },
          ],
          details: {
            ...resultDetails(running, { sessionFile: running.sessionFile }, "started"),
            launchScriptFile: running.launchScriptFile,
            model: running.runtimePlan?.model,
            thinking: running.runtimePlan?.thinking,
            runtimePlan: running.runtimePlan,
          },
        };
      },

      renderCall(args, theme, context) {
        return renderInitialToolCall(args, theme, context.toolCallId, context.executionStarted, context.state);
      },

      renderResult(result, _opts, theme, context) {
        context.state.resultRendered = true;
        const { toolCallId, isError } = context;
        const details = result.details && typeof result.details === "object" ? result.details : isError ? {} : undefined;
        if (!details) return new Text("", 0, 0);
        return subagentMouseRegion({
          invalidate() {},
          render: (width: number) =>
            renderSubagentPresentation(presentationFromDetails(details, toolCallId, isError), theme, width),
        }, () => { void activateSubagent(details); });
      },
    });

  // ── subagent_prompt tool ──
  if (shouldRegister("subagent_prompt"))
    pi.registerTool({
      name: "subagent_prompt",
      label: "Continue Subagent",
      description:
        "Send follow-up work or an answer to an existing subagent by id; it keeps its full context. Use to answer its questions or to correct or extend its result.",
      promptSnippet: "Send follow-up work or an answer to an existing subagent by id; it keeps its full context.",
      parameters: Type.Object({
        id: Type.String({ description: "Immutable subagent handle" }),
        message: Type.String({ description: "Follow-up work, recovery instruction, or answer for the continued session" }),
      }),
      executionMode: "parallel",
      renderShell: "self",

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const parentId = ctx.sessionManager?.getSessionId?.();
        const known = ownsParentSession(parentId) ? subagentHandles.get(params.id) : undefined;
        const identity = {
          id: params.id,
          ...(known ? {
            name: known.name,
            ...(known.agent ? { agent: known.agent } : {}),
            ...(known.cwd ? { cwd: known.cwd } : {}),
            ...(known.surface ? { surface: known.surface } : {}),
            sessionFile: known.sessionFile,
          } : {}),
        };
        const failure = (text: string) => ({ content: [{ type: "text" as const, text }], details: { errorMessage: text, ...identity } });
        const release = await acquireLaunchGate(params.id);
        try {
          if (!ownsParentSession(parentId)) return failure("Parent session changed or is shutting down.");
          const handle = subagentHandles.get(params.id);
          let running = runningSubagents.get(params.id);
          const error = handlePromptError(handle, running?.inputLocked === true || running?.lifecycle.delivery === "pending");
          if (error) {
            return { content: [{ type: "text" as const, text: error }], details: { errorMessage: error, ...identity } };
          }
          if (!handle || !existsSync(handle.sessionFile)) {
            const text = `Subagent handle ${params.id} has no saved session file.`;
            return { content: [{ type: "text" as const, text }], details: { errorMessage: text, ...identity } };
          }

          if (!ownsParentSession(parentId)) return failure("Parent session changed or is shutting down.");
          if (!running) {
            if (!isTerminalAvailable()) {
              const result = muxUnavailableResult();
              return { ...result, details: { ...result.details, ...identity } };
            }
            if (!handle.surface) return failure("No current subagent pane is available.");
            const inspection = await inspectPaneStrict(handle.surface);
            if (!ownsParentSession(parentId)) return failure("Parent session changed or is shutting down.");
            const fresh = subagentHandles.get(params.id);
            if (!fresh || fresh.surface !== handle.surface || fresh.sessionFile !== handle.sessionFile || runningSubagents.has(params.id)) {
              return failure("Subagent target changed.");
            }
            const eligibilityError = handlePromptError(fresh, false);
            if (eligibilityError) return failure(eligibilityError);
            if (inspection.kind === "present" && inspection.agent === "pi") running = attachLivePiSubagent(fresh, params.message, runtime.latestCtx!);
            else if (inspection.kind !== "missing") return failure("Could not confirm a live Pi agent or missing subagent pane.");
          }

          if (running) {
            running.inputLocked = true;
            running.task = params.message;
            try {
              startParentSubscription(running);
              promptPane(running.surface, params.message, running.agentDir);
            } catch (cause: any) {
              cancelParentSubscription(running, handle);
              running.inputLocked = false;
              const text = `Could not prompt subagent ${params.id}: ${cause?.message ?? String(cause)}`;
              return { content: [{ type: "text" as const, text }], details: { errorMessage: text, ...identity } };
            }
            running.startTime = Date.now();
            running.lifecycle = createLifecycle(running.startTime);
            running.initialToolCallId = _toolCallId;
            const controller = new AbortController();
            running.abortController = controller;
            runningSubagents.set(running.id, running);
            startWidgetRefresh();
            startStatusRefresh();
            const completion = watchSubagent(running, controller.signal);
            release();
            if (running.orchestrationMode === "wait-all") {
              const waited = await waitForCompletionOrAbort(completion, signal);
              if ("cancelled" in waited) {
                if (running.initialToolCallId === _toolCallId) running.initialToolCallId = undefined;
                deliverPromptCompletion(running, completion, pi);
                return {
                  content: [{ type: "text" as const, text: "Wait cancelled. Continued subagent session remains live." }],
                  details: resultDetails(running, { sessionFile: running.sessionFile }, "wait_cancelled"),
                };
              }
              const outcome = applyAssignmentFinalization(running, waited.result, ctx);
              return {
                content: [{ type: "text" as const, text: resolveWaitAllResultPresentation(waited.result, running.name, running.id) }],
                details: resultDetails(running, waited.result, outcome.disposition),
              };
            }
            deliverPromptCompletion(running, completion, pi);
            return {
              content: [{ type: "text" as const, text: `Continuation sent to subagent ${params.id}.` }],
              details: resultDetails(running, { sessionFile: running.sessionFile }, "continued"),
            };
          }

          if (!isTerminalAvailable()) {
            const result = muxUnavailableResult();
            return { ...result, details: { ...result.details, ...identity } };
          }
          const fresh = subagentHandles.get(params.id)!;
          const resumed = await reopenPiSubagent(fresh, params.message, parentId);
          if ("failure" in resumed) {
            const cause = resumed.failure;
            const text = cause instanceof Error ? cause.message : String(cause);
            const result = failure("Could not reopen saved subagent session.");
            return { ...result, content: [{ type: "text" as const, text }] };
          }
          resumed.initialToolCallId = _toolCallId;
          const controller = new AbortController();
          resumed.abortController = controller;
          startWidgetRefresh();
          startStatusRefresh();
          const completion = watchSubagent(resumed, controller.signal);
          release();

          if (resumed.orchestrationMode === "wait-all") {
            const waited = await waitForCompletionOrAbort(completion, signal);
            if ("cancelled" in waited) {
              if (resumed.initialToolCallId === _toolCallId) resumed.initialToolCallId = undefined;
              deliverPromptCompletion(resumed, completion, pi);
              return {
                content: [{ type: "text" as const, text: "Wait cancelled. Continued subagent session remains live." }],
                details: resultDetails(resumed, { sessionFile: resumed.sessionFile }, "wait_cancelled"),
              };
            }
            const outcome = applyAssignmentFinalization(resumed, waited.result, ctx);
            return {
              content: [{ type: "text" as const, text: resolveWaitAllResultPresentation(waited.result, resumed.name, resumed.id) }],
              details: resultDetails(resumed, waited.result, outcome.disposition),
            };
          }

          deliverPromptCompletion(resumed, completion, pi);
          return {
            content: [{ type: "text" as const, text: `Subagent ${resumed.id} reopened and is continuing.` }],
            details: resultDetails(resumed, { sessionFile: resumed.sessionFile }, "continued"),
          };
        } finally {
          release();
        }
      },

      renderCall(args, theme, context) {
        return subagentMouseRegion({
          invalidate() {},
          render: (width: number) => {
            if (context.state.resultRendered === true) return [];
            const running = runningSubagents.get(args.id);
            const handle = subagentHandles.get(args.id);
            const presentation = running?.initialToolCallId === context.toolCallId && context.toolCallId
              ? presentationFromRunning(running)
              : { name: handle?.name, agent: handle?.agent, cwd: handle?.cwd };
            return renderSubagentPresentation(presentation, theme, width);
          },
        }, () => { void activateSubagent({ id: args.id }); });
      },

      renderResult(result, _opts, theme, context) {
        context.state.resultRendered = true;
        const details = result.details && typeof result.details === "object" ? result.details : {};
        return subagentMouseRegion({
          invalidate() {},
          render: (width: number) =>
            renderSubagentPresentation(presentationFromDetails(details, context.toolCallId, context.isError), theme, width),
        }, () => { void activateSubagent(details); });
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
  pi.registerMessageRenderer("subagent_result", (message, _options, theme) => {
    const details = message.details;
    if (!details || typeof details !== "object") return new Text("", 0, 0);
    return subagentMouseRegion({
      invalidate() {},
      render: (width: number) => renderSubagentPresentation(presentationFromDetails(details), theme, width),
    }, () => { void activateSubagent(details); });
  });

  pi.registerEntryRenderer<object>("subagent_outcome", (entry, _options, theme) => {
    const details = entry.data;
    if (!details || typeof details !== "object") return undefined;
    return subagentMouseRegion({
      invalidate() {},
      render: (width: number) => renderSubagentPresentation(presentationFromRecordedDetails(details, {
        failed: isSubagentFailure(details),
        hasTerminalEvidence: typeof Reflect.get(details, "exitCode") === "number" || hasErrorMessage(Reflect.get(details, "errorMessage")),
        abandoned: Reflect.get(details, "status") === "abandoned",
        formatElapsed,
      }), theme, width),
    }, () => { void activateSubagent(details); });
  });

  // ── subagent_ask message renderer ──
  pi.registerMessageRenderer("subagent_ask", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      invalidate() {},
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
