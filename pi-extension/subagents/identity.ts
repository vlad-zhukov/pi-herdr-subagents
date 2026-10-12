export const SUBAGENT_COUNTER_ENTRY = "subagent_counter";

/** Full session history owns each parent's allocations, including launches without handles. */
export function allocateSubagentId(
  entries: unknown[],
  appendEntry: (customType: string, data: { version: 1; parentId: string | null; value: number }) => void,
  role: string,
  parentId: string | null,
): string {
  let maximum = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
    if (record.type !== "custom" || record.customType !== SUBAGENT_COUNTER_ENTRY) continue;
    if (!record.data || typeof record.data !== "object") continue;
    const data = record.data as { version?: unknown; parentId?: unknown; value?: unknown };
    if (data.parentId !== parentId) continue;
    if (data.version !== 1 || typeof data.value !== "number" || !Number.isSafeInteger(data.value) || data.value <= 0) {
      throw new Error("Invalid subagent counter record.");
    }
    maximum = Math.max(maximum, data.value);
  }
  const value = maximum + 1;
  if (!Number.isSafeInteger(value)) throw new Error("Subagent counter exceeds safe integer range.");
  appendEntry(SUBAGENT_COUNTER_ENTRY, { version: 1, parentId, value });
  return `${parentId ? `${parentId}-` : ""}${role}-${String(value).padStart(2, "0")}`;
}
