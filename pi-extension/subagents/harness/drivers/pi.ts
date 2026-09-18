import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  HarnessDriver,
  SubagentLaunchContext,
  BuiltHarnessCommand,
} from "../types.ts";
import type { ResolvedRuntimePlan } from "../../runtime-routing.ts";
import type { SubagentHandle } from "../../assignment-handles.ts";
import { getSubagentActivityFile } from "../../activity.ts";
import { createSubagentPane, runScriptInPane, setPaneTask, shellQuote } from "../../terminal.ts";

const SUBAGENT_CONTROL_TOOLS = ["subagent_ask"] as const;

export function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

export function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

/** Reopen a persisted Pi session with its original child settings. */
export function buildPiContinuationCommand(params: {
  handle: SubagentHandle;
  surface: string;
  activityFile: string;
  messageFile: string;
}): string {
  const { handle, surface, activityFile, messageFile } = params;
  const env = [
    handle.agentDir ? `PI_CODING_AGENT_DIR=${shellQuote(handle.agentDir)}` : "",
    `PI_SUBAGENT_SPAWNING=${handle.spawning ? "1" : "0"}`,
    `PI_SUBAGENT_NAME=${shellQuote(handle.name)}`,
    ...(handle.agent ? [`PI_SUBAGENT_AGENT=${shellQuote(handle.agent)}`] : []),
    `PI_SUBAGENT_SESSION=${shellQuote(handle.sessionFile)}`,
    `PI_SUBAGENT_ID=${shellQuote(handle.id)}`,
    `PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`,
    `PI_SUBAGENT_SURFACE=${shellQuote(surface)}`,
    `PI_SUBAGENT_INTERACTIVE=${handle.interactive ? "1" : "0"}`,
    ...(handle.autoExit ? ["PI_SUBAGENT_AUTO_EXIT=1"] : []),
  ].filter(Boolean).join(" ");
  const cwd = handle.cwd ? `cd ${shellQuote(handle.cwd)} && ` : "";
  return `${cwd}${env} pi --session ${shellQuote(handle.sessionFile)} ${shellQuote(`@${messageFile}`)}; echo '__SUBAGENT_DONE_'$?'__'`;
}

export async function launchPiContinuation(params: {
  handle: SubagentHandle;
  message: string;
  artifactDir: string;
  shellReadyDelayMs: number;
}): Promise<{ surface: string; activityFile: string; launchScriptFile: string }> {
  const { handle, message, artifactDir, shellReadyDelayMs } = params;
  const surface = createSubagentPane(handle.name);
  setPaneTask(surface, message);
  await new Promise<void>((resolve) => setTimeout(resolve, shellReadyDelayMs));

  const activityFile = getSubagentActivityFile(artifactDir, handle.id);
  const messageFile = join(artifactDir, "subagent-prompts", `${handle.id}-${Date.now()}.md`);
  mkdirSync(dirname(activityFile), { recursive: true });
  mkdirSync(dirname(messageFile), { recursive: true });
  writeFileSync(messageFile, message, "utf8");

  const launchScriptFile = join(artifactDir, "subagent-scripts", `${handle.id}-continue-${Date.now()}.sh`);
  runScriptInPane(
    surface,
    buildPiContinuationCommand({ handle, surface, activityFile, messageFile }),
    { scriptPath: launchScriptFile },
  );
  return { surface, activityFile, launchScriptFile };
}

export class PiHarnessDriver implements HarnessDriver {
  readonly id = "pi";
  readonly name = "Pi";
  readonly hasActivitySnapshots = true;
  readonly supportsTurnInterrupt = true;

  formatModel(runtimePlan: Pick<ResolvedRuntimePlan, "model" | "modelId" | "provider">): string {
    return runtimePlan.model;
  }

