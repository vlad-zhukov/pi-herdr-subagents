import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isThinkingLevel, THINKING_LEVELS, type ThinkingLevel } from "./runtime-routing.ts";

/** Resolve the global Pi agent directory, respecting PI_CODING_AGENT_DIR. */
export function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function getDefaultModelConfigPath(): string {
  return join(getAgentConfigDir(), "agents", "config.json");
}

export interface ModelConfig {
  default?: string;
  agents: Record<string, string>;
}

function invalidModelConfig(source: string, message: string): never {
  throw new Error(`Invalid subagent model config in ${source}: ${message}`);
}

interface ConfiguredModel {
  model: string;
  thinking?: ThinkingLevel;
}

function parseConfiguredModel(value: string, source: string, field: string): ConfiguredModel {
  const separator = value.lastIndexOf("#");
  if (separator < 0) return { model: value };

  const model = value.slice(0, separator).trim();
  const thinking = value.slice(separator + 1).trim();
  if (!model) invalidModelConfig(source, `${field} must include a model before #`);
  if (!isThinkingLevel(thinking)) {
    invalidModelConfig(
      source,
      `${field} thinking suffix must be one of: ${THINKING_LEVELS.join(", ")}`,
    );
  }
  return { model, thinking };
}

function configuredModelValue(
  agentName: string | undefined,
  config: ModelConfig,
): string | undefined {
  if (agentName && Object.hasOwn(config.agents, agentName)) return config.agents[agentName];
  return config.default;
}

export function parseModelConfig(rawConfig: unknown, source = "config.json"): ModelConfig {
  if (rawConfig == null || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    invalidModelConfig(source, "root must be an object");
  }

  const config = rawConfig as Record<string, unknown>;
  const models = config.models;
  if (models == null) return { agents: {} };
  if (typeof models !== "object" || Array.isArray(models)) {
    invalidModelConfig(source, "models must be an object");
  }

  const value = models as Record<string, unknown>;
  const allowedKeys = new Set(["default", "agents"]);
  const unsupportedKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unsupportedKeys.length > 0) {
    invalidModelConfig(source, `models has unsupported key(s): ${unsupportedKeys.join(", ")}`);
  }

  let defaultModel: string | undefined;
  if (value.default != null) {
    if (typeof value.default !== "string" || value.default.trim() === "") {
      invalidModelConfig(source, "models.default must be a non-empty string");
    }
    defaultModel = value.default.trim();
    parseConfiguredModel(defaultModel, source, "models.default");
  }

  const agents: Record<string, string> = {};
  if (value.agents != null) {
    if (typeof value.agents !== "object" || Array.isArray(value.agents)) {
      invalidModelConfig(source, "models.agents must be an object");
    }
    for (const [agent, model] of Object.entries(value.agents as Record<string, unknown>)) {
      if (typeof model !== "string" || model.trim() === "") {
        invalidModelConfig(source, `models.agents.${agent} must be a non-empty string`);
      }
      const normalized = model.trim();
      parseConfiguredModel(normalized, source, `models.agents.${agent}`);
      Object.defineProperty(agents, agent, {
        value: normalized,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  return { default: defaultModel, agents };
}

export function resolveModelDefault(
  agentName: string | undefined,
  config: ModelConfig,
): string | undefined {
  const configured = configuredModelValue(agentName, config);
  return configured ? parseConfiguredModel(configured, "config.json", "models").model : undefined;
}

export function resolveThinkingDefault(
  agentName: string | undefined,
  config: ModelConfig,
): ThinkingLevel | undefined {
  const configured = configuredModelValue(agentName, config);
  return configured ? parseConfiguredModel(configured, "config.json", "models").thinking : undefined;
}

export function loadModelConfig(configPath = getDefaultModelConfigPath()): ModelConfig {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return { agents: {} };
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent model config ${configPath}: ${detail}`);
  }
  return parseModelConfig(parsed, configPath);
}
