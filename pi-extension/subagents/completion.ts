import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ABORT_MESSAGE = "Aborted while waiting for subagent to finish";
const TERMINAL_SENTINEL = /__SUBAGENT_DONE_(\d+)__/;

export type CompletionPayload =
  | { reason: "done"; exitCode: 0 }
  | { reason: "ask"; exitCode: 0; ask: { question: string } }
  | { reason: "sentinel"; exitCode: number }
  | { reason: "error"; exitCode: 1; errorMessage: string };

export interface CompletionOptions {
  intervalMs: number;
  readTerminalTail: () => Promise<string>;
  inspectPane?: () => Promise<import("./lifecycle.ts").PaneInspection>;
  /** Bounded artifact grace after explicit pane disappearance. Default: 500ms. */
  paneDisappearanceGraceMs?: number;
  onPaneInspection?: (
    inspection: import("./lifecycle.ts").PaneInspection,
    observedAt: number,
  ) => void;
  sessionFile?: string;
  sentinelFile?: string;
  onTick?: (elapsedSeconds: number) => void;
}

function exitFile(sessionFile: string): string {
  return `${sessionFile}.exit`;
}

/** Open one parent-delivery channel for this child turn. */
export function beginCompletionChannel(sessionFile: string): void {
  writeFileSync(exitFile(sessionFile), "", "utf8");
}

/** Remove an unused parent-delivery channel. */
export function cancelCompletionChannel(sessionFile: string): void {
  rmSync(exitFile(sessionFile), { force: true });
}

/** True only while parent has opened a channel and child has not replied. */
export function hasCompletionChannel(sessionFile: string | undefined): boolean {
  if (!sessionFile) return false;
  try {
    return existsSync(exitFile(sessionFile)) && readFileSync(exitFile(sessionFile), "utf8").trim() === "";
  } catch {
    return false;
  }
}

/** Publish one child reply through an open channel. Local turns have no channel. */
export function publishCompletion(
  sessionFile: string | undefined,
  payload: CompletionPayload,
): boolean {
  if (!sessionFile || !hasCompletionChannel(sessionFile)) return false;

  const file = exitFile(sessionFile);
  const temp = join(dirname(file), `${file.split("/").pop()}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(payload), "utf8");
    renameSync(temp, file);
    return true;
  } catch {
    rmSync(temp, { force: true });
    return false;
  }
}

export function buildCompletionPayload(messages: any[] | undefined): CompletionPayload {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i--) {
    const message = messages![i];
    if (message?.role !== "assistant" || message.stopReason !== "error") continue;
    const errorMessage = typeof message.errorMessage === "string" && message.errorMessage.trim()
      ? message.errorMessage.trim()
      : "Subagent agent loop ended with stopReason=error (no errorMessage field).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export function interpretExitSidecar(data: unknown): CompletionPayload {
  const payload = data as Partial<CompletionPayload>;
  if (payload?.reason === "done" && payload.exitCode === 0) return { reason: "done", exitCode: 0 };
  if (payload?.reason === "ask" && payload.exitCode === 0 && typeof payload.ask?.question === "string") {
    return { reason: "ask", exitCode: 0, ask: { question: payload.ask.question } };
  }
  if (payload?.reason === "sentinel" && Number.isInteger(payload.exitCode)) {
    return { reason: "sentinel", exitCode: payload.exitCode };
  }
  if (payload?.reason === "error") {
    const errorMessage = typeof payload.errorMessage === "string" && payload.errorMessage.trim()
      ? payload.errorMessage
      : "Subagent exited with reason=error (no errorMessage in completion payload).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return {
    reason: "error",
    exitCode: 1,
    errorMessage: "Invalid completion payload.",
  };
}

function consumeExitSidecar(sessionFile: string | undefined): CompletionPayload | null {
  if (!sessionFile) return null;
  const file = exitFile(sessionFile);
  if (!hasCompletionChannel(sessionFile) && !existsSync(file)) return null;

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  if (!raw.trim()) return null;

  const claimed = `${file}.${process.pid}.consumed`;
  try {
    renameSync(file, claimed);
    return interpretExitSidecar(JSON.parse(readFileSync(claimed, "utf8")));
  } catch {
    return null;
  } finally {
    rmSync(claimed, { force: true });
  }
}

function terminalExitCode(screen: string): number | null {
  const match = screen.match(TERMINAL_SENTINEL);
  return match ? Number.parseInt(match[1], 10) : null;
}

function completionArtifact(options: CompletionOptions): CompletionPayload | null {
  const sidecar = consumeExitSidecar(options.sessionFile);
  if (sidecar) return sidecar;
  if (options.sentinelFile && existsSync(options.sentinelFile)) {
    return { reason: "sentinel", exitCode: 0 };
  }
  return null;
}

async function waitForDisappearanceArtifacts(
  signal: AbortSignal,
  options: CompletionOptions,
): Promise<CompletionPayload | null> {
  const immediate = completionArtifact(options);
  if (immediate) return immediate;

  const graceMs = Math.max(0, options.paneDisappearanceGraceMs ?? 500);
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await abortableDelay(Math.min(25, remaining), signal);
    const result = completionArtifact(options);
    if (result) return result;
  }
  return null;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error(ABORT_MESSAGE));

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(ABORT_MESSAGE));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForCompletion(
  signal: AbortSignal,
  options: CompletionOptions,
): Promise<CompletionPayload> {
  const startedAt = Date.now();

  for (;;) {
    if (signal.aborted) throw new Error(ABORT_MESSAGE);

    const sidecarResult = completionArtifact(options);
    if (sidecarResult) return sidecarResult;

    if (options.sentinelFile && existsSync(options.sentinelFile)) {
      return { reason: "sentinel", exitCode: 0 };
    }

    try {
      const exitCode = terminalExitCode(await options.readTerminalTail());
      if (exitCode !== null) return { reason: "sentinel", exitCode };
    } catch {
      // Terminal reads are only sentinel/output probes; Herdr status is polled
      // independently below, even when terminal reads succeed.
    }

    if (options.inspectPane) {
      let inspection: import("./lifecycle.ts").PaneInspection;
      try {
        inspection = await options.inspectPane();
      } catch {
        inspection = { kind: "unavailable", error: "inspectPane threw" };
      }
      const observedAt = Date.now();
      options.onPaneInspection?.(inspection, observedAt);
      if (inspection.kind === "missing") {
        const racedCompletion = await waitForDisappearanceArtifacts(signal, options);
        if (racedCompletion) return racedCompletion;
        return {
          reason: "error",
          exitCode: 1,
          errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
        };
      }
    }

    options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
    await abortableDelay(options.intervalMs, signal);
  }
}
