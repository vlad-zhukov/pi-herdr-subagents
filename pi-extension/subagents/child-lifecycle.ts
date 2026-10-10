/** Child-session hooks and result command. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { createSubagentActivityRecorder } from "./activity.ts";
import { parseAgentMarkdown } from "./agent-markdown.ts";
import {
  buildCompletionPayload,
  hasCompletionChannel,
  publishCompletion,
} from "./completion.ts";

export function shouldFinalizeOnAgentSettlement(messages: any[] | undefined): boolean {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages![i];
    if (message?.role === "assistant") return message.stopReason !== "aborted";
  }
  return false;
}

function loadChildIdentity(): string {
  const file = process.env.PI_SUBAGENT_AGENT_FILE;
  if (!file) {
    if (process.env.PI_SUBAGENT_AGENT) throw new Error(`Subagent ${process.env.PI_SUBAGENT_AGENT} has no agent file path`);
    return "";
  }
  if (!isAbsolute(file)) throw new Error(`Subagent agent file path must be absolute: ${file}`);
  const content = readFileSync(file, "utf8");
  const parsed = parseAgentMarkdown(content);
  if (!parsed) throw new Error(`Subagent agent file has no YAML frontmatter: ${file}`);
  return parsed.body.trim() ? parsed.body : "";
}

function fatalChildIdentity(
  error: Error,
  ctx: Pick<ExtensionContext, "mode" | "ui" | "shutdown" | "abort">,
  duringRun = false,
): Promise<never> | never {
  const message = `Subagent identity error: ${error.message}`;
  console.error(message);
  publishCompletion(process.env.PI_SUBAGENT_SESSION, { reason: "error", exitCode: 1, errorMessage: message });
  ctx.shutdown();
  if (ctx.mode === "tui") {
    if (duringRun) {
      // Pi defers shutdown until agent_settled here, but this hook must not start the agent.
      // The public TUI stop restores raw mode, cursor and keyboard protocols before forced exit.
      return ctx.ui.custom<never>((tui) => {
        tui.stop();
        process.exit(1);
      });
    }
    // At session_start Pi is idle: its graceful shutdown stops the TUI. Block startup meanwhile.
    return new Promise<never>(() => {});
  }
  ctx.abort();
  // Print/RPC do not restore a TUI; Pi can otherwise continue after a caught hook error.
  return process.exit(1);
}

export function registerChildLifecycle(pi: ExtensionAPI): void {
  let identity = "";
  let identityError: Error | undefined;
  try {
    identity = loadChildIdentity();
  } catch (error) {
    identityError = error instanceof Error ? error : new Error(String(error));
  }
  let toolNames: string[] = [];
  let expanded = false;
  let latestAgentMessages: any[] | undefined;
  let finalized = false;
  let awaitingAnswer = false;

  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const interactive = process.env.PI_SUBAGENT_INTERACTIVE === "1";
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function finalize(ctx: { shutdown(): void }): void {
    if (finalized) return;
    finalized = true;
    publishCompletion(process.env.PI_SUBAGENT_SESSION, buildCompletionPayload(latestAgentMessages));
    recorder.assignmentFinalized();
    if (autoExit) ctx.shutdown();
  }

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));
        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";
        const countInfo = theme.fg("dim", ` — ${toolNames.length} ${expanded ? "available" : "tools"}`);
        const hint = theme.fg("muted", expanded ? "  (Ctrl+J to collapse)" : "  (Ctrl+J to expand)");
        const toolList = expanded
          ? `\n${toolNames.map((name) => theme.fg("dim", name)).join(theme.fg("muted", ", "))}`
          : "";
        box.addChild(new Text(`${agentTag}${countInfo}${hint}${toolList}`, 0, 0));
        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  pi.on("session_start", async (_event, ctx) => {
    if (identityError) await fatalChildIdentity(identityError, ctx);
    recorder.sessionStart();
    toolNames = pi.getAllTools().map((tool) => tool.name).sort();
    renderWidget(ctx, null);
  });
  pi.on("input", () => {
    if (hasCompletionChannel(process.env.PI_SUBAGENT_SESSION)) finalized = false;
    awaitingAnswer = false;
    recorder.input();
  });
  pi.on("before_agent_start", async (event, ctx) => {
    recorder.beforeAgentStart();
    if (!identity) return;
    if (typeof event.systemPromptOptions?.appendSystemPrompt !== "string") {
      await fatalChildIdentity(new Error("Pi 1.0+ systemPromptOptions.appendSystemPrompt is required for subagent identity"), ctx, true);
    }
    if (event.systemPrompt?.includes(identity) || event.systemPromptOptions.appendSystemPrompt.trimEnd().endsWith(identity.trimEnd())) return;
    event.systemPromptOptions.appendSystemPrompt += `\n\n${identity}`;
  });
  pi.on("agent_start", () => recorder.agentStart());
  pi.on("agent_end", (event) => {
    latestAgentMessages = (event as any).messages as any[] | undefined;
    recorder.agentEndWaiting();
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!interactive && hasCompletionChannel(process.env.PI_SUBAGENT_SESSION) && !awaitingAnswer && shouldFinalizeOnAgentSettlement(latestAgentMessages)) finalize(ctx);
  });
  pi.on("turn_start", (event) => recorder.turnStart((event as any).turnIndex));
  pi.on("turn_end", (event) => recorder.turnEnd((event as any).turnIndex));
  pi.on("before_provider_request", () => recorder.beforeProviderRequest());
  pi.on("after_provider_response", () => recorder.afterProviderResponse());
  pi.on("message_update", (event) => recorder.messageUpdate((event as any).assistantMessageEvent?.type));
  pi.on("tool_execution_start", (event) => recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName));
  pi.on("tool_call", (event) => recorder.toolCall((event as any).toolCallId, (event as any).toolName));
  pi.on("tool_execution_update", (event) => recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName));
  pi.on("tool_result", (event) => recorder.toolResult((event as any).toolCallId, (event as any).toolName));
  pi.on("tool_execution_end", (event) => recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName));
  pi.on("session_shutdown", (event) => recorder.sessionShutdown((event as any).reason));

  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerCommand("subagent_finalize", {
    description: "Send this subagent result after current work finishes",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      finalize(ctx);
    },
  });

  pi.registerTool({
    name: "subagent_ask",
    exposure: "model-only",
    label: "Ask Question",
    description:
      "Ask a question without closing this session. " +
      "This ends the current turn and waits for a reply.",
    promptGuidelines: [
      "When you need a decision or clarification to continue, call subagent_ask. Do not end a task with an unresolved question.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "Question needing a decision or clarification" }),
    }),
    async execute(_toolCallId, params) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error("subagent_ask is only available in subagent contexts. PI_SUBAGENT_SESSION environment variable is not set.");
      }
      awaitingAnswer = true;
      recorder.assignmentAwaiting();
      const report = publishCompletion(sessionFile, { reason: "ask", exitCode: 0, ask: { question: params.question } });
      return {
        content: [{ type: "text", text: report ? "Question sent. Waiting for a reply." : "Waiting for a local reply." }],
        details: {},
        terminate: true,
      };
    },
  });
}
