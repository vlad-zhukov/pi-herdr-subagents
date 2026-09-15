import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentConfigDir } from "./model-config.ts";

export type OrchestrationMode = "async" | "wait-all";

export interface OrchestrationConfig {
  mode: OrchestrationMode;
}

const DEFAULT_CONFIG: OrchestrationConfig = { mode: "async" };

function getDefaultConfigPath(): string {
  return join(getAgentConfigDir(), "agents", "config.json");
}

function invalidConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent orchestration config in ${source}: ${message}`);
}

export function parseOrchestrationConfig(rawConfig: unknown, source = "config.json"): OrchestrationConfig {
  if (rawConfig == null || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    invalidConfig(source, "root must be an object");
  }

  const orchestration = (rawConfig as Record<string, unknown>).orchestration;
  if (orchestration == null) return DEFAULT_CONFIG;
  if (typeof orchestration !== "object" || Array.isArray(orchestration)) {
    invalidConfig(source, "orchestration must be an object");
  }

  const value = orchestration as Record<string, unknown>;
  const unsupportedKeys = Object.keys(value).filter((key) => key !== "mode");
  if (unsupportedKeys.length > 0) {
    invalidConfig(source, `orchestration has unsupported key(s): ${unsupportedKeys.join(", ")}`);
  }

  if (value.mode == null) return DEFAULT_CONFIG;
  if (value.mode !== "async" && value.mode !== "wait-all") {
    invalidConfig(source, 'orchestration.mode must be "async" or "wait-all"');
  }
  return { mode: value.mode };
}

export function loadOrchestrationConfig(configPath = getDefaultConfigPath()): OrchestrationConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent orchestration config ${configPath}: ${detail}`);
  }
  return parseOrchestrationConfig(parsed, configPath);
}
