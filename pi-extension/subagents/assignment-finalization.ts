export type AssignmentFinalizationEvent =
  | { kind: "result"; exitCode: number; error?: string }
  | { kind: "ask" }
  | { kind: "abandonment"; reason: "automatic" | "user" };

export interface AssignmentFinalizationState {
  cli?: string;
  autoExit: boolean;
  abandoned?: boolean;
  delivery: "pending" | "delivered" | "suppressed";
}

export interface AssignmentFinalizationOutcome {
  disposition: "finalized" | "awaiting_answer" | "abandoned" | "suppressed";
  lifecycle: "completed" | "failed" | "unchanged";
  handle: "finalized" | "awaiting_answer" | "abandoned" | "unchanged";
  parentSubscription: "consume" | "cancel" | "retain";
  pane: "close" | "retain";
  delivery: "deliver" | "suppress";
  haltOrchestrator: boolean;
  removeFromRunning: boolean;
}

const suppressed = (removeFromRunning: boolean): AssignmentFinalizationOutcome => ({
  disposition: "suppressed",
  lifecycle: "unchanged",
  handle: "unchanged",
  parentSubscription: "retain",
  pane: "retain",
  delivery: "suppress",
  haltOrchestrator: false,
  removeFromRunning,
});

/** Pure policy for one observed Subagent Reportable event. */
export function finalizeAssignment(
  state: AssignmentFinalizationState,
  event: AssignmentFinalizationEvent,
): AssignmentFinalizationOutcome {
  if (state.abandoned || state.delivery !== "pending") return suppressed(event.kind !== "ask");

  if (event.kind === "ask") {
    return {
      disposition: "awaiting_answer",
      lifecycle: "unchanged",
      handle: "awaiting_answer",
      parentSubscription: "consume",
      pane: "retain",
      delivery: "deliver",
      haltOrchestrator: false,
      removeFromRunning: false,
    };
  }

  const abandoned = event.kind === "abandonment" ||
    (state.cli === "pi" && event.exitCode !== 0 && event.error !== "cancelled");
  if (abandoned) {
    return {
      disposition: "abandoned",
      lifecycle: "failed",
      handle: "abandoned",
      parentSubscription: "cancel",
      pane: "close",
      delivery: event.kind === "abandonment" && event.reason === "user" ? "suppress" : "deliver",
      haltOrchestrator: true,
      removeFromRunning: true,
    };
  }

  return {
    disposition: "finalized",
    lifecycle: event.exitCode === 0 ? "completed" : "failed",
    handle: "finalized",
    parentSubscription: "consume",
    pane: state.autoExit ? "close" : "retain",
    delivery: "deliver",
    haltOrchestrator: false,
    removeFromRunning: true,
  };
}