  buildCommand(context: SubagentLaunchContext): BuiltHarnessCommand {
    const {
      params,
      agentDefs,
      runtimePlan,
      effectiveModel,
      effectiveThinking,
      surface,
      artifactDir,
      subagentSessionFile,
      effectiveCwd,
      localAgentDir,
      effectiveAutoExit,
      effectiveInteractive,
      taskDelivery,
      spawning,
      identity,
      identityInSystemPrompt,
      systemPromptMode,
      roleBlock,
      modeHint,
      summaryInstruction,
      shellQuote,
    } = context;

    const parts: string[] = ["pi"];
    parts.push("--session", shellQuote(subagentSessionFile));

    if (effectiveModel) {
      parts.push("--model", shellQuote(effectiveModel));
    }
    if (effectiveThinking) {
      parts.push("--thinking", shellQuote(effectiveThinking));
    }

    if (identityInSystemPrompt && identity) {
      const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
      const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const spSafeName = params.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const syspromptPath = join(artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
      mkdirSync(dirname(syspromptPath), { recursive: true });
      writeFileSync(syspromptPath, identity, "utf8");
      parts.push(flag, shellQuote(syspromptPath));
    }

    const effectiveTools = agentDefs?.tools;
    const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
    if (toolAllowlist) {
      parts.push("--tools", shellQuote(toolAllowlist));
    }

    const envParts: string[] = [];
    if (localAgentDir && existsSync(localAgentDir)) {
      envParts.push(`PI_CODING_AGENT_DIR=${shellQuote(localAgentDir)}`);
    } else if (process.env.PI_CODING_AGENT_DIR) {
      envParts.push(`PI_CODING_AGENT_DIR=${shellQuote(process.env.PI_CODING_AGENT_DIR)}`);
    }

    envParts.push(`PI_SUBAGENT_SPAWNING=${spawning ? "1" : "0"}`);
    envParts.push(`PI_SUBAGENT_NAME=${shellQuote(params.name)}`);
    if (params.agent) {
      envParts.push(`PI_SUBAGENT_AGENT=${shellQuote(params.agent)}`);
    }
    envParts.push(`PI_SUBAGENT_INTERACTIVE=${effectiveInteractive ? "1" : "0"}`);
    if (effectiveAutoExit) envParts.push("PI_SUBAGENT_AUTO_EXIT=1");
    envParts.push(`PI_SUBAGENT_SESSION=${shellQuote(subagentSessionFile)}`);
    envParts.push(`PI_SUBAGENT_ID=${shellQuote(params.id)}`);
    const activityFile = join(artifactDir, `subagent-activity-${params.id}.json`);
    envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`);
    envParts.push(`PI_SUBAGENT_SURFACE=${shellQuote(surface)}`);

    const fullTask = taskDelivery === "direct"
      ? params.task
      : `${roleBlock ?? ""}\n\n${modeHint ?? ""}\n\n${params.task}\n\n${summaryInstruction ?? ""}`;

    let taskArg: string;
    if (taskDelivery === "direct") {
      taskArg = fullTask;
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const safeName = params.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
      const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
      const artifactPath = join(artifactDir, artifactName);
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, fullTask, "utf8");
      taskArg = `@${artifactPath}`;
    }

    const effectiveSkills = agentDefs?.skills;
    const promptArgs = buildPiPromptArgs({
      effectiveSkills,
      taskDelivery,
      taskArg,
    });
    for (const promptArg of promptArgs) {
      parts.push(shellQuote(promptArg));
    }

    const envPrefix = envParts.length > 0 ? `${envParts.join(" ")} ` : "";
    const cdPrefix = effectiveCwd ? `cd ${shellQuote(effectiveCwd)} && ` : "";
    const command = `${cdPrefix}${envPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;

    return {
      command,
      sessionFile: subagentSessionFile,
      cli: "pi",
      launchScriptPreamble: [
        `# Subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Session: ${subagentSessionFile}`,
        `# Surface: ${surface}`,
        `# Runtime: ${runtimePlan.model} (thinking: ${runtimePlan.thinking})`,
      ],
    };
  }
}
