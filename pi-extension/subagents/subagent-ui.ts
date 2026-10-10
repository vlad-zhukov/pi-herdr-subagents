import type { Theme } from "@earendil-works/pi-coding-agent";
import { MouseRegion, stripTerminalSequences, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

export type SubagentUiTheme = Pick<Theme, "fg">;

/** Consume primary clicks before native tool expansion, even without a target. */
export function subagentMouseRegion(component: Component, activate?: () => void): Component {
  return new MouseRegion(component, (event) => {
    if (event.type !== "click" || event.button !== "left") return undefined;
    activate?.();
    return { handled: true };
  });
}

export interface SubagentPresentation {
  name?: unknown;
  agent?: unknown;
  cwd?: unknown;
  state?: unknown;
  elapsed?: unknown;
  async?: unknown;
  failed?: boolean;
  errorMessage?: unknown;
  exitCode?: unknown;
}

export interface RecordedPresentationOptions {
  failed: boolean;
  hasTerminalEvidence: boolean;
  abandoned?: boolean;
  formatElapsed(seconds: number): string;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = stripTerminalSequences(value).trim();
  return sanitized || undefined;
}

function firstLine(value: unknown): string | undefined {
  return text(value)?.split(/\r?\n/).find((candidate) => candidate.trim())?.trim();
}

export function failureReason(presentation: SubagentPresentation): string {
  const message = firstLine(presentation.errorMessage);
  // Node command failures include outgoing prompt argv, including on replay.
  if (message?.includes("Command failed: herdr agent prompt ")) return "Could not prompt subagent.";
  if (message) return message;
  if (typeof presentation.exitCode === "number" && presentation.exitCode !== 0) {
    return `Exit code ${presentation.exitCode}`;
  }
  return "Unknown error";
}

/** Maps persisted details only; live ownership and classification remain in caller. */
export function presentationFromRecordedDetails(
  details: object,
  options: RecordedPresentationOptions,
): SubagentPresentation {
  const { failed, hasTerminalEvidence } = options;
  const status = Reflect.get(details, "status");
  const elapsed = Reflect.get(details, "elapsed");
  const recordedState = typeof status === "string" && status !== "started" && !hasTerminalEvidence
    ? status === "wait_cancelled" ? "wait cancelled" : status
    : undefined;
  return {
    name: Reflect.get(details, "name"),
    agent: Reflect.get(details, "agent"),
    cwd: Reflect.get(details, "cwd"),
    state: options.abandoned ? "abandoned" : recordedState ?? (hasTerminalEvidence ? failed ? "failed" : "completed" : status === "started" ? "started" : undefined),
    elapsed: typeof elapsed === "number" ? options.formatElapsed(elapsed) : undefined,
    async: Reflect.get(details, "async") === true,
    failed: failed || options.abandoned === true,
    errorMessage: Reflect.get(details, "errorMessage"),
    exitCode: Reflect.get(details, "exitCode"),
  };
}

/** Compact shared transcript layout. Adapters own lifecycle observation and actions. */
export function renderSubagentPresentation(
  presentation: SubagentPresentation,
  theme: SubagentUiTheme,
  width: number,
): string[] {
  if (width <= 0) return [];

  const failed = presentation.failed === true;
  const agent = text(presentation.agent);
  const name = text(presentation.name);
  const header = agent && name && agent !== name ? `${agent} — ${name}` : agent ?? name ?? "subagent";
  const state = text(presentation.state);
  const elapsed = text(presentation.elapsed);
  const status = [state, presentation.async === true ? "async" : undefined, elapsed].filter(Boolean).join(" · ");
  const logicalLines = [
    header,
    text(presentation.cwd),
    status || undefined,
    failed ? failureReason(presentation) : undefined,
  ].filter((value): value is string => Boolean(value));

  if (width <= 2) {
    return logicalLines.map((_line, index) => {
      const marker = index === 0 ? "◈" : index === logicalLines.length - 1 ? "└" : "│";
      return index === 0 ? theme.fg(failed ? "error" : "success", marker) : theme.fg("dim", marker);
    });
  }

  const contentWidth = width - 2;
  const physicalLines = logicalLines.flatMap((logical) => {
    const fitting = wrapTextWithAnsi(logical, contentWidth).filter((line) => visibleWidth(line) <= contentWidth);
    return fitting.length > 0 ? fitting : [""];
  });
  return physicalLines.map((physical, index) => {
    const contentColor = failed ? "error" : "dim";
    if (index === 0) {
      const marker = theme.fg(failed ? "error" : "success", "◈");
      return `${marker}${theme.fg(contentColor, ` ${physical}`)}`;
    }
    const prefix = index === physicalLines.length - 1 ? "└" : "│";
    return failed
      ? `${theme.fg("dim", `${prefix} `)}${theme.fg(contentColor, physical)}`
      : theme.fg("dim", `${prefix} ${physical}`);
  });
}
