export const SUBAGENT_HANDLE_ENTRY = "subagent_handle";

export type AssignmentState = "active" | "awaiting_answer" | "finalized" | "accepted" | "abandoned";

export interface SubagentHandle {
  id: string;
  name: string;
  sessionFile: string;
  surface?: string;
  state: AssignmentState;
  autoExit: boolean;
  interactive: boolean;
  agent?: string;
  agentDir?: string;
  cwd?: string;
  spawning?: boolean;
  createdAt: number;
}

interface HandleEntry {
  version: 1;
  handle: SubagentHandle;
}

function isHandle(value: unknown): value is SubagentHandle {
  if (!value || typeof value !== "object") return false;
  const handle = value as Partial<SubagentHandle>;
  return typeof handle.id === "string" &&
    typeof handle.name === "string" &&
    typeof handle.sessionFile === "string" &&
    (handle.surface == null || typeof handle.surface === "string") &&
    (handle.state === "active" || handle.state === "awaiting_answer" || handle.state === "finalized" || handle.state === "accepted" || handle.state === "abandoned") &&
    typeof handle.autoExit === "boolean" &&
    typeof handle.interactive === "boolean" &&
    (handle.agent == null || typeof handle.agent === "string") &&
    (handle.agentDir == null || typeof handle.agentDir === "string") &&
    (handle.cwd == null || typeof handle.cwd === "string") &&
    (handle.spawning == null || typeof handle.spawning === "boolean") &&
    typeof handle.createdAt === "number";
}

export function restoreSubagentHandles(entries: unknown[]): Map<string, SubagentHandle> {
  const handles = new Map<string, SubagentHandle>();
  for (const entry of entries) {
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record.type !== "custom" || record.customType !== SUBAGENT_HANDLE_ENTRY) continue;
    const data = record.data as Partial<HandleEntry> | undefined;
    if (data?.version === 1 && isHandle(data.handle)) handles.set(data.handle.id, data.handle);
  }
  return handles;
}

export function saveSubagentHandle(
  appendEntry: (customType: string, data: HandleEntry) => void,
  handle: SubagentHandle,
): void {
  appendEntry(SUBAGENT_HANDLE_ENTRY, { version: 1, handle });
}

export function handlePromptError(
  handle: SubagentHandle | undefined,
  inputLocked: boolean,
): string | null {
  if (!handle) return "Unknown subagent handle.";
  if (handle.state === "accepted" || handle.state === "abandoned") {
    return `Subagent handle ${handle.id} is ${handle.state} and cannot be continued.`;
  }
  if (inputLocked) return `Subagent handle ${handle.id} is busy with another prompt.`;
  return null;
}
