import type { OrchestrationMode } from "./lifecycle.ts";

export const SUBAGENT_TOOL_BLURB =
  "Delegate work to a specialist subagent running in its own context; you get back its result.";

const DELEGATION_DEFAULT =
  "Delegation is your default. Delegate any work needing more than a few tool calls or real reading. Do it yourself only for conversation, trivial edits, tight back-and-forth with the user, or when no available subagent fits the work.";

const EXPECTED_RESULT =
  "Before delegating, decide exactly what result you need back. State it in plain text in `task`, with any context from this conversation the subagent needs; it cannot see this conversation. How to reach the result is the subagent's business.";

const PARALLELIZE =
  "Parallelize aggressively. Whenever work splits into independent parts (separate areas, questions, or files), launch one subagent per part as multiple subagent calls in the same turn. They run concurrently. Parallel parts must not edit the same files. Delegating independent parts one after another wastes the user's time.";

const OWNERSHIP =
  "A delegated task belongs to its subagent. Never do, duplicate, or redo it yourself; reviewing or spot-checking a result is not redoing it. If a result fails or falls short, re-delegate: use subagent_prompt on the same subagent when its context helps, otherwise spawn a new one with a sharper expected result. If re-delegation keeps failing, report to the user.";

const MODE_RULES: Record<OrchestrationMode, string> = {
  async:
    "Subagents run in the background. While waiting, do only unrelated work, or end your turn; each result wakes you automatically. If your next step needs results still pending, end your turn.",
  "wait-all":
    "Each subagent call returns its result; calls made in the same turn run concurrently and return together.",
};

/** Child Orchestrators (a Subagent that can spawn) get mechanics only, so nested delegation does not fan out. */
export function buildSubagentGuidelines(
  agentCatalog: string,
  mode: OrchestrationMode,
  isChildOrchestrator: boolean,
): string[] {
  return [
    ...(isChildOrchestrator ? [] : [DELEGATION_DEFAULT]),
    EXPECTED_RESULT,
    ...(isChildOrchestrator ? [] : [PARALLELIZE]),
    OWNERSHIP,
    MODE_RULES[mode],
    agentCatalog,
  ];
}

/** Display name: given name, else agent name, else "fork" (a fork has neither). */
export function resolveSubagentName(name: unknown, agent: unknown): string {
  const clean = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  return clean(name) || clean(agent) || "fork";
}

export function buildAsyncAcknowledgement(name: string): string {
  return `"${name}" owns this task now. Do not work on it yourself. Continue only with unrelated work, or end your turn — the result will wake you automatically.`;
}
