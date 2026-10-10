import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  closeHerdrSurface,
  createHerdrSurface,
  createHerdrSurfaceSplit,
  isHerdrAvailable,
  readHerdrScreen,
  readHerdrScreenAsync,
  inspectHerdrPane,
  inspectHerdrPaneStrict,
  focusHerdrPane,
  renameHerdrTab,
  renameHerdrWorkspace,
  reportHerdrPaneTask,
  sendHerdrAgentPrompt,
  sendHerdrCommand,
  sendHerdrEscape,
} from "./herdr.ts";

export type PaneId = string;
export type SplitDirection = "right" | "down";

const SETUP_HINT = "Start pi inside herdr (`herdr`, then run `pi`).";

export function isTerminalAvailable(): boolean {
  return isHerdrAvailable();
}

export function terminalSetupHint(): string {
  return SETUP_HINT;
}

function assertTerminalAvailable(): void {
  if (!isTerminalAvailable()) throw new Error(`herdr is not available. ${SETUP_HINT}`);
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** Create a new herdr tab and return its root pane ID. */
export function createSubagentPane(name: string, focus = false): PaneId {
  assertTerminalAvailable();
  return createHerdrSurface(name, focus);
}

/** Split the current herdr pane and return the child pane ID. */
export function splitCurrentPane(name: string, direction: SplitDirection): PaneId {
  assertTerminalAvailable();
  return createHerdrSurfaceSplit(name, direction);
}

export function renameCurrentTab(title: string): void {
  assertTerminalAvailable();
  renameHerdrTab(title);
}

export function renameCurrentWorkspace(title: string): void {
  assertTerminalAvailable();
  renameHerdrWorkspace(title);
}

export function runInPane(paneId: PaneId, command: string): void {
  assertTerminalAvailable();
  sendHerdrCommand(paneId, command);
}

/** Submit a normal user prompt to recognized Pi agent in a live pane. */
export function promptPane(paneId: PaneId, message: string, agentDir?: string): void {
  assertTerminalAvailable();
  sendHerdrAgentPrompt(paneId, message, agentDir);
}

export function interruptPane(paneId: PaneId): void {
  assertTerminalAvailable();
  sendHerdrEscape(paneId);
}

export function runScriptInPane(
  paneId: PaneId,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string; beforeSend?: () => void },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-herdr-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptLines = ["#!/bin/bash"];
  if (options?.scriptPreamble) scriptLines.push(options.scriptPreamble.trimEnd());
  scriptLines.push(command);
  writeFileSync(scriptPath, `${scriptLines.join("\n")}\n`, { mode: 0o755 });

  options?.beforeSend?.();
  runInPane(paneId, `bash ${shellQuote(scriptPath)}`);
  return scriptPath;
}

export function readPane(paneId: PaneId, lines = 50): string {
  assertTerminalAvailable();
  return readHerdrScreen(paneId, lines);
}

export async function readPaneAsync(paneId: PaneId, lines = 50): Promise<string> {
  assertTerminalAvailable();
  return readHerdrScreenAsync(paneId, lines);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

export async function inspectPane(paneId: PaneId): Promise<import("./lifecycle.ts").PaneInspection> {
  assertTerminalAvailable();
  const result = await inspectHerdrPane(paneId);
  if (result.kind === "present") {
    return { kind: "present", observedAt: Date.now(), ...result };
  }
  return result;
}

export type { PaneFocusOutcome, StrictPaneInspection } from "./herdr.ts";

export async function inspectPaneStrict(paneId: PaneId): Promise<import("./herdr.ts").StrictPaneInspection> {
  return inspectHerdrPaneStrict(paneId);
}

export async function focusPane(paneId: PaneId): Promise<import("./herdr.ts").PaneFocusOutcome> {
  return focusHerdrPane(paneId);
}

export function closePane(paneId: PaneId): void {
  assertTerminalAvailable();
  closeHerdrSurface(paneId);
}

export function setPaneTask(paneId: PaneId, task: string): void {
  if (!isTerminalAvailable()) return;
  reportHerdrPaneTask(paneId, task);
}
