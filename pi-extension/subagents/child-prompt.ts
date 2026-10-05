/** Blank-session task wrapper lines; fork-mode tasks stay raw and use neither. */
export function buildTaskHints(interactive: boolean): { modeHint: string; summaryInstruction: string } {
  return {
    modeHint: interactive
      ? "Complete your task, then wait for further instructions."
      : "Complete your task autonomously.",
    summaryInstruction:
      "Your final message is your result: the agent that delegated this task sees nothing else.",
  };
}
