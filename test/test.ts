import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { MouseRegion, stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { presentationFromRecordedDetails, renderSubagentPresentation, subagentMouseRegion } from "../pi-extension/subagents/subagent-ui.ts";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import {
  cleanupSubagentsForShutdown,
  selectCompletionApi,
  shouldPreserveSubagentsOnShutdown,
  waitForCompletionOrAbort,
} from "../pi-extension/subagents/index.ts";

import {
  handlePromptError,
  restoreSubagentHandles,
  saveSubagentHandle,
  type SubagentHandle,
} from "../pi-extension/subagents/assignment-handles.ts";

import { buildPiContinuationCommand, launchPiContinuation } from "../pi-extension/subagents/harness/drivers/pi.ts";
import { createSubagentPane, runScriptInPane } from "../pi-extension/subagents/terminal.ts";
import { buildAsyncAcknowledgement, buildSubagentGuidelines, resolveSubagentName } from "../pi-extension/subagents/orchestrator-prompt.ts";

import {
  getNewEntries,
  findLastAssistantMessage,
  findObservedSessionRuntime,
  seedSubagentSessionFile,
} from "../pi-extension/subagents/session.ts";

import { isHerdrAvailable, __herdrTest__, focusHerdrPane, inspectHerdrPaneStrict, type StrictPaneInspection, type PaneFocusOutcome } from "../pi-extension/subagents/herdr.ts";
import {
  loadModelConfig,
  parseModelConfig,
  resolveModelDefault,
  resolveThinkingDefault,
} from "../pi-extension/subagents/model-config.ts";
import {
  loadOrchestrationConfig,
  parseOrchestrationConfig,
} from "../pi-extension/subagents/orchestration-config.ts";
import {
  loadStatusConfig,
  parseStatusConfig,
} from "../pi-extension/subagents/status.ts";
import {
  createSubagentActivityRecorder,
  getSubagentActivityFile,
  readSubagentActivityFile,
} from "../pi-extension/subagents/activity.ts";
import { registerChildLifecycle,
  shouldFinalizeOnAgentSettlement,
} from "../pi-extension/subagents/child-lifecycle.ts";
import {
  beginCompletionChannel,
  buildCompletionPayload,
  hasCompletionChannel,
  removeEmptyCompletionChannel,
  interpretExitSidecar,
  publishCompletion,
  waitForCompletion,
  type CompletionPayload,
} from "../pi-extension/subagents/completion.ts";
import {
  finalizeAssignment,
} from "../pi-extension/subagents/assignment-finalization.ts";
import {
  createLifecycle,
  markCompleted,
  markCompletionDetected,
  markFailed,
  markDelivery,
  observeActivity as observeLifecycleActivity,
  observePaneInspection,
  projectLifecycle,
} from "../pi-extension/subagents/lifecycle.ts";

// Tool-registration behavior is environment-sensitive for child subagents.
// Isolate the unit suite from inherited parent/child capability variables.
const inheritedSubagentId = process.env.PI_SUBAGENT_ID;
const inheritedSpawning = process.env.PI_SUBAGENT_SPAWNING;
const inheritedAgent = process.env.PI_SUBAGENT_AGENT;
const inheritedAgentFile = process.env.PI_SUBAGENT_AGENT_FILE;
before(() => {
  delete process.env.PI_SUBAGENT_ID;
  delete process.env.PI_SUBAGENT_SPAWNING;
  delete process.env.PI_SUBAGENT_AGENT;
  delete process.env.PI_SUBAGENT_AGENT_FILE;
});
after(() => {
  if (inheritedSubagentId == null) delete process.env.PI_SUBAGENT_ID;
  else process.env.PI_SUBAGENT_ID = inheritedSubagentId;
  if (inheritedSpawning == null) delete process.env.PI_SUBAGENT_SPAWNING;
  else process.env.PI_SUBAGENT_SPAWNING = inheritedSpawning;
  restoreEnvVar("PI_SUBAGENT_AGENT", inheritedAgent);
  restoreEnvVar("PI_SUBAGENT_AGENT_FILE", inheritedAgentFile);
});

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

function withTempDir(run: (dir: string) => void) {
  const dir = createTestDir();
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function createMockExtensionApi() {
  const registeredTools: Array<any> = [];
  const registeredCommands: Array<any> = [];
  const registeredMessageRenderers: Array<any> = [];
  const registeredEntryRenderers: Array<{
    name: string;
    renderer(entry: { data?: object }, options: { expanded: boolean }, theme: { fg(color: string, text: string): string }): Component | undefined;
  }> = [];
  const appendedEntries: Array<{ customType: string; data?: object }> = [];
  const eventHandlers = new Map<string, Array<Function>>();
  const sentUserMessages: string[] = [];
  const sentMessages: Array<any> = [];
  return {
    registeredTools,
    registeredCommands,
    registeredMessageRenderers,
    registeredEntryRenderers,
    appendedEntries,
    eventHandlers,
    sentUserMessages,
    sentMessages,
    api: {
      on(event: string, handler: Function) {
        const handlers = eventHandlers.get(event) ?? [];
        handlers.push(handler);
        eventHandlers.set(event, handlers);
      },
      registerTool(tool: any) {
        registeredTools.push(tool);
      },
      registerCommand(name: string, command: any) {
        registeredCommands.push({ name, ...command });
      },
      registerMessageRenderer(name: string, renderer: any) {
        registeredMessageRenderers.push({ name, renderer });
      },
      registerEntryRenderer(name: string, renderer: typeof registeredEntryRenderers[number]["renderer"]) {
        registeredEntryRenderers.push({ name, renderer });
      },
      appendEntry(customType: string, data?: object) {
        appendedEntries.push({ customType, data });
      },
      registerShortcut() {},
      sendUserMessage(message: string) {
        sentUserMessages.push(message);
      },
      sendMessage(message: any, options?: any) {
        sentMessages.push({ message, options });
      },
      getAllTools() {
        return [];
      },
      getThinkingLevel() {
        return "low";
      },
    } as any,
  };
}

function restoreEnvVar(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function writeAgentFile(
  agentsDir: string,
  name: string,
  frontmatter: string,
  body = "You are a test agent.",
) {
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}\n`);
}

async function withIsolatedAgentEnv(
  fn: (paths: {
    projectDir: string;
    projectAgentsDir: string;
    globalDir: string;
    globalAgentsDir: string;
  }) => Promise<void> | void,
) {
  const root = createTestDir();
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const projectDir = join(root, "project");
  const projectAgentsDir = join(projectDir, ".pi", "agents");
  const globalDir = join(root, "global");
  const globalAgentsDir = join(globalDir, "agents");

  mkdirSync(projectAgentsDir, { recursive: true });
  mkdirSync(globalAgentsDir, { recursive: true });
  process.chdir(projectDir);
  process.env.PI_CODING_AGENT_DIR = globalDir;

  try {
    await fn({ projectDir, projectAgentsDir, globalDir, globalAgentsDir });
  } finally {
    process.chdir(previousCwd);
    restoreEnvVar("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
}
const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};

// --- Tests ---

describe("durable subagent handles", () => {
  const handle: SubagentHandle = {
    id: "child-001",
    name: "Scout",
    sessionFile: "/tmp/child-001.jsonl",
    surface: "w1:p2",
    state: "finalized",
    subscribed: false,
    autoExit: false,
    interactive: false,
    createdAt: 1_000,
  };

  it("persists immutable handles and restores latest lifecycle state", () => {
    const saved: Array<{ customType: string; data: unknown }> = [];
    saveSubagentHandle((customType, data) => saved.push({ customType, data }), {
      ...handle,
      state: "active",
      subscribed: true,
    });
    saveSubagentHandle((customType, data) => saved.push({ customType, data }), handle);

    const restored = restoreSubagentHandles(saved.map(({ customType, data }) => ({
      type: "custom",
      customType,
      data,
    })));
    assert.deepEqual(restored.get(handle.id), handle);
    const named = { ...handle, agent: "scout", agentFile: "/original/config/agents/scout.md" };
    saveSubagentHandle((customType, data) => saved.push({ customType, data }), named);
    assert.equal(restoreSubagentHandles(saved.map(({ customType, data }) => ({
      type: "custom", customType, data,
    }))).get(handle.id)?.agentFile, named.agentFile);
  });

  it("reopens with original Pi launch settings without resolving config", () => {
    const command = buildPiContinuationCommand({
      handle: {
        ...handle,
        agent: "scout",
        agentFile: "/original/config/agents/scout.md",
        agentDir: "/agents/scout",
        cwd: "/work/scout",
        spawning: true,
        autoExit: true,
      },
      surface: "w1:p9",
      activityFile: "/artifacts/activity.json",
      messageFile: "/artifacts/message.md",
    });

    assert.match(command, /^cd '\/work\/scout' && /);
    assert.match(command, /pi --session/);
    assert.match(command, /PI_SUBAGENT_AGENT_FILE='\/original\/config\/agents\/scout.md'/);
    for (const setting of [
      "PI_CODING_AGENT_DIR='/agents/scout'",
      "PI_SUBAGENT_SPAWNING=1",
      "PI_SUBAGENT_NAME='Scout'",
      "PI_SUBAGENT_AGENT='scout'",
      "PI_SUBAGENT_AUTO_EXIT=1",
      "--session '/tmp/child-001.jsonl'",
    ]) assert.match(command, new RegExp(setting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("reopens no-agent Pi without an agent file", () => {
    const command = buildPiContinuationCommand({
      handle, surface: "pane", activityFile: "/activity.json", messageFile: "/prompt.md",
    });
    assert.match(command, /PI_SUBAGENT_AGENT_FILE=''/);
  });

  it("persists detached subscriptions without blocking continuation", () => {
    const saved: Array<{ customType: string; data: unknown }> = [];
    saveSubagentHandle((customType, data) => saved.push({ customType, data }), handle);
    const restored = restoreSubagentHandles(saved.map(({ customType, data }) => ({
      type: "custom", customType, data,
    })));
    assert.equal(restored.get(handle.id)?.subscribed, false);
    assert.equal(handlePromptError(restored.get(handle.id), false), null);
  });

  it("rejects unknown, abandoned, and locked handles without mutation", () => {
    assert.equal(handlePromptError(undefined, false), "Unknown subagent handle.");
    assert.match(handlePromptError({ ...handle, state: "abandoned" }, false)!, /abandoned/);
    assert.match(handlePromptError(handle, true)!, /busy/);
    assert.equal(handlePromptError(handle, false), null);
  });
});

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });

    it("skips empty assistant messages and returns real content above", () => {
      const realMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Real summary content." }],
        },
      };
      const emptyMsg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
        },
      };
      const entries = [realMsg, emptyMsg] as any[];
      assert.equal(findLastAssistantMessage(entries), "Real summary content.");
    });

    it("surfaces errorMessage when last assistant ended with stopReason=error and no text", () => {
      // Reproduces the overload-exhaustion case: an earlier turn looked
      // normal, then the provider went 529 and auto-retry gave up. Without
      // the errorMessage fallback we'd return the stale earlier summary and
      // the orchestrator would believe the subagent completed.
      const earlierGood = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Investigating the bug..." }],
        },
      };
      const overloadError = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "Anthropic 529 Overloaded after 3 retries",
        },
      };
      const entries = [earlierGood, overloadError] as any[];
      assert.equal(
        findLastAssistantMessage(entries),
        "Subagent error: Anthropic 529 Overloaded after 3 retries",
      );
    });

    it("prefers text content even when an error stopReason is set", () => {
      // If the model produced text before the error (rare but possible), we
      // prefer the actual content over the synthetic error fallback.
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Here is partial output." }],
          stopReason: "error",
          errorMessage: "stream interrupted",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), "Here is partial output.");
    });

    it("does not invent a summary for a stop=error message with no errorMessage", () => {
      const msg = {
        type: "message",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
        },
      };
      assert.equal(findLastAssistantMessage([msg] as any[]), null);
    });
  });

  describe("findObservedSessionRuntime", () => {
    it("extracts the latest model and thinking entries", () => {
      assert.deepEqual(
        findObservedSessionRuntime([
          { type: "model_change", id: "m1", provider: "fake", modelId: "old" },
          { type: "thinking_level_change", id: "t1", thinkingLevel: "medium" },
          { type: "model_change", id: "m2", provider: "other", modelId: "new" },
        ]),
        { provider: "other", modelId: "new", thinking: "medium" },
      );
    });
  });

  describe("seedSubagentSessionFile", () => {
    it("creates a lineage-only child session with parent linkage and no copied turns", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "lineage-child.jsonl");

      seedSubagentSessionFile({
        mode: "lineage-only",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/child-cwd",
      });

      const lines = readFileSync(childFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);

      const header = JSON.parse(lines[0]);
      assert.equal(header.type, "session");
      assert.equal(header.parentSession, parentFile);
      assert.equal(header.cwd, "/tmp/child-cwd");
    });

    it("creates a forked child session with copied context before the triggering user turn", () => {
      const parentFile = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const childFile = join(dir, "fork-child.jsonl");

      seedSubagentSessionFile({
        mode: "fork",
        parentSessionFile: parentFile,
        childSessionFile: childFile,
        childCwd: "/tmp/fork-child-cwd",
      });

      const entries = readFileSync(childFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(entries.length, 2);
      assert.equal(entries[0].type, "session");
      assert.equal(entries[0].parentSession, parentFile);
      assert.equal(entries[0].cwd, "/tmp/fork-child-cwd");
      assert.equal(entries[1].type, "model_change");
      assert.equal(entries.some((entry) => entry.type === "session" && entry.parentSession !== parentFile), false);
      assert.equal(entries.some((entry) => entry.type === "message"), false);
    });
  });


});

describe("status.ts", () => {
  it("parses strict config objects", () => {
    const disabled = parseStatusConfig({ status: { enabled: false } });

    assert.deepEqual(disabled, {
      enabled: false,
    });
  });

  it("loads a valid config file", () => {
    const examplePath = fileURLToPath(new URL("../agents/config.json", import.meta.url));
    const config = loadStatusConfig(examplePath);

    assert.deepEqual(config, {
      enabled: true,
    });
  });

  it("loads status config beside global agent definitions", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeFileSync(
        join(globalAgentsDir, "config.json"),
        JSON.stringify({ status: { enabled: false }, models: { agents: {} } }),
      );

      assert.equal(loadStatusConfig().enabled, false);
    });
  });

  it("loads the shared example when local config is absent", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      const config = loadStatusConfig(join(dir, "config.json"), examplePath);

      assert.deepEqual(config, {
        enabled: true,
        });
    });
  });

  it("fails fast for invalid config shapes", () => {
    assert.throws(
      () => parseStatusConfig({ status: { enabled: "false" } }),
      /status\.enabled must be a boolean/,
    );
    assert.throws(
      () => parseStatusConfig({ status: { enabled: true, defaultCadenceSeconds: 60 } }),
      /status has unsupported key\(s\): defaultCadenceSeconds/,
    );
  });

  it("reports when neither local nor shared config exists", () => {
    withTempDir((dir) => {
      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), join(dir, "config.json.example")),
        /Missing subagent status config\. Expected .*config\.json.*or.*config\.json\.example/,
      );
    });
  });

  it("reports invalid JSON from the shared example path", () => {
    withTempDir((dir) => {
      const examplePath = join(dir, "config.json.example");
      writeFileSync(examplePath, "{\n");

      assert.throws(
        () => loadStatusConfig(join(dir, "config.json"), examplePath),
        /Invalid JSON in subagent config .*config\.json\.example/,
      );
    });
  });

  it("fails on invalid local config instead of falling back to the shared example", () => {
    withTempDir((dir) => {
      const configPath = join(dir, "config.json");
      const examplePath = join(dir, "config.json.example");
      writeFileSync(configPath, "{\n");
      writeFileSync(
        examplePath,
        JSON.stringify({ status: { enabled: true } }, null, 2) + "\n",
      );

      assert.throws(
        () => loadStatusConfig(configPath, examplePath),
        /Invalid JSON in subagent config .*config\.json/,
      );
    });
  });

});

describe("orchestration configuration", () => {
  it("defaults to async when orchestration mode is omitted", () => {
    assert.deepEqual(parseOrchestrationConfig({}), { mode: "async" });
    assert.deepEqual(parseOrchestrationConfig({ orchestration: {} }), { mode: "async" });
  });

  it("accepts wait-all", () => {
    assert.deepEqual(
      parseOrchestrationConfig({ orchestration: { mode: "wait-all" } }),
      { mode: "wait-all" },
    );
  });

  it("describes each orchestration mode and the Orchestrator role in the guidelines", () => {
    const base = (mode: "async" | "wait-all") => buildSubagentGuidelines("<catalog/>", mode, false).join("\n");
    const child = (mode: "async" | "wait-all") => buildSubagentGuidelines("<catalog/>", mode, true).join("\n");

    assert.match(base("async"), /each result wakes you automatically/);
    assert.match(base("async"), /reasoning and decisions/);
    assert.match(base("async"), /Launch independent parts/);
    assert.doesNotMatch(base("async"), /return together/);
    assert.match(base("wait-all"), /return together/);
    assert.doesNotMatch(base("wait-all"), /wakes you/);

    for (const mode of ["async", "wait-all"] as const) {
      assert.match(child(mode), /decide exactly what result you need/);
      assert.match(child(mode), /belongs to its subagent/);
      assert.match(child(mode), /<catalog\/>/);
      assert.doesNotMatch(child(mode), /reasoning and decisions|Launch independent parts/);
    }
  });

  it("async acknowledgement restates ownership", () => {
    const text = buildAsyncAcknowledgement("scout");
    assert.match(text, /^"scout" owns this task now\./);
    assert.match(text, /Do not work on it yourself/);
    assert.match(text, /wake you automatically/);
  });

  it("resolves the display name: name, then agent, then fork", () => {
    assert.equal(resolveSubagentName("Label", "scout"), "Label");
    assert.equal(resolveSubagentName("  ", "scout"), "scout");
    assert.equal(resolveSubagentName(undefined, " scout "), "scout");
    assert.equal(resolveSubagentName(undefined, undefined), "fork");
    assert.equal(resolveSubagentName("", ""), "fork");
    assert.equal(resolveSubagentName(42, null), "fork");
  });

  it("rejects invalid orchestration configuration", () => {
    assert.throws(
      () => parseOrchestrationConfig({ orchestration: { mode: "fan-in" } }),
      /orchestration\.mode must be "async" or "wait-all"/,
    );
    assert.throws(
      () => parseOrchestrationConfig({ orchestration: { mode: "async", extra: true } }),
      /orchestration has unsupported key\(s\): extra/,
    );
  });

  it("loads orchestration mode beside global agent definitions", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeFileSync(
        join(globalAgentsDir, "config.json"),
        JSON.stringify({ orchestration: { mode: "wait-all" } }),
      );
      assert.deepEqual(loadOrchestrationConfig(), { mode: "wait-all" });
    });
  });
});

describe("model configuration", () => {
  it("parses global and per-agent model defaults", () => {
    assert.deepEqual(
      parseModelConfig({
        models: {
          default: " anthropic/claude-sonnet-4-6 ",
          agents: { scout: " openai/gpt-5-mini " },
        },
      }),
      {
        default: "anthropic/claude-sonnet-4-6",
        agents: { scout: "openai/gpt-5-mini" },
      },
    );
  });

  it("supports thinking suffixes in configured model values", () => {
    const config = parseModelConfig({
      models: {
        default: "openai-codex/gpt-5.6-line#high",
        agents: { scout: "openai-codex/gpt-5.6-line#xhigh" },
      },
    });

    assert.equal(
      resolveModelDefault("scout", config),
      "openai-codex/gpt-5.6-line",
    );
    assert.equal(resolveThinkingDefault("scout", config), "xhigh");
    assert.equal(resolveThinkingDefault("reviewer", config), "high");
    assert.equal(resolveThinkingDefault("unconfigured", config), "high");
    assert.equal(resolveThinkingDefault("reviewer", parseModelConfig({ models: { default: "fake/model" } })), undefined);
  });

  it("rejects invalid thinking suffixes", () => {
    assert.throws(
      () => parseModelConfig({ models: { default: "fake/model#turbo" } }),
      /thinking suffix must be one of/,
    );
  });

  it("loads no model overrides when config.json is absent", () => {
    const config = loadModelConfig(join(createTestDir(), "missing-config.json"));
    assert.deepEqual(config, { agents: {} });
  });

  it("loads model config beside global agent definitions", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeFileSync(
        join(globalAgentsDir, "config.json"),
        JSON.stringify({
          models: {
            default: "fake/global",
            agents: { scout: "fake/scout" },
          },
        }),
      );

      assert.deepEqual(loadModelConfig(), {
        default: "fake/global",
        agents: { scout: "fake/scout" },
      });
    });
  });

  it("resolves per-agent, global, and parent fallback precedence", () => {
    const config = parseModelConfig({
      models: {
        default: "fake/global",
        agents: { scout: "fake/scout" },
      },
    });

    assert.equal(resolveModelDefault("scout", config), "fake/scout");
    assert.equal(resolveModelDefault("reviewer", config), "fake/global");
    assert.equal(resolveModelDefault(undefined, { agents: {} }), undefined);
    assert.equal(resolveThinkingDefault("reviewer", config), undefined);
  });

  it("does not read inherited object properties as agent model defaults", () => {
    const config = parseModelConfig({ models: { agents: {} } });
    for (const agent of ["constructor", "toString", "__proto__"]) {
      assert.equal(resolveModelDefault(agent, config), undefined);
    }
  });

  it("supports reserved property names when explicitly configured", () => {
    const config = parseModelConfig(
      JSON.parse(
        '{"models":{"agents":{"constructor":"fake/constructor","__proto__":"fake/proto"}}}',
      ),
    );
    assert.equal(resolveModelDefault("constructor", config), "fake/constructor");
    assert.equal(resolveModelDefault("__proto__", config), "fake/proto");
  });

  it("rejects invalid model configuration", () => {
    assert.throws(() => parseModelConfig({ models: { default: "" } }), /non-empty string/);
    assert.throws(() => parseModelConfig({ models: { agents: [] } }), /must be an object/);
  });
});

describe("subagent discovery", () => {
  const testApi = (subagentsModule as any).__test__;

  it("ignores project-local agents", async () => {
    await withIsolatedAgentEnv(async ({ projectAgentsDir }) => {
      writeAgentFile(projectAgentsDir, "ignored-agent", "name: ignored-agent");
      assert.equal(testApi.loadAgentDefaults("ignored-agent"), null);
    });
  });

  it("ignores removed runtime frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "removed-runtime-frontmatter-test-agent",
        [
          "name: removed-runtime-frontmatter-test-agent",
          "model: fake/frontmatter",
          "thinking: max",
          "system-prompt: replace",
          "tools: read",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("removed-runtime-frontmatter-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.model, undefined);
      assert.equal(loaded.thinking, undefined);
      assert.equal(Object.hasOwn(loaded, "systemPromptMode"), false);
      assert.equal(loaded.tools, "read");
    });
  });

  it("loads session-mode from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "lineage-mode-test-agent",
        [
          "name: lineage-mode-test-agent",
          "session-mode: lineage-only",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("lineage-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, "lineage-only");
    });
  });

  it("ignores removed deny-tools frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "removed-deny-tools-test-agent",
        [
          "name: removed-deny-tools-test-agent",
          "spawning: true",
          "deny-tools: subagent",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("removed-deny-tools-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal((loaded as any).denyTools, undefined);
      assert.equal(testApi.resolveSpawning(loaded), true);
    });
  });

  it("loads explicit interactive flag from frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "interactive-true-test-agent",
        [
          "name: interactive-true-test-agent",
          "interactive: true",
        ].join("\n"),
      );
      writeAgentFile(
        globalAgentsDir,
        "interactive-false-test-agent",
        [
          "name: interactive-false-test-agent",
          "interactive: false",
        ].join("\n"),
      );

      const loadedTrue = testApi.loadAgentDefaults("interactive-true-test-agent");
      assert.equal(loadedTrue?.interactive, true);

      const loadedFalse = testApi.loadAgentDefaults("interactive-false-test-agent");
      assert.equal(loadedFalse?.interactive, false);
    });
  });

  it("leaves interactive undefined when not set in frontmatter", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "interactive-unset-test-agent",
        [
          "name: interactive-unset-test-agent",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("interactive-unset-test-agent");
      assert.equal(loaded?.interactive, undefined);
    });
  });

  it("resolves auto-exit and interactive behavior for named and bare spawns", () => {
    // Autonomous named agents are not interactive, so the parent gets status pings.
    assert.equal(
      testApi.resolveEffectiveAutoExit({ name: "A", task: "T" }, { autoExit: true }),
      true,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { autoExit: true }),
      false,
    );

    // Missing settings are independently false for named and bare spawns.
    assert.equal(testApi.resolveEffectiveAutoExit({ name: "A", task: "T" }, { }), false);
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { }), false);
    assert.equal(testApi.resolveEffectiveAutoExit({ name: "A", task: "T", fork: true }, null), false);
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T", fork: true }, null), false);

    // Explicit interactive remains independent from auto-exit.
    assert.equal(testApi.resolveEffectiveAutoExit({ name: "A", task: "T", interactive: true }, null), false);
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T", interactive: true }, null), true);
  });

  it("resolveEffectiveInteractive honors explicit frontmatter", () => {
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { interactive: true }), true);
    assert.equal(testApi.resolveEffectiveInteractive({ name: "A", task: "T" }, { interactive: false }), false);
  });

  it("resolveEffectiveInteractive honors the explicit tool parameter over all else", () => {
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: false },
        { autoExit: false, interactive: true },
      ),
      false,
    );
    assert.equal(
      testApi.resolveEffectiveInteractive(
        { name: "A", task: "T", interactive: true },
        { autoExit: true, interactive: false },
      ),
      true,
    );
  });

  it("ignores invalid session-mode values", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "invalid-mode-test-agent",
        [
          "name: invalid-mode-test-agent",
          "session-mode: sideways",
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("invalid-mode-test-agent");
      assert.ok(loaded, "expected agent to load");
      assert.equal(loaded.sessionMode, undefined);
    });
  });

  it("defaults missing session mode to lineage-only", () => {
    assert.equal(testApi.resolveEffectiveSessionMode({ name: "A", task: "T" }, null), "lineage-only");
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T" },
        { sessionMode: "standalone" },
      ),
      "standalone",
    );
  });

  it("resolves session mode with fork override precedence", () => {
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T" },
        { sessionMode: "lineage-only" },
      ),
      "lineage-only",
    );
    assert.equal(
      testApi.resolveEffectiveSessionMode(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      "fork",
    );
  });

  it("resolves launch behavior for standalone, lineage-only, and fork modes", () => {
    assert.deepEqual(testApi.resolveLaunchBehavior({ name: "A", task: "T" }, null), {
      sessionMode: "lineage-only",
      seededSessionMode: "lineage-only",
      inheritsConversationContext: false,
      taskDelivery: "artifact",
    });
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T" },
        { sessionMode: "standalone" },
      ),
      {
        sessionMode: "standalone",
        seededSessionMode: null,
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "lineage-only" }),
      {
        sessionMode: "lineage-only",
        seededSessionMode: "lineage-only",
        inheritsConversationContext: false,
        taskDelivery: "artifact",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior({ name: "A", task: "T" }, { sessionMode: "fork" }),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
    assert.deepEqual(
      testApi.resolveLaunchBehavior(
        { name: "A", task: "T", fork: true },
        { sessionMode: "lineage-only" },
      ),
      {
        sessionMode: "fork",
        seededSessionMode: "fork",
        inheritsConversationContext: true,
        taskDelivery: "direct",
      },
    );
  });

  it("buildSubagentToolAllowlist preserves requested tools and adds child control tools", () => {
    assert.equal(
      testApi.buildSubagentToolAllowlist("read,bash,web_search"),
      "read,bash,web_search,subagent_ask",
    );
  });

  it("buildSubagentToolAllowlist returns null without an explicit tool restriction", () => {
    assert.equal(testApi.buildSubagentToolAllowlist(undefined), null);
    assert.equal(testApi.buildSubagentToolAllowlist(""), null);
  });

  it("buildPiPromptArgs inserts separator for artifact-backed launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review,lint", taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["", "/skill:review", "/skill:lint", "@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for artifact-backed launches without skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: undefined, taskDelivery: "artifact", taskArg: "@artifact.md" }),
      ["@artifact.md"],
    );
  });

  it("buildPiPromptArgs omits separator for direct launches with skills", () => {
    assert.deepEqual(
      testApi.buildPiPromptArgs({ effectiveSkills: "review", taskDelivery: "direct", taskArg: "do the task" }),
      ["/skill:review", "do the task"],
    );
  });

  it("keeps disable-model-invocation agents directly loadable", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "hidden-discovery-test-agent",
        [
          "name: hidden-discovery-test-agent",
          "description: Hidden test agent",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden agent.",
      );

      const loaded = testApi.loadAgentDefaults("hidden-discovery-test-agent");
      assert.ok(loaded, "expected hidden agent to remain directly loadable");
      assert.equal(loaded.model, undefined);
      assert.equal(loaded.thinking, undefined);
      assert.equal(loaded.body, "You are the hidden agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("keeps hidden global agents directly loadable", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "shadowed-discovery-test-agent",
        [
          "name: shadowed-discovery-test-agent",
          "description: Hidden global agent",
          "disable-model-invocation: true",
        ].join("\n"),
        "You are the hidden global agent.",
      );

      const loaded = testApi.loadAgentDefaults("shadowed-discovery-test-agent");
      assert.ok(loaded, "expected hidden global agent to remain directly loadable");
      assert.equal(loaded.model, undefined);
      assert.equal(loaded.thinking, undefined);
      assert.equal(loaded.body, "You are the hidden global agent.");
      assert.equal(loaded.disableModelInvocation, true);
    });
  });

  it("resolves loadAgentDefaults by the frontmatter name the catalog advertises, not the filename", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "renamed-file-test-agent",
        [
          "name: aliased-test-agent",
          "description: Frontmatter name differs from filename",
        ].join("\n"),
        "You are the aliased agent.",
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const guidance = registeredTools.find((tool) => tool.name === "subagent").promptGuidelines.join("\n");
      assert.match(guidance, /<agent name="aliased-test-agent">/, "catalog should advertise the frontmatter name");

      const loadedByFrontmatterName = testApi.loadAgentDefaults("aliased-test-agent");
      assert.ok(
        loadedByFrontmatterName,
        "loadAgentDefaults must resolve the same name the catalog advertises",
      );
      assert.equal(loadedByFrontmatterName.model, undefined);
      assert.equal(loadedByFrontmatterName.thinking, undefined);
      assert.equal(loadedByFrontmatterName.file, join(globalAgentsDir, "renamed-file-test-agent.md"));

      const loadedByFilename = testApi.loadAgentDefaults("renamed-file-test-agent");
      assert.equal(
        loadedByFilename,
        null,
        "the filename alone should not resolve once frontmatter overrides the name",
      );
    });
  });

  it("discoverAgentDefinitions skips an unreadable entry instead of aborting discovery", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "readable-sibling-test-agent",
        ["name: readable-sibling-test-agent", "description: Should still be discovered"].join("\n"),
      );
      // A directory ending in .md passes the file filter but throws EISDIR on
      // read — previously this aborted discoverAgentDefinitions() entirely.
      mkdirSync(join(globalAgentsDir, "broken-entry-test-agent.md"));

      const agents = testApi.discoverAgentDefinitions();
      assert.ok(
        agents.some((agent: any) => agent.name === "readable-sibling-test-agent"),
        "a broken sibling entry should not prevent discovery of valid agents",
      );
    });
  });

  it("strips surrounding quotes from a quoted command: frontmatter value", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "quoted-command-test-agent",
        [
          "name: quoted-command-test-agent",
          `command: "aider --model {model} --message {task}"`,
        ].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("quoted-command-test-agent");
      assert.equal(loaded?.commandTemplate, "aider --model {model} --message {task}");
    });
  });

  it("leaves an unquoted command: frontmatter value untouched", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "unquoted-command-test-agent",
        ["name: unquoted-command-test-agent", "command: aider --model {model} --message {task}"].join("\n"),
      );

      const loaded = testApi.loadAgentDefaults("unquoted-command-test-agent");
      assert.equal(loaded?.commandTemplate, "aider --model {model} --message {task}");
    });
  });
});
describe("child assignment lifecycle", () => {
  it("appends identity after the existing system append on each fresh Pi turn", () => {
    withTempDir((dir) => {
      const savedFile = process.env.PI_SUBAGENT_AGENT_FILE;
      const savedAgent = process.env.PI_SUBAGENT_AGENT;
      const agentFile = join(dir, "scout.md");
      writeFileSync(agentFile, "---\nname: scout\n---\nYou are Scout.");
      process.env.PI_SUBAGENT_AGENT_FILE = agentFile;
      process.env.PI_SUBAGENT_AGENT = "scout";
      try {
        const { api, eventHandlers } = createMockExtensionApi();
        registerChildLifecycle(api);
        const hook = eventHandlers.get("before_agent_start")![0];
        for (let i = 0; i < 2; i++) {
          const event = { systemPromptOptions: { appendSystemPrompt: "Existing APPEND_SYSTEM.md" } };
          hook(event, { shutdown: () => assert.fail("unexpected shutdown") });
          assert.equal(event.systemPromptOptions.appendSystemPrompt, "Existing APPEND_SYSTEM.md\n\nYou are Scout.");
        }
        const duplicate = { systemPromptOptions: { appendSystemPrompt: "Existing APPEND_SYSTEM.md" } };
        const other = createMockExtensionApi();
        registerChildLifecycle(other.api);
        hook(duplicate, {});
        other.eventHandlers.get("before_agent_start")![0](duplicate, {});
        assert.equal(duplicate.systemPromptOptions.appendSystemPrompt, "Existing APPEND_SYSTEM.md\n\nYou are Scout.");
        writeFileSync(agentFile, "---\nname: scout\n---\n \t \n");
        const bodyless = createMockExtensionApi();
        registerChildLifecycle(bodyless.api);
        const unchanged = { systemPromptOptions: { appendSystemPrompt: "Existing APPEND_SYSTEM.md" } };
        bodyless.eventHandlers.get("before_agent_start")![0](unchanged, {});
        assert.equal(unchanged.systemPromptOptions.appendSystemPrompt, "Existing APPEND_SYSTEM.md");
      } finally {
        restoreEnvVar("PI_SUBAGENT_AGENT_FILE", savedFile);
        restoreEnvVar("PI_SUBAGENT_AGENT", savedAgent);
      }
    });
  });

  it("reads current definition at each startup despite child cwd and config differences", () => {
    withTempDir((dir) => {
      const saved = { agent: process.env.PI_SUBAGENT_AGENT, file: process.env.PI_SUBAGENT_AGENT_FILE };
      const file = join(dir, "scout.md");
      writeFileSync(file, "---\nname: scout\n---\nOriginal identity.");
      process.env.PI_SUBAGENT_AGENT = "scout";
      process.env.PI_SUBAGENT_AGENT_FILE = file;
      try {
        const first = createMockExtensionApi();
        registerChildLifecycle(first.api);
        const old = { systemPromptOptions: { appendSystemPrompt: "Existing append\n\nOriginal identity." } };
        first.eventHandlers.get("before_agent_start")![0](old, {});
        assert.equal(old.systemPromptOptions.appendSystemPrompt, "Existing append\n\nOriginal identity.");
        writeFileSync(file, "---\nname: scout\n---\nChanged identity.");
        const reopened = createMockExtensionApi();
        registerChildLifecycle(reopened.api);
        const next = { systemPromptOptions: { appendSystemPrompt: "Existing append" } };
        reopened.eventHandlers.get("before_agent_start")![0](next, {});
        assert.equal(next.systemPromptOptions.appendSystemPrompt, "Existing append\n\nChanged identity.");
        const script = `import { registerChildLifecycle } from ${JSON.stringify(new URL("../pi-extension/subagents/child-lifecycle.ts", import.meta.url).href)};\n` +
          `let hook; registerChildLifecycle({ on(name, fn) { if (name === 'before_agent_start') hook = fn; }, registerTool() {}, registerCommand() {}, registerShortcut() {} });\n` +
          `const event = { systemPromptOptions: { appendSystemPrompt: 'APPEND_SYSTEM.md' } }; await hook(event, {}); console.log(event.systemPromptOptions.appendSystemPrompt);`;
        const childCwd = join(dir, "unrelated");
        mkdirSync(childCwd);
        const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
          cwd: childCwd, env: { ...process.env, PI_CODING_AGENT_DIR: childCwd }, encoding: "utf8",
        });
        assert.equal(child.status, 0, child.stderr);
        assert.match(child.stdout, /APPEND_SYSTEM\.md\n\nChanged identity\./);
      } finally {
        restoreEnvVar("PI_SUBAGENT_AGENT", saved.agent);
        restoreEnvVar("PI_SUBAGENT_AGENT_FILE", saved.file);
      }
    });
  });

  it("registers lifecycle before a bad identity, then exits without starting a model turn", () => {
    withTempDir((dir) => {
      const extension = fileURLToPath(new URL("../pi-extension/subagents/index.ts", import.meta.url));
      const baseEnv = { ...process.env, PI_CODING_AGENT_DIR: dir, PI_SUBAGENT_AGENT: "scout", PI_SUBAGENT_ID: "bad-identity", PI_SUBAGENT_SESSION: join(dir, "child.jsonl") };
      const run = (agentFile?: string) => {
        const env = { ...baseEnv };
        beginCompletionChannel(baseEnv.PI_SUBAGENT_SESSION);
        if (agentFile === undefined) delete env.PI_SUBAGENT_AGENT_FILE;
        else env.PI_SUBAGENT_AGENT_FILE = agentFile;
        return spawnSync("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension], {
          env, cwd: dir, input: '{"id":"prompt","type":"prompt","message":"Must not call provider"}\n',
          encoding: "utf8", timeout: 15000,
        });
      };
      const missing = run(join(dir, "missing.md"));
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /Subagent identity error:.*ENOENT/);
      assert.equal(JSON.parse(readFileSync(`${baseEnv.PI_SUBAGENT_SESSION}.exit`, "utf8")).reason, "error");
      assert.doesNotMatch(missing.stdout, /agent_start|message_start/);
      writeFileSync(join(dir, "empty.md"), "  ");
      assert.match(run(join(dir, "empty.md")).stderr, /no YAML frontmatter/);
      assert.match(run(dir).stderr, /Subagent identity error:.*EISDIR/);
      assert.match(run().stderr, /Subagent scout has no agent file path/);
      assert.match(run("scout.md").stderr, /agent file path must be absolute/);
      const frontmatter = join(dir, "frontmatter.md");
      writeFileSync(frontmatter, "---\nname: scout\n---\n");
      const frontmatterOnly = run(frontmatter);
      assert.equal(frontmatterOnly.status, 0, frontmatterOnly.stderr);
      assert.match(frontmatterOnly.stdout, /"command":"prompt"/);
      writeFileSync(frontmatter, "---\nname: scout\n---\n  \t  \n");
      assert.equal(run(frontmatter).status, 0);
      const noAgent = spawnSync("pi", ["--mode", "rpc", "--no-session", "--no-extensions", "-e", extension], {
        env: { ...baseEnv, PI_SUBAGENT_AGENT: "", PI_SUBAGENT_AGENT_FILE: "" }, cwd: dir,
        input: '{"id":"prompt","type":"prompt","message":"No role"}\n', encoding: "utf8", timeout: 15000,
      });
      assert.equal(noAgent.status, 0, noAgent.stderr);

      const body = join(dir, "valid.md");
      writeFileSync(body, "---\nname: scout\n---\nYou are Scout.");
      const script = `import { registerChildLifecycle } from ${JSON.stringify(new URL("../pi-extension/subagents/child-lifecycle.ts", import.meta.url).href)};\n` +
        `let hook; registerChildLifecycle({ on(name, fn) { if (name === 'before_agent_start') hook = fn; }, registerTool() {}, registerCommand() {}, registerShortcut() {} });\n` +
        `hook({ systemPromptOptions: {} }, { shutdown() {}, abort() {} }); console.log('unexpected provider');`;
      const absentApi = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...baseEnv, PI_SUBAGENT_AGENT_FILE: body }, cwd: dir, encoding: "utf8", timeout: 15000,
      });
      assert.equal(absentApi.status, 1);
      assert.match(absentApi.stderr, /systemPromptOptions\.appendSystemPrompt is required/);
      assert.doesNotMatch(absentApi.stdout, /unexpected provider/);

      const tuiScript = `import { registerChildLifecycle } from ${JSON.stringify(new URL("../pi-extension/subagents/child-lifecycle.ts", import.meta.url).href)};\n` +
        `let hook; registerChildLifecycle({ on(name, fn) { if (name === 'before_agent_start') hook = fn; }, registerTool() {}, registerCommand() {}, registerShortcut() {} });\n` +
        `process.exit = (code) => { console.log('exit:' + code); throw Error('intercepted'); };\n` +
        `hook({ systemPromptOptions: {} }, { mode: 'tui', shutdown() { console.log('shutdown'); }, abort() {}, ui: { custom(factory) { return factory({ stop() { console.log('stopped'); } }); } } }).catch(() => {});`;
      const tuiFailure = spawnSync(process.execPath, ["--input-type=module", "-e", tuiScript], {
        env: { ...baseEnv, PI_SUBAGENT_AGENT_FILE: body }, cwd: dir, encoding: "utf8", timeout: 15000,
      });
      assert.equal(tuiFailure.status, 0, tuiFailure.stderr);
      assert.match(tuiFailure.stdout, /shutdown\n(?:.*\n)*stopped\nexit:1/);
    });
  });

  it("lets Pi restore the TUI before exiting and blocks a pending startup turn", async () => {
    const saved = { file: process.env.PI_SUBAGENT_AGENT_FILE, session: process.env.PI_SUBAGENT_SESSION };
    process.env.PI_SUBAGENT_AGENT_FILE = "/not-present/subagent-agent.md";
    process.env.PI_SUBAGENT_SESSION = "/not-present/subagent-session.jsonl";
    try {
      const { api, eventHandlers } = createMockExtensionApi();
      registerChildLifecycle(api);
      let terminalRestored = false;
      const startup = eventHandlers.get("session_start")![0]({}, {
        mode: "tui",
        shutdown: () => { terminalRestored = true; },
        abort: () => assert.fail("TUI shutdown should not use the noninteractive abort path"),
      });
      assert.equal(terminalRestored, true);
      assert.equal(await Promise.race([startup.then(() => "returned"), Promise.resolve("blocked")]), "blocked");
    } finally {
      restoreEnvVar("PI_SUBAGENT_AGENT_FILE", saved.file);
      restoreEnvVar("PI_SUBAGENT_SESSION", saved.session);
    }
  });

  it("finalizes a noninteractive settled child while default auto-exit retains Pi", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "child.jsonl");
      const previous = {
        interactive: process.env.PI_SUBAGENT_INTERACTIVE,
        autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
        session: process.env.PI_SUBAGENT_SESSION,
      };
      delete process.env.PI_SUBAGENT_INTERACTIVE;
      delete process.env.PI_SUBAGENT_AUTO_EXIT;
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      try {
        beginCompletionChannel(sessionFile);
        const { api, eventHandlers } = createMockExtensionApi();
        registerChildLifecycle(api);
        const agentEnd = eventHandlers.get("agent_end")![0];
        const agentSettled = eventHandlers.get("agent_settled")![0];
        let shutdowns = 0;
        const ctx = { shutdown: () => { shutdowns += 1; } };
        agentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
        agentSettled({}, ctx);
        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { reason: "done", exitCode: 0 });
        assert.equal(shutdowns, 0);
      } finally {
        restoreEnvVar("PI_SUBAGENT_INTERACTIVE", previous.interactive);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previous.autoExit);
        restoreEnvVar("PI_SUBAGENT_SESSION", previous.session);
      }
    });
  });

  it("keeps an interactive child live until /subagent_finalize waits for idle", async () => {
    const dir = createTestDir();
    try {
      const sessionFile = join(dir, "child.jsonl");
      const previousInteractive = process.env.PI_SUBAGENT_INTERACTIVE;
      const previousAutoExit = process.env.PI_SUBAGENT_AUTO_EXIT;
      const previousSession = process.env.PI_SUBAGENT_SESSION;
      process.env.PI_SUBAGENT_INTERACTIVE = "1";
      process.env.PI_SUBAGENT_AUTO_EXIT = "1";
      process.env.PI_SUBAGENT_SESSION = sessionFile;
      try {
        beginCompletionChannel(sessionFile);
        const { api, eventHandlers, registeredCommands } = createMockExtensionApi();
        registerChildLifecycle(api);
        let waited = 0;
        let shutdowns = 0;
        const ctx = { shutdown: () => { shutdowns += 1; }, waitForIdle: async () => { waited += 1; } };
        eventHandlers.get("agent_end")![0]({ messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
        eventHandlers.get("agent_settled")![0]({}, ctx);
        assert.equal(hasCompletionChannel(sessionFile), true);
        assert.equal(shutdowns, 0);
        const finalize = registeredCommands.find((command) => command.name === "subagent_finalize");
        assert.ok(finalize);
        await finalize.handler("", ctx);
        assert.equal(waited, 1);
        assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), { reason: "done", exitCode: 0 });
        assert.equal(shutdowns, 1);
      } finally {
        restoreEnvVar("PI_SUBAGENT_INTERACTIVE", previousInteractive);
        restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
        restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("subagent_ask keeps child live and suppresses automatic finalization", async () => {
    const dir = createTestDir();
    const sessionFile = join(dir, "child.jsonl");
    const previousSession = process.env.PI_SUBAGENT_SESSION;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    try {
      beginCompletionChannel(sessionFile);
      const { api, eventHandlers, registeredTools } = createMockExtensionApi();
      registerChildLifecycle(api);
      const ask = registeredTools.find((tool) => tool.name === "subagent_ask");
      assert.ok(ask);
      assert.match(ask.promptGuidelines.join("\n"), /Do not end a task with an unresolved question/);
      const result = await ask.execute("ask-1", { question: "Use v1 or v2?" });
      assert.equal(result.terminate, true);
      assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
        reason: "ask", exitCode: 0, ask: { question: "Use v1 or v2?" },
      });
      eventHandlers.get("agent_end")![0]({ messages: [{ role: "assistant", stopReason: "stop" }] }, {});
      eventHandlers.get("agent_settled")![0]({}, { shutdown() {} });
      assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
        reason: "ask", exitCode: 0, ask: { question: "Use v1 or v2?" },
      });
      eventHandlers.get("input")![0]({}, {});
      eventHandlers.get("agent_end")![0]({ messages: [{ role: "assistant", stopReason: "stop" }] }, {});
      eventHandlers.get("agent_settled")![0]({}, { shutdown() {} });
      assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
        reason: "ask", exitCode: 0, ask: { question: "Use v1 or v2?" },
      });
    } finally {
      restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps local asks private after finalization and resubscribes on parent prompt", async () => {
    const dir = createTestDir();
    const sessionFile = join(dir, "child.jsonl");
    const previousSession = process.env.PI_SUBAGENT_SESSION;
    process.env.PI_SUBAGENT_SESSION = sessionFile;
    try {
      beginCompletionChannel(sessionFile);
      const { api, eventHandlers, registeredTools } = createMockExtensionApi();
      registerChildLifecycle(api);
      const ask = registeredTools.find((tool) => tool.name === "subagent_ask");
      const agentEnd = eventHandlers.get("agent_end")![0];
      const agentSettled = eventHandlers.get("agent_settled")![0];
      agentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }, {});
      agentSettled({}, { shutdown() {} });
      rmSync(`${sessionFile}.exit`);

      const local = await ask.execute("local", { question: "Try another path?" });
      assert.equal(local.content[0].text, "Waiting for a local reply.");
      assert.equal(existsSync(`${sessionFile}.exit`), false);

      beginCompletionChannel(sessionFile);
      eventHandlers.get("input")![0]({}, {});
      const parent = await ask.execute("parent", { question: "Need a decision?" });
      assert.equal(parent.content[0].text, "Question sent. Waiting for a reply.");
      assert.deepEqual(JSON.parse(readFileSync(`${sessionFile}.exit`, "utf8")), {
        reason: "ask", exitCode: 0, ask: { question: "Need a decision?" },
      });
    } finally {
      restoreEnvVar("PI_SUBAGENT_SESSION", previousSession);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finalizes awaiting-answer state and reports errors", () => {
    assert.equal(shouldFinalizeOnAgentSettlement([{ role: "assistant", stopReason: "aborted" }]), false);
    assert.equal(shouldFinalizeOnAgentSettlement([{ role: "assistant", stopReason: "error" }]), true);
    assert.deepEqual(buildCompletionPayload(undefined), { reason: "done", exitCode: 0 });
    assert.deepEqual(buildCompletionPayload([{ role: "assistant", stopReason: "error", errorMessage: "provider failed" }]), {
      reason: "error", exitCode: 1, errorMessage: "provider failed",
    });
  });

  it("registers /subagent_finalize only when index loads in child mode", () => {
    const previousId = process.env.PI_SUBAGENT_ID;
    try {
      process.env.PI_SUBAGENT_ID = "child-test";
      const child = createMockExtensionApi();
      (subagentsModule as any).default(child.api);
      assert.ok(child.registeredCommands.some((command) => command.name === "subagent_finalize"));
    } finally {
      restoreEnvVar("PI_SUBAGENT_ID", previousId);
    }
    const parent = createMockExtensionApi();
    (subagentsModule as any).default(parent.api);
    assert.equal(parent.registeredCommands.some((command) => command.name === "subagent_finalize"), false);
  });


});

describe("lifecycle.ts", () => {
  const activity = (overrides: Record<string, unknown> = {}) => ({
    version: 1 as const,
    runningChildId: "child",
    createdAt: 1_000,
    updatedAt: 2_000,
    sequence: 1,
    latestEvent: "agent_start" as const,
    phase: "active" as const,
    agentActive: true,
    turnActive: true,
    providerActive: false,
    toolActive: false,
    activeScope: "agent" as const,
    activeSince: 2_000,
    ...overrides,
  });

  it("makes finalizing and terminal process states irreversible", () => {
    const running = observeLifecycleActivity(createLifecycle(1_000), { ok: true, activity: activity() }, 2_000);
    const finalizing = markCompletionDetected(running, { reason: "done", exitCode: 0 }, 4_000);
    const ignored = observeLifecycleActivity(finalizing, {
      ok: true,
      activity: activity({ updatedAt: 5_000, sequence: 9 }),
    }, 5_000);
    assert.equal(ignored.process.kind, "finalizing");
    assert.deepEqual(projectLifecycle(ignored, 9_000), { kind: "finalizing", runtimeEndedAt: 4_000 });
    const completed = markCompleted(ignored, 6_000);
    assert.equal(markFailed(completed, "late failure", 7_000).process.kind, "completed");
  });

  it("projects confirmed running without turn detail as running, not starting", () => {
    const started = createLifecycle(1_000);
    const running = {
      ...started,
      process: { kind: "running" as const, startedAt: 1_000, confirmedAt: 1_500 },
    };
    assert.deepEqual(projectLifecycle(running, 3_000), { kind: "running" });
  });

  it("does not interpret initial idle as completion", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "idle" }, 2_000);
    assert.equal(projectLifecycle(lifecycle, 3_000).kind, "starting");
    assert.equal(lifecycle.turn.kind, "starting");
  });

  it("treats working then idle as waiting", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    assert.equal(projectLifecycle(lifecycle, 2_500).kind, "active");
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "idle" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
  });

  it("preserves state entry time across repeated herdr observations", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "working" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 4_000).stateDurationSince, 2_000);

    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 5_000, agentStatus: "blocked" }, 5_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 6_000, agentStatus: "blocked" }, 6_000);
    assert.equal(projectLifecycle(lifecycle, 7_000).stateDurationSince, 5_000);

    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 8_000, agentStatus: "idle" }, 8_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 9_000, agentStatus: "done" }, 9_000);
    assert.equal(projectLifecycle(lifecycle, 10_000).stateDurationSince, 8_000);
  });

  it("does not enter finalizing from herdr idle/done", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "done" }, 3_000);
    assert.equal(lifecycle.process.kind, "running");
    assert.notEqual(projectLifecycle(lifecycle, 4_000).kind, "finalizing");
  });

  it("projects blocked when herdr reports blocked", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "blocked" }, 2_000);
    assert.equal(projectLifecycle(lifecycle, 3_000).kind, "blocked");
  });

  it("treats missing pane as pane observation but not immediate failure", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "missing", error: "pane_not_found" }, 3_000);
    assert.equal(lifecycle.pane.kind, "missing");
    assert.equal(lifecycle.process.kind, "running");
  });

  it("preserves hasWorked across unavailable observations", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "unavailable", error: "socket" }, 2_500);
    lifecycle = observePaneInspection(lifecycle, { kind: "unavailable", error: "socket" }, 2_600);
    assert.equal(lifecycle.pane.kind, "read-error");
    assert.equal(lifecycle.pane.kind === "read-error" ? lifecycle.pane.consecutiveFailures : 0, 2);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "idle" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
  });

  it("does not let missing activity detail stall healthy herdr working", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observeLifecycleActivity(lifecycle, { ok: false, reason: "missing" }, 3_000);
    assert.equal(projectLifecycle(lifecycle, 120_000).kind, "active");
  });

  it("uses activity only as detail and does not override herdr waiting", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 3_000, agentStatus: "idle" }, 3_000);
    lifecycle = observeLifecycleActivity(lifecycle, { ok: true, activity: activity({ updatedAt: 3_100, sequence: 2 }) }, 3_100);
    assert.equal(projectLifecycle(lifecycle, 4_000).kind, "waiting");
  });

  it("preserves activity detail duration across repeated updates", () => {
    let lifecycle = createLifecycle(1_000);
    lifecycle = observePaneInspection(lifecycle, { kind: "present", observedAt: 2_000, agentStatus: "working" }, 2_000);
    lifecycle = observeLifecycleActivity(lifecycle, {
      ok: true,
      activity: activity({ updatedAt: 2_100, sequence: 1, activeSince: 2_000, activeScope: "tool", toolName: "bash", toolStartedAt: 2_000 }),
    }, 2_100);
    lifecycle = observeLifecycleActivity(lifecycle, {
      ok: true,
      activity: activity({ updatedAt: 3_000, sequence: 2, activeSince: 2_000, activeScope: "tool", toolName: "bash", toolStartedAt: 2_000 }),
    }, 3_000);
    const projection = projectLifecycle(lifecycle, 4_000);
    assert.equal(projection.kind, "active");
    assert.equal(projection.label, "bash");
    assert.equal(projection.stateDurationSince, 2_000);
  });
});

describe("completion.ts", () => {

  it("opens one channel and publishes one payload", () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-channel-"));
    const sessionFile = join(dir, "session.jsonl");
    try {
      beginCompletionChannel(sessionFile);
      assert.equal(hasCompletionChannel(sessionFile), true);
      assert.equal(publishCompletion(sessionFile, { reason: "done", exitCode: 0 }), true);
      assert.equal(hasCompletionChannel(sessionFile), false);
      assert.equal(publishCompletion(sessionFile, { reason: "done", exitCode: 0 }), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("removes canonically empty inspection channels but preserves payloads and unreadable markers", () => {
    withTempDir((dir) => {
      const sessionFile = join(dir, "session.jsonl");
      const file = `${sessionFile}.exit`;
      for (const marker of [undefined, "", " ", " \n ", "\t\r\n\v\f\u00a0", '{"reason":"done","exitCode":0}', " malformed payload "]) {
        rmSync(file, { force: true });
        if (marker !== undefined) writeFileSync(file, marker);
        const open = marker !== undefined && marker.trim() === "";
        assert.equal(hasCompletionChannel(sessionFile), open);
        removeEmptyCompletionChannel(sessionFile);
        assert.equal(hasCompletionChannel(sessionFile), false);
        if (open || marker === undefined) assert.equal(existsSync(file), false);
        else assert.equal(readFileSync(file, "utf8"), marker);
      }
      rmSync(file);
      mkdirSync(file);
      assert.equal(hasCompletionChannel(sessionFile), false);
      removeEmptyCompletionChannel(sessionFile);
      assert.equal(existsSync(file), true, "read errors never authorize removing unknown marker data");
    });
  });

  it("decodes structured ask payloads", () => {
    assert.deepEqual(
      interpretExitSidecar({ reason: "ask", exitCode: 0, ask: { question: "need help" } }),
      { reason: "ask", exitCode: 0, ask: { question: "need help" } },
    );
  });

  it("decodes done payloads", () => {
    assert.deepEqual(interpretExitSidecar({ reason: "done", exitCode: 0 }), {
      reason: "done",
      exitCode: 0,
    });
  });

  it("decodes error payloads and propagates the message with a non-zero exit code", () => {
    assert.deepEqual(
      interpretExitSidecar({
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      }),
      {
        reason: "error",
        exitCode: 1,
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
    );
  });

  it("falls back to a placeholder when error payload has no errorMessage", () => {
    const result = interpretExitSidecar({ reason: "error" });
    assert.equal(result.reason, "error");
    assert.equal(result.exitCode, 1);
    assert.match(result.errorMessage ?? "", /no errorMessage/);
  });

  it("rejects unknown completion sidecar payloads", () => {
    for (const payload of [{}, null]) {
      const result = interpretExitSidecar(payload);
      assert.equal(result.reason, "error");
      assert.equal(result.exitCode, 1);
      assert.match(result.errorMessage ?? "", /Invalid completion payload/);
    }
  });

  it("consumes a sidecar and removes it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-sidecar-"));
    const sessionFile = join(dir, "session.jsonl");
    beginCompletionChannel(sessionFile);
    publishCompletion(sessionFile, { reason: "ask", exitCode: 0, ask: { question: "ready" } });
    try {
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sessionFile,
        readTerminalTail: async () => "",
      });
      assert.deepEqual(result, {
        reason: "ask",
        exitCode: 0,
        ask: { question: "ready" },
      });
      assert.equal(existsSync(`${sessionFile}.exit`), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomically claims an ask sidecar for one watcher", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-ask-race-"));
    const sessionFile = join(dir, "session.jsonl");
    beginCompletionChannel(sessionFile);
    publishCompletion(sessionFile, { reason: "ask", exitCode: 0, ask: { question: "Choose one" } });
    const first = new AbortController();
    const second = new AbortController();
    try {
      const waits = [first, second].map((controller) =>
        waitForCompletion(controller.signal, { intervalMs: 10_000, sessionFile, readTerminalTail: async () => "" }),
      );
      const winner = await Promise.race(waits.map((wait) => wait.then((result) => ({ result }))));
      first.abort();
      second.abort();
      const settled = await Promise.allSettled(waits);
      assert.deepEqual(winner.result, { reason: "ask", exitCode: 0, ask: { question: "Choose one" } });
      assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the terminal sentinel exit code", async () => {
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => "output\n__SUBAGENT_DONE_17__\n",
    });
    assert.deepEqual(result, { reason: "sentinel", exitCode: 17 });
  });

  it("returns when an external sentinel file appears", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-sentinel-"));
    const sentinelFile = join(dir, "done");
    writeFileSync(sentinelFile, "complete");
    try {
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sentinelFile,
        readTerminalTail: async () => "",
      });
      assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retries transient terminal read failures and reports ticks", async () => {
    let reads = 0;
    let ticks = 0;
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        if (reads === 1) throw new Error("pane temporarily unavailable");
        return "__SUBAGENT_DONE_0__";
      },
      onTick: () => {
        ticks += 1;
      },
    });
    assert.deepEqual(result, { reason: "sentinel", exitCode: 0 });
    assert.equal(reads, 2);
    assert.equal(ticks, 1);
  });

  it("returns a failure when the pane explicitly disappears", async () => {
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => { throw new Error("pane read failed"); },
      inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
      paneDisappearanceGraceMs: 0,
    });
    assert.deepEqual(result, {
      reason: "error",
      exitCode: 1,
      errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
    });
  });

  it("lets a sidecar win the pane-disappearance race", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-race-"));
    const sessionFile = join(dir, "child.jsonl");
    try {
      beginCompletionChannel(sessionFile);
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sessionFile,
        readTerminalTail: async () => "",
        inspectPane: async () => {
          publishCompletion(sessionFile, { reason: "done", exitCode: 0 });
          return { kind: "missing", error: "pane_not_found" };
        },
      });
      assert.deepEqual(result, { reason: "done", exitCode: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits briefly for delayed sidecar publication after pane disappearance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "completion-delayed-race-"));
    const sessionFile = join(dir, "child.jsonl");
    const timer = setTimeout(() => {
      publishCompletion(sessionFile, { reason: "done", exitCode: 0 });
    }, 30);
    try {
      beginCompletionChannel(sessionFile);
      const result = await waitForCompletion(new AbortController().signal, {
        intervalMs: 1,
        sessionFile,
        readTerminalTail: async () => "",
        inspectPane: async () => ({ kind: "missing", error: "pane_not_found" }),
        paneDisappearanceGraceMs: 150,
      });
      assert.deepEqual(result, { reason: "done", exitCode: 0 });
    } finally {
      clearTimeout(timer);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an ambiguous pane read failure retryable while the pane exists", async () => {
    let reads = 0;
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        if (reads === 1) throw new Error("socket unavailable");
        return "__SUBAGENT_DONE_0__";
      },
      inspectPane: async () => ({ kind: "present", observedAt: 0, agentStatus: "working" }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(reads, 2);
  });

  it("treats presence-check throws as unknown and keeps polling", async () => {
    let reads = 0;
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        if (reads === 1) throw new Error("pane read failed");
        return "__SUBAGENT_DONE_0__";
      },
      inspectPane: async () => { throw new Error("herdr list failed"); },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(reads, 2);
  });

  it("inspects herdr status even when terminal reads succeed", async () => {
    let reads = 0;
    const inspections: string[] = [];
    const result = await waitForCompletion(new AbortController().signal, {
      intervalMs: 1,
      readTerminalTail: async () => {
        reads += 1;
        return reads === 1 ? "shell output" : "__SUBAGENT_DONE_0__";
      },
      inspectPane: async () => ({ kind: "present", observedAt: 2_000, agentStatus: "blocked" }),
      onPaneInspection: (inspection) => inspections.push(inspection.kind === "present" ? inspection.agentStatus : inspection.kind),
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(inspections, ["blocked"]);
  });

  it("rejects promptly when aborted", async () => {
    const controller = new AbortController();
    const completion = waitForCompletion(controller.signal, {
      intervalMs: 10_000,
      readTerminalTail: async () => "",
    });
    controller.abort();
    await assert.rejects(completion, /Aborted while waiting for subagent to finish/);
  });
});

describe("commands", () => {
  it("/iterate always emits a full-context fork tool call", () => {
    const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();

    (subagentsModule as any).default(api);

    const iterate = registeredCommands.find((command) => command.name === "iterate");
    assert.ok(iterate, "expected /iterate to be registered");

    iterate.handler("Fix the bug", {});

    assert.equal(sentUserMessages.length, 1);
    assert.match(sentUserMessages[0], /fork: true/);
    assert.match(sentUserMessages[0], /interactive: true/);
    assert.match(sentUserMessages[0], /name: "Iterate"/);
  });
});

describe("tool registration", () => {
  it("allows sibling subagents in one tool batch to launch concurrently", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagent = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagent);
    assert.equal(subagent.executionMode, "parallel");
  });

  it("registers subagent once with the catalog at load, without any event", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(
        globalAgentsDir,
        "researcher",
        [
          "name: researcher",
          "description: \"Researches topics.\n  Use for external sources.\"",
        ].join("\n"),
      );
      writeAgentFile(
        globalAgentsDir,
        "secret",
        ["name: secret", "description: Hidden one", "disable-model-invocation: true"].join("\n"),
      );

      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);

      const subagents = registeredTools.filter((tool) => tool.name === "subagent");
      assert.equal(subagents.length, 1);
      const guidance = subagents[0].promptGuidelines.join("\n");
      assert.match(guidance, /<available_subagents>/);
      assert.match(
        guidance,
        /<agent name="researcher">Researches topics\. Use for external sources\.<\/agent>/,
      );
      assert.doesNotMatch(guidance, /secret|Hidden one/);
      assert.doesNotMatch(guidance, /"Researches|authenticated|model-id|runtime comes from config/i);
      assert.equal(subagents[0].parameters.additionalProperties, false);
      for (const removed of ["model", "thinking", "systemPrompt", "skills", "tools"]) {
        assert.equal(subagents[0].parameters.properties[removed], undefined);
      }
    });
  });

  it("catalog handles folded, block, malformed, frontmatter-less and non-string agents", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      mkdirSync(globalAgentsDir, { recursive: true });
      writeFileSync(join(globalAgentsDir, "folded.md"), "---\nname: folded\ndescription: >\n  Use when\n  folding.\n---\nbody\n");
      writeFileSync(join(globalAgentsDir, "block.md"), "---\nname: block\ndescription: |\n  Line one\n  line two\n---\nbody\n");
      writeFileSync(join(globalAgentsDir, "bad.md"), "---\nname: [unclosed\n---\nbody\n");
      writeFileSync(join(globalAgentsDir, "plain.md"), "no frontmatter at all\n");
      writeAgentFile(globalAgentsDir, "listy", "name: listy\ndescription:\n  - a\n  - b");
      const { api, registeredTools, eventHandlers } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const guidance = registeredTools.find((tool) => tool.name === "subagent").promptGuidelines.join("\n");
      assert.match(guidance, /<agent name="folded">Use when folding\.<\/agent>/);
      assert.match(guidance, /<agent name="block">Line one line two<\/agent>/);
      assert.match(guidance, /<agent name="listy"><\/agent>/);
      const catalogBlock = guidance.slice(guidance.indexOf("<available_subagents>"));
      assert.doesNotMatch(catalogBlock, /plain|bad|unclosed/);
      const warnings: string[] = [];
      eventHandlers.get("session_start")![0]({}, { ui: { notify: (m: string) => warnings.push(m) } });
      assert.ok(warnings.some((m) => /Skipped agent bad\.md/.test(m)));
      assert.ok(warnings.some((m) => /Skipped agent plain\.md: missing YAML frontmatter/.test(m)));
    });
  });

  it("caps the catalog and reports omitted agents", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      for (let i = 0; i < 30; i++) {
        writeAgentFile(globalAgentsDir, `agent-${String(i).padStart(2, "0")}`, `name: agent-${String(i).padStart(2, "0")}\ndescription: d`);
      }
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const guidance = registeredTools.find((tool) => tool.name === "subagent").promptGuidelines.join("\n");
      assert.equal((guidance.match(/<agent name=/g) ?? []).length, 24);
      assert.match(guidance, /6 more named subagents omitted/);
    });
  });

  it("empty catalog tells the model to do the work itself", async () => {
    await withIsolatedAgentEnv(async () => {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const guidance = registeredTools.find((tool) => tool.name === "subagent").promptGuidelines.join("\n");
      assert.match(guidance, /none; do the work yourself/);
      assert.doesNotMatch(guidance, /bare spawn/);
    });
  });

  it("child orchestrator catalog excludes its own agent", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(globalAgentsDir, "lead", "name: lead\ndescription: Leads\nspawning: true");
      writeAgentFile(globalAgentsDir, "worker", "name: worker\ndescription: Works");
      const saved = { id: process.env.PI_SUBAGENT_ID, agent: process.env.PI_SUBAGENT_AGENT, sp: process.env.PI_SUBAGENT_SPAWNING, file: process.env.PI_SUBAGENT_AGENT_FILE };
      process.env.PI_SUBAGENT_AGENT_FILE = join(globalAgentsDir, "lead.md");
      process.env.PI_SUBAGENT_ID = "child";
      process.env.PI_SUBAGENT_AGENT = "lead";
      process.env.PI_SUBAGENT_SPAWNING = "1";
      try {
        const { api, registeredTools } = createMockExtensionApi();
        (subagentsModule as any).default(api);
        const guidance = registeredTools.find((tool) => tool.name === "subagent").promptGuidelines.join("\n");
        assert.match(guidance, /name="worker"/);
        assert.doesNotMatch(guidance, /name="lead"/);
      } finally {
        for (const [k, v] of [["PI_SUBAGENT_ID", saved.id], ["PI_SUBAGENT_AGENT", saved.agent], ["PI_SUBAGENT_SPAWNING", saved.sp], ["PI_SUBAGENT_AGENT_FILE", saved.file]] as const) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
    });
  });

  it("keeps lifecycle tools in the base process", () => {
    delete process.env.PI_SUBAGENT_ID;
    process.env.PI_SUBAGENT_SPAWNING = "0";
    try {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      assert.equal(registeredTools.some((tool) => tool.name === "subagent"), true);
      assert.equal(registeredTools.some((tool) => tool.name === "subagent_interrupt"), false);
      assert.equal(registeredTools.some((tool) => tool.name === "subagents_list"), false);
      assert.equal(registeredTools.some((tool) => tool.name === "subagent_prompt"), true);
    } finally {
      delete process.env.PI_SUBAGENT_SPAWNING;
    }
  });

  it("gates all lifecycle tools in a child process with spawning", () => {
    process.env.PI_SUBAGENT_ID = "child-test";
    process.env.PI_SUBAGENT_SPAWNING = "0";
    try {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      for (const name of [
        "subagent",
        "subagent_prompt",
      ]) {
        assert.equal(registeredTools.some((tool) => tool.name === name), false);
      }
      for (const name of ["subagent_interrupt", "subagents_list"]) {
        assert.equal(registeredTools.some((tool) => tool.name === name), false);
      }
    } finally {
      delete process.env.PI_SUBAGENT_ID;
      delete process.env.PI_SUBAGENT_SPAWNING;
    }
  });

  it("allows all lifecycle tools in a child with spawning enabled", () => {
    process.env.PI_SUBAGENT_ID = "child-test";
    process.env.PI_SUBAGENT_SPAWNING = "1";
    try {
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      for (const name of [
        "subagent",
        "subagent_prompt",
      ]) {
        assert.equal(registeredTools.some((tool) => tool.name === name), true);
      }
      for (const name of ["subagent_interrupt", "subagents_list"]) {
        assert.equal(registeredTools.some((tool) => tool.name === name), false);
      }
    } finally {
      delete process.env.PI_SUBAGENT_ID;
      delete process.env.PI_SUBAGENT_SPAWNING;
    }
  });

  it("does not register obsolete parent detachment controls", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    assert.equal(registeredTools.some((tool) => tool.label === "Accept Subagent"), false);
  });

  it("registers subagent_prompt for handle-based continuation", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const promptTool = registeredTools.find((tool) => tool.name === "subagent_prompt");
    assert.ok(promptTool, "expected subagent_prompt tool to be registered");
    assert.equal(promptTool.executionMode, "parallel");
    assert.equal(promptTool.parameters.properties.id.type, "string");
    assert.equal(promptTool.parameters.properties.message.type, "string");
    assert.equal(promptTool.parameters.properties.name, undefined);
    assert.equal(promptTool.parameters.properties.sessionPath, undefined);
  });

  it("uses errorMessage for every subagent_prompt failure", async (t) => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const promptTool = registeredTools.find((tool) => tool.name === "subagent_prompt");
    const testApi = (subagentsModule as any).__test__;
    const previousCtx = testApi.runtime.latestCtx;
    const previousShutdown = testApi.runtime.shuttingDown;
    const ctx = { sessionManager: { getSessionId: () => "prompt-parent" } };
    testApi.runtime.latestCtx = ctx;
    testApi.runtime.shuttingDown = false;
    t.after(() => {
      testApi.runtime.latestCtx = previousCtx;
      testApi.runtime.shuttingDown = previousShutdown;
    });
    const signal = new AbortController().signal;
    const unknown = await promptTool.execute("test", { id: "unknown", message: "Continue" }, signal, undefined, ctx);
    assert.deepEqual(unknown.details, { errorMessage: "Unknown subagent handle.", id: "unknown" });

    const busyId = "initial-turn-lock";
    testApi.subagentHandles.set(busyId, {
      id: busyId, name: "Worker", sessionFile: "/tmp/worker.jsonl", state: "active", autoExit: true, interactive: false, createdAt: 1,
    });
    testApi.runningSubagents.set(busyId, { inputLocked: true });
    try {
      const result = await promptTool.execute("test", { id: busyId, message: "Continue" }, signal, undefined, ctx);
      assert.match(result.content[0].text, /busy/);
      assert.equal(result.details.errorMessage, result.content[0].text);
      assert.equal(result.details.error, undefined);
      assert.deepEqual(result.details, { errorMessage: result.content[0].text, id: busyId, name: "Worker", sessionFile: "/tmp/worker.jsonl" });
    } finally {
      testApi.subagentHandles.delete(busyId);
      testApi.runningSubagents.delete(busyId);
    }

    const missingId = "missing-session";
    testApi.subagentHandles.set(missingId, {
      id: missingId, name: "Worker", sessionFile: "/tmp/missing-session.jsonl", state: "active", autoExit: true, interactive: false, createdAt: 1,
    });
    try {
      const result = await promptTool.execute("test", { id: missingId, message: "Continue" }, signal, undefined, ctx);
      assert.match(result.content[0].text, /no saved session file/);
      assert.equal(result.details.errorMessage, result.content[0].text);
      assert.equal(result.details.error, undefined);
      assert.deepEqual(result.details, { errorMessage: result.content[0].text, id: missingId, name: "Worker", sessionFile: "/tmp/missing-session.jsonl" });
    } finally {
      testApi.subagentHandles.delete(missingId);
    }

    const dir = createTestDir();
    const promptId = "prompt-failure";
    const sessionFile = join(dir, "worker.jsonl");
    const previousPath = process.env.PATH;
    const previousHerdrEnv = process.env.HERDR_ENV;
    writeFileSync(sessionFile, "");
    writeFileSync(join(dir, "herdr"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    process.env.PATH = `${dir}:${previousPath ?? ""}`;
    process.env.HERDR_ENV = "1";
    const handle = {
      id: promptId, name: "Worker", agent: "implementer", cwd: "/saved/cwd", sessionFile, surface: "pane", state: "active" as const, autoExit: true, interactive: false, createdAt: 1,
    };
    testApi.subagentHandles.set(promptId, handle);
    testApi.runningSubagents.set(promptId, {
      ...handle, task: "Continue", startTime: Date.now(), lifecycle: markDelivery(createLifecycle(Date.now()), "delivered"), inputLocked: false,
      initialToolCallId: "previous-call", abortController: new AbortController(),
    });
    try {
      const previous = testApi.runningSubagents.get(promptId);
      const { lifecycle, startTime, abortController, initialToolCallId } = previous;
      const result = await promptTool.execute("test", { id: promptId, message: "SECRET_FOLLOWUP\nFull outgoing instruction" }, signal, undefined, ctx);
      assert.equal(previous.lifecycle, lifecycle);
      assert.equal(previous.startTime, startTime);
      assert.equal(previous.abortController, abortController);
      assert.equal(previous.initialToolCallId, initialToolCallId);
      assert.match(result.content[0].text, /Could not prompt subagent.*Command failed: herdr agent prompt pane SECRET_FOLLOWUP\nFull outgoing instruction/);
      assert.equal(testApi.runningSubagents.get(promptId).task, "SECRET_FOLLOWUP\nFull outgoing instruction");
      assert.equal(result.details.errorMessage, result.content[0].text);
      assert.equal(result.details.error, undefined);
      assert.deepEqual(result.details, { errorMessage: result.content[0].text, id: promptId, name: "Worker", agent: "implementer", cwd: "/saved/cwd", surface: "pane", sessionFile });
      testApi.runningSubagents.delete(promptId);
      testApi.setExecutionTestAdapters(undefined, undefined, () => false);
      const theme = { fg: (_color: string, value: string) => value };
      for (const target of [
        { ...handle, state: "abandoned" },
        { ...handle, sessionFile: join(dir, "absent.jsonl") },
        handle,
        { ...handle, surface: undefined },
      ]) {
        testApi.subagentHandles.set(promptId, target);
        const failed = await promptTool.execute("test", { id: promptId, message: "Continue" }, signal, undefined, ctx);
        assert.deepEqual(failed.details, {
          errorMessage: failed.details.errorMessage, id: promptId, name: target.name, agent: target.agent, cwd: target.cwd,
          ...(target.surface ? { surface: target.surface } : {}), sessionFile: target.sessionFile,
        });
        assert.match(failed.details.errorMessage, /abandoned|no saved session file|herdr not available/);
        const snapshot = JSON.stringify(failed);
        testApi.subagentHandles.set(promptId, { ...handle, name: "Conflicting", agent: "other", cwd: "/other" });
        const rendered = promptTool.renderResult(JSON.parse(snapshot), {}, theme, { state: {}, isError: false }).render(120).join("\n");
        assert.match(rendered, /◈ implementer — Worker\n│ \/saved\/cwd\n│ failed/);
        assert.doesNotMatch(rendered, /async|0s|Conflicting|\/other/);
        assert.equal(JSON.stringify(failed), snapshot);
      }
    } finally {
      testApi.setExecutionTestAdapters(undefined, undefined, undefined);
      restoreEnvVar("PATH", previousPath);
      restoreEnvVar("HERDR_ENV", previousHerdrEnv);
      testApi.subagentHandles.delete(promptId);
      testApi.runningSubagents.delete(promptId);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("keeps unlocked pending turns busy, preserves older notifications and accepts settled retry", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
    const mock = createMockExtensionApi();
    subagentsModule.default(mock.api);
    const owner: typeof subagentsModule.__test__ = Reflect.get(subagentsModule, "__test__");
    const previous = { ctx: owner.runtime.latestCtx, halted: owner.runtime.halted, shuttingDown: owner.runtime.shuttingDown };
    const tool = mock.registeredTools.find((entry) => entry.name === "subagent_prompt");
    const dir = createTestDir();
    const ctx = { sessionManager: { getSessionId: () => "busy-parent", getSessionDir: () => dir } };
    Reflect.set(owner.runtime, "latestCtx", ctx);
    owner.runtime.shuttingDown = false;
    try {
      for (const assignment of ["initial", "prompt"] as const) {
        const id = `busy-${assignment}`;
        const sessionFile = createSessionFile(dir, [SESSION_HEADER]);
        const handle: SubagentHandle = { id, name: "Worker", sessionFile, surface: "mock-pane", state: "active",
          autoExit: false, interactive: true, createdAt: 1 };
        const running = { ...handle, task: "OLD_TASK", startTime: 1, cli: "pi", runtimePlan: undefined, orchestrationMode: "async" as const,
          inputLocked: false, initialToolCallId: "old-call" as string | undefined, lifecycle: createLifecycle(1), abortController: new AbortController(),
          activityFile: join(dir, `${id}.activity`) };
        owner.runningSubagents.set(id, running);
        owner.subagentHandles.set(id, handle);
        const oldResult = { name: "Worker", task: "OLD_TASK", summary: "", sessionFile, exitCode: 0, elapsed: 99, ask: { question: "OLD_QUESTION" } };
        let finishOld!: (result: typeof oldResult) => void;
        const completion = new Promise<typeof oldResult>((resolve) => { finishOld = resolve; });
        (assignment === "initial" ? owner.deliverInitialCompletion : owner.deliverPromptCompletion)(running, completion, mock.api);
        const marker = JSON.stringify({ reason: "ask", exitCode: 0, ask: { question: "OLD_QUESTION" } });
        writeFileSync(`${sessionFile}.exit`, marker);
        const controller = running.abortController;
        const beforeMessages = mock.sentMessages.length;
        let sends = 0;
        let watches = 0;
        let failSend = false;
        let finishNew!: () => void;
        owner.setExecutionTestAdapters(undefined, () => {
          watches += 1;
          return new Promise((resolve) => { finishNew = () => resolve({ ...oldResult, task: "NEW_TASK", ask: undefined, summary: "NEW_RESPONSE", elapsed: 0 }); });
        }, () => true, () => { sends += 1; if (failSend) throw new Error("send failed"); });
        const recorder = createSubagentActivityRecorder({ runningChildId: id, activityFile: running.activityFile });
        for (const phase of ["waiting", "done"] as const) {
          if (phase === "waiting") recorder.agentEndWaiting();
          else recorder.assignmentFinalized();
          owner.observeRunningSubagent(running);
          const observed = JSON.stringify(running);
          const busy = await tool.execute("new-call", { id, message: "NEW_TASK" }, undefined, undefined, ctx);
          assert.match(busy.details.errorMessage, /busy/);
          assert.equal(JSON.stringify(running), observed);
          assert.equal(readFileSync(`${sessionFile}.exit`, "utf8"), marker);
        }
        assert.equal(sends, 0);
        assert.equal(watches, 0);
        assert.equal(running.abortController, controller);
        assert.equal(controller.signal.aborted, false);
        assert.equal(mock.sentMessages.length, beforeMessages);
        finishOld(oldResult);
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(mock.sentMessages.at(-1).message.customType, "subagent_ask");
        assert.equal(mock.sentMessages.at(-1).message.details.task, "OLD_TASK");
        assert.equal(mock.sentMessages.at(-1).message.details.question, "OLD_QUESTION");
        assert.equal(running.lifecycle.delivery, "delivered");
        assert.equal(running.initialToolCallId, undefined);
        const settled = running.lifecycle;
        failSend = true;
        const failed = await tool.execute("failed-call", { id, message: "NEW_TASK" }, undefined, undefined, ctx);
        assert.match(failed.details.errorMessage, /send failed/);
        assert.equal(running.lifecycle, settled);
        assert.equal(running.startTime, 1);
        assert.equal(running.abortController, controller);
        assert.equal(running.initialToolCallId, undefined);
        assert.equal(running.task, "NEW_TASK", "existing failed-send task update remains unchanged");
        failSend = false;
        const accepted = await tool.execute("accepted-call", { id, message: "NEW_TASK" }, undefined, undefined, ctx);
        assert.equal(accepted.details.status, "continued");
        assert.equal(running.initialToolCallId, "accepted-call");
        assert.equal(running.startTime, 100_000);
        assert.notEqual(running.abortController, controller);
        assert.equal(watches, 1);
        finishNew();
        await Promise.resolve();
        assert.equal(mock.sentMessages.at(-1).message.details.task, "NEW_TASK");
        assert.equal(mock.sentMessages.length, assignment === "initial" ? 2 : 4);
        owner.runningSubagents.delete(id);
        owner.subagentHandles.delete(id);
      }
    } finally {
      owner.setExecutionTestAdapters(undefined, undefined, undefined);
      mock.eventHandlers.get("session_shutdown")![0]({ reason: "quit" }, {});
      Reflect.set(owner.runtime, "latestCtx", previous.ctx);
      owner.runtime.halted = previous.halted;
      owner.runtime.shuttingDown = previous.shuttingDown;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("returns owning continuation metadata and fresh turn time from retained, attached and reopened prompt execution", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
    const { api, registeredTools, eventHandlers, sentMessages } = createMockExtensionApi();
    subagentsModule.default(api);
    const promptTool = registeredTools.find((tool) => tool.name === "subagent_prompt");
    const testApi = Reflect.get(subagentsModule, "__test__");
    const dir = createTestDir();
    const originalHalted = testApi.runtime.halted;
    const originalCtx = testApi.runtime.latestCtx;
    const originalShutdown = testApi.runtime.shuttingDown;
    const ctx = { sessionManager: { getSessionDir: () => dir, getSessionId: () => "parent", getSessionFile: () => join(dir, "parent.jsonl") } };
    testApi.runtime.latestCtx = ctx;
    testApi.runtime.shuttingDown = false;
    testApi.setInspectionTestAdapters({ inspectPaneStrict: async () => ({ kind: "missing" }), createSubagentPane: () => "reopened-pane", closePane() {} });
    try {
      for (const branch of ["live", "attached", "reopened"] as const) {
        for (const mode of ["async", "wait-all"] as const) {
          const id = `${branch}-${mode}`;
          const sessionFile = join(dir, `${id}.jsonl`);
          writeFileSync(sessionFile, JSON.stringify({ ...SESSION_HEADER, cwd: dir }) + "\n");
          const handle: SubagentHandle = {
            id, name: "Stable worker", agent: "implementer", cwd: dir, agentDir: dir, sessionFile,
            state: "finalized", subscribed: false, autoExit: false, interactive: false, createdAt: 1,
            surface: branch !== "reopened" ? "live-pane" : "missing-pane",
          };
          testApi.subagentHandles.set(id, handle);
          if (branch === "live") testApi.runningSubagents.set(id, {
            id, name: handle.name, agent: handle.agent, cwd: "/live/cwd", agentDir: dir, sessionFile,
            task: "previous work", surface: "live-pane", cli: "pi", runtimePlan: undefined,
            startTime: 1, orchestrationMode: mode, autoExit: false, interactive: false,
            inputLocked: false, lifecycle: markDelivery(createLifecycle(1), "delivered"),
          });
          testApi.setInspectionTestAdapters({ inspectPaneStrict: async () => branch === "attached" ? { kind: "present", agent: "pi" } : { kind: "missing" }, createSubagentPane: () => "reopened-pane", closePane() {} });
          const completionResult = { name: handle.name, task: "Follow up", summary: "done", sessionFile, exitCode: 0, elapsed: 1 };
          let finish!: (result: typeof completionResult) => void;
          const prompted: Array<{ surface: string; message: string; agentDir?: string }> = [];
          const launches: Array<Parameters<typeof launchPiContinuation>[0]> = [];
          const watched: string[] = [];
          let failAttach = branch === "attached";
          testApi.setExecutionTestAdapters(undefined, (running: { id: string; orchestrationMode: "async" | "wait-all" }) => {
            watched.push(running.id);
            running.orchestrationMode = mode;
            return new Promise<typeof completionResult>((resolve) => { finish = resolve; });
          }, () => true, (surface: string, message: string, agentDir?: string) => {
            if (failAttach) throw new Error("attach send failed");
            prompted.push({ surface, message, agentDir });
          }, async (params: Parameters<typeof launchPiContinuation>[0]) => {
            launches.push(params);
            params.beforeSend?.();
            return { surface: "reopened-pane", activityFile: join(dir, "activity.json"), launchScriptFile: join(dir, "continue.sh") };
          });
          testApi.runtime.halted = false;
          const signal = new AbortController();
          if (mode === "wait-all") signal.abort();
          try {
            if (branch === "attached") {
              const failed = await promptTool.execute(`failed-${id}`, { id, message: "Follow up" }, signal.signal, undefined, ctx);
              assert.match(failed.details.errorMessage, /attach send failed/);
              assert.equal(testApi.runningSubagents.has(id), false, "failed attach does not register a pending assignment");
              assert.deepEqual(watched, []);
              failAttach = false;
            }
            const result = await promptTool.execute(`prompt-${id}`, { id, message: "Follow up" }, signal.signal, undefined, ctx);
            assert.deepEqual(result.details, {
              id, name: "Stable worker", task: "Follow up", agent: "implementer",
              cwd: branch === "live" ? "/live/cwd" : dir, async: mode === "async",
              surface: branch !== "reopened" ? "live-pane" : "reopened-pane", sessionFile,
              status: mode === "async" ? "continued" : "wait_cancelled",
            });
            assert.match(result.content[0].text, mode === "async" ? /Continuation sent|reopened and is continuing/ : /Wait cancelled/);
            assert.deepEqual(watched, [id]);
            assert.equal(testApi.runningSubagents.get(id).startTime, 100_000);
            assert.equal(testApi.runningSubagents.get(id).lifecycle.process.startedAt, 100_000);
            assert.equal(testApi.runningSubagents.get(id).initialToolCallId, mode === "async" ? `prompt-${id}` : undefined);
            assert.equal(testApi.runningSubagents.get(id).abortController.signal.aborted, false);
            assert.equal(testApi.subagentHandles.get(id).subscribed, true);
            if (branch !== "reopened") {
              assert.deepEqual(prompted, [{ surface: "live-pane", message: "Follow up", agentDir: dir }]);
              assert.deepEqual(launches, []);
            } else {
              assert.deepEqual(prompted, []);
              assert.equal(launches.length, 1);
              assert.deepEqual(launches[0].handle, { ...handle, surface: "reopened-pane" });
              assert.equal(launches[0].message, "Follow up");
              assert.equal(launches[0].artifactDir, join(dir, "artifacts", "parent"));
            }
            finish(completionResult);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            assert.equal(sentMessages.at(-1).message.customType, "subagent_result");
            assert.equal(sentMessages.at(-1).message.details.id, id);
          } finally {
            if (typeof finish === "function") finish(completionResult);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            testApi.setExecutionTestAdapters(undefined, undefined, undefined);
            testApi.runningSubagents.delete(id);
            testApi.subagentHandles.delete(id);
          }
        }
      }
      assert.equal(sentMessages.length, 6);
    } finally {
      testApi.setExecutionTestAdapters(undefined, undefined, undefined);
      testApi.runtime.halted = originalHalted;
      eventHandlers.get("session_shutdown")?.[0]({ reason: "quit" }, {});
      testApi.runtime.latestCtx = originalCtx;
      testApi.runtime.shuttingDown = originalShutdown;
      testApi.setInspectionTestAdapters();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults child spawning off and allows explicit opt-in", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.equal(testApi.resolveSpawning(null), false);
    assert.equal(testApi.resolveSpawning({}), false);
    assert.equal(testApi.resolveSpawning({ spawning: false }), false);
    assert.equal(testApi.resolveSpawning({ spawning: true }), true);
  });

  it("blocks bare spawns unless an explicit fork is requested", async () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagent = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagent);
    assert.equal(
      subagent.description,
      "Delegate work to a specialist subagent running in its own context; you get back its result.",
    );
    assert.equal(subagent.promptSnippet, subagent.description);
    assert.match(subagent.parameters.properties.fork.description, /only when the user explicitly asks to fork/i);
    assert.equal(subagent.parameters.required.includes("name"), false);
    const rules = subagent.promptGuidelines.join("\n");
    assert.doesNotMatch(rules, /fork|herdr|do not poll|generic default/i);
    assert.doesNotMatch(subagent.description, /fork|herdr|do not poll/i);

    for (const params of [
      { name: "Bare", task: "T" },
      { name: "Bare", task: "T", fork: false },
      { name: "Bare", task: "T", agent: " " },
    ]) {
      const result = await subagent.execute(
        "test-call",
        params,
        new AbortController().signal,
        undefined,
        {},
      );
      assert.match(result.content[0].text, /bare subagents require fork: true/i);
      assert.equal(result.details.errorMessage, result.content[0].text);
    }

    const testApi = (subagentsModule as any).__test__;
    assert.equal(testApi.validateSubagentRequest({ agent: "worker" }), null);
    assert.equal(testApi.validateSubagentRequest({ fork: true }), null);
  });

  it("/subagent launches a hidden agent by exact name and rejects unknown names", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(globalAgentsDir, "secret", "name: secret\ndescription: Hid\ndisable-model-invocation: true");
      const { api, registeredCommands, sentUserMessages } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const command = registeredCommands.find((entry) => entry.name === "subagent");
      const notices: Array<[string, string]> = [];
      const ctx = { ui: { notify: (message: string, level: string) => notices.push([message, level]) } };

      await command.handler("secret do the thing", ctx);
      assert.equal(notices.length, 0);
      assert.equal(sentUserMessages.length, 1);
      assert.match(sentUserMessages[0], /agent: "secret".*do the thing/);

      await command.handler("nope", ctx);
      assert.equal(sentUserMessages.length, 1);
      assert.match(notices[0][0], /Agent "nope" not found/);
      assert.equal(notices[0][1], "error");
    });
  });

  it("rejects unknown agent names, listing only visible agents, but accepts hidden ones", async () => {
    await withIsolatedAgentEnv(async ({ globalAgentsDir }) => {
      writeAgentFile(globalAgentsDir, "worker", "name: worker\ndescription: Works");
      writeAgentFile(globalAgentsDir, "secret", "name: secret\ndescription: Hid\ndisable-model-invocation: true");
      const { api, registeredTools } = createMockExtensionApi();
      (subagentsModule as any).default(api);
      const subagent = registeredTools.find((tool) => tool.name === "subagent");
      const run = (params: object) =>
        subagent.execute("c", params, new AbortController().signal, undefined, {
          sessionManager: { getSessionFile: () => undefined },
        });

      for (const params of [{ name: "x", task: "T", agent: "wrker" }, { task: "T", agent: "wrker", fork: true }]) {
        const result = await run(params);
        assert.equal(result.content[0].text, 'Unknown agent "wrker". Available: worker');
        // Rejected before any launch: result carries only the error.
        assert.deepEqual(Object.keys(result.details), ["errorMessage"]);
        assert.equal(result.details.errorMessage, result.content[0].text);
      }

      const bareFork = await run({ name: "x", task: "T", fork: true });
      assert.doesNotMatch(bareFork.content[0].text, /Unknown agent|Bare subagents/);

      const hidden = await run({ name: "x", task: "T", agent: "secret" });
      assert.doesNotMatch(hidden.content[0].text, /Unknown agent/);
    });
  });

  it("renders partial subagent tool-call args without throwing", () => {
    const { api, registeredTools } = createMockExtensionApi();
    (subagentsModule as any).default(api);

    const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
    assert.ok(subagentTool, "expected subagent tool to be registered");

    const theme = {
      fg(_color: string, text: string) {
        return text;
      },
      bold(text: string) {
        return text;
      },
    };
    const context = { toolCallId: "partial", executionStarted: false, invalidate() {}, state: {} };
    const rendered = subagentTool.renderCall({}, theme, context);
    const output = rendered.render(80).join("\n");

    assert.match(output, /◈ subagent/);

    const named = subagentTool.renderCall({ agent: "scout" }, theme, { ...context, toolCallId: "named" }).render(80).join("\n");
    assert.match(named, /◈ scout/);
  });


});

describe("Assignment finalization policy", () => {
  it("returns one disposition for async and wait-all adapters", () => {
    const cases = [
      {
        name: "normal completion retains pane",
        state: { cli: "pi", autoExit: false, delivery: "pending" as const },
        event: { kind: "result" as const, exitCode: 0 },
        expected: { disposition: "finalized", lifecycle: "completed", handle: "finalized", parentSubscription: "consume", pane: "retain", delivery: "deliver", haltOrchestrator: false, removeFromRunning: true },
      },
      {
        name: "ask stays live despite auto-exit",
        state: { cli: "pi", autoExit: true, delivery: "pending" as const },
        event: { kind: "ask" as const },
        expected: { disposition: "awaiting_answer", lifecycle: "unchanged", handle: "awaiting_answer", parentSubscription: "consume", pane: "retain", delivery: "deliver", haltOrchestrator: false, removeFromRunning: false },
      },
      {
        name: "fatal Pi failure abandons only this assignment",
        state: { cli: "pi", autoExit: false, delivery: "pending" as const },
        event: { kind: "result" as const, exitCode: 1 },
        expected: { disposition: "abandoned", lifecycle: "failed", handle: "abandoned", parentSubscription: "cancel", pane: "close", delivery: "deliver", haltOrchestrator: true, removeFromRunning: true },
      },
      {
        name: "non-Pi failure remains ordinary result",
        state: { cli: "test-shell", autoExit: true, delivery: "pending" as const },
        event: { kind: "result" as const, exitCode: 1 },
        expected: { disposition: "finalized", lifecycle: "failed", handle: "finalized", parentSubscription: "consume", pane: "close", delivery: "deliver", haltOrchestrator: false, removeFromRunning: true },
      },
      {
        name: "cancelled Pi failure remains ordinary result",
        state: { cli: "pi", autoExit: false, delivery: "pending" as const },
        event: { kind: "result" as const, exitCode: 1, errorMessage: "cancelled" },
        expected: { disposition: "finalized", lifecycle: "failed", handle: "finalized", parentSubscription: "consume", pane: "retain", delivery: "deliver", haltOrchestrator: false, removeFromRunning: true },
      },
      {
        name: "user abandonment suppresses later delivery",
        state: { cli: "pi", autoExit: false, delivery: "pending" as const },
        event: { kind: "abandonment" as const, reason: "user" as const },
        expected: { disposition: "abandoned", lifecycle: "failed", handle: "abandoned", parentSubscription: "cancel", pane: "close", delivery: "suppress", haltOrchestrator: true, removeFromRunning: true },
      },
      {
        name: "duplicate completion is idempotent",
        state: { cli: "pi", autoExit: false, abandoned: true, delivery: "delivered" as const },
        event: { kind: "result" as const, exitCode: 1 },
        expected: { disposition: "suppressed", lifecycle: "unchanged", handle: "unchanged", parentSubscription: "retain", pane: "retain", delivery: "suppress", haltOrchestrator: false, removeFromRunning: true },
      },
    ];

    for (const test of cases) {
      assert.deepEqual(finalizeAssignment(test.state, test.event), test.expected, test.name);
    }
  });
});

describe("subagent parent lifecycle", () => {
  it("upgrades reload-persisted runtime objects with durable handles", () => {
    const testApi = (subagentsModule as any).__test__;
    const runningSubagents = new Map();
    const legacyRuntime = { runningSubagents };

    const runtime = testApi.ensureSubagentRuntime(legacyRuntime);
    assert.equal(runtime, legacyRuntime);
    assert.equal(runtime.runningSubagents, runningSubagents);
    assert.ok(runtime.handles instanceof Map);
  });

  it("releases parent wait without aborting subagent completion", async () => {
    const controller = new AbortController();
    let finish!: (value: string) => void;
    const completion = new Promise<string>((resolve) => { finish = resolve; });

    const waiting = waitForCompletionOrAbort(completion, controller.signal);
    controller.abort();
    assert.deepEqual(await waiting, { cancelled: true });

    finish("finished");
    assert.deepEqual(await waitForCompletionOrAbort(completion), { result: "finished" });
  });

  it("closes a pane only when auto-exit is enabled", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.equal(testApi.shouldClosePaneAfterFinalization({ autoExit: true }), true);
    assert.equal(testApi.shouldClosePaneAfterFinalization({ autoExit: false }), false);
  });

  it("observes parent Escape without consuming Pi input", () => {
    const { api, eventHandlers } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const testApi = (subagentsModule as any).__test__;
    let rawInput: ((data: string) => unknown) | undefined;
    let unsubscribed = 0;
    const ctx = {
      sessionManager: { getEntries: () => [], getSessionFile: () => null },
      modelRegistry: { find: () => undefined, getAvailable: () => [], hasConfiguredAuth: () => true },
      scopedModels: [],
      ui: {
        onTerminalInput(handler: (data: string) => unknown) {
          rawInput = handler;
          return () => { unsubscribed += 1; };
        },
      },
    };

    try {
      eventHandlers.get("session_start")![0]({}, ctx);
      assert.equal(rawInput?.("\x1b"), undefined);
      eventHandlers.get("session_start")![0]({}, ctx);
      assert.equal(unsubscribed, 1);
    } finally {
      testApi.runtime.stopTerminalInput?.();
      testApi.runtime.stopTerminalInput = undefined;
    }
  });

  it("preserves active subagents during extension reload", () => {
    const abortController = new AbortController();
    const agents = new Map([["child", {
      abortController,
      lifecycle: createLifecycle(1_000),
    }]]);

    cleanupSubagentsForShutdown("reload", agents);

    assert.equal(shouldPreserveSubagentsOnShutdown("reload"), true);
    assert.equal(abortController.signal.aborted, false);
    assert.equal(agents.get("child")!.lifecycle.delivery, "pending");
    assert.equal(agents.size, 1);
  });

  it("aborts and clears active subagents during final shutdown", () => {
    for (const reason of ["quit", "new", "resume", "fork", undefined]) {
      const abortController = new AbortController();
      const running = { abortController, lifecycle: createLifecycle(1_000) };
      const agents = new Map([["child", running]]);

      cleanupSubagentsForShutdown(reason, agents);

      assert.equal(shouldPreserveSubagentsOnShutdown(reason), false);
      assert.equal(abortController.signal.aborted, true);
      assert.equal(running.lifecycle.delivery, "suppressed");
      assert.equal(agents.size, 0);
    }
  });

  it("delivers completion through the reloaded extension API", () => {
    const previous = { id: "previous" };
    const current = { id: "current" };

    assert.equal(selectCompletionApi(previous, current), current);
    assert.equal(selectCompletionApi(previous, undefined), previous);
  });

  void it("delivers async initial completion through the selected extension API", async () => {
    type SentMessage = {
      message: {
        customType?: string;
        content: string;
        details: { exitCode?: number; sessionFile?: string };
      };
      options: { deliverAs?: string };
    };
    type MockApi = {
      sendMessage(message: SentMessage["message"], options: SentMessage["options"]): void;
    };
    type CompletionResult = {
      name: string;
      task: string;
      summary: string;
      sessionFile: string;
      exitCode: number;
      elapsed: number;
      errorMessage?: string;
    };
    type TestApi = {
      runtime: { pi?: MockApi; halted: boolean };
      deliverInitialCompletion(
        running: Record<string, unknown>,
        completion: Promise<CompletionResult>,
        pi: MockApi,
      ): void;
      deliverPromptCompletion(
        running: Record<string, unknown>,
        completion: Promise<CompletionResult>,
        pi: MockApi,
      ): void;
      completionResultMetadata(
        running: { cli?: string },
        completion: CompletionPayload,
      ): { exitCode: number; errorMessage?: string };
      runningSubagents: Map<string, unknown>;
      subagentHandles: Map<string, unknown>;
    };
    const testApi: TestApi = Reflect.get(subagentsModule, "__test__");
    const previousMessages: SentMessage[] = [];
    const currentMessages: SentMessage[] = [];
    const previousApi = {
      sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
        previousMessages.push({ message, options });
      },
    };
    const currentApi = {
      sendMessage(message: SentMessage["message"], options: SentMessage["options"]) {
        currentMessages.push({ message, options });
      },
    };
    const rendererApi = createMockExtensionApi();
    subagentsModule.default(rendererApi.api);
    const renderer = rendererApi.registeredMessageRenderers.find((entry) => entry.name === "subagent_result");
    assert.ok(renderer);
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    const renderPublished = (message: SentMessage["message"]) => renderer.renderer(
      { customType: "subagent_result", content: message.content, details: message.details },
      { expanded: true },
      theme,
    ).render(120).join("\n");
    const originalPi = testApi.runtime.pi;
    const originalHalted = testApi.runtime.halted;
    const running = {
      id: "async-initial",
      name: "Worker",
      task: "do work",
      agent: "worker",
      surface: "pane-async-initial",
      startTime: 1,
      sessionFile: "/tmp/async-initial.jsonl",
      cli: "pi",
      autoExit: false,
      interactive: false,
      cwd: "/work/worker",
      lifecycle: createLifecycle(1),
    };

    try {
      testApi.runtime.pi = currentApi;
      testApi.runtime.halted = false;
      testApi.deliverInitialCompletion(running, Promise.resolve({
        name: "Worker",
        task: "do work",
        summary: "real result",
        sessionFile: running.sessionFile,
        exitCode: 0,
        elapsed: 2,
      }), previousApi);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      assert.equal(previousMessages.length, 0);
      assert.equal(currentMessages.length, 1);
      assert.equal(currentMessages[0].message.customType, "subagent_result");
      assert.match(currentMessages[0].message.content, /real result/);
      assert.match(currentMessages[0].message.content, /Continue: subagent_prompt/);
      assert.equal(currentMessages[0].message.details.exitCode, 0);
      assert.equal(currentMessages[0].message.details.sessionFile, running.sessionFile);
      assert.equal(currentMessages[0].options.deliverAs, "steer");
      assert.match(renderPublished(currentMessages[0].message), /completed/);
      assert.equal(running.lifecycle.delivery, "delivered");

      const failed = {
        ...running,
        id: "async-initial-failed",
        sessionFile: "/tmp/async-initial-failed.jsonl",
        cli: "claude",
        lifecycle: createLifecycle(1),
      };
      testApi.deliverInitialCompletion(
        failed,
        Promise.reject<CompletionResult>(new Error("real failure")),
        previousApi,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      assert.equal(previousMessages.length, 0);
      assert.equal(currentMessages.length, 2);
      assert.match(currentMessages[1].message.content, /real failure/);
      assert.doesNotMatch(currentMessages[1].message.content, /completionApi/);
      assert.equal(currentMessages[1].options.deliverAs, "steer");
      assert.equal(currentMessages[1].message.details.id, failed.id);
      assert.equal(currentMessages[1].message.details.agent, failed.agent);
      assert.equal(currentMessages[1].message.details.cwd, failed.cwd);
      assert.equal(currentMessages[1].message.details.sessionFile, failed.sessionFile);
      assert.equal(currentMessages[1].message.details.exitCode, 1);
      assert.equal(currentMessages[1].message.details.errorMessage, "real failure");
      assert.equal(typeof currentMessages[1].message.details.elapsed, "number");
      assert.match(renderPublished(currentMessages[1].message), /failed/);

      const continued = {
        ...running,
        id: "continuation-failed",
        sessionFile: "/tmp/continuation-failed.jsonl",
        cli: "claude",
        lifecycle: createLifecycle(1),
      };
      testApi.deliverPromptCompletion(continued, Promise.reject<CompletionResult>("plain rejection"), previousApi);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      assert.equal(currentMessages.length, 3);
      assert.equal(currentMessages[2].message.details.id, continued.id);
      assert.equal(currentMessages[2].message.details.agent, continued.agent);
      assert.equal(currentMessages[2].message.details.cwd, continued.cwd);
      assert.equal(currentMessages[2].message.details.sessionFile, continued.sessionFile);
      assert.equal(currentMessages[2].message.details.exitCode, 1);
      assert.equal(currentMessages[2].message.details.errorMessage, "plain rejection");
      assert.equal(typeof currentMessages[2].message.details.elapsed, "number");
      assert.match(renderPublished(currentMessages[2].message), /failed/);

      const watcherError = {
        ...running,
        id: "watcher-error",
        sessionFile: "/tmp/watcher-error.jsonl",
        cli: "claude",
        lifecycle: createLifecycle(1),
      };
      testApi.deliverInitialCompletion(watcherError, Promise.resolve({
        name: watcherError.name,
        task: watcherError.task,
        summary: "watcher failed",
        sessionFile: watcherError.sessionFile,
        ...testApi.completionResultMetadata(watcherError, {
          reason: "error",
          exitCode: 1,
          errorMessage: "Subagent pane disappeared",
        }),
        elapsed: 4,
      }), previousApi);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      assert.equal(currentMessages.length, 4);
      assert.equal(currentMessages[3].message.details.errorMessage, "Subagent pane disappeared");
      assert.equal(currentMessages[3].message.details.exitCode, 1);
      const watcherRendered = renderPublished(currentMessages[3].message);
      assert.match(watcherRendered, /failed/);
      assert.doesNotMatch(watcherRendered, /provider\/agent|internal error/);

      const providerFailure = {
        ...running,
        id: "provider-failed",
        sessionFile: "/tmp/provider-failed.jsonl",
        cli: "claude",
        lifecycle: createLifecycle(1),
      };
      testApi.deliverInitialCompletion(providerFailure, Promise.resolve({
        name: providerFailure.name,
        task: providerFailure.task,
        summary: "ignored",
        sessionFile: providerFailure.sessionFile,
        ...testApi.completionResultMetadata(providerFailure, {
          reason: "error",
          exitCode: 1,
          errorMessage: "rate limited",
        }),
        elapsed: 5,
      }), previousApi);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const providerRendered = renderPublished(currentMessages[4].message);
      assert.match(providerRendered, /failed/);
      assert.match(providerRendered, /rate limited/);

      const exited = { ...providerFailure, id: "exit-17", lifecycle: createLifecycle(1) };
      testApi.deliverInitialCompletion(exited, Promise.resolve({
        name: exited.name, task: exited.task, summary: "exit", sessionFile: exited.sessionFile, exitCode: 17, elapsed: 6,
      }), previousApi);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.match(renderPublished(currentMessages[5].message), /Exit code 17/);

      const continuedSuccess = { ...providerFailure, id: "continuation-success", lifecycle: createLifecycle(1) };
      testApi.deliverPromptCompletion(continuedSuccess, Promise.resolve({
        name: continuedSuccess.name, task: continuedSuccess.task, summary: "done", sessionFile: continuedSuccess.sessionFile, exitCode: 0, elapsed: 7,
      }), previousApi);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.match(renderPublished(currentMessages[6].message), /completed/);

      const continuedProvider = { ...providerFailure, id: "continuation-provider", lifecycle: createLifecycle(1) };
      testApi.deliverPromptCompletion(continuedProvider, Promise.resolve({
        name: continuedProvider.name, task: continuedProvider.task, summary: "ignored", sessionFile: continuedProvider.sessionFile,
        ...testApi.completionResultMetadata(continuedProvider, { reason: "error", exitCode: 1, errorMessage: "overloaded" }), elapsed: 8,
      }), previousApi);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.match(renderPublished(currentMessages[7].message), /failed/);

      const continuedExit = { ...providerFailure, id: "continuation-exit", lifecycle: createLifecycle(1) };
      testApi.deliverPromptCompletion(continuedExit, Promise.resolve({
        name: continuedExit.name, task: continuedExit.task, summary: "exit", sessionFile: continuedExit.sessionFile, exitCode: 17, elapsed: 9,
      }), previousApi);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.match(renderPublished(currentMessages[8].message), /Exit code 17/);

      const whitespace = { ...providerFailure, id: "whitespace-error", lifecycle: createLifecycle(1) };
      testApi.deliverInitialCompletion(whitespace, Promise.resolve({
        name: whitespace.name, task: whitespace.task, summary: "done", sessionFile: whitespace.sessionFile,
        exitCode: 0, elapsed: 10, errorMessage: " \t\n ",
      }), previousApi);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.match(currentMessages[9].message.content, /completed/);
      assert.match(renderPublished(currentMessages[9].message), /completed/);
      assert.equal(currentMessages[9].message.details.errorMessage, undefined);

      assert.deepEqual(
        testApi.completionResultMetadata({ cli: "pi" }, { reason: "sentinel", exitCode: 0 }),
        { exitCode: 1, errorMessage: "Subagent Pi process exited before completion evidence was recorded." },
      );
    } finally {
      testApi.runtime.pi = originalPi;
      testApi.runtime.halted = originalHalted;
      testApi.runningSubagents.delete(running.id);
      testApi.subagentHandles.delete(running.id);
    }
  });

  void it("publishes owning ask metadata through initial and prompt completion without changing question layout", async () => {
    const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
    initTheme("dark");
    const { api, registeredMessageRenderers, sentMessages, appendedEntries } = createMockExtensionApi();
    subagentsModule.default(api);
    const testApi = Reflect.get(subagentsModule, "__test__");
    const questionRenderer = registeredMessageRenderers.find((entry) => entry.name === "subagent_ask");
    const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value };
    const originalHalted = testApi.runtime.halted;
    try {
      for (const [assignment, asyncMode] of [["initial", true], ["prompt", false]] as const) {
        const running = {
          id: `${assignment}-ask`, name: "Friendly", task: "Work", agent: "implementer", cwd: "/effective/cwd",
          surface: "recorded-pane", sessionFile: "/saved/child.jsonl", startTime: Date.now(), cli: "pi",
          orchestrationMode: asyncMode ? "async" : "wait-all", autoExit: false, interactive: false,
          lifecycle: createLifecycle(Date.now()), initialToolCallId: assignment === "initial" ? "initial-ask-call" : undefined,
        };
        testApi.runtime.halted = false;
        testApi.runningSubagents.set(running.id, running);
        const result = { name: running.name, task: running.task, summary: "", sessionFile: running.sessionFile,
          exitCode: 0, elapsed: 3, ask: { question: "Question one\nQuestion two" } };
        const publish = assignment === "initial" ? testApi.deliverInitialCompletion : testApi.deliverPromptCompletion;
        publish(running, Promise.resolve(result), api);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const published = sentMessages.at(-1);
        assert.equal(published.message.customType, "subagent_ask");
        assert.equal(published.message.display, true);
        assert.equal(published.message.content, `Sub-agent "Friendly" asks (3s):\n\nQuestion one\nQuestion two\nContinue: subagent_prompt({ id: "${running.id}", message: "..." })`);
        assert.deepEqual(published.message.details, {
          id: running.id, name: "Friendly", task: "Work", agent: "implementer", cwd: "/effective/cwd",
          async: asyncMode, surface: "recorded-pane", exitCode: 0, elapsed: 3,
          sessionFile: "/saved/child.jsonl", question: "Question one\nQuestion two",
        });
        assert.deepEqual(published.options, { triggerTurn: true, deliverAs: "steer" });
        assert.equal(running.initialToolCallId, undefined);
        assert.equal(running.lifecycle.delivery, "delivered");
        for (const expanded of [false, true]) {
          const output: string[] = questionRenderer.renderer(published.message, { expanded }, theme).render(80);
          assert.deepEqual(output.map((line) => stripTerminalSequences(line).trimEnd()), expanded ? [
            "", "", " ? Friendly (implementer) — asks", "", " Question one", " Question two", "", " Session: /saved/child.jsonl", "",
          ] : ["", "", " ? Friendly (implementer) — asks", " Question one", "  to expand", ""]);
        }
        testApi.runningSubagents.delete(running.id);
      }
      assert.equal(sentMessages.length, 2);
      assert.deepEqual(appendedEntries, []);
    } finally {
      testApi.runningSubagents.delete("initial-ask");
      testApi.runningSubagents.delete("prompt-ask");
      testApi.runtime.halted = originalHalted;
    }
  });

  it("abandons every Assignment on parent Escape without consuming it", () => {
    const testApi = (subagentsModule as any).__test__;
    const agents = new Map();
    const closed: string[] = [];
    let parentAborts = 0;
    const makeRunning = (id: string) => ({
      id,
      name: "Worker",
      task: "work",
      surface: `pane-${id}`,
      startTime: 1,
      sessionFile: `/tmp/${id}.jsonl`,
      cli: "pi",
      autoExit: false,
      interactive: false,
      abortController: new AbortController(),
      lifecycle: createLifecycle(1),
    });
    const makeHandle = (running: ReturnType<typeof makeRunning>) => ({
      id: running.id,
      name: running.name,
      sessionFile: running.sessionFile,
      surface: running.surface,
      state: "active" as const,
      subscribed: true,
      autoExit: running.autoExit,
      interactive: running.interactive,
      createdAt: running.startTime,
    });
    const first = makeRunning("escaped-first");
    const second = { ...makeRunning("escaped-second"), interactive: true };

    testApi.runtime.halted = false;
    for (const running of [first, second]) {
      beginCompletionChannel(running.sessionFile);
      agents.set(running.id, running);
      testApi.subagentHandles.set(running.id, makeHandle(running));
    }
    try {
      assert.equal(testApi.handleParentTerminalInput("x", { abort() {} }), false);
      assert.equal(
        testApi.abandonAllSubagents(
          { abort() { parentAborts += 1; } },
          agents,
          (surface: string) => {
            closed.push(surface);
            if (surface === second.surface) throw new Error("pane already gone");
          },
        ),
        2,
      );

      assert.equal(parentAborts, 1);
      assert.equal(agents.size, 0);
      assert.deepEqual(closed, [first.surface, second.surface]);
      for (const running of [first, second]) {
        assert.equal(running.abortController.signal.aborted, true);
        assert.equal(running.lifecycle.process.kind, "failed");
        assert.equal(running.lifecycle.delivery, "suppressed");
        assert.equal(existsSync(`${running.sessionFile}.exit`), false);
        const handle = testApi.subagentHandles.get(running.id);
        assert.equal(handle.state, "abandoned");
        assert.equal(handle.subscribed, false);
        assert.match(handlePromptError(handle, false) ?? "", /cannot be continued/);
      }
    } finally {
      testApi.runtime.halted = false;
      for (const running of [first, second]) {
        testApi.subagentHandles.delete(running.id);
        rmSync(`${running.sessionFile}.exit`, { force: true });
      }
    }
  });

  void it("records only accepted user abandonment across harnesses, modes, and assignments", async () => {
    const { api, sentMessages, sentUserMessages } = createMockExtensionApi();
    const manager = SessionManager.inMemory();
    api.appendEntry = (customType: string, data?: object) => manager.appendCustomEntry(customType, data);
    subagentsModule.default(api);
    const testApi = Reflect.get(subagentsModule, "__test__");
    const root = manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() });
    const otherBranch = manager.appendMessage({ role: "user", content: "other branch", timestamp: Date.now() });
    manager.branch(root);
    const originalHalted = testApi.runtime.halted;
    try {
      for (const cli of ["pi", "claude", "opencode", "codex", "grok", "custom"]) {
        for (const mode of ["async", "wait-all"]) {
          for (const assignment of ["initial", "continuation"]) {
            const running = {
              id: `${cli}-${mode}`, name: "Worker", task: assignment, cli, orchestrationMode: mode,
              surface: "recorded-pane", startTime: Date.now() - 2_000, sessionFile: "/recorded/session.jsonl",
              cwd: "/effective/cwd", agent: "implementer", autoExit: false, interactive: false,
              initialToolCallId: assignment === "initial" ? "initial-call" : undefined,
              lifecycle: createLifecycle(Date.now() - 2_000),
            };
            const agents = new Map([[running.id, running]]);
            const count = manager.getEntryCount();
            const leaf = manager.getLeafId();
            testApi.runtime.halted = false;
            assert.equal(testApi.abandonAllSubagents({ abort() {} }, agents, () => {}), 1);
            assert.equal(manager.getEntryCount(), count + 1);
            const entry = manager.getLeafEntry();
            assert.equal(entry?.type, "custom");
            if (entry?.type !== "custom") throw new Error("Expected native custom entry");
            assert.equal(entry.customType, "subagent_outcome");
            assert.equal(entry.parentId, leaf);
            assert.deepEqual(entry.data, {
              id: running.id, name: "Worker", task: assignment, agent: "implementer", cwd: "/effective/cwd",
              surface: "recorded-pane", async: mode === "async", elapsed: 2,
              sessionFile: "/recorded/session.jsonl", status: "abandoned", errorMessage: "Abandoned by user.",
            });
            assert.equal(running.initialToolCallId, undefined);
            assert.equal(testApi.abandonAllSubagents({ abort() {} }, agents, () => {}), 0);
            testApi.deliverPromptCompletion(running, Promise.resolve({
              name: "Worker", task: assignment, summary: "late", exitCode: 0, elapsed: 2,
            }), api);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            assert.equal(manager.getEntryCount(), count + 1, "late result cannot append again");
          }
        }
      }
      for (const delivery of ["delivered", "suppressed"] as const) {
        const settled = { id: delivery, name: "Worker", task: "asked or delivered", cli: "pi", autoExit: false,
          startTime: Date.now(), lifecycle: markDelivery(createLifecycle(Date.now()), delivery) };
        const count = manager.getEntryCount();
        assert.equal(testApi.abandonAllSubagents({ abort() {} }, new Map([[settled.id, settled]]), () => {}), 0);
        assert.equal(manager.getEntryCount(), count);
      }
      assert.equal(sentMessages.length, 0);
      assert.equal(sentUserMessages.length, 0);
      assert.deepEqual(manager.buildSessionContext().messages.map((message) => message.role), ["user"]);
      assert.equal(manager.getBranch().some((entry) => entry.id === otherBranch), false);
      manager.branch(otherBranch);
      assert.equal(manager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "subagent_outcome"), false);
    } finally {
      testApi.runtime.pi = api;
      testApi.runtime.halted = originalHalted;
    }
  });

  void it("rejects missing outcome runtime before mutating any assignment and preserves no-op calls", () => {
    const { api, appendedEntries } = createMockExtensionApi();
    subagentsModule.default(api);
    const testApi = Reflect.get(subagentsModule, "__test__");
    const originalHalted = testApi.runtime.halted;
    withTempDir((dir) => {
      const agents = new Map(["first", "second"].map((id) => [id, {
        id, name: "Worker", task: "work", cli: "pi", surface: `pane-${id}`, startTime: Date.now(),
        sessionFile: join(dir, `${id}.jsonl`), autoExit: false, interactive: false, inputLocked: true,
        initialToolCallId: id, abortController: new AbortController(), lifecycle: createLifecycle(Date.now()),
      }]));
      const lifecycles = new Map(Array.from(agents, ([id, running]) => [id, running.lifecycle]));
      const handles = Array.from(agents.values(), (running) => ({
        id: running.id, name: running.name, sessionFile: running.sessionFile, surface: running.surface,
        state: "active" as const, subscribed: true, autoExit: false, interactive: false, createdAt: running.startTime,
      }));
      let closes = 0;
      let parentAborts = 0;
      for (const running of agents.values()) {
        beginCompletionChannel(running.sessionFile);
        testApi.runningSubagents.set(running.id, running);
      }
      for (const handle of handles) testApi.subagentHandles.set(handle.id, handle);
      testApi.runtime.pi = undefined;
      testApi.runtime.halted = false;
      try {
        assert.throws(() => testApi.abandonAllSubagents({ abort() { parentAborts += 1; } }, agents, () => { closes += 1; }), /initialized extension runtime/);
        assert.equal(agents.size, 2);
        assert.equal(parentAborts, 0);
        assert.equal(closes, 0);
        assert.equal(testApi.runtime.halted, false);
        assert.deepEqual(appendedEntries, []);
        for (const running of agents.values()) {
          assert.equal(running.lifecycle, lifecycles.get(running.id));
          assert.equal(Reflect.get(running, "abandoned"), undefined);
          assert.equal(running.inputLocked, true);
          assert.equal(running.initialToolCallId, running.id);
          assert.equal(running.abortController.signal.aborted, false);
          assert.equal(testApi.runningSubagents.get(running.id), running);
          assert.equal(hasCompletionChannel(running.sessionFile), true);
          assert.deepEqual(testApi.subagentHandles.get(running.id), handles.find((handle) => handle.id === running.id));
        }
        assert.equal(testApi.abandonAllSubagents(undefined, new Map(), () => {}), 0);
        const settled = { ...agents.get("first")!, lifecycle: markDelivery(createLifecycle(Date.now()), "delivered") };
        assert.equal(testApi.abandonAllSubagents(undefined, new Map([[settled.id, settled]]), () => {}), 0);
        assert.deepEqual(appendedEntries, []);
      } finally {
        testApi.runtime.pi = api;
        testApi.runtime.halted = originalHalted;
        for (const handle of handles) {
          testApi.runningSubagents.delete(handle.id);
          testApi.subagentHandles.delete(handle.id);
        }
      }
    });
  });

  it("applies identical finalization to live and reopened continuations", () => {
    const testApi = (subagentsModule as any).__test__;
    const running = (id: string) => ({
      id,
      name: "Worker",
      task: "continue",
      surface: `pane-${id}`,
      startTime: 1,
      sessionFile: `/tmp/${id}.jsonl`,
      cli: "pi",
      autoExit: false,
      interactive: false,
      lifecycle: markCompletionDetected(createLifecycle(1), { reason: "done", exitCode: 0 }, 2),
    });
    const handle = (agent: ReturnType<typeof running>) => ({
      id: agent.id,
      name: agent.name,
      sessionFile: agent.sessionFile,
      surface: agent.surface,
      state: "active" as const,
      subscribed: true,
      autoExit: agent.autoExit,
      interactive: agent.interactive,
      createdAt: agent.startTime,
    });

    try {
      for (const source of ["live", "reopened"]) {
        const agent = running(`${source}-continuation`);
        testApi.runningSubagents.set(agent.id, agent);
        testApi.subagentHandles.set(agent.id, handle(agent));

        const outcome = testApi.applyAssignmentFinalization(agent, {
          name: agent.name, task: agent.task, summary: "done", sessionFile: agent.sessionFile, exitCode: 0, elapsed: 1,
        });

        assert.equal(outcome.disposition, "finalized", source);
        assert.equal(agent.lifecycle.process.kind, "completed", source);
        assert.equal(testApi.runningSubagents.has(agent.id), false, source);
        assert.deepEqual(testApi.subagentHandles.get(agent.id), { ...handle(agent), state: "finalized", subscribed: false }, source);
      }
    } finally {
      for (const id of ["live-continuation", "reopened-continuation"]) {
        testApi.runningSubagents.delete(id);
        testApi.subagentHandles.delete(id);
      }
    }
  });

  it("halts only fatal Pi failures and resumes only on human input", () => {
    const testApi = (subagentsModule as any).__test__;
    testApi.runtime.halted = false;
    let aborts = 0;
    assert.equal(testApi.haltOrchestrator({ abort: () => { aborts += 1; } }), true);
    assert.equal(testApi.haltOrchestrator({ abort: () => { aborts += 1; } }), false);
    assert.equal(aborts, 1);
    assert.deepEqual(testApi.completionDeliveryOptions(), { triggerTurn: false, deliverAs: "steer" });
    assert.equal(testApi.clearOrchestratorHalt("extension"), false);
    assert.equal(testApi.clearOrchestratorHalt("rpc"), false);
    assert.equal(testApi.clearOrchestratorHalt("interactive"), true);
    assert.deepEqual(testApi.completionDeliveryOptions(), { triggerTurn: true, deliverAs: "steer" });
  });
});

describe("subagent activity snapshots", () => {
  function validActivity(overrides: Record<string, unknown> = {}) {
    return {
      version: 1,
      runningChildId: "child-1",
      createdAt: 1_000,
      updatedAt: 1_000,
      sequence: 1,
      latestEvent: "session_start",
      phase: "starting",
      agentActive: false,
      turnActive: false,
      providerActive: false,
      toolActive: false,
      ...overrides,
    };
  }

  it("writes and validates activity files by running child id", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-1");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-1",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.toolExecutionStart("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-1");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "active");
      assert.equal(read.activity.activeScope, "tool");
      assert.equal(read.activity.toolName, "bash");

      assert.deepEqual(readSubagentActivityFile(activityFile, "other-child"), {
        ok: false,
        reason: "wrong-id",
      });
    });
  });

  it("records waiting and final done states", () => {
    withTempDir((dir) => {
      let currentNow = 2_000;
      const activityFile = getSubagentActivityFile(dir, "child-2");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-2",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      currentNow = 3_000;
      recorder.agentEndWaiting();
      let read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "waiting");
      assert.equal(read.activity.waitingSince, 3_000);

      currentNow = 4_000;
      recorder.assignmentFinalized();
      read = readSubagentActivityFile(activityFile, "child-2");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "done");
      assert.equal(read.activity.agentActive, false);
    });
  });

  it("rejects malformed activity fields used by classification and rendering", () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, "subagent-activity"), { recursive: true });
      const cases = [
        { activeSince: "bad" },
        { waitingSince: "bad" },
        { activeScope: "database" },
        { latestEvent: "unknown" },
        { runningChildId: 42 },
        { toolActive: "yes" },
        { toolName: "bad\nname" },
      ];

      for (const [index, overrides] of cases.entries()) {
        const activityFile = getSubagentActivityFile(dir, `child-${index}`);
        const activity = validActivity({ runningChildId: `child-${index}`, ...overrides });
        writeFileSync(activityFile, `${JSON.stringify(activity)}\n`);

        const read = readSubagentActivityFile(activityFile, `child-${index}`);
        assert.equal(read.ok, false);
        assert.equal((read as { ok: false; reason: string }).reason, "invalid");
      }
    });
  });

  it("does not let tool_result resurrect finished tool activity", () => {
    withTempDir((dir) => {
      let currentNow = 1_000;
      const activityFile = getSubagentActivityFile(dir, "child-3");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-3",
        activityFile,
        now: () => currentNow,
      });

      recorder.sessionStart();
      recorder.agentStart();
      recorder.turnStart(1);
      currentNow = 2_000;
      recorder.toolExecutionStart("tool-1", "bash");
      currentNow = 3_000;
      recorder.toolExecutionEnd("tool-1", "bash");
      currentNow = 4_000;
      recorder.toolResult("tool-1", "bash");

      const read = readSubagentActivityFile(activityFile, "child-3");
      assert.ok(read.ok);
      assert.equal(read.activity.toolActive, false);
      assert.equal(read.activity.activeScope, "turn");
    });
  });

  it("does not mark reload shutdown as the final done snapshot", () => {
    withTempDir((dir) => {
      const activityFile = getSubagentActivityFile(dir, "child-4");
      const recorder = createSubagentActivityRecorder({
        runningChildId: "child-4",
        activityFile,
        now: () => 1_000,
      });

      recorder.sessionStart();
      recorder.sessionShutdown("reload");

      const read = readSubagentActivityFile(activityFile, "child-4");
      assert.ok(read.ok);
      assert.equal(read.activity.phase, "starting");
      assert.equal(read.activity.latestEvent, "session_start");
    });
  });

  it("cancels pending throttled writes on reload shutdown", async () => {
    const dir = createTestDir();
    try {
      await new Promise<void>((resolve) => {
        let currentNow = 1_000;
        const activityFile = getSubagentActivityFile(dir, "child-5");
        const recorder = createSubagentActivityRecorder({
          runningChildId: "child-5",
          activityFile,
          now: () => currentNow,
        });

        recorder.sessionStart();
        currentNow = 1_100;
        recorder.messageUpdate("delta");
        recorder.sessionShutdown("reload");

        setTimeout(() => {
          const read = readSubagentActivityFile(activityFile, "child-5");
          assert.ok(read.ok);
          assert.equal(read.activity.phase, "starting");
          assert.equal(read.activity.latestEvent, "session_start");
          resolve();
        }, 650);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("status supervision", () => {
  it("sends no model-facing message when a subagent stalls and recovers", (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
    const { api, eventHandlers, sentMessages } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const testApi = (subagentsModule as any).__test__;

    const lifecycle = {
      ...createLifecycle(0),
      process: { kind: "running" as const, startedAt: 0, confirmedAt: 0 },
      pane: { kind: "read-error" as const, firstFailedAt: 0, lastFailedAt: 0, consecutiveFailures: 3 },
    };
    testApi.runningSubagents.set("stall-1", {
      id: "stall-1", name: "Worker", task: "", surface: "s1", startTime: 0,
      sessionFile: "w.jsonl", interactive: false, cli: "claude", lifecycle,
    });
    try {
      eventHandlers.get("session_start")![0]({}, {});
      const running = testApi.runningSubagents.get("stall-1");
      // Stall needs a 60s pane read failure; the status loop polls every 1s.
      t.mock.timers.tick(70_000);
      assert.equal(running.lastProjectedKind, "stalled", "stall must be observed");
      running.lifecycle = { ...running.lifecycle, pane: { kind: "present", observedAt: 70_000, agentStatus: "working" } };
      t.mock.timers.tick(2_000);
      assert.equal(running.lastProjectedKind, "running", "recovery must be observed");
      assert.deepEqual(sentMessages, [], "no model-facing message for stalled/recovered");
    } finally {
      testApi.runningSubagents.delete("stall-1");
      eventHandlers.get("session_shutdown")![0]({ reason: "quit" }, {});
    }
  });
});

describe("subagent result presentation", () => {
  it("returns subagent_ask through its wait-all tool result", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveWaitAllResultPresentation(
      { exitCode: 0, elapsed: 3, summary: "ignored", ask: { question: "Need a decision" } },
      "Worker",
      "worker-id",
    );

    assert.match(presentation, /asks/);
    assert.match(presentation, /Need a decision/);
    assert.match(presentation, /subagent_prompt/);
    assert.doesNotMatch(presentation, /completed/);
  });

  it("formats exit code 130 as an ordinary failure", () => {
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 130,
        elapsed: 61,
        summary: "Sub-agent exited with code 130",
        sessionFile: "/tmp/subagent.jsonl",
      },
      "Worker",
    );

    assert.match(presentation, /failed \(exit code 130\)/);
    assert.doesNotMatch(presentation, /interrupted/);
    assert.match(presentation, /Session: \/tmp\/subagent.jsonl/);
  });

  it("renders a clear failure when errorMessage is set", () => {
    // An errorMessage is canonical for provider and watcher failures. The
    // presentation must not infer a source category from it.
    const testApi = (subagentsModule as any).__test__;
    const presentation = testApi.resolveResultPresentation(
      {
        exitCode: 1,
        elapsed: 14,
        summary: "ignored when errorMessage is present",
        sessionFile: "/tmp/subagent.jsonl",
        errorMessage: "Anthropic 529 Overloaded after 3 retries",
      },
      "Worker",
    );

    assert.match(presentation, /Sub-agent "Worker" failed/);
    assert.doesNotMatch(presentation, /provider\/agent|internal error/);
    assert.match(presentation, /Error: Anthropic 529 Overloaded after 3 retries/);
    assert.match(presentation, /retry by spawning a new subagent/);
    assert.match(presentation, /Session: \/tmp\/subagent.jsonl/);
    assert.doesNotMatch(presentation, /ignored when errorMessage is present/);
  });
});

void describe("subagent result renderer", () => {
  void it("classifies persisted errors, provider errors, exits, and success", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    subagentsModule.default(api);
    const renderer = registeredMessageRenderers.find((entry) => entry.name === "subagent_result");
    assert.ok(renderer);
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => text,
    };
    const render = (details: object) => renderer.renderer(
      { customType: "subagent_result", content: "done", details },
      { expanded: true },
      theme,
    ).render(120).join("\n");

    const persistedErrorMessage = render({ name: "Worker", errorMessage: "old watcher error" });
    assert.match(persistedErrorMessage, /failed/);
    assert.match(persistedErrorMessage, /<error>◈<\/error><error> Worker<\/error>/);
    assert.doesNotMatch(persistedErrorMessage, /\?|completed|provider\/agent|internal error/);

    assert.match(render({ name: "Worker", exitCode: 0, errorMessage: "rate limited" }), /failed/);
    assert.match(render({ name: "Worker", exitCode: 17 }), /Exit code 17/);
    assert.match(render({ name: "Worker", exitCode: 0 }), /completed/);
    for (const status of ["completed", "finalized", "suppressed", "abandoned"]) {
      assert.match(render({ name: "Worker", status, exitCode: 0, errorMessage: "broken" }), /failed/);
    }
  });

  void it("renders display-only abandonment from its own data without terminal or registry effects", () => {
    const { api, registeredEntryRenderers, appendedEntries, sentMessages } = createMockExtensionApi();
    subagentsModule.default(api);
    const renderer = registeredEntryRenderers.find((entry) => entry.name === "subagent_outcome")!;
    const data = { id: "recorded-child", name: "Recorded", task: "Work", cwd: "/recorded/cwd", status: "abandoned",
      elapsed: 2, async: true, errorMessage: "Abandoned by user.", surface: "recorded-pane" };
    const theme = { fg: (color: string, value: string) => `<${color}>${value}</${color}>` };
    for (const expanded of [false, true]) {
      const component = renderer.renderer({ data }, { expanded }, theme)!;
      component.invalidate();
      assert.deepEqual(component.render(80), [
        "<error>◈</error><error> Recorded</error>",
        "<dim>│ </dim><error>/recorded/cwd</error>",
        "<dim>│ </dim><error>abandoned · async · 2s</error>",
        "<dim>└ </dim><error>Abandoned by user.</error>",
      ]);
    }
    assert.equal(renderer.renderer({}, { expanded: false }, theme), undefined);
    assert.deepEqual(appendedEntries, []);
    assert.deepEqual(sentMessages, []);
    const legacy = renderer.renderer({ data: { name: "Legacy", status: "abandoned", errorMessage: "Abandoned by user." } }, { expanded: false }, theme)!;
    const output = legacy.render(80).join("\n");
    assert.doesNotMatch(output, /async|cwd|0s|Exit code|failed/);
    assert.match(output, /abandoned/);
    const unknown = renderer.renderer({ data: { name: "Legacy" } }, { expanded: false }, theme)!;
    assert.doesNotMatch(unknown.render(80).join("\n"), /completed|failed|abandoned|async|0s/);
  });

  void it("hides continuation and raw-session details", () => {
    const { api, registeredMessageRenderers } = createMockExtensionApi();
    (subagentsModule as any).default(api);
    const renderer = registeredMessageRenderers.find((entry) => entry.name === "subagent_result");
    assert.ok(renderer);
    const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
    const output = renderer.renderer(
      { customType: "subagent_result", content: "done", details: { id: "child-1", name: "Worker", sessionFile: "/tmp/worker.jsonl" } },
      { expanded: true },
      theme,
    ).render(120).join("\n");

    assert.doesNotMatch(output, /Continue: subagent_prompt|Resume:.*pi --session|done/);
    for (const expanded of [false, true]) {
      const legacy = renderer.renderer({ customType: "subagent_result", content: "PRIVATE_RESULT" }, { expanded }, theme);
      assert.deepEqual(legacy.render(80), []);
    }
  });
});

void describe("subagent tool UI adapters", () => {
  void it("never renders outbound input through native calls, shared adapters or replay", async () => {
    const source = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", source).href);
    const { CustomMessageComponent } = await import(new URL("./modes/interactive/components/custom-message.js", source).href);
    const { CustomEntryComponent } = await import(new URL("./modes/interactive/components/custom-entry.js", source).href);
    const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", source).href);
    initTheme("dark");
    const mock = createMockExtensionApi();
    subagentsModule.default(mock.api);
    const owner = Reflect.get(subagentsModule, "__test__");
    const secrets = ["SECRET_FOLLOWUP", "SECRET_LONG_TASK", "SECRET_MULTILINE_TASK", "SECRET_RECORDED_TASK", "SECRET_RAW_RESULT"];
    const check = (component: Component) => {
      for (const expanded of [false, true]) {
        Reflect.get(component, "setExpanded").call(component, expanded);
        for (const width of [120, 20, 3, 2, 1, 0]) {
          const output = stripTerminalSequences(component.render(width).join("\n")).replace(/[◈│└\s]/g, "");
          for (const secret of secrets) assert.ok(!output.includes(secret), `outbound input leaked: ${secret}`);
        }
        component.invalidate();
      }
    };
    // Prompt cases first: native formatToolCallWithArgs must never handle message args.
    for (const [toolName, args, label] of [
      ["subagent_prompt", '{"message":"SECRET_FOLLOWUP', "subagent"],
      ["subagent_prompt", { message: "SECRET_FOLLOWUP" }, "subagent"],
      ["subagent_prompt", { id: "private-identity", message: "SECRET_FOLLOWUP\nsecond outgoing line" }, "subagent"],
      ["subagent", '{"task":"SECRET_MULTILINE_TASK', "subagent"],
      ["subagent", { task: `SECRET_LONG_TASK${"x".repeat(200)}` }, "subagent"],
      ["subagent", { task: "\nSECRET_MULTILINE_TASK\nsecond outgoing line" }, "subagent"],
      ["subagent", { agent: "scout", task: "SECRET_LONG_TASK" }, "scout"],
      ["subagent", { name: "Friendly", agent: "scout", task: "SECRET_LONG_TASK" }, "Friendly"],
    ] as const) {
      const tool = mock.registeredTools.find((entry) => entry.name === toolName);
      const make = () => new ToolExecutionComponent(toolName, "privacy-call", args, {}, tool, { requestRender() {} }, process.cwd());
      const component = make();
      const argsBefore = JSON.stringify(args);
      check(component);
      component.updateArgs(args);
      check(component);
      assert.match(stripTerminalSequences(component.render(120).join("\n")), new RegExp(label));
      for (const details of [
        { name: "Friendly", agent: "scout", status: "started", async: true },
        { status: "continued", async: true },
        { name: "Friendly", exitCode: 0, elapsed: 2 },
        { name: "Friendly", status: "wait_cancelled" },
        { name: "Friendly", errorMessage: "canonical failure" },
        { errorMessage: "Could not prompt subagent private-identity: Command failed: herdr agent prompt pane SECRET_FOLLOWUP\nsecond outgoing line" },
        undefined,
      ]) {
        const result = { content: [{ type: "text", text: "SECRET_RAW_RESULT" }],
          details: details && { ...details, task: "SECRET_RECORDED_TASK" }, isError: !details };
        const snapshot = JSON.stringify(result);
        component.updateResult(result, false);
        const replay = make();
        replay.updateResult(JSON.parse(snapshot), false);
        for (const row of [component, replay]) check(row);
        const output = stripTerminalSequences(component.render(120).join("\n"));
        if (details?.errorMessage === "canonical failure") assert.match(output, /canonical failure/);
        if (details?.errorMessage?.includes("Command failed:")) assert.match(output, /Could not prompt subagent\./);
        assert.equal(JSON.stringify(result), snapshot, "model content and recorded details stay untouched");
      }
      assert.equal(JSON.stringify(args), argsBefore, "native raw args stay untouched");
    }
    const tool = mock.registeredTools.find((entry) => entry.name === "subagent");
    const running = { id: "privacy-live", name: "Friendly", agent: "scout", task: "SECRET_MULTILINE_TASK\nsecond outgoing line",
      cwd: "/effective/cwd", startTime: Date.now(), initialToolCallId: "privacy-live-call", orchestrationMode: "async",
      lifecycle: createLifecycle(Date.now()) };
    owner.runningSubagents.set(running.id, running);
    try {
      const component = new ToolExecutionComponent("subagent", "privacy-live-call", { task: "SECRET_LONG_TASK" }, {}, tool,
        { requestRender() {} }, process.cwd());
      const snapshot = JSON.stringify(running);
      component.markExecutionStarted();
      check(component);
      component.updateResult({ content: [], details: { id: running.id, status: "started", task: "SECRET_RECORDED_TASK" } }, false);
      check(component);
      assert.equal(JSON.stringify(running), snapshot, "live presentation never mutates operational task");
    } finally {
      owner.runningSubagents.delete(running.id);
    }
    const session = SessionManager.inMemory();
    const details = { id: "recorded-identity", name: "Friendly", agent: "scout", task: "SECRET_RECORDED_TASK", cwd: "/recorded/cwd",
      elapsed: 2, async: true, errorMessage: "Command failed: herdr agent prompt pane SECRET_FOLLOWUP\nsecond outgoing line" };
    session.appendCustomMessageEntry("subagent_result", "SECRET_RAW_RESULT", true, details);
    session.appendCustomEntry("subagent_outcome", { ...details, status: "abandoned" });
    const messageRenderer = mock.registeredMessageRenderers.find((entry) => entry.name === "subagent_result").renderer;
    const entryRenderer = mock.registeredEntryRenderers.find((entry) => entry.name === "subagent_outcome")!;
    const branch = session.getBranch();
    const snapshot = JSON.stringify(branch);
    for (const entries of [branch, JSON.parse(snapshot)]) {
      for (const entry of entries) {
        if (entry.type === "custom_message") check(new CustomMessageComponent({ ...entry, role: "custom" }, messageRenderer));
        if (entry.type === "custom") check(new CustomEntryComponent(entry, entryRenderer.renderer.bind(entryRenderer)));
      }
    }
    assert.equal(JSON.stringify(session.getBranch()), snapshot, "presentation leaves persisted input and model messages intact");
    assert.match(JSON.stringify(session.buildSessionContext().messages), /SECRET_RAW_RESULT/);
    assert.deepEqual(mock.sentMessages, []);
    assert.deepEqual(mock.appendedEntries, []);
  });

  void it("supports native MouseRegion invalidation for every shared transcript adapter", () => {
    const { api, registeredTools, registeredMessageRenderers } = createMockExtensionApi();
    subagentsModule.default(api);
    const tool = registeredTools.find((entry) => entry.name === "subagent");
    const renderer = registeredMessageRenderers.find((entry) => entry.name === "subagent_result");
    const questionRenderer = registeredMessageRenderers.find((entry) => entry.name === "subagent_ask");
    const theme = { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value };
    const context = { toolCallId: "invalidation-call", executionStarted: false, invalidate() {}, state: {} };
    const details = { name: "Worker", task: "run", exitCode: 0 };
    const components = [
      tool.renderCall({ name: "Worker", task: "run" }, theme, context),
      tool.renderResult({ content: [], details }, { expanded: false }, theme, context),
      renderer.renderer({ customType: "subagent_result", content: "hidden", details }, { expanded: true }, theme),
      questionRenderer.renderer({ customType: "subagent_ask", details: { name: "Worker", question: "Need input" } }, { expanded: true }, theme),
    ];
    for (const component of components) {
      const region = new MouseRegion(component, () => undefined);
      const rendered = region.render(80);
      assert.doesNotThrow(() => region.invalidate());
      assert.deepEqual(region.render(80), rendered);
    }
  });

  void it("keeps native ToolExecutionComponent composition bounded on first result and refresh", async () => {
    const source = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", source).href);
    const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", source).href);
    initTheme("dark");
    const { api, registeredTools } = createMockExtensionApi();
    subagentsModule.default(api);
    const tool = registeredTools.find((entry) => entry.name === "subagent");
    let requests = 0;
    for (const result of [
      { details: { name: "Worker", task: "Work", status: "started", async: true } },
      { details: { name: "Worker", task: "Work", exitCode: 0, elapsed: 1 } },
      { details: { name: "Worker", task: "Work", status: "wait_cancelled" } },
      { details: { name: "Worker", task: "Work", exitCode: 1, elapsed: 1, errorMessage: "broken" } },
      { details: undefined, isError: true },
      { details: undefined, isError: false },
    ]) {
      const component = new ToolExecutionComponent("subagent", "native-composition", { name: "Worker", task: "Work" }, {}, tool,
      { requestRender() { requests += 1; } }, process.cwd());
      assert.equal(component.render(80).filter((line: string) => line.includes("◈")).length, 1);
      component.updateResult({ content: [{ type: "text", text: "PRIVATE_MODEL_RESPONSE" }], ...result }, false);
      for (let refresh = 0; refresh < 3; refresh += 1) {
        const lines: string[] = component.render(80);
        assert.equal(lines.filter((line) => line.includes("◈")).length, result.details || result.isError ? 1 : 0);
        assert.equal(component.selfRenderContainer.children.length, 2);
        assert.doesNotMatch(lines.join("\n"), /PRIVATE_MODEL_RESPONSE/);
        if (result.isError) assert.match(lines.join("\n"), /failed[\s\S]*Unknown error/);
        if (result.details?.status === "wait_cancelled") {
          assert.match(lines.join("\n"), /wait cancelled/);
          assert.doesNotMatch(lines.join("\n"), /wait_cancelled/);
          assert.equal(component.result.details.status, "wait_cancelled");
        }
        component.invalidate();
      }
      assert.equal(requests, 0, "renderers never request a reentrant render");
    }
  });

  void it("renders historical native prompt cards through shared own-record presentation", async (t) => {
    const source = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", source).href);
    const { initTheme, theme } = await import(new URL("./modes/interactive/theme/theme.js", source).href);
    initTheme("dark");
    t.mock.timers.enable({ apis: ["Date"], now: 100_000 });
    const mock = createMockExtensionApi();
    subagentsModule.default(mock.api);
    const owner = Reflect.get(subagentsModule, "__test__");
    const tool = mock.registeredTools.find((entry) => entry.name === "subagent_prompt");
    const renderer = mock.registeredMessageRenderers.find((entry) => entry.name === "subagent_result").renderer;
    const id = "prompt-own";
    const handle: SubagentHandle = { id, name: "Current label", agent: "current-role", cwd: "/current/cwd", surface: "current-pane",
      sessionFile: "/saved.jsonl", state: "active", createdAt: 1, autoExit: false, interactive: true };
    const running = { ...handle, startTime: 1, orchestrationMode: "async", initialToolCallId: "newer-prompt-call", lifecycle: createLifecycle(1) };
    owner.subagentHandles.set(id, handle);
    owner.runningSubagents.set(id, running);
    let requests = 0;
    const make = () => new ToolExecutionComponent("subagent_prompt", id, { id, message: "PRIVATE_MESSAGE" }, {}, tool,
      { requestRender() { requests += 1; } }, process.cwd());
    try {
      assert.equal(tool.renderShell, "self");
      const call = make();
      assert.deepEqual(stripTerminalSequences(call.render(120).join("\n")), "\n◈ current-role — Current label\n└ /current/cwd");
      const cachedCall = call.callRendererComponent;
      t.mock.timers.tick(5_000);
      assert.equal(call.callRendererComponent, cachedCall);
      assert.doesNotMatch(call.render(120).join("\n"), /active|async|104s|PRIVATE_MESSAGE/);
      const snapshot = JSON.stringify(running);
      for (const result of [
        { details: { id, name: "Recorded label", agent: "recorded-role", cwd: "/recorded/项目/cwd", status: "started", async: false } },
        { details: { id, name: "Recorded label", agent: "recorded-role", cwd: "/recorded/项目/cwd", status: "continued", async: true } },
        { details: { id, name: "Recorded label", agent: "recorded-role", cwd: "/recorded/项目/cwd", status: "wait_cancelled", async: false } },
        { details: { id, name: "Recorded label", agent: "recorded-role", cwd: "/recorded/项目/cwd", exitCode: 0, elapsed: 7, async: false } },
        { details: { id, name: "Recorded label", agent: "recorded-role", cwd: "/recorded/项目/cwd", errorMessage: "Long canonical failure reason wraps", elapsed: 8, async: true } },
        { details: { id, status: "continued" } },
        { details: undefined, isError: true },
        { details: undefined, isError: false },
      ]) {
        const component = make();
        const modelResult = { content: [{ type: "text", text: "PRIVATE_RESPONSE" }], ...result };
        const saved = JSON.stringify(modelResult);
        component.updateResult(modelResult, true);
        const replay = make();
        replay.updateResult(JSON.parse(saved), false);
        const cached = [component.callRendererComponent, component.resultRendererComponent];
        const expected = result.details ? renderer({ details: result.details }, {}, theme) : undefined;
        for (const expanded of [false, true]) {
          component.setExpanded(expanded);
          replay.setExpanded(expanded);
          for (const width of [120, 20, 8, 3, 2, 1, 0]) {
            const lines: string[] = component.render(width);
            assert.deepEqual(lines, replay.render(width));
            if (expected) assert.deepEqual(lines, width === 0 ? [] : ["", ...expected.render(width)]);
            assert.equal(lines.filter((line) => line.includes("◈")).length, width > 0 ? 1 : 0);
            assert.ok(lines.every((line) => visibleWidth(line) <= width));
            assert.deepEqual(component.callRendererComponent.render(width), []);
            assert.equal(component.selfRenderContainer.children.length, 2);
            assert.doesNotMatch(lines.join("\n"), /PRIVATE_MESSAGE|PRIVATE_RESPONSE|current-role|Current label|\/current/);
          }
          component.invalidate();
          assert.deepEqual(component.render(120), replay.render(120));
        }
        const text = stripTerminalSequences(component.render(120).join("\n"));
        if (result.details?.name) assert.match(text, /◈ recorded-role — Recorded label/);
        if (!result.details?.elapsed) assert.doesNotMatch(text, /\d+s/);
        if (result.details?.async === false) assert.doesNotMatch(text, /async/);
        if (result.details?.status === "started") assert.match(text, /started/);
        if (result.isError) assert.match(text, /failed[\s\S]*Unknown error/);
        if (!result.details && !result.isError) assert.equal(text, "\n◈ subagent");
        component.updateResult(modelResult, false);
        const beforeTick = component.render(120);
        const cachedResult = component.resultRendererComponent;
        t.mock.timers.tick(5_000);
        assert.deepEqual(component.render(120), beforeTick);
        assert.equal(component.resultRendererComponent, cachedResult);
        assert.ok(cached.every((entry) => entry instanceof MouseRegion));
        assert.equal(JSON.stringify(modelResult), saved);
      }
      assert.equal(JSON.stringify(running), snapshot, "prompt presentation never reactivates or alters initial association");
      assert.equal(requests, 0);
      assert.deepEqual(mock.sentMessages, []);
      assert.deepEqual(mock.appendedEntries, []);
    } finally {
      owner.subagentHandles.delete(id);
      owner.runningSubagents.delete(id);
    }
  });

  void it("repaints only current cached native prompt assignment through widget ticks and detaches every outcome", async (t) => {
    const source = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", source).href);
    const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", source).href);
    initTheme("dark");
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100_000 });
    const mock = createMockExtensionApi();
    subagentsModule.default(mock.api);
    const owner: typeof subagentsModule.__test__ = Reflect.get(subagentsModule, "__test__");
    const previous = { ctx: owner.runtime.latestCtx, halted: owner.runtime.halted, shuttingDown: owner.runtime.shuttingDown };
    const tool = mock.registeredTools.find((entry) => entry.name === "subagent_prompt");
    const initialTool = mock.registeredTools.find((entry) => entry.name === "subagent");
    const callFactory = t.mock.method(tool, "renderCall");
    const resultFactory = t.mock.method(tool, "renderResult");
    const dir = createTestDir();
    owner.setInspectionTestAdapters({ closePane() {} });
    try {
      for (const mode of ["async", "wait-all"] as const) {
        const outcomes = mode === "async" ? ["completed", "ask", "failed", "rejected", "abandoned"] as const
          : ["completed", "ask", "failed", "abandoned", "wait_cancelled"] as const;
        for (const outcome of outcomes) {
          const id = `${mode}-${outcome}-prompt`;
          const sessionFile = createSessionFile(dir, [SESSION_HEADER]);
          const handle: SubagentHandle = { id, name: "Worker", agent: "implementer", cwd: dir, sessionFile,
            surface: "mock-pane", state: "awaiting_answer", subscribed: false, createdAt: 1, autoExit: false, interactive: false };
          const running = { ...handle, task: "PRIVATE_OLD_TASK", startTime: 1, cli: "pi", runtimePlan: undefined,
            orchestrationMode: mode, inputLocked: false, lifecycle: markDelivery(createLifecycle(1), "delivered"),
            initialToolCallId: undefined as string | undefined, abortController: new AbortController() };
          owner.subagentHandles.set(id, handle);
          owner.runningSubagents.set(id, running);
          const oldRows = [initialTool, tool].map((definition, index) => {
            const row = new ToolExecutionComponent(definition.name, `old-${index}`, { id, task: "PRIVATE_OLD_TASK", message: "PRIVATE_OLD_TASK" }, {}, definition,
              { requestRender() {} }, process.cwd());
            row.updateResult({ content: [{ type: "text", text: "PRIVATE_RESPONSE" }], details: { ...handle, status: index === 0 ? "started" : "continued", async: true } }, false);
            return row;
          });
          const oldRecorded = oldRows.map((row) => row.render(80));
          let requests = 0;
          const row = new ToolExecutionComponent("subagent_prompt", id, { id, message: "PRIVATE_MESSAGE" }, {}, tool,
            { requestRender() { requests += 1; } }, process.cwd());
          row.markExecutionStarted();
          let painted: string[] = [];
          let paints = 0;
          const ctx = { hasUI: true, abort() {}, sessionManager: { getSessionId: () => "parent", getSessionDir: () => dir },
            ui: { setWidget() { paints += 1; painted = row.render(80); } } };
          Reflect.set(owner.runtime, "latestCtx", ctx);
          owner.runtime.shuttingDown = false;
          owner.runtime.halted = false;
          const terminal = { name: "Worker", task: "PRIVATE_MESSAGE", summary: "PRIVATE_RESPONSE", sessionFile, elapsed: 2,
            exitCode: outcome === "failed" ? 1 : 0, ...(outcome === "failed" ? { errorMessage: "canonical failure" } : {}),
            ...(outcome === "ask" ? { ask: { question: "INCOMING_QUESTION" } } : {}) };
          let finish!: (result: typeof terminal) => void;
          let reject!: (cause: Error) => void;
          owner.setExecutionTestAdapters(undefined, () => new Promise<typeof terminal>((resolve, fail) => { finish = resolve; reject = fail; }), () => true,
            (_pane, message) => { assert.equal(message, "PRIVATE_MESSAGE"); });
          const signal = new AbortController();
          const acceptedAt = Date.now();
          const calls = callFactory.mock.callCount();
          const execution = tool.execute(id, { id, message: "PRIVATE_MESSAGE" }, signal.signal, undefined, ctx);
          await Promise.resolve();
          await Promise.resolve();
          assert.match(stripTerminalSequences(painted.join("\n")), /starting.*0s/);
          assert.equal(running.startTime, acceptedAt);
          assert.equal(running.initialToolCallId, id);
          assert.equal(callFactory.mock.callCount(), calls);
          if (mode === "async") row.updateResult(await execution, false);
          const cached = [row.callRendererComponent, row.resultRendererComponent];
          const factories = [callFactory.mock.callCount(), resultFactory.mock.callCount()];
          running.lifecycle = observePaneInspection(running.lifecycle, { kind: "present", agent: "pi", agentStatus: "working" }, Date.now());
          t.mock.timers.tick(1_000);
          assert.match(stripTerminalSequences(painted.join("\n")), /active.*1s/);
          const beforeTick = paints;
          t.mock.timers.tick(1_000);
          assert.ok(paints > beforeTick);
          assert.match(stripTerminalSequences(painted.join("\n")), /active.*2s/);
          assert.deepEqual([row.callRendererComponent, row.resultRendererComponent], cached);
          assert.deepEqual([callFactory.mock.callCount(), resultFactory.mock.callCount()], factories);
          for (const expanded of [false, true]) {
            row.setExpanded(expanded);
            for (const width of [80, 20, 3, 2, 1, 0]) {
              const lines: string[] = row.render(width);
              assert.equal(lines.filter((line) => line.includes("◈")).length, width > 0 ? 1 : 0);
              assert.ok(lines.every((line) => visibleWidth(line) <= width));
              assert.doesNotMatch(lines.join("\n"), /PRIVATE_MESSAGE|PRIVATE_RESPONSE|PRIVATE_OLD_TASK/);
            }
          }
          assert.deepEqual(oldRows.map((old) => old.render(80)), oldRecorded);
          if (outcome === "wait_cancelled" && mode === "wait-all") {
            signal.abort();
            row.updateResult(await execution, false);
            assert.equal(running.initialToolCallId, undefined);
            assert.equal(running.abortController.signal.aborted, false);
            assert.equal(running.lifecycle.delivery, "pending");
          }
          if (outcome === "abandoned") owner.abandonAllSubagents({ abort() { signal.abort(); } }, owner.runningSubagents, () => {});
          if (outcome === "rejected") reject(new Error("canonical failure"));
          else finish(terminal);
          if (mode === "wait-all" && outcome !== "wait_cancelled") row.updateResult(await execution, false);
          await Promise.resolve();
          await Promise.resolve();
          assert.equal(running.initialToolCallId, undefined);
          const settled = row.render(80);
          const settledText = stripTerminalSequences(settled.join("\n"));
          if (mode === "async") {
            assert.match(settledText, /continued · async/);
            assert.doesNotMatch(settledText, /2s|canonical failure/);
          } else if (outcome === "abandoned" || outcome === "wait_cancelled") {
            assert.match(settledText, /wait cancelled/);
            assert.doesNotMatch(settledText, /2s/);
          } else {
            assert.match(settledText, outcome === "failed" ? /failed · 2s[\s\S]*canonical failure/ : /completed · 2s/);
          }
          if (outcome === "ask") {
            const next = tool.execute(`${id}-next`, { id, message: "PRIVATE_MESSAGE" }, signal.signal, undefined, ctx);
            await Promise.resolve();
            await Promise.resolve();
            assert.equal(running.initialToolCallId, `${id}-next`);
            assert.deepEqual(row.render(80), settled, "previous prompt stays recorded after accepted same-id continuation");
            assert.deepEqual(oldRows.map((old) => old.render(80)), oldRecorded);
            finish({ ...terminal, ask: undefined });
            await next;
            await Promise.resolve();
          }
          assert.equal(requests, 1, "only native execution-start requests render");
          owner.runningSubagents.delete(id);
          owner.subagentHandles.delete(id);
          mock.eventHandlers.get("session_shutdown")![0]({ reason: "reload" }, {});
        }
      }
    } finally {
      owner.setExecutionTestAdapters(undefined, undefined, undefined);
      owner.setInspectionTestAdapters();
      mock.eventHandlers.get("session_shutdown")![0]({ reason: "quit" }, {});
      Reflect.set(owner.runtime, "latestCtx", previous.ctx);
      owner.runtime.halted = previous.halted;
      owner.runtime.shuttingDown = previous.shuttingDown;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("repaints cached native initial rows on widget ticks without invalidation or rebuild", async (t) => {
    const source = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", source).href);
    const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", source).href);
    initTheme("dark");
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
    const { api, registeredTools, eventHandlers } = createMockExtensionApi();
    subagentsModule.default(api);
    const testApi = Reflect.get(subagentsModule, "__test__");
    const originalCtx = testApi.runtime.latestCtx;
    const originalHalted = testApi.runtime.halted;
    const tool = registeredTools.find((entry) => entry.name === "subagent");
    const callFactory = t.mock.method(tool, "renderCall");
    const resultFactory = t.mock.method(tool, "renderResult");
    try {
      for (const mode of ["async", "wait-all"] as const) {
        for (const outcome of ["completed", "ask", "failed", "abandoned"] as const) {
          const id = `${mode}-${outcome}`;
          let rowRequests = 0;
          const component = new ToolExecutionComponent("subagent", id, { name: "Worker", task: "initial" }, {}, tool,
            { requestRender() { rowRequests += 1; } }, process.cwd());
          assert.match(component.render(80).join("\n"), /starting/);
          component.markExecutionStarted();
          assert.deepEqual(component.render(80), [], "cached pending call has no active assignment yet");
          let repaints = 0;
          let painted: string[] = [];
          const ctx = { hasUI: true, sessionManager: { getEntries: () => [], getSessionFile: () => "/parent.jsonl" },
            ui: { setWidget() { repaints += 1; painted = component.render(80); } } };
          const running = { id, name: "Worker", task: "initial", cwd: "/effective/cwd", surface: "mock-pane",
            startTime: Date.now(), sessionFile: "/mock-child.jsonl", cli: "claude", autoExit: false, interactive: false,
            orchestrationMode: mode, initialToolCallId: id, lifecycle: createLifecycle(Date.now()) };
          testApi.runningSubagents.set("other-active", { ...running, id: "other-active", initialToolCallId: "other-call" });
          eventHandlers.get("session_start")![0]({}, ctx);
          const terminal = { name: "Worker", task: "initial", summary: "PRIVATE_RESPONSE", elapsed: 2,
            exitCode: outcome === "failed" ? 1 : 0, ...(outcome === "failed" ? { errorMessage: "failure" } : {}),
            ...(outcome === "ask" ? { ask: { question: "PRIVATE_QUESTION" } } : {}) };
          let finish!: (result: typeof terminal) => void;
          testApi.runtime.halted = false;
          testApi.setExecutionTestAdapters(async () => {
            testApi.runningSubagents.set(id, running);
            return running;
          }, () => new Promise<typeof terminal>((resolve) => { finish = resolve; }), () => true);
          const signal = new AbortController();
          try {
            const callsBeforeLaunch = callFactory.mock.callCount();
            const paintsBeforeLaunch = repaints;
            const execution = tool.execute(id, { name: "Worker", task: "initial", fork: true }, signal.signal, undefined, ctx);
            await Promise.resolve();
            assert.ok(repaints > paintsBeforeLaunch, "launch repaints immediately even with existing widget timer");
            assert.match(painted.join("\n"), /starting.*0s/);
            assert.equal(callFactory.mock.callCount(), callsBeforeLaunch, "registration does not rebuild cached call");
            assert.equal(rowRequests, 1, "only native execution-start event requests row render");
            if (mode === "async") component.updateResult(await execution, false);
            const factories = [callFactory.mock.callCount(), resultFactory.mock.callCount()];
            const cachedCall = component.callRendererComponent;
            const cachedResult = component.resultRendererComponent;
            t.mock.timers.tick(1_000);
            const beforeStableTick = repaints;
            t.mock.timers.tick(1_000);
            assert.equal(repaints, beforeStableTick + 1, "stable lifecycle still repaints through widget tick");
            assert.match(painted.join("\n"), /starting.*2s/);
            assert.equal(component.callRendererComponent, cachedCall);
            assert.equal(component.resultRendererComponent, cachedResult);
            assert.deepEqual([callFactory.mock.callCount(), resultFactory.mock.callCount()], factories);
            const beforeTransition = repaints;
            if (outcome === "abandoned") testApi.abandonAllSubagents({ abort() { signal.abort(); } }, testApi.runningSubagents, () => {});
            finish(terminal);
            if (mode === "wait-all") component.updateResult(await execution, false);
            await Promise.resolve();
            await Promise.resolve();
            assert.ok(repaints > beforeTransition, "terminal transition uses existing widget repaint");
            assert.equal(running.initialToolCallId, undefined);
            const settled: string[] = component.render(80);
            assert.equal(settled.filter((line) => line.includes("◈")).length, 1);
            assert.doesNotMatch(settled.join("\n"), /PRIVATE_RESPONSE|PRIVATE_QUESTION/);
            if (mode === "async") {
              assert.match(settled.join("\n"), /started · async/);
              assert.doesNotMatch(settled.join("\n"), /2s|failure/);
              assert.equal(component.resultRendererComponent, cachedResult, "async launch retains owning recorded result");
            } else {
              assert.match(settled.join("\n"), outcome === "failed" ? /failed · 2s/ : outcome === "abandoned" ? /wait cancelled/ : /completed · 2s/);
            }
            const settledFactories = [callFactory.mock.callCount(), resultFactory.mock.callCount()];
            if (outcome === "ask") {
              running.task = "continuation";
              running.lifecycle = createLifecycle(Date.now());
              t.mock.timers.tick(1_000);
              assert.deepEqual(component.render(80), settled, "ask-retained reuse never reactivates original row");
            }
            assert.deepEqual(component.render(80), settled);
            assert.deepEqual([callFactory.mock.callCount(), resultFactory.mock.callCount()], settledFactories);
            assert.equal(rowRequests, 1, "clocks and detach never invalidate native tool rows");
          } finally {
            if (typeof finish === "function") finish(terminal);
            await Promise.resolve();
            testApi.setExecutionTestAdapters(undefined, undefined, undefined);
            eventHandlers.get("session_shutdown")![0]({ reason: "quit" }, {});
          }
        }
      }
    } finally {
      testApi.setExecutionTestAdapters(undefined, undefined, undefined);
      testApi.runtime.latestCtx = originalCtx;
      testApi.runtime.halted = originalHalted;
      eventHandlers.get("session_shutdown")![0]({ reason: "quit" }, {});
    }
  });

  void it("returns native wait cancellation and preserves completion delivery or Escape suppression", async () => {
    const { api, registeredTools, eventHandlers, sentMessages, appendedEntries } = createMockExtensionApi();
    subagentsModule.default(api);
    const tool = registeredTools.find((entry) => entry.name === "subagent");
    const testApi = Reflect.get(subagentsModule, "__test__");
    let finish!: (result: object) => void;
    const ctx = { sessionManager: { getSessionFile: () => "/parent.jsonl" } };
    testApi.setExecutionTestAdapters(async (params: { name: string; task: string }, _ctx: unknown, _thinking: string, options: { toolCallId: string }) => {
      const running = { id: options.toolCallId, name: params.name, task: params.task, cwd: "/work", surface: "mock-pane",
        sessionFile: "/child.jsonl", cli: "claude", orchestrationMode: "wait-all", autoExit: false, interactive: false,
        startTime: Date.now(), initialToolCallId: options.toolCallId, lifecycle: createLifecycle(Date.now()) };
      testApi.runningSubagents.set(running.id, running);
      return running;
    }, () => new Promise<object>((resolve) => { finish = resolve; }), () => true);
    const originalHalted = testApi.runtime.halted;
    try {
      for (const userAbandoned of [false, true]) {
        testApi.runtime.halted = false;
        const signal = new AbortController();
        const pending = tool.execute(`cancel-${userAbandoned}`, { name: "Wait", task: "work", fork: true }, signal.signal, undefined, ctx);
        await Promise.resolve();
        if (userAbandoned) testApi.abandonAllSubagents({ abort() { signal.abort(); } }, testApi.runningSubagents, () => {});
        else signal.abort();
        const result = await pending;
        assert.match(result.content[0].text, /Wait cancelled/);
        assert.equal(result.details.status, "wait_cancelled");
        assert.equal(result.details.cwd, "/work");
        assert.equal(result.details.async, false);
        assert.equal(result.details.surface, "mock-pane");
        finish({ name: "Wait", task: "work", summary: "model-facing completion", exitCode: 0, elapsed: 1 });
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      assert.equal(sentMessages.length, 1, "only uncancelled assignment completion is delivered");
      assert.match(sentMessages[0].message.content, /model-facing completion/);
      assert.equal(appendedEntries.filter((entry) => entry.customType === "subagent_outcome").length, 1);
    } finally {
      testApi.setExecutionTestAdapters(undefined, undefined, undefined);
      testApi.runtime.halted = originalHalted;
      testApi.runningSubagents.clear();
      eventHandlers.get("session_shutdown")?.[0]({ reason: "quit" }, {});
    }
  });

  void it("old completion watchers redraw new cached native rows after module reload", async (t) => {
    const source = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", source).href);
    const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", source).href);
    initTheme("dark");
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
    const oldApi = createMockExtensionApi();
    const newApi = createMockExtensionApi();
    const testApi = Reflect.get(subagentsModule, "__test__");
    const originalCtx = testApi.runtime.latestCtx;
    const originalPi = testApi.runtime.pi;
    const originalHalted = testApi.runtime.halted;
    subagentsModule.default(oldApi.api);
    const oldTool = oldApi.registeredTools.find((entry) => entry.name === "subagent");
    let component = new ToolExecutionComponent("subagent", "reload-call", { name: "Worker", task: "initial" }, {}, oldTool,
      { requestRender() {} }, process.cwd());
    let painted: string[] = [];
    const ctx = { hasUI: true, sessionManager: { getEntries: () => [], getSessionFile: () => "/parent.jsonl" },
      ui: { setWidget() { painted = component.render(80); } } };
    const running = { id: "reload-worker", name: "Worker", task: "initial", cwd: "/work", surface: "mock-pane",
      sessionFile: "/mock-child.jsonl", startTime: 0, cli: "claude", autoExit: false, interactive: false,
      orchestrationMode: "async", initialToolCallId: "reload-call", lifecycle: createLifecycle(0) };
    const terminal = { name: "Worker", task: "initial", summary: "PRIVATE_RESPONSE", exitCode: 0, elapsed: 2 };
    let finish!: (result: typeof terminal) => void;
    testApi.setExecutionTestAdapters(async () => {
      testApi.runningSubagents.set(running.id, running);
      return running;
    }, () => new Promise<typeof terminal>((resolve) => { finish = resolve; }), () => true);
    try {
      oldApi.eventHandlers.get("session_start")![0]({}, ctx);
      const launch = await oldTool.execute("reload-call", { name: "Worker", task: "initial", fork: true }, undefined, undefined, ctx);
      component.updateResult(launch, false);
      assert.match(component.render(80).join("\n"), /starting · async · 0s/);
      oldApi.eventHandlers.get("session_shutdown")![0]({ reason: "reload" }, {});
      const reloaded = await import(new URL("../pi-extension/subagents/index.ts?cached-widget-reload", import.meta.url).href);
      reloaded.default(newApi.api);
      const newTool = newApi.registeredTools.find((entry) => entry.name === "subagent");
      const callFactory = t.mock.method(newTool, "renderCall");
      const resultFactory = t.mock.method(newTool, "renderResult");
      component = new ToolExecutionComponent("subagent", "reload-call", { name: "Worker", task: "initial" }, {}, newTool,
        { requestRender() {} }, process.cwd());
      component.updateResult(launch, false);
      newApi.eventHandlers.get("session_start")![0]({}, ctx);
      const factories = [callFactory.mock.callCount(), resultFactory.mock.callCount()];
      const cachedResult = component.resultRendererComponent;
      t.mock.timers.tick(2_000);
      assert.match(painted.join("\n"), /starting · async · 2s/);
      assert.deepEqual([callFactory.mock.callCount(), resultFactory.mock.callCount()], factories);
      finish(terminal);
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(running.initialToolCallId, undefined);
      assert.match(painted.join("\n"), /started · async/);
      assert.doesNotMatch(painted.join("\n"), /2s|PRIVATE_RESPONSE/);
      assert.equal(component.resultRendererComponent, cachedResult);
      assert.deepEqual([callFactory.mock.callCount(), resultFactory.mock.callCount()], factories);
      assert.equal(oldApi.sentMessages.length, 0);
      assert.equal(newApi.sentMessages.length, 1);
      assert.match(newApi.sentMessages[0].message.content, /PRIVATE_RESPONSE/);
    } finally {
      if (typeof finish === "function") finish(terminal);
      await Promise.resolve();
      newApi.eventHandlers.get("session_shutdown")?.[0]({ reason: "quit" }, {});
      oldApi.eventHandlers.get("session_shutdown")![0]({ reason: "quit" }, {});
      testApi.setExecutionTestAdapters(undefined, undefined, undefined);
      testApi.runningSubagents.delete(running.id);
      testApi.runtime.latestCtx = originalCtx;
      testApi.runtime.pi = originalPi;
      testApi.runtime.halted = originalHalted;
    }
  });

  void it("suppresses call after result and response content in both result modes", () => {
    const { api, registeredTools } = createMockExtensionApi();
    subagentsModule.default(api);
    const tool = registeredTools.find((entry) => entry.name === "subagent");
    const theme = { fg: (color: string, value: string) => `<${color}>${value}</${color}>` };
    const context = { toolCallId: "completed", executionStarted: true, invalidate() {}, state: {} };
    for (const expanded of [false, true]) {
      const output = tool.renderResult(
        { content: [{ type: "text", text: "model-facing response" }], details: { name: "Worker", exitCode: 0, elapsed: 1 } },
        { expanded }, theme, context,
      ).render(80).join("\n");
      assert.doesNotMatch(output, /model-facing response/);
      assert.match(output, /<success>◈<\/success><dim> Worker<\/dim>/);
    }
    const failed = tool.renderResult(
      { content: [], details: { name: "Worker", exitCode: 1, errorMessage: "broken" } },
      { expanded: false }, theme, { toolCallId: "failed", executionStarted: true, invalidate() {}, state: {} },
    ).render(80);
    assert.match(failed[0], /^<error>◈<\/error><error> Worker<\/error>$/);
    assert.ok(failed.slice(1).every((line: string) => /^<dim>[│└] <\/dim><error>.+<\/error>$/.test(line)));
  });
});

void describe("shared subagent UI", () => {
  const theme = { fg: (_color: string, value: string) => value };

  void it("maps recorded details without live state and wraps full logical content", () => {
    const recorded = presentationFromRecordedDetails(
      { name: "implementer", task: "Apply", cwd: "/workspace/project", status: "started", async: true },
      { failed: false, hasTerminalEvidence: false, formatElapsed: (seconds) => `${seconds}s` },
    );
    assert.deepEqual(recorded, {
      name: "implementer", agent: undefined, cwd: "/workspace/project", state: "started", elapsed: undefined,
      async: true, failed: false, errorMessage: undefined, exitCode: undefined,
    });
    const options = { failed: false, hasTerminalEvidence: false, formatElapsed: (seconds: number) => `${seconds}s` };
    const cancellation = { status: "wait_cancelled" };
    assert.equal(presentationFromRecordedDetails(cancellation, options).state, "wait cancelled");
    assert.equal(cancellation.status, "wait_cancelled");
    assert.equal(presentationFromRecordedDetails({ status: "awaiting_answer" }, options).state, "awaiting_answer");
    assert.equal(presentationFromRecordedDetails({ name: "legacy" }, options).state, undefined);
    for (const [name, agent, label] of [
      ["Friendly", "implementer", "implementer — Friendly"],
      [" implementer ", "\u001b[31mimplementer\u001b[0m", "implementer"],
      [undefined, "implementer", "implementer"],
      ["Friendly", undefined, "Friendly"],
      [" \u001b[31m Friendly \u001b[0m", "\u001b[32m scout \u001b[0m", "scout — Friendly"],
      [" \u001b[31m \u001b[0m", "implementer", "implementer"],
      [{}, "implementer", "implementer"],
      [undefined, undefined, "subagent"],
      ["Friendly", {}, "Friendly"],
    ] as const) {
      const details = { name, agent, task: "SECRET_TASK", message: "SECRET_MESSAGE" };
      const presentation = presentationFromRecordedDetails(details, { failed: false, hasTerminalEvidence: false, formatElapsed: (seconds) => `${seconds}s` });
      assert.deepEqual(renderSubagentPresentation(presentation, theme, 80), [`◈ ${label}`]);
      assert.equal(details.name, name, "display role never mutates recorded or model-facing name");
    }
    for (const width of [8, 20, 80]) {
      const wrapped = renderSubagentPresentation({ agent: "\u001b[32m审查-reviewer\u001b[0m", name: "任务 03 privacy full review round 2" }, theme, width);
      assert.ok(wrapped.every((line) => visibleWidth(line) <= width));
      assert.equal(wrapped.map((line) => line.slice(2)).join("").replace(/\s/g, ""), "审查-reviewer—任务03privacyfullreviewround2");
      assert.equal(wrapped.filter((line) => line.startsWith("◈ ")).length, 1);
      if (wrapped.length > 1) assert.ok(wrapped.at(-1)?.startsWith("└ "));
    }
    const lines = renderSubagentPresentation({
      name: "implementer Apply final search refinements",
      cwd: "/workspace/a/very/long/path/for/a/subagent",
      state: "started",
      elapsed: "12m 28s",
      async: true,
    }, theme, 20);

    assert.deepEqual(lines.slice(0, 3), ["◈ implementer Apply", "│ final search", "│ refinements"]);
    assert.ok(lines.includes("│ /workspace/a/very/"));
    assert.equal(lines.at(-1), "└ 12m 28s");
    assert.ok(lines.every((line) => visibleWidth(line) <= 20));
  });

  void it("renders every failed line red-safe with canonical reason precedence", () => {
    const lines = renderSubagentPresentation({
      name: "Worker",
      cwd: "/work/项目",
      state: "failed",
      elapsed: "2s",
      async: true,
      failed: true,
      errorMessage: "\u001b[31mRate limit exceeded\u001b[0m\nstack trace",
      exitCode: 17,
    }, theme, 40);

    assert.deepEqual(lines, [
      "◈ Worker",
      "│ /work/项目",
      "│ failed · async · 2s",
      "└ Rate limit exceeded",
    ]);
    assert.deepEqual(
      renderSubagentPresentation({ failed: true, state: "failed", exitCode: 9 }, theme, 40).at(-1),
      "└ Exit code 9",
    );
    assert.deepEqual(
      renderSubagentPresentation({ failed: true, state: "failed" }, theme, 40).at(-1),
      "└ Unknown error",
    );
  });

  void it("styles failed content red while retaining independent markers", () => {
    const styledTheme = { fg: (color: string, value: string) => `<${color}>${value}</${color}>` };
    const failed = renderSubagentPresentation({
      agent: "reviewer",
      name: "Worker long header continuation",
      cwd: "/long/working/directory",
      state: "failed",
      elapsed: "2s",
      failed: true,
      errorMessage: "long failure reason continuation",
    }, styledTheme, 12);

    assert.match(failed[0], /^<error>◈<\/error><error> reviewer —<\/error>$/);
    assert.ok(failed.slice(1).every((line) => /^<dim>[│└] <\/dim><error>.+<\/error>$/.test(line)));
    assert.ok(failed.some((line) => line.includes("header")));
    assert.ok(failed.some((line) => line.includes("/long/work")));
    assert.ok(failed.some((line) => line.includes("failed")));
    assert.ok(failed.some((line) => line.includes("failure")));

    const normal = renderSubagentPresentation({ agent: "reviewer", name: "Worker", state: "completed" }, styledTheme, 40);
    assert.deepEqual(normal, [
      "<success>◈</success><dim> reviewer — Worker</dim>",
      "<dim>└ completed</dim>",
    ]);
  });

  void it("handles partial and narrow presentation data without overflow", () => {
    for (const width of [0, 1, 2, 3]) {
      const lines = renderSubagentPresentation({ agent: "\u001b[32m审查", name: "\u001b[31m名 long unstyled name", cwd: "\u001b[31m/项目" }, theme, width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(lines.every((line) => !line.includes("\u001b[31m")));
    }
    const narrow = renderSubagentPresentation({ name: "Worker", cwd: "/a/b", state: "completed", elapsed: "2s" }, theme, 3);
    assert.deepEqual(narrow, [
      "◈ W", "│ o", "│ r", "│ k", "│ e", "│ r",
      "│ /", "│ a", "│ /", "│ b", "│ c", "│ o", "│ m", "│ p", "│ l", "│ e", "│ t", "│ e", "│ d", "│ ·", "│ 2", "└ s",
    ]);
  });
});

describe("subagent startup delay", () => {
  it("defaults to 500ms when no env var is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });

  it("uses PI_SUBAGENT_SHELL_READY_DELAY_MS when it is set", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.getShellReadyDelayMs, "function");

    const original = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
    process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "2500";
    try {
      assert.equal(testApi.getShellReadyDelayMs(), 2500);
    } finally {
      if (original == null) delete process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS;
      else process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = original;
    }
  });
});
describe("subagents widget rendering", () => {
  it("projects Claude agents as running and counts them as active", () => {
    const testApi = (subagentsModule as any).__test__;
    const originalNow = Date.now;
    Date.now = () => 30_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([{
        id: "c1",
        name: "Claude",
        task: "",
        surface: "s1",
        startTime: 5_000,
        sessionFile: "sess1",
        cli: "claude",
        lifecycle: { ...createLifecycle(5_000), process: { kind: "running", startedAt: 5_000, confirmedAt: 5_000 } },
        interactive: false,
      }], 64);

      assert.match(lines[0], /1 active/);
      assert.ok(lines[0].includes("\x1b[38;2;77;163;255m"));
      assert.match(lines[1], /running/);
    } finally {
      Date.now = originalNow;
    }
  });

  it("freezes runtime when the subagent reports done", () => {
    const testApi = (subagentsModule as any).__test__;
    const doneAt = 20_000;
    const lifecycle = markCompletionDetected(createLifecycle(5_000), { reason: "done", exitCode: 0 }, doneAt);

    const originalNow = Date.now;
    Date.now = () => 30_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([{
        id: "a1",
        name: "Reviewer",
        task: "",
        surface: "s1",
        startTime: 5_000,
        sessionFile: "sess1",
        lifecycle,
        interactive: false,
      }], 64);

      assert.match(lines[0], /1 open/);
      assert.match(lines[1], /00:15\s+Reviewer/);
      assert.match(lines[1], /finalizing…/);
      assert.doesNotMatch(lines[1], /00:25/);
    } finally {
      Date.now = originalNow;
    }
  });

  it("keeps a blue border and summarizes mixed active and open agents", () => {
    const testApi = (subagentsModule as any).__test__;
    const now = 30_000;
    const active = observeLifecycleActivity(
      createLifecycle(5_000),
      {
        ok: true,
        activity: {
          version: 1,
          runningChildId: "a1",
          createdAt: 5_000,
          updatedAt: 29_000,
          sequence: 1,
          latestEvent: "agent_start",
          phase: "active",
          agentActive: true,
          turnActive: true,
          providerActive: false,
          toolActive: false,
          activeScope: "agent",
          activeSince: 29_000,
        },
      },
      29_000,
    );
    const waiting = {
      ...createLifecycle(10_000),
      process: { kind: "running" as const, startedAt: 10_000, confirmedAt: 10_000 },
      turn: { kind: "waiting" as const, startedAt: 20_000 },
    };

    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        { id: "a1", name: "Active", task: "", surface: "s1", startTime: 5_000, sessionFile: "s1", lifecycle: active, interactive: false },
        { id: "a2", name: "Open", task: "", surface: "s2", startTime: 10_000, sessionFile: "s2", lifecycle: waiting, interactive: false },
      ], 72);

      assert.match(lines[0], /1 active · 1 open/);
      assert.ok(lines[0].includes("\x1b[38;2;77;163;255m"));
    } finally {
      Date.now = originalNow;
    }
  });

  it("keeps every rendered line within a very narrow width", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const originalNow = Date.now;
    Date.now = () => 1_000_000;
    try {
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime: 1_000_000 - 13_000,
          sessionFile: "sess1",
          lifecycle: createLifecycle(1_000_000 - 13_000),
        },
        {
          id: "a2",
          name: "B",
          task: "",
          surface: "s2",
          startTime: 1_000_000 - 21_000,
          sessionFile: "sess2",
          lifecycle: createLifecycle(1_000_000 - 21_000),
        },
        {
          id: "a3",
          name: "C",
          task: "",
          surface: "s3",
          startTime: 1_000_000 - 27_000,
          sessionFile: "sess3",
          lifecycle: createLifecycle(1_000_000 - 27_000),
        },
      ], 16);

      assert.deepEqual(
        lines.map((line: string) => visibleWidth(line)),
        [16, 16, 16, 16, 16],
      );
    } finally {
      Date.now = originalNow;
    }
  });

  it("truncates the right-hand status instead of overflowing when it alone is too wide", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.borderLine, "function");

    const line = testApi.borderLine(" A ", " 999 msgs (999.9KB) ", 16);
    assert.equal(visibleWidth(line), 16);
  });

  it("handles ultra-narrow widths without exceeding the width contract", () => {
    const testApi = (subagentsModule as any).__test__;
    assert.ok(testApi, "expected subagents test helpers to be exported");
    assert.equal(typeof testApi.renderSubagentWidgetLines, "function");

    const widths = [0, 1, 2];
    for (const width of widths) {
      const startTime = Date.now() - 5_000;
      const lines = testApi.renderSubagentWidgetLines([
        {
          id: "a1",
          name: "A",
          task: "",
          surface: "s1",
          startTime,
          sessionFile: "sess1",
          lifecycle: createLifecycle(startTime),
        },
      ], width);

      for (const line of lines) {
        assert.ok(
          visibleWidth(line) <= width,
          `expected line width <= ${width}, got ${visibleWidth(line)} for ${JSON.stringify(line)}`,
        );
      }
    }
  });
});

function transcriptClick(y: number, width = 80, height = 100): TuiMouseEvent {
  return { type: "click", button: "left", x: 0, y, screenX: 0, screenY: y,
    width, height, shift: false, alt: false, ctrl: false };
}

void describe("subagent transcript activation", () => {
  void it("consumes every native physical row without expansion, redraw actions or nonprimary activation", async () => {
    const source = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { ToolExecutionComponent } = await import(new URL("./modes/interactive/components/tool-execution.js", source).href);
    const { CustomMessageComponent } = await import(new URL("./modes/interactive/components/custom-message.js", source).href);
    const { CustomEntryComponent } = await import(new URL("./modes/interactive/components/custom-entry.js", source).href);
    const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", source).href);
    initTheme("dark");
    const mock = createMockExtensionApi();
    subagentsModule.default(mock.api);
    const owner = Reflect.get(subagentsModule, "__test__");
    const oldCtx = owner.runtime.latestCtx;
    const notifications: string[] = [];
    const focused: string[] = [];
    const details = { id: "mouse-worker", name: "Worker with long name", agent: "reviewer", task: "long task wrapped across rows",
      cwd: "/effective/directory/with/many/segments", errorMessage: "long failure reason wraps too", async: true, elapsed: 8 };
    const lifecycle = createLifecycle(Date.now());
    const running = { ...details, name: "Worker", task: "initial", surface: "live-pane", lifecycle,
      startTime: Date.now(), initialToolCallId: "mouse-initial", cli: "pi" };
    owner.runningSubagents.set(details.id, running);
    owner.runtime.latestCtx = { mode: "tui", sessionManager: { getSessionId: () => "mouse-parent" }, ui: { notify(text: string) { notifications.push(text); } } };
    owner.setFocusTestAdapter(async (pane) => { focused.push(pane); return { kind: "focused" }; });
    const session = SessionManager.inMemory();
    session.appendCustomMessageEntry("subagent_result", "PRIVATE_MODEL_RESPONSE", true, details);
    session.appendCustomEntry("subagent_outcome", { ...details, status: "abandoned" });
    const tool = mock.registeredTools.find((entry) => entry.name === "subagent");
    const promptTool = mock.registeredTools.find((entry) => entry.name === "subagent_prompt");
    const handle: SubagentHandle = { id: details.id, name: details.name, agent: details.agent, cwd: details.cwd, surface: "handle-pane",
      sessionFile: "/saved.jsonl", state: "finalized", subscribed: false, createdAt: 1, autoExit: false, interactive: true };
    owner.subagentHandles.set(details.id, handle);
    const messageRenderer = mock.registeredMessageRenderers.find((entry) => entry.name === "subagent_result").renderer;
    const entryRenderer = mock.registeredEntryRenderers.find((entry) => entry.name === "subagent_outcome")!;
    const initial = new ToolExecutionComponent("subagent", "mouse-initial", {}, {}, tool, { requestRender() {} }, process.cwd());
    const prompt = new ToolExecutionComponent("subagent_prompt", "mouse-prompt", { id: details.id, message: "PRIVATE_MESSAGE" }, {}, promptTool,
      { requestRender() {} }, process.cwd());
    const components = [initial, prompt];
    for (const resultDetails of [{ ...details, status: "started", async: true, errorMessage: undefined }, details]) {
      const component = new ToolExecutionComponent("subagent", "settled", {}, {}, tool, { requestRender() {} }, process.cwd());
      component.updateResult({ content: [{ type: "text", text: "PRIVATE_MODEL_RESPONSE" }], details: resultDetails }, false);
      components.push(component);
      const continuation = new ToolExecutionComponent("subagent_prompt", "mouse-prompt-result", { id: details.id, message: "PRIVATE_MESSAGE" }, {}, promptTool,
        { requestRender() {} }, process.cwd());
      continuation.updateResult({ content: [{ type: "text", text: "PRIVATE_MODEL_RESPONSE" }], details: resultDetails }, false);
      components.push(continuation);
    }
    for (const entry of session.getBranch()) {
      if (entry.type === "custom_message") components.push(new CustomMessageComponent({ ...entry, role: "custom" }, messageRenderer));
      if (entry.type === "custom") components.push(new CustomEntryComponent(entry, entryRenderer.renderer.bind(entryRenderer)));
    }
    const originalShutdown = owner.runtime.shuttingDown;
    owner.runtime.shuttingDown = false;
    const beforeState = JSON.stringify([...owner.runningSubagents]);
    try {
      for (const component of components) {
        for (const expanded of [false, true]) {
          component.setExpanded(expanded);
          for (const width of [120, 20, 3, 2, 1]) {
            const lines: string[] = component.render(width);
            const cached = component.callRendererComponent ?? component.customComponent;
            assert.ok(lines.some((line) => line.includes("◈")));
            assert.doesNotMatch(lines.join("\n"), /PRIVATE_MODEL_RESPONSE/);
            const beforeRender = focused.length;
            component.render(width);
            component.invalidate();
            component.render(width);
            assert.equal(focused.length, beforeRender);
            for (let y = 1; y < lines.length; y += 1) {
              const beforeClick = focused.length;
              const currentPane = `current-pane-${beforeClick}`;
              owner.subagentHandles.set(details.id, { ...handle, surface: currentPane });
              assert.equal(component.handleMouse(transcriptClick(y, width, lines.length))?.handled, true);
              await new Promise<void>((done) => setImmediate(done));
              assert.equal(focused.length, beforeClick + 1);
              assert.equal(focused.at(-1), currentPane, "each cached physical row resolves current pane without redraw");
              assert.equal(component.expanded ?? Reflect.get(component, "_expanded"), expanded);
              for (const event of [{ type: "click", button: "right" }, { type: "move", button: "none" },
                { type: "wheel", button: "none", wheelDelta: 1 }, { type: "press", button: "left" }]) {
                component.handleMouse({ ...transcriptClick(y, width, lines.length), ...event });
              }
              assert.equal(focused.length, beforeClick + 1);
            }
            assert.ok(cached instanceof MouseRegion);
          }
        }
      }
      await Promise.resolve();
      assert.deepEqual(notifications, []);
      assert.equal(JSON.stringify([...owner.runningSubagents]), beforeState);
      assert.equal(session.getEntryCount(), 2);
      assert.deepEqual(mock.sentMessages, []);
      assert.deepEqual(mock.sentUserMessages, []);
      assert.deepEqual(mock.appendedEntries, []);
      let invalidations = 0;
      const optional = subagentMouseRegion({ render: () => ["row"], invalidate() { invalidations += 1; } });
      assert.equal(optional.handleMouse!(transcriptClick(0))?.handled, true);
      optional.invalidate();
      assert.equal(invalidations, 1);
    } finally {
      owner.runtime.latestCtx = oldCtx;
      owner.runtime.shuttingDown = originalShutdown;
      owner.runningSubagents.delete(details.id);
      owner.subagentHandles.delete(details.id);
      owner.setFocusTestAdapter();
    }
  });

  void it("resolves stable identity and latest association at click time, never names or stale fallback", async () => {
    const mock = createMockExtensionApi();
    subagentsModule.default(mock.api);
    const owner = Reflect.get(subagentsModule, "__test__");
    const oldCtx = owner.runtime.latestCtx;
    const originalShutdown = owner.runtime.shuttingDown;
    owner.runtime.shuttingDown = false;
    const focused: string[] = [];
    const notifications: Array<[string, string]> = [];
    owner.runtime.latestCtx = { mode: "tui", sessionManager: { getSessionId: () => "association-parent" }, ui: { notify(text: string, level: string) { notifications.push([text, level]); } } };
    owner.setFocusTestAdapter(async (pane) => { focused.push(pane); return { kind: "focused" }; });
    const renderer = mock.registeredMessageRenderers.find((entry) => entry.name === "subagent_result").renderer;
    const theme = { fg: (_color: string, value: string) => value };
    const id = "association-worker";
    const details = { id, name: "Duplicate", surface: "recorded-pane" };
    const component = renderer({ details }, {}, theme);
    const handle = { id, name: "Duplicate", sessionFile: "/saved.jsonl", surface: "handle-pane", state: "active",
      subscribed: true, autoExit: false, interactive: false, createdAt: 1 };
    const running = { id, name: "Duplicate", surface: "runtime-pane", cli: "pi", lifecycle: createLifecycle(0) };
    const click = async (expected?: string, target = component) => {
      const priorFocusCount = focused.length;
      target.handleMouse(transcriptClick(0));
      await new Promise<void>((done) => setImmediate(done));
      assert.deepEqual(focused.slice(priorFocusCount), expected ? [expected] : []);
    };
    try {
      owner.subagentHandles.set("other-worker", { ...handle, id: "other-worker", surface: "wrong-pane" });
      component.render(80);
      await click("recorded-pane");
      const tool = mock.registeredTools.find((entry) => entry.name === "subagent");
      const call = tool.renderCall({}, theme, { toolCallId: "late-call", executionStarted: false, state: {} });
      call.render(80);
      owner.runningSubagents.set("late-worker", { ...running, id: "late-worker", surface: "late-pane", initialToolCallId: "late-call" });
      await click("late-pane", call);
      owner.runningSubagents.set("late-worker", { ...running, id: "late-worker", surface: "reassociated-pane", initialToolCallId: "late-call" });
      await click("reassociated-pane", call);
      owner.runningSubagents.delete("late-worker");
      owner.runningSubagents.set(id, running);
      await click("runtime-pane");
      owner.subagentHandles.set(id, handle);
      await click("runtime-pane");
      for (const state of ["awaiting_answer", "abandoned", "finalized"]) {
        owner.subagentHandles.set(id, { ...handle, state });
        await click("handle-pane");
      }
      owner.subagentHandles.set(id, { ...handle, subscribed: false });
      await click("handle-pane");
      owner.subagentHandles.set(id, { ...handle, surface: "newer-pane" });
      running.lifecycle.delivery = "delivered";
      await click("newer-pane");
      owner.subagentHandles.set(id, { ...handle, surface: undefined });
      await click();
      owner.subagentHandles.delete(id);
      await click("runtime-pane");
      running.cli = "claude";
      running.lifecycle.delivery = "pending";
      owner.subagentHandles.set(id, handle);
      await click("runtime-pane");
      owner.subagentHandles.delete(id);
      running.lifecycle.delivery = "suppressed";
      await click("runtime-pane");
      running.surface = "";
      await click();
      owner.runningSubagents.delete(id);
      const promptTool = mock.registeredTools.find((entry) => entry.name === "subagent_prompt");
      const promptComponents: Component[] = [];
      for (const invalid of [{ name: "Duplicate", surface: "wrong-pane" }, { id: "", surface: "wrong-pane" },
        { id: 42, surface: "wrong-pane" }, { id, terminalId: "wrong-pane", tabId: "wrong-tab" }, { id, surface: {} }]) {
        await click(undefined, renderer({ details: invalid }, {}, theme));
        const promptCall = promptTool.renderCall({ id: Reflect.get(invalid, "id"), message: "PRIVATE_MESSAGE" }, theme, { state: {} });
        const promptResult = promptTool.renderResult({ content: [], details: invalid }, {}, theme, { state: {}, isError: false });
        for (const target of [promptCall, promptResult]) {
          target.render(80);
          await click(undefined, target);
          promptComponents.push(target);
        }
      }
      assert.equal(notifications.length, 17);
      assert.ok(notifications.every(([text, level]) => text === "No current subagent pane is available." && level === "warning"));
      owner.runtime.latestCtx = { mode: "json", ui: { notify() { assert.fail("non-TUI notification"); } } };
      await click();
      for (const target of promptComponents) await click(undefined, target);
      assert.deepEqual(mock.sentMessages, []);
      assert.deepEqual(mock.sentUserMessages, []);
      assert.deepEqual(mock.appendedEntries, []);
    } finally {
      owner.runtime.latestCtx = oldCtx;
      owner.runtime.shuttingDown = originalShutdown;
      owner.runningSubagents.delete(id);
      owner.subagentHandles.delete(id);
      owner.subagentHandles.delete("other-worker");
      owner.runningSubagents.delete("late-worker");
      owner.setFocusTestAdapter();
    }
  });

  void it("catches focus failures and emits only fixed outcome notifications", async () => {
    const mock = createMockExtensionApi();
    subagentsModule.default(mock.api);
    const owner = Reflect.get(subagentsModule, "__test__");
    const oldCtx = owner.runtime.latestCtx;
    const originalShutdown = owner.runtime.shuttingDown;
    owner.runtime.shuttingDown = false;
    const notifications: Array<[string, string]> = [];
    owner.runtime.latestCtx = { mode: "tui", sessionManager: { getSessionId: () => "notification-parent" }, ui: { notify(text: string, level: string) { notifications.push([text, level]); } } };
    const renderer = mock.registeredMessageRenderers.find((entry) => entry.name === "subagent_result").renderer;
    const component = renderer({ details: { id: "notification-worker", surface: "pane" } }, {}, { fg: (_c: string, v: string) => v });
    try {
      const outcomes: Array<PaneFocusOutcome | undefined> = [{ kind: "focused" }, { kind: "missing" }, { kind: "unavailable" },
        { kind: "error", code: "agent_not_found", panePresent: true }, { kind: "error", code: "agent_not_found" }, undefined];
      for (const outcome of outcomes) {
        owner.setFocusTestAdapter(async () => {
          if (!outcome) throw new Error("PRIVATE_ERROR");
          return outcome;
        });
        component.handleMouse(transcriptClick(0));
        await new Promise<void>((done) => setImmediate(done));
      }
      assert.deepEqual(notifications, [["Subagent pane no longer exists.", "warning"], ["Herdr is unavailable.", "warning"],
        ["Pane exists, but no focusable agent was found.", "error"], ["Could not focus subagent pane.", "error"],
        ["Could not focus subagent pane.", "error"]]);
    } finally {
      owner.runtime.latestCtx = oldCtx;
      owner.runtime.shuttingDown = originalShutdown;
      owner.setFocusTestAdapter();
    }
  });
});

const flush = () => new Promise<void>((done) => setImmediate(done));
const deferred = () => {
  let done!: () => void;
  const promise = new Promise<void>((resolve) => { done = resolve; });
  return { promise, release: () => done() };
};

void describe("saved-session inspection", () => {

  async function withInspection(run: (fixture: {
    owner: typeof subagentsModule.__test__;
    mock: ReturnType<typeof createMockExtensionApi>;
    dir: string;
    handle: SubagentHandle;
    ctx: { mode: "tui"; sessionManager: { getSessionId(): string; getSessionDir(): string; getSessionFile(): undefined | null; getEntries(): object[] }; ui: { notify(text: string, level: string): void; setWidget(): void; setStatus(): void } };
    launches: Array<Parameters<typeof launchPiContinuation>[0]>;
    created: string[];
    creationFocus: boolean[];
    closed: string[];
    focused: string[];
    watched: string[];
    prompted: string[];
    notices: string[];
    panes: Map<string, StrictPaneInspection>;
    click: () => Promise<void>;
    prompt: (signal?: AbortSignal) => Promise<{ details: Record<string, unknown>; content: Array<{ text: string }> }>;
    finish: () => void;
    assertPromptFailure: (result: { details: Record<string, unknown>; content: Array<{ text: string }> }, error: RegExp, expected?: SubagentHandle) => Promise<void>;
  }) => Promise<void>): Promise<void> {
    const owner: typeof subagentsModule.__test__ = Reflect.get(subagentsModule, "__test__");
    const mock = createMockExtensionApi();
    const previousPi = owner.runtime.pi;
    subagentsModule.default(mock.api);
    const previous = { ctx: owner.runtime.latestCtx, shuttingDown: owner.runtime.shuttingDown, halted: owner.runtime.halted };
    const dir = createTestDir();
    const handle: SubagentHandle = { id: "inspection-worker", name: "Saved worker", agent: "implementer", agentFile: "/original/implementer.md", agentDir: dir,
      cwd: dir, sessionFile: join(dir, "child.jsonl"), surface: "old-pane", state: "finalized", subscribed: false, autoExit: false, interactive: true,
      spawning: true, createdAt: 17 };
    writeFileSync(handle.sessionFile, JSON.stringify({ ...SESSION_HEADER, id: "native-child-not-handle", cwd: dir }) + "\n");
    const notices: string[] = [];
    const ctx = { mode: "tui" as const, sessionManager: { getSessionId: () => "native-parent", getSessionDir: () => dir,
      getSessionFile: (): undefined | null => undefined, getEntries: () => mock.appendedEntries.map((entry) => ({ type: "custom", ...entry })) },
      ui: { notify(text: string) { notices.push(text); }, setWidget() {}, setStatus() {} } };
    Reflect.set(owner.runtime, "latestCtx", ctx);
    owner.runtime.shuttingDown = false;
    owner.runtime.halted = false;
    owner.subagentHandles.set(handle.id, handle);
    const panes = new Map<string, StrictPaneInspection>([["old-pane", { kind: "missing", code: "pane_not_found" }]]);
    const created: string[] = [];
    const creationFocus: boolean[] = [];
    const closed: string[] = [];
    const focused: string[] = [];
    const watched: string[] = [];
    const prompted: string[] = [];
    const launches: Array<Parameters<typeof launchPiContinuation>[0]> = [];
    let finishWatch: (() => void) | undefined;
    owner.setInspectionTestAdapters({
      inspectPaneStrict: async (pane) => panes.get(pane) ?? { kind: "present" },
      createSubagentPane(_name, focus = false) {
        creationFocus.push(focus);
        const pane = `new-pane-${created.length + 1}`;
        created.push(pane);
        panes.set(pane, { kind: "present" });
        return pane;
      },
      closePane(pane) { closed.push(pane); panes.set(pane, { kind: "missing" }); },
    });
    const focus = async (pane: string): Promise<PaneFocusOutcome> => {
      focused.push(pane);
      const inspection = panes.get(pane);
      if (inspection?.kind === "missing") return { kind: "missing", code: inspection.code };
      if (inspection?.kind === "unavailable" || inspection?.kind === "error") return inspection;
      return inspection?.kind === "present" && inspection.agent === "pi" ? { kind: "focused" } : { kind: "error", code: "agent_not_found", panePresent: true };
    };
    owner.setFocusTestAdapter(focus);
    owner.setExecutionTestAdapters(undefined, (running) => {
      running.orchestrationMode = "async";
      watched.push(running.id);
      return new Promise((resolve) => { finishWatch = () => resolve({ name: running.name, task: running.task, summary: "done", sessionFile: running.sessionFile, exitCode: 0, elapsed: 1 }); });
    }, () => true, (pane) => { prompted.push(pane); }, async (params) => {
      launches.push(params);
      assert.equal(owner.subagentHandles.get(handle.id)?.surface, params.surface, "association persisted before dispatch");
      assert.equal(mock.appendedEntries.at(-1)?.customType, "subagent_handle");
      params.beforeSend?.();
      panes.set(params.surface, { kind: "present", agent: "pi" });
      return { surface: params.surface, activityFile: join(dir, "activity.json"), launchScriptFile: join(dir, "continue.sh") };
    });
    const tool = mock.registeredTools.find((entry) => entry.name === "subagent_prompt");
    try {
      await run({ owner, mock, dir, handle, ctx, launches, created, creationFocus, closed, focused, watched, prompted, notices, panes,
        click: () => owner.activateSubagent({ id: handle.id, surface: "historical-pane", task: "PRIVATE_TASK" }),
        prompt: (signal = new AbortController().signal) => tool.execute("continuation", { id: handle.id, message: "EXPLICIT_WORK" }, signal, undefined, ctx),
        finish() { finishWatch?.(); },
        async assertPromptFailure(result, error, expected = handle) {
          assert.match(String(result.details.errorMessage), error);
          assert.deepEqual(result.details, {
            errorMessage: result.details.errorMessage, id: expected.id, name: expected.name,
            ...(expected.agent ? { agent: expected.agent } : {}),
            ...(expected.cwd ? { cwd: expected.cwd } : {}),
            ...(expected.surface ? { surface: expected.surface } : {}),
            sessionFile: expected.sessionFile,
          });
          if (result.details.errorMessage !== "Could not reopen saved subagent session.") assert.equal(result.details.errorMessage, result.content[0].text);
          const current = owner.subagentHandles.get(handle.id);
          const currentCtx = owner.runtime.latestCtx;
          const clicked: string[] = [];
          owner.subagentHandles.set(handle.id, { ...handle, name: "Conflicting label", agent: "conflicting-type", cwd: "/conflicting-cwd", surface: "conflicting-pane" });
          Reflect.set(owner.runtime, "latestCtx", { ...ctx, sessionManager: { getSessionId: () => "render-parent" } });
          owner.setFocusTestAdapter(async (pane) => { clicked.push(pane); return { kind: "focused" }; });
          try {
            const snapshot = JSON.stringify(result);
            for (const expanded of [false, true]) {
              const component = tool.renderResult(JSON.parse(snapshot), { expanded }, { fg: (_color: string, text: string) => text }, { state: {}, isError: false });
              const rendered = component.render(120).join("\n");
              assert.ok(rendered.includes(`${expected.agent} — ${expected.name}`));
              if (expected.cwd) assert.ok(rendered.includes(expected.cwd));
              assert.match(rendered, error);
              assert.match(rendered, /failed/);
              assert.doesNotMatch(rendered, /EXPLICIT_WORK|PRIVATE_TASK|Conflicting label|conflicting-type|conflicting-cwd|async|elapsed/);
              assert.equal(component.handleMouse(transcriptClick(0))?.handled, true);
              await flush();
            }
            const currentPane = owner.runningSubagents.get(handle.id)?.surface ?? "conflicting-pane";
            assert.deepEqual(clicked, [currentPane, currentPane], "own result keeps click id and current ownership despite conflicting display metadata");
            assert.equal(JSON.stringify(result), snapshot);
          } finally {
            if (current) owner.subagentHandles.set(handle.id, current);
            else owner.subagentHandles.delete(handle.id);
            Reflect.set(owner.runtime, "latestCtx", currentCtx);
            owner.setFocusTestAdapter(focus);
          }
        },
      });
    } finally {
      finishWatch?.();
      await flush();
      mock.eventHandlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
      owner.subagentHandles.delete(handle.id);
      owner.setFocusTestAdapter();
      owner.setInspectionTestAdapters();
      owner.setExecutionTestAdapters(undefined, undefined, undefined);
      Reflect.set(owner.runtime, "latestCtx", previous.ctx);
      owner.runtime.shuttingDown = previous.shuttingDown;
      owner.runtime.halted = previous.halted;
      owner.runtime.pi = previousPi;
      assert.equal(owner.runtime.launchGates.size, 0, "all operation gates released");
      rmSync(dir, { recursive: true, force: true });
    }
  }

  void it("reopens only missing saved targets, persists surface only, keeps abandoned policy and focuses latest pane", async () => {
    for (const [code, marker] of [["pane_not_found", ""], ["tab_not_found", " \n "]] as const) {
      for (const state of ["finalized", "abandoned"] as const) {
        await withInspection(async ({ owner, mock, handle, click, launches, created, creationFocus, closed, focused, watched, prompted, notices, panes, prompt }) => {
          const saved = { ...handle, state, subscribed: true };
          owner.subagentHandles.set(handle.id, saved);
          panes.set("old-pane", { kind: "missing", code });
          const originalFile = readFileSync(handle.sessionFile, "utf8");
          writeFileSync(`${handle.sessionFile}.exit`, marker);
          assert.equal(hasCompletionChannel(handle.sessionFile), true);
          await click();
          assert.equal(hasCompletionChannel(handle.sessionFile), false);
          assert.deepEqual(created, ["new-pane-1"]);
          assert.deepEqual(closed, []);
          assert.deepEqual(focused, ["old-pane"]);
          assert.deepEqual(creationFocus, [true]);
          assert.deepEqual(owner.subagentHandles.get(handle.id), { ...saved, surface: "new-pane-1" });
          assert.equal(launches.length, 1);
          assert.equal(launches[0].message, undefined);
          assert.equal(launches[0].artifactDir.endsWith("artifacts/native-parent"), true);
          assert.equal(launches[0].handle.id, handle.id);
          assert.equal(launches[0].handle.autoExit, false);
          assert.equal(launches[0].handle.agentFile, handle.agentFile);
          assert.equal(existsSync(`${handle.sessionFile}.exit`), false);
          assert.equal(readFileSync(handle.sessionFile, "utf8"), originalFile);
          assert.deepEqual(watched, []);
          assert.deepEqual(prompted, []);
          assert.equal(owner.runningSubagents.has(handle.id), false);
          assert.deepEqual(mock.sentMessages, []);
          assert.deepEqual(mock.sentUserMessages, []);
          assert.equal(mock.appendedEntries.length, 1);
          assert.equal(mock.appendedEntries[0].customType, "subagent_handle");
          await click();
          assert.equal(created.length, 1);
          assert.equal(focused.at(-1), "new-pane-1");
          assert.deepEqual(notices, []);
          if (state === "abandoned") {
            const result = await prompt();
            assert.match(String(result.details.errorMessage), /abandoned/);
            assert.equal(watched.length, 0);
            assert.deepEqual(owner.subagentHandles.get(handle.id), { ...saved, surface: "new-pane-1" });
          }
        });
      }
    }
  });

  void it("retains nonempty completion data and leaves markers owned by any running map entry untouched", async () => {
    for (const marker of ["{\"reason\":\"done\",\"exitCode\":0}", " malformed payload "]) {
      await withInspection(async ({ handle, click }) => {
        writeFileSync(`${handle.sessionFile}.exit`, marker);
        await click();
        assert.equal(readFileSync(`${handle.sessionFile}.exit`, "utf8"), marker);
      });
    }
    for (const delivery of ["pending", "delivered", "suppressed"] as const) {
      await withInspection(async ({ owner, handle, click, created, notices }) => {
        beginCompletionChannel(handle.sessionFile);
        const lifecycle = createLifecycle(0);
        lifecycle.delivery = delivery;
        owner.runningSubagents.set(handle.id, { ...handle, surface: "old-pane", task: "old assignment", startTime: 0, lifecycle,
          interactive: true, cli: "pi", runtimePlan: undefined, orchestrationMode: "async" });
        await click();
        assert.deepEqual(created, []);
        assert.equal(hasCompletionChannel(handle.sessionFile), true);
        assert.equal(notices.length, 1);
      });
    }
  });

  void it("never launches for absent association, remaining shell, unknown agent, done, unavailable, malformed or unsupported target", async () => {
    const outcomes: StrictPaneInspection[] = [{ kind: "present" }, { kind: "present", agent: "unknown" },
      { kind: "error", code: "not_found" }, { kind: "error", code: "agent_not_found", panePresent: true },
      { kind: "unavailable", code: "server_not_running" }, { kind: "error" }];
    for (const outcome of outcomes) {
      await withInspection(async ({ panes, click, created, closed, notices, mock }) => {
        panes.set("old-pane", outcome);
        await click();
        assert.deepEqual(created, []);
        assert.deepEqual(closed, []);
        assert.equal(notices.length, 1);
        assert.deepEqual(mock.appendedEntries, []);
      });
    }
    await withInspection(async ({ owner, handle, click, created, prompt, notices, assertPromptFailure }) => {
      owner.subagentHandles.set(handle.id, { ...handle, surface: undefined });
      await click();
      await assertPromptFailure(await prompt(), /No current subagent pane/, { ...handle, surface: undefined });
      assert.deepEqual(created, []);
      assert.equal(notices.length, 1);
      owner.subagentHandles.delete(handle.id);
      await click();
      assert.deepEqual(created, []);
    });
    for (const outcome of outcomes) {
      await withInspection(async ({ owner, panes, prompt, created, watched, mock, assertPromptFailure }) => {
        panes.set("old-pane", outcome);
        await assertPromptFailure(await prompt(), /Could not confirm/);
        assert.deepEqual(created, []);
        assert.deepEqual(watched, []);
        assert.deepEqual(mock.appendedEntries, []);
        assert.equal(owner.runtime.launchGates.size, 0);
      });
    }
  });

  void it("new prompt target and eligibility failures own original identity even after handle changes or disappears", async () => {
    for (const race of ["association", "session-file", "removed", "abandoned", "runtime-owner"] as const) {
      await withInspection(async ({ owner, handle, prompt, created, watched, prompted, mock, assertPromptFailure }) => {
        owner.setInspectionTestAdapters({ inspectPaneStrict: async () => {
          const changed = { ...handle, name: "Wrong current label", agent: "wrong-current-type", cwd: "/wrong-current-cwd" };
          if (race === "association") owner.subagentHandles.set(handle.id, { ...changed, surface: "different-pane" });
          if (race === "session-file") owner.subagentHandles.set(handle.id, { ...changed, sessionFile: "/different-session.jsonl" });
          if (race === "removed") owner.subagentHandles.delete(handle.id);
          if (race === "abandoned") owner.subagentHandles.set(handle.id, { ...changed, state: "abandoned" });
          if (race === "runtime-owner") owner.runningSubagents.set(handle.id, { ...handle, surface: "old-pane", task: "other work", startTime: 0,
            lifecycle: createLifecycle(0), runtimePlan: undefined, orchestrationMode: "async" });
          return { kind: "missing" };
        } });
        await assertPromptFailure(await prompt(), race === "abandoned" ? /abandoned.*cannot be continued/ : /Subagent target changed/);
        assert.deepEqual(created, []);
        assert.deepEqual(watched, []);
        assert.deepEqual(prompted, []);
        assert.deepEqual(mock.appendedEntries, []);
        assert.equal(existsSync(`${handle.sessionFile}.exit`), false);
        assert.equal(owner.runtime.launchGates.size, 0);
      });
    }
  });

  void it("checks regular nonempty files and usable cwd before creation, leaving format and header cwd to Pi", async () => {
    for (const invalid of ["missing", "empty", "directory", "cwd-missing", "cwd-relative"]) {
      await withInspection(async ({ owner, handle, dir, click, prompt, created, closed, notices, assertPromptFailure }) => {
        if (invalid === "missing") rmSync(handle.sessionFile);
        if (invalid === "empty") writeFileSync(handle.sessionFile, "");
        if (invalid === "directory") { rmSync(handle.sessionFile); mkdirSync(handle.sessionFile); }
        const original = { ...handle, cwd: invalid === "cwd-missing" ? join(dir, "missing") : invalid === "cwd-relative" ? "." : dir };
        owner.subagentHandles.set(handle.id, original);
        await click();
        assert.deepEqual(notices, ["Could not reopen saved subagent session."]);
        await assertPromptFailure(await prompt(), invalid === "missing" ? /no saved session file/ : /Could not reopen saved subagent session/, original);
        assert.deepEqual(created, []);
        assert.deepEqual(closed, []);
      });
    }
    for (const content of ["not JSON", " \n ", '{"type":"session","version":999,"cwd":"/different"}']) {
      await withInspection(async ({ handle, click, created, notices }) => {
        writeFileSync(handle.sessionFile, content);
        await click();
        assert.equal(created.length, 1);
        assert.deepEqual(notices, []);
        assert.equal(readFileSync(handle.sessionFile, "utf8"), content);
      });
    }
  });

  void it("prompt setup and final beforeSend failures return owning cards, clean only owned targets and release queued retries", async () => {
    for (const phase of ["create", "save", "artifact", "parent", "target", "abandoned", "truncate"] as const) {
      await withInspection(async ({ owner, mock, handle, ctx, prompt, click, created, closed, watched, prompted, assertPromptFailure, panes }) => {
        const pause = deferred();
        const cause = new Error(`${phase} setup failed`);
        let entered = false;
        let sent = false;
        if (phase === "create") owner.setInspectionTestAdapters({ inspectPaneStrict: async () => ({ kind: "missing" }), createSubagentPane() { throw cause; } });
        if (phase === "save") mock.api.appendEntry = () => { throw cause; };
        owner.setExecutionTestAdapters(undefined, undefined, () => true, undefined, async (params) => {
          entered = true;
          if (phase === "artifact") throw cause;
          await pause.promise;
          params.beforeSend?.();
          sent = true;
          return { surface: params.surface, activityFile: "activity", launchScriptFile: "script" };
        });
        const work = prompt();
        await flush();
        let queued: Promise<void> | undefined;
        if (phase === "parent" || phase === "target" || phase === "abandoned" || phase === "truncate") {
          assert.equal(entered, true);
          assert.equal(owner.runtime.launchGates.has(handle.id), true);
          queued = click();
          await flush();
          assert.equal(created.length, 1);
          if (phase === "parent") ctx.sessionManager.getSessionId = () => "other-parent";
          if (phase === "truncate") writeFileSync(handle.sessionFile, "");
          if (phase === "target") {
            owner.subagentHandles.set(handle.id, { ...handle, name: "Changed label", agent: "changed-type", surface: "foreign-pane" });
            panes.set("foreign-pane", { kind: "present", agent: "pi" });
          }
          if (phase === "abandoned") {
            owner.subagentHandles.set(handle.id, { ...owner.subagentHandles.get(handle.id)!, name: "Changed label", state: "abandoned" });
            owner.setFocusTestAdapter(async () => ({ kind: "error", code: "agent_not_found", panePresent: true }));
          }
        }
        pause.release();
        const result = await work;
        await queued;
        await assertPromptFailure(result, /Could not reopen saved subagent session/);
        if (phase === "create" || phase === "save" || phase === "artifact") assert.equal(result.content[0].text, cause.message);
        assert.equal(sent, false);
        assert.equal(created.length, phase === "create" ? 0 : 1);
        assert.deepEqual(closed, phase === "create" ? [] : [created[0]]);
        assert.deepEqual(watched, []);
        assert.deepEqual(prompted, []);
        assert.equal(owner.runtime.launchGates.size, 0);
        assert.equal(existsSync(`${handle.sessionFile}.exit`), false);
        assert.equal(closed.includes("old-pane"), false);
        assert.equal(closed.includes("foreign-pane"), false);
        if (phase === "create" || phase === "save") assert.deepEqual(owner.subagentHandles.get(handle.id), handle);
        if (phase === "abandoned") assert.equal(owner.subagentHandles.get(handle.id)?.state, "abandoned");
        if (phase === "artifact") {
          owner.setExecutionTestAdapters(undefined, undefined, () => true, undefined, async (params) => {
            params.beforeSend?.();
            panes.set(params.surface, { kind: "present", agent: "pi" });
            return { surface: params.surface, activityFile: "activity", launchScriptFile: "script" };
          });
          await click();
          assert.equal(created.length, 2, "released failure gate permits retry only after confirmed missing cleanup target");
        }
      });
    }
  });

  void it("inspection focuses at creation before agent detection, without post-launch focus or readiness warnings", async () => {
    await withInspection(async ({ owner, handle, click, created, creationFocus, closed, focused, panes, notices }) => {
      owner.setFocusTestAdapter(async (pane) => {
        if (pane !== "old-pane") assert.fail("post-launch agent focus must not run");
        focused.push(pane);
        return { kind: "missing" };
      });
      owner.setExecutionTestAdapters(undefined, undefined, () => true, undefined, async (params) => {
        params.beforeSend?.();
        return { surface: params.surface, activityFile: "activity", launchScriptFile: "script" };
      });
      await click();
      assert.deepEqual(creationFocus, [true]);
      assert.deepEqual(focused, ["old-pane"]);
      assert.equal(panes.get("new-pane-1")?.kind, "present");
      assert.equal(Reflect.get(panes.get("new-pane-1")!, "agent"), undefined);
      assert.equal(owner.subagentHandles.get(handle.id)?.surface, "new-pane-1");
      assert.deepEqual(created, ["new-pane-1"]);
      assert.deepEqual(closed, []);
      assert.deepEqual(notices, []);
    });
    for (const message of ["EXPLICIT_WORK", ""]) {
      await withInspection(async ({ mock, handle, ctx, launches, creationFocus }) => {
        const tool = mock.registeredTools.find((entry) => entry.name === "subagent_prompt");
        await tool.execute("continue", { id: handle.id, message }, new AbortController().signal, undefined, ctx);
        assert.deepEqual(creationFocus, [false], "prompted continuations stay in background, including empty messages");
        assert.equal(launches[0].message, message);
      });
    }
  });

  void it("cleans only owned pre-dispatch targets on save, script and ownership failure; send errors retain association and retry only after confirmed missing", async () => {
    for (const failure of ["save", "post-create-switch", "script", "send", "post-send-switch"] as const) {
      await withInspection(async ({ owner, mock, handle, ctx, click, created, closed, notices, panes }) => {
        if (failure === "save") mock.api.appendEntry = () => { throw new Error("save failed"); };
        if (failure === "post-create-switch") owner.setInspectionTestAdapters({
          inspectPaneStrict: async () => ({ kind: "missing" }),
          createSubagentPane() { created.push("owned-new"); ctx.sessionManager.getSessionId = () => "other-parent"; return "owned-new"; },
          closePane(pane) { closed.push(pane); },
        });
        if (failure === "script" || failure === "send" || failure === "post-send-switch") owner.setExecutionTestAdapters(undefined, undefined, () => true, undefined, async (params) => {
          if (failure === "script") throw new Error("script write failed");
          params.beforeSend?.();
          if (failure === "post-send-switch") ctx.sessionManager.getSessionId = () => "other-parent";
          else throw new Error("send may have happened");
          return { surface: params.surface, activityFile: "activity", launchScriptFile: "script" };
        });
        await click();
        assert.equal(created.length, 1);
        assert.equal(closed.length, failure === "send" || failure === "post-send-switch" ? 0 : 1);
        assert.equal(closed.includes("old-pane"), false);
        assert.equal(owner.subagentHandles.get(handle.id)?.surface, failure === "save" || failure === "post-create-switch" ? "old-pane" : created[0]);
        assert.ok(notices.length <= 1);
        for (const notice of notices) assert.match(notice, /^Could not reopen saved subagent session\./);
        assert.equal(owner.runtime.launchGates.size, 0);
        if (failure === "send") {
          await click();
          assert.equal(created.length, 1, "unknown writer in present shell is never retried");
          panes.set(created[0], { kind: "missing", code: "pane_not_found" });
          await click();
          assert.equal(created.length, 2, "retry requires newly confirmed missing target");
          assert.deepEqual(closed, []);
        }
      });
    }
  });

  void it("fresh target and running-owner checks reject creation and dispatch races without touching old or foreign panes", async () => {
    for (const boundary of ["create", "send"] as const) {
      for (const race of ["association", "handle-removed", "runtime-owner", "session-empty", "cwd-changed"] as const) {
        await withInspection(async ({ owner, handle, click, created, closed, panes, notices }) => {
          const mutate = () => {
            if (race === "association") owner.subagentHandles.set(handle.id, { ...handle, surface: "foreign-pane" });
            if (race === "handle-removed") owner.subagentHandles.delete(handle.id);
            if (race === "runtime-owner") owner.runningSubagents.set(handle.id, { ...handle, surface: "foreign-pane", task: "other owner", startTime: 0,
              lifecycle: createLifecycle(0), runtimePlan: undefined, orchestrationMode: "async" });
            if (race === "session-empty") writeFileSync(handle.sessionFile, "");
            if (race === "cwd-changed") owner.subagentHandles.set(handle.id, { ...owner.subagentHandles.get(handle.id)!, cwd: "/missing-after-create" });
          };
          owner.setInspectionTestAdapters({
            inspectPaneStrict: async () => ({ kind: "missing" }),
            createSubagentPane() {
              created.push("owned-new");
              if (boundary === "create") mutate();
              return "owned-new";
            },
            closePane(pane) { closed.push(pane); },
          });
          let dispatchAttempted = false;
          owner.setExecutionTestAdapters(undefined, undefined, () => true, undefined, async (params) => {
            if (boundary === "send") mutate();
            params.beforeSend?.();
            dispatchAttempted = true;
            panes.set(params.surface, { kind: "present", agent: "pi" });
            return { surface: params.surface, activityFile: "activity", launchScriptFile: "script" };
          });
          await click();
          assert.equal(dispatchAttempted, false);
          assert.deepEqual(closed, ["owned-new"]);
          assert.deepEqual(created, ["owned-new"]);
          assert.equal(notices.length, 1);
        });
      }
    }
  });

  void it("strict uncertainty after missing focus and parent changes during inspection never create target", async () => {
    for (const outcome of [{ kind: "present" }, { kind: "unavailable" }, { kind: "error" }] satisfies StrictPaneInspection[]) {
      await withInspection(async ({ owner, click, created, notices }) => {
        owner.setFocusTestAdapter(async () => ({ kind: "missing" }));
        owner.setInspectionTestAdapters({ inspectPaneStrict: async () => outcome });
        await click();
        assert.deepEqual(created, []);
        assert.equal(notices.length, 1);
      });
    }
    for (const operation of ["click", "prompt"]) {
      await withInspection(async ({ owner, handle, ctx, click, prompt, created, focused, mock, assertPromptFailure }) => {
        owner.setInspectionTestAdapters({ inspectPaneStrict: async () => {
          ctx.sessionManager.getSessionId = () => "other-parent";
          owner.subagentHandles.set(handle.id, { ...handle, surface: "foreign-pane" });
          return { kind: "missing" };
        } });
        if (operation === "click") await click();
        else await assertPromptFailure(await prompt(), /Parent session changed/);
        assert.deepEqual(focused, operation === "click" ? ["old-pane"] : []);
        assert.deepEqual(created, []);
        assert.deepEqual(mock.appendedEntries, []);
      });
    }
  });

  void it("prompt pre-send failure releases gate and cleans only empty target; post-send failure keeps channel and association", async () => {
    for (const boundary of ["script", "send", "after-send-parent", "after-send-target", "after-send-abandoned"] as const) {
      await withInspection(async ({ owner, handle, ctx, prompt, click, created, closed, watched, assertPromptFailure }) => {
        const cause = new Error("launch failed");
        owner.setExecutionTestAdapters(undefined, undefined, () => true, undefined, async (params) => {
          if (boundary === "script") throw cause;
          params.beforeSend?.();
          if (boundary === "send") throw cause;
          if (boundary === "after-send-parent") ctx.sessionManager.getSessionId = () => "other-parent";
          if (boundary === "after-send-target") owner.subagentHandles.set(handle.id, { ...params.handle, surface: "foreign-pane" });
          if (boundary === "after-send-abandoned") owner.subagentHandles.set(handle.id, { ...params.handle, state: "abandoned" });
          return { surface: params.surface, activityFile: "activity", launchScriptFile: "script" };
        });
        if (boundary === "script") await assertPromptFailure(await prompt(), /Could not reopen saved subagent session/);
        else if (boundary === "send") await assert.rejects(prompt(), (error) => error === cause);
        else await assert.rejects(prompt(), boundary === "after-send-parent" ? /Parent session changed/ : boundary === "after-send-target" ? /Subagent target changed/ : /abandoned.*cannot be continued/);
        assert.equal(owner.runtime.launchGates.size, 0);
        assert.equal(owner.subagentHandles.get(handle.id)?.surface, boundary === "after-send-target" ? "foreign-pane" : created[0]);
        assert.equal(owner.subagentHandles.get(handle.id)?.state, boundary === "after-send-abandoned" ? "abandoned" : "finalized");
        assert.deepEqual(watched, []);
        assert.equal(hasCompletionChannel(handle.sessionFile), boundary !== "script");
        assert.deepEqual(closed, boundary === "script" ? [created[0]] : []);
        if (boundary === "send") {
          await click();
          assert.equal(created.length, 1, "no second launch alongside uncertain dispatched writer");
        }
      });
    }
  });

  void it("missing persistence, new running owner and cleanup failure cannot broaden target ownership", async () => {
    await withInspection(async ({ owner, click, created, closed }) => {
      owner.runtime.pi = undefined;
      await click();
      assert.equal(created.length, 1);
      assert.deepEqual(closed, [created[0]]);
    });
    await withInspection(async ({ owner, handle, click, created }) => {
      owner.setInspectionTestAdapters({ inspectPaneStrict: async () => {
        owner.runningSubagents.set(handle.id, { ...handle, surface: "old-pane", task: "other owner", startTime: 0,
          lifecycle: createLifecycle(0), runtimePlan: undefined, orchestrationMode: "async" });
        return { kind: "missing" };
      } });
      await click();
      assert.deepEqual(created, []);
    });
    await withInspection(async ({ owner, click, closed }) => {
      owner.setInspectionTestAdapters({ inspectPaneStrict: async () => ({ kind: "missing" }), createSubagentPane: () => "owned-new",
        closePane(pane) { closed.push(pane); throw new Error("cleanup failed"); } });
      owner.setExecutionTestAdapters(undefined, undefined, () => true, undefined, async () => { throw new Error("script failed"); });
      await click();
      assert.deepEqual(closed, ["owned-new"]);
    });
  });

  void it("retargets closure races using fresh association and never closes or dispatches into stale pane", async () => {
    await withInspection(async ({ owner, handle, panes, focused, click, created, launches }) => {
      owner.setFocusTestAdapter(async (pane) => {
        focused.push(pane);
        if (pane === "old-pane") {
          owner.subagentHandles.set(handle.id, { ...handle, surface: "replacement-pane" });
          panes.set("replacement-pane", { kind: "present", agent: "pi" });
          return { kind: "missing" };
        }
        return { kind: "focused" };
      });
      await click();
      assert.deepEqual(focused, ["old-pane", "replacement-pane"]);
      assert.deepEqual(created, []);
      assert.deepEqual(launches, []);
    });
    await withInspection(async ({ owner, handle, click, created, focused }) => {
      owner.setInspectionTestAdapters({ inspectPaneStrict: async () => {
        owner.subagentHandles.set(handle.id, { ...handle, surface: "reassociated-pane" });
        return { kind: "missing" };
      } });
      owner.setFocusTestAdapter(async (pane) => { focused.push(pane); return pane === "old-pane" ? { kind: "missing" } : { kind: "focused" }; });
      await click();
      assert.deepEqual(created, []);
      assert.deepEqual(focused, ["old-pane", "reassociated-pane"]);
    });
  });

  void it("serializes click-click and click-prompt in either arrival order without duplicate writers", async () => {
    for (const order of ["click-click", "click-prompt", "prompt-click"]) {
      await withInspection(async ({ owner, handle, click, prompt, launches, panes, created, watched, prompted, finish }) => {
        const pause = deferred();
        let entered = false;
        owner.setExecutionTestAdapters(undefined, (running) => {
          running.orchestrationMode = "async";
          watched.push(running.id);
          return new Promise(() => {});
        }, () => true, (pane) => { prompted.push(pane); }, async (params) => {
          launches.push(params);
          entered = true;
          await pause.promise;
          assert.equal(owner.subagentHandles.get(handle.id)?.surface, params.surface);
          params.beforeSend?.();
          panes.set(params.surface, { kind: "present", agent: "pi" });
          return { surface: params.surface, activityFile: "activity", launchScriptFile: "script" };
        });
        const first = order === "prompt-click" ? prompt() : click();
        await flush();
        assert.equal(entered, true);
        const second = order === "click-click" || order === "prompt-click" ? click() : prompt();
        await flush();
        assert.equal(launches.length, 1);
        assert.equal(created.length, 1);
        assert.equal(owner.runtime.launchGates.has(handle.id), true);
        pause.release();
        await Promise.all([first, second]);
        assert.equal(created.length, 1);
        assert.equal(launches.length, 1);
        assert.equal(owner.runtime.launchGates.size, 0);
        assert.equal(watched.length, order === "click-click" ? 0 : 1);
        assert.equal(prompted.length, order === "click-prompt" ? 1 : 0);
        if (order === "click-prompt") assert.equal(owner.runningSubagents.get(handle.id)?.initialToolCallId, "continuation");
        finish();
      });
    }
  });

  void it("gate releases before wait-all completion and on rejection; waiting prompt rechecks abandoned eligibility", async () => {
    await withInspection(async ({ owner, prompt, click, created, watched, finish }) => {
      let resolveCompletion!: () => void;
      owner.setExecutionTestAdapters(undefined, (running) => {
        watched.push(running.id);
        running.orchestrationMode = "wait-all";
        return new Promise((done) => { resolveCompletion = () => done({ name: running.name, task: running.task, summary: "done", sessionFile: running.sessionFile, exitCode: 0, elapsed: 1 }); });
      }, () => true, undefined, async (params) => {
        params.beforeSend?.();
        return { surface: params.surface, activityFile: "activity", launchScriptFile: "script" };
      });
      const work = prompt();
      await flush();
      assert.equal(owner.runtime.launchGates.size, 0);
      assert.equal(watched.length, 1);
      await click();
      assert.equal(created.length, 1);
      resolveCompletion();
      await work;
      finish();
    });
    await withInspection(async ({ owner, handle, click, prompt, created, panes }) => {
      const pause = deferred();
      owner.setExecutionTestAdapters(undefined, undefined, () => true, undefined, async (params) => {
        await pause.promise;
        owner.subagentHandles.set(handle.id, { ...params.handle, state: "abandoned" });
        params.beforeSend?.();
        panes.set(params.surface, { kind: "present", agent: "pi" });
        return { surface: params.surface, activityFile: "activity", launchScriptFile: "script" };
      });
      const first = click();
      await flush();
      const second = prompt();
      pause.release();
      const [, result] = await Promise.all([first, second]);
      assert.match(String(result.details.errorMessage), /abandoned/);
      assert.equal(created.length, 1);
      assert.equal(owner.runtime.launchGates.size, 0);
    });
  });

  void it("native parent id with null or undefined file owns reload; switch and shutdown abort before send without clearing in-flight gate", async () => {
    for (const transition of ["reload", "switch", "shutdown"] as const) {
      for (const file of [undefined, null]) {
        await withInspection(async ({ owner, mock, handle, ctx, click, created, closed, panes, notices }) => {
          ctx.sessionManager.getSessionFile = () => file;
          const pause = deferred();
          let dispatched = 0;
          owner.setExecutionTestAdapters(undefined, undefined, () => true, undefined, async (params) => {
            await pause.promise;
            params.beforeSend?.();
            dispatched += 1;
            panes.set(params.surface, { kind: "present", agent: "pi" });
            return { surface: params.surface, activityFile: "activity", launchScriptFile: "script" };
          });
          const first = click();
          await flush();
          const gate = owner.runtime.launchGates.get(handle.id);
          assert.ok(gate);
          assert.equal(created.length, 1);
          if (transition === "reload") {
            mock.eventHandlers.get("session_shutdown")?.[0]({ reason: "reload" }, ctx);
            mock.eventHandlers.get("session_start")?.[0]({ reason: "reload" }, { ...ctx });
            Object.defineProperty(ctx, "sessionManager", { get() { throw new Error("Captured context is stale after reload"); } });
            assert.equal(owner.ensureSubagentRuntime(owner.runtime), owner.runtime);
          } else if (transition === "switch") {
            mock.eventHandlers.get("session_shutdown")?.[0]({ reason: "resume" }, ctx);
            mock.eventHandlers.get("session_start")?.[0]({ reason: "resume" }, { ...ctx,
              sessionManager: { ...ctx.sessionManager, getSessionId: () => "different-parent", getEntries: () => [] } });
          } else mock.eventHandlers.get("session_shutdown")?.[0]({ reason: "quit" }, ctx);
          assert.equal(owner.runtime.launchGates.get(handle.id), gate);
          pause.release();
          await first;
          assert.equal(dispatched, transition === "reload" ? 1 : 0);
          assert.equal(closed.length, transition === "reload" ? 0 : 1);
          assert.equal(owner.runtime.launchGates.size, 0);
          assert.equal(mock.appendedEntries.length, 1, "never append another handle into switched parent");
          if (transition === "reload") assert.deepEqual(notices, []);
        });
      }
    }
  });

  void it("captured parent identity prevents queued operations from launching or focusing after switch", async () => {
    await withInspection(async ({ owner, handle, ctx, click, prompt, created, closed, assertPromptFailure }) => {
      const pause = deferred();
      owner.setExecutionTestAdapters(undefined, undefined, () => true, undefined, async (params) => {
        await pause.promise;
        params.beforeSend?.();
        return { surface: params.surface, activityFile: "activity", launchScriptFile: "script" };
      });
      const first = click();
      await flush();
      const queuedClick = click();
      const queuedPrompt = prompt();
      await flush();
      ctx.sessionManager.getSessionId = () => "other-parent";
      owner.subagentHandles.set(handle.id, { ...handle, name: "Wrong session label", agent: "wrong-session-type", cwd: "/wrong-session-cwd", surface: "wrong-session-pane" });
      const getHandle = owner.subagentHandles.get.bind(owner.subagentHandles);
      let foreignReads = 0;
      owner.subagentHandles.get = (id) => { foreignReads += 1; return getHandle(id); };
      try {
        pause.release();
        await first;
        await queuedClick;
        const result = await queuedPrompt;
        assert.equal(foreignReads, 0, "queued operations never read replacement parent's handles");
        Reflect.deleteProperty(owner.subagentHandles, "get");
        await assertPromptFailure(result, /Parent session changed/, { ...handle, surface: created[0] });
        assert.equal(created.length, 1);
        assert.deepEqual(closed, [created[0]]);
        assert.equal(owner.runtime.launchGates.has(handle.id), false);
      } finally {
        Reflect.deleteProperty(owner.subagentHandles, "get");
      }
    });
  });
});

void describe("inspection continuation launch", () => {
  const environment = Reflect.get(process, "env");
  void it("optional message omits prompt artifacts, args and task report; supplied surface and saved false override inherited env", async () => {
    const dir = createTestDir();
    const previousPath = environment.PATH;
    const previousHerdr = environment.HERDR_ENV;
    const previousAutoExit = environment.PI_SUBAGENT_AUTO_EXIT;
    const log = join(dir, "commands.log");
    const handle: SubagentHandle = { id: "original-handle", name: "Original", agent: "implementer", agentFile: "/original/agent.md", agentDir: dir,
      sessionFile: join(dir, "saved.jsonl"), cwd: dir, surface: "old-pane", state: "abandoned", subscribed: false, autoExit: false, interactive: true, spawning: true, createdAt: 1 };
    writeFileSync(join(dir, "herdr"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
    environment.PATH = `${dir}:${previousPath ?? ""}`;
    environment.HERDR_ENV = "1";
    environment.PI_SUBAGENT_AUTO_EXIT = "1";
    try {
      for (const message of [undefined, "OUTGOING_WORK"]) {
        const artifactDir = join(dir, message === undefined ? "inspection" : "prompted");
        let beforeSend = 0;
        const result = await launchPiContinuation({ handle, message, surface: "caller-owned-pane", artifactDir, shellReadyDelayMs: 0,
          beforeSend() {
            beforeSend += 1;
            const scripts = readdirSync(join(artifactDir, "subagent-scripts"));
            assert.equal(scripts.length, 1, "script exists before send guard");
            const command = readFileSync(join(artifactDir, "subagent-scripts", scripts[0]), "utf8");
            assert.match(command, /PI_SUBAGENT_AUTO_EXIT=0/);
            assert.match(command, /PI_SUBAGENT_INTERACTIVE=1/);
            assert.match(command, /PI_SUBAGENT_SPAWNING=1/);
            assert.match(command, /PI_SUBAGENT_SURFACE='caller-owned-pane'/);
            assert.match(command, /PI_SUBAGENT_AGENT_FILE='\/original\/agent.md'/);
            assert.match(command, /PI_SUBAGENT_ID='original-handle'/);
            assert.match(command, /PI_SUBAGENT_ACTIVITY_FILE=/);
            assert.match(command, /^#!\/bin\/bash\ncd /);
            assert.match(command, /pi --session /);
            if (message === undefined) {
              assert.doesNotMatch(command, /@|--print|--mode|OUTGOING_WORK/);
              assert.equal(existsSync(join(artifactDir, "subagent-prompts")), false);
              assert.equal(existsSync(log), false, "inspection has no task report or target creation");
            } else {
              assert.match(command, /'@/);
              const files = readdirSync(join(artifactDir, "subagent-prompts"));
              assert.equal(files.length, 1);
              assert.equal(readFileSync(join(artifactDir, "subagent-prompts", files[0]), "utf8"), message);
            }
          },
        });
        assert.equal(beforeSend, 1);
        assert.equal(result.surface, "caller-owned-pane");
        assert.equal(existsSync(result.launchScriptFile), true);
        const commands = readFileSync(log, "utf8");
        assert.doesNotMatch(commands, /tab create|pane split/);
        assert.equal(commands.split("\n").filter((line) => line.startsWith("pane run caller-owned-pane bash")).length, message === undefined ? 1 : 2);
        assert.equal(commands.includes("pane report-metadata"), message !== undefined);
        assert.equal(existsSync(`${handle.sessionFile}.exit`), false);
      }
    } finally {
      restoreEnvVar("PATH", previousPath);
      restoreEnvVar("HERDR_ENV", previousHerdr);
      restoreEnvVar("PI_SUBAGENT_AUTO_EXIT", previousAutoExit);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("script write failure never invokes beforeSend; send exception occurs only after synchronous guard", () => {
    withTempDir((dir) => {
      let guardCalls = 0;
      const notDirectory = join(dir, "file");
      writeFileSync(notDirectory, "file");
      assert.throws(() => runScriptInPane("owned", "command", { scriptPath: join(notDirectory, "launch.sh"), beforeSend() { guardCalls += 1; } }));
      assert.equal(guardCalls, 0);
      const scriptPath = join(dir, "launch.sh");
      assert.throws(() => runScriptInPane("owned", "command", { scriptPath, beforeSend() {
        guardCalls += 1;
        assert.equal(readFileSync(scriptPath, "utf8"), "#!/bin/bash\ncommand\n");
        throw new Error("ownership lost");
      } }), /ownership lost/);
      assert.equal(guardCalls, 1);
      const previousPath = environment.PATH;
      const previousHerdr = environment.HERDR_ENV;
      writeFileSync(join(dir, "herdr"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      environment.PATH = `${dir}:${previousPath ?? ""}`;
      environment.HERDR_ENV = "1";
      try {
        assert.throws(() => runScriptInPane("owned", "command", { scriptPath, beforeSend() { guardCalls += 1; } }), /Command failed/);
        assert.equal(guardCalls, 2, "actual send failure is after dispatch-attempt guard");
      } finally {
        restoreEnvVar("PATH", previousPath);
        restoreEnvVar("HERDR_ENV", previousHerdr);
      }
    });
  });
});

void describe("strict Herdr exact-pane inspection", () => {
  void it("only documented structured exact absence is missing; shells, done and PIDs cannot prove agent exit", async () => {
    const pane = "exact-pane";
    const failure = (code: string) => JSON.stringify({ error: { code, message: pane } });
    const cases: Array<{ output: string | Error; expected: StrictPaneInspection }> = [
      ...["pane_not_found", "tab_not_found", "server_not_running", "not_found", "unexpected", "agent_not_found"].map((code) => ({
        output: failure(code), expected: { kind: code === "pane_not_found" || code === "tab_not_found" ? "missing" : code === "server_not_running" ? "unavailable" : "error", code } satisfies StrictPaneInspection,
      })),
      ...[{}, { agent_status: "done" }, { shell_pid: 123, foreground_processes: [] }, { agent: "" }, { agent: " " }].map((fields) => ({
        output: JSON.stringify({ result: { pane: { pane_id: pane, ...fields } } }), expected: { kind: "present" } satisfies StrictPaneInspection,
      })),
      { output: JSON.stringify({ result: { pane: { pane_id: pane, agent: "pi", agent_status: "done" } } }), expected: { kind: "present", agent: "pi" } },
      { output: JSON.stringify({ result: { pane: { pane_id: pane, agent: "other-agent" } } }), expected: { kind: "present", agent: "other-agent" } },
      { output: JSON.stringify({ result: { pane: { pane_id: "other", agent: "pi" } } }), expected: { kind: "error" } },
      { output: JSON.stringify({ result: { pane: { pane_id: pane, agent: {} } } }), expected: { kind: "error" } },
      ...["not_found", "pane_not_found", "malformed", "null", "[]", "{}", new Error("transport")].map((output) => ({ output, expected: { kind: "error" } satisfies StrictPaneInspection })),
      { output: Object.assign(new Error("no binary"), { code: "ENOENT" }), expected: { kind: "unavailable", code: "ENOENT" } },
      { output: Object.assign(new Error("missing"), { stderr: "garbage", stdout: failure("pane_not_found") }), expected: { kind: "missing", code: "pane_not_found" } },
      { output: Object.assign(new Error("stopped"), { stderr: failure("server_not_running") }), expected: { kind: "unavailable", code: "server_not_running" } },
    ];
    for (const { output, expected } of cases) {
      const calls: string[][] = [];
      const result = await inspectHerdrPaneStrict(pane, async (args) => {
        calls.push(args);
        if (output instanceof Error) throw output;
        return output;
      });
      assert.deepEqual(result, expected);
      assert.deepEqual(calls, [["pane", "get", pane]]);
    }
    for (const invalid of ["", " ", "--current", "pane\nrun", "pane\x00"]) {
      assert.deepEqual(await inspectHerdrPaneStrict(invalid, async () => { assert.fail("invalid pane command"); }), { kind: "error" });
    }
    const environment = Reflect.get(process, "env");
    const oldHerdr = environment.HERDR_ENV;
    try {
      delete environment.HERDR_ENV;
      assert.deepEqual(await inspectHerdrPaneStrict(pane), { kind: "unavailable" });
    } finally { restoreEnvVar("HERDR_ENV", oldHerdr); }
  });
});

void describe("strict Herdr exact-pane focus", () => {
  void it("validates pane identity before focus, classifies structured failures and reinspects ambiguous races", async () => {
    const pane = "opaque-pane";
    const present = JSON.stringify({ result: { pane: { pane_id: pane } } });
    const success = JSON.stringify({ result: { agent: { pane_id: pane, focused: true } } });
    const failure = (code: string) => JSON.stringify({ error: { code, message: `private diagnostic for ${pane}` } });
    const rejected = (code: string, stream = "stderr") => Object.assign(new Error("private diagnostic"), { [stream]: failure(code) });
    const cases: Array<{ responses: Array<string | Error>; expected: PaneFocusOutcome }> = [
      { responses: [present, success], expected: { kind: "focused" } },
      { responses: [present, JSON.stringify({ result: { agent: { pane_id: "wrong", focused: true } } })], expected: { kind: "error" } },
      { responses: [present, JSON.stringify({ result: { agent: { pane_id: pane, focused: false } } })], expected: { kind: "error" } },
      { responses: [present, "{}"], expected: { kind: "error" } },
      { responses: [present, rejected("agent_not_found"), present], expected: { kind: "error", code: "agent_not_found", panePresent: true } },
      { responses: [present, rejected("agent_not_found"), rejected("pane_not_found")], expected: { kind: "missing", code: "pane_not_found" } },
      { responses: [present, failure("agent_not_found"), failure("tab_not_found")], expected: { kind: "missing", code: "tab_not_found" } },
      { responses: [present, rejected("agent_not_found"), rejected("server_not_running")], expected: { kind: "unavailable", code: "server_not_running" } },
      { responses: [present, rejected("agent_not_found"), "malformed"], expected: { kind: "error" } },
      { responses: [present, rejected("agent_not_found"), failure("not_found")], expected: { kind: "error", code: "not_found" } },
      { responses: [JSON.stringify({ result: { pane: { pane_id: "wrong" } } })], expected: { kind: "error" } },
      ...["pane_not_found", "tab_not_found", "server_not_running", "not_found", "unexpected"].flatMap((code) => [
        { responses: [failure(code)], expected: { kind: code === "server_not_running" ? "unavailable" : code === "pane_not_found" || code === "tab_not_found" ? "missing" : "error", code } satisfies PaneFocusOutcome },
        { responses: [present, rejected(code, "stdout")], expected: { kind: code === "server_not_running" ? "unavailable" : code === "pane_not_found" || code === "tab_not_found" ? "missing" : "error", code } satisfies PaneFocusOutcome },
      ]),
      ...["malformed", "{}", "null", "[]", failure("agent_not_found"), new Error("transport")].map((response) => ({
        responses: [response], expected: typeof response === "string" && response === failure("agent_not_found")
          ? { kind: "error", code: "agent_not_found" } satisfies PaneFocusOutcome : { kind: "error" } satisfies PaneFocusOutcome,
      })),
      { responses: [Object.assign(new Error("binary missing"), { code: "ENOENT" })], expected: { kind: "unavailable", code: "ENOENT" } },
      { responses: [Object.assign(new Error("transport"), { stderr: "pane_not_found", stdout: "garbage" })], expected: { kind: "error" } },
      { responses: [Object.assign(new Error("structured stdout"), { stderr: "malformed", stdout: failure("pane_not_found") })], expected: { kind: "missing", code: "pane_not_found" } },
    ];
    for (const { responses, expected } of cases) {
      const commands: string[][] = [];
      const result = await focusHerdrPane(pane, async (args) => {
        commands.push(args);
        const response = responses[commands.length - 1];
        assert.notEqual(response, undefined, "unexpected command");
        if (response instanceof Error) throw response;
        return response;
      });
      assert.deepEqual(result, expected);
      assert.deepEqual(commands, [["pane", "get", pane], ...commands.slice(1).map((_args, index) =>
        index === 0 ? ["agent", "focus", pane] : ["pane", "get", pane])]);
      assert.equal(commands.length, responses.length);
    }
    for (const invalid of ["", " ", "--current", "pane\nrun", "pane\x00"]) {
      assert.deepEqual(await focusHerdrPane(invalid, async () => { assert.fail("invalid target command"); }), { kind: "error" });
    }
    const injected = "$(touch /tmp/never); quoted ' target";
    const commands: string[][] = [];
    assert.deepEqual(await focusHerdrPane(injected, async (args) => {
      commands.push(args);
      return JSON.stringify({ result: args[0] === "pane" ? { pane: { pane_id: injected } } : { agent: { pane_id: injected, focused: true } } });
    }), { kind: "focused" });
    assert.deepEqual(commands, [["pane", "get", injected], ["agent", "focus", injected]]);
    assert.deepEqual(await focusHerdrPane("live-agent-name", async () => failure("pane_not_found")), { kind: "missing", code: "pane_not_found" });
    const environment = Reflect.get(process, "env");
    const oldEnv = environment.HERDR_ENV;
    try {
      delete environment.HERDR_ENV;
      assert.deepEqual(await focusHerdrPane(pane), { kind: "unavailable" });
    } finally { restoreEnvVar("HERDR_ENV", oldEnv); }
  });
});

describe("herdr.ts", () => {
  describe("isHerdrAvailable", () => {
    it("returns boolean based on HERDR_ENV", () => {
      const result = isHerdrAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

  describe("herdr command construction", () => {
    it("targets the current workspace when creating a subagent tab", () => {
      const background = ["tab", "create", "--workspace", "workspace-2", "--label", "reviewer", "--cwd", "/repo", "--no-focus"];
      assert.deepEqual(__herdrTest__.buildTabCreateArgs("reviewer", "/repo", "workspace-2"), background);
      assert.deepEqual(__herdrTest__.buildTabCreateArgs("reviewer", "/repo", "workspace-2", false), background);
      assert.deepEqual(__herdrTest__.buildTabCreateArgs("reviewer", "/repo", "workspace-2", true), [...background.slice(0, -1), "--focus"]);
    });

    void it("threads creation focus to caller workspace and returns exact root pane without agent detection", () => {
      withTempDir((dir) => {
        const environment = Reflect.get(process, "env");
        const previous = { PATH: environment.PATH, HERDR_ENV: environment.HERDR_ENV, HERDR_PANE_ID: environment.HERDR_PANE_ID,
          HERDR_TAB_ID: environment.HERDR_TAB_ID, HERDR_WORKSPACE_ID: environment.HERDR_WORKSPACE_ID };
        const log = join(dir, "commands.log");
        writeFileSync(join(dir, "herdr"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nprintf '%s\\n' '{"result":{"tab":{"tab_id":"not-the-root"},"root_pane":{"pane_id":"caller-root"}}}'\n`, { mode: 0o755 });
        Object.assign(environment, { PATH: `${dir}:${previous.PATH ?? ""}`, HERDR_ENV: "1", HERDR_PANE_ID: "caller-pane",
          HERDR_TAB_ID: "caller-tab", HERDR_WORKSPACE_ID: "caller-workspace" });
        try {
          for (const focus of [undefined, false, true]) {
            rmSync(log, { force: true });
            const pane = focus === undefined ? createSubagentPane("reviewer") : createSubagentPane("reviewer", focus);
            assert.equal(pane, "caller-root");
            assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
              `tab create --workspace caller-workspace --label reviewer --cwd ${process.cwd()} ${focus === true ? "--focus" : "--no-focus"}`,
              "pane rename caller-root reviewer",
            ]);
          }
        } finally {
          for (const [key, value] of Object.entries(previous)) restoreEnvVar(key, value);
        }
      });
    });

    it("submits live prompts through the agent API", () => {
      assert.deepEqual(
        __herdrTest__.buildAgentPromptArgs("w1:p2", "Continue with v2"),
        ["agent", "prompt", "w1:p2", "Continue with v2"],
      );
    });

    it("constructs report-metadata arguments with normalized task token", () => {
      assert.deepEqual(
        __herdrTest__.buildPaneReportTaskArgs("pane-1", "Inspect failing test suite", "pi"),
        [
          "pane",
          "report-metadata",
          "pane-1",
          "--source",
          "pi",
          "--token",
          "task=Inspect failing test suite",
        ],
      );
    });

    it("flattens multi-line and tab-padded tasks into a single line", () => {
      assert.deepEqual(
        __herdrTest__.buildPaneReportTaskArgs(
          "pane-2",
          "  Line 1\n\tLine 2\r\nLine 3  ",
          "pi",
        ),
        [
          "pane",
          "report-metadata",
          "pane-2",
          "--source",
          "pi",
          "--token",
          "task=Line 1 Line 2 Line 3",
        ],
      );
    });
  });

  describe("herdr response parsing", () => {
    it("extracts pane id from a pane split response", () => {
      const output = JSON.stringify({
        result: {
          pane: {
            pane_id: "1-3",
            tab_id: "1:2",
            workspace_id: "1",
          },
        },
      });
      assert.equal(__herdrTest__.extractHerdrPaneId(output, "pane split"), "1-3");
    });

    it("extracts root pane id from a tab create response", () => {
      const output = JSON.stringify({
        result: {
          tab: { tab_id: "1:2" },
          root_pane: { pane_id: "1-2" },
        },
      });
      assert.equal(__herdrTest__.extractHerdrRootPaneId(output, "tab create"), "1-2");
    });

    it("throws on malformed herdr JSON", () => {
      assert.throws(
        () => __herdrTest__.extractHerdrPaneId("not json", "pane split"),
        /Unexpected herdr pane split output/,
      );
    });

    it("parses pane-not-found JSON from stderr-shaped errors", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane gone" } }),
        stdout: "",
      });
      assert.deepEqual(result, { kind: "missing", error: "pane gone" });
    });

    it("treats an already-missing pane as successful cleanup", () => {
      assert.equal(__herdrTest__.isPaneMissingError({
        stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane gone" } }),
        stdout: "",
      }), true);
      assert.equal(__herdrTest__.isPaneMissingError({
        message: "connection refused",
        stderr: "",
        stdout: "",
      }), false);
    });

    it("continues from non-JSON stderr to structured stdout", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: "warning: connection closed",
        stdout: JSON.stringify({ error: { code: "pane_not_found", message: "pane gone" } }),
      });
      assert.deepEqual(result, { kind: "missing", error: "pane gone" });
    });

    it("returns unavailable when both error streams are non-JSON", () => {
      const result = __herdrTest__.parsePaneGetError({
        message: "command failed",
        stderr: "warning: connection closed",
        stdout: "not json either",
      });
      assert.deepEqual(result, { kind: "unavailable", error: "command failed" });
    });

    it("recognizes plain-text pane_not_found on stderr", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: "pane_not_found: pane w1:p1 not found",
        stdout: "unrelated output",
      });
      assert.deepEqual(result, {
        kind: "missing",
        error: "pane_not_found: pane w1:p1 not found",
      });
    });

    it("recognizes plain-text not_found on stdout after malformed stderr", () => {
      const result = __herdrTest__.parsePaneGetError({
        stderr: "{malformed json",
        stdout: "not_found: pane w1:p1",
      });
      assert.deepEqual(result, { kind: "missing", error: "not_found: pane w1:p1" });
    });

    it("normalizes unknown agent_status values", () => {
      const result = __herdrTest__.parsePaneGetOutput(JSON.stringify({
        result: { pane: { pane_id: "w1:p1", agent: "pi", agent_status: "paused" } },
      }), "w1:p1");
      assert.deepEqual(result, { kind: "present", agent: "pi", agentStatus: "unknown" });
    });
  });
});
