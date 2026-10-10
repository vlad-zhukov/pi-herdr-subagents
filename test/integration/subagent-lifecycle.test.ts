/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn real pi sessions with real LLM calls.
 * Each test creates a herdr pane, runs pi with a task that uses the subagent
 * tool, and verifies the outcome through marker files and terminal output.
 *
 * Duration: ~30-120s per test, depending on the selected model.
 *
 * Run `PI_TEST_MODEL="deepseek/deepseek-v4-flash" PI_TEST_TIMEOUT=180000
 * npm run test:integration` from inside herdr. The explicit model keeps
 * real-LLM runs predictable and the longer timeout covers the lifecycle suite.
 *
 * Configuration:
 *   PI_TEST_MODEL     — model for all pi sessions (default: openrouter/free; recommended: deepseek/deepseek-v4-flash)
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */
import { describe, it, before, after } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  promptPane,
  interruptPane,
  waitForScreen,
  waitForFile,
  sleep,
  uniqueId,
  trackTempFile,
  readPane,
  PI_TIMEOUT,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

function configureWaitAll(env: TestEnv): void {
  writeFileSync(
    `${env.agentDir}/agents/config.json`,
    JSON.stringify({
      status: { enabled: true },
      models: { default: process.env.PI_TEST_MODEL ?? "openrouter/free" },
      orchestration: { mode: "wait-all" },
    }),
  );
}

interface SessionEntry {
  type?: string;
  id?: unknown;
  parentSession?: unknown;
  customType?: string;
  data?: { handle?: { id?: unknown } };
  message?: { role?: string; content?: unknown };
}

/** Parse a Pi session JSONL file, skipping blank or half-written lines. */
function readSessionEntries(sessionFile: string): SessionEntry[] {
  return readFileSync(sessionFile, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line) as SessionEntry] : [];
      } catch {
        return [];
      }
    });
}

/** Every message from every Pi session file the test environment produced. */
function readSessionMessages(env: TestEnv): Array<NonNullable<SessionEntry["message"]>> {
  const root = join(env.agentDir, "sessions");
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) => readSessionEntries(join(root, file)))
    .flatMap((entry) => (entry.message ? [entry.message] : []));
}

function subagentToolCalls(env: TestEnv): Array<Record<string, unknown>> {
  return readSessionMessages(env)
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((block): block is { type: string; name: string; arguments: Record<string, unknown> } =>
      block?.type === "toolCall" && block.name === "subagent")
    .map((block) => block.arguments);
}

function toolResultTexts(env: TestEnv): string[] {
  return readSessionMessages(env)
    .filter((message) => message.role === "toolResult" && Array.isArray(message.content))
    .flatMap((message) => (message.content as Array<{ text?: string }>).map((block) => block.text ?? ""));
}

/** Poll until a recorded tool result matches; wait-all results land only after the child finishes. */
async function waitForToolResult(env: TestEnv, pattern: RegExp, timeout: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const match = toolResultTexts(env).find((text) => pattern.test(text));
    if (match) return match;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for a tool result matching ${pattern}.`);
}

function paneSessionFile(surface: string): string | undefined {
  const output = execFileSync("herdr", ["pane", "get", surface], { encoding: "utf8" });
  const parsed: unknown = JSON.parse(output);
  const result: unknown = parsed && typeof parsed === "object" ? Reflect.get(parsed, "result") : undefined;
  const pane: unknown = result && typeof result === "object" ? Reflect.get(result, "pane") : undefined;
  if (!pane || typeof pane !== "object" || Reflect.get(pane, "pane_id") !== surface) return undefined;
  const agentSession: unknown = Reflect.get(pane, "agent_session");
  const sessionFile: unknown = agentSession && typeof agentSession === "object" ? Reflect.get(agentSession, "value") : undefined;
  return typeof sessionFile === "string" ? sessionFile : undefined;
}

/** Count model-facing results by original call identity, not private text hidden by the TUI. */
function assertWaitAllDelivery(surface: string, name: string, outcomes: Array<"completed" | "failed" | "asks">): void {
  const sessionFile = paneSessionFile(surface);
  assert.ok(sessionFile, "parent pane must report its native persisted session");
  const entries = parseSessionEntries(readFileSync(sessionFile, "utf8"));
  const messages = entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []);
  const calls = messages.flatMap((message) => message.role === "assistant"
    ? message.content.filter((block) => block.type === "toolCall") : []);
  const initialCalls = calls.filter((call) => call.name === "subagent" && call.arguments.name === name);
  assert.equal(initialCalls.length, 1, "one initial call must own this assignment");
  const results = messages.filter((message) => message.role === "toolResult");
  const initialResults = results.filter((message) => message.toolCallId === initialCalls[0].id);
  assert.equal(initialResults.length, 1, "initial call needs exactly one native result");
  const initialDetails = initialResults[0].details;
  assert.ok(initialDetails && typeof initialDetails === "object");
  const handleId: unknown = Reflect.get(initialDetails, "id");
  assert.equal(typeof handleId, "string");
  const assignmentCalls = [initialCalls[0], ...calls.filter((call) =>
    call.name === "subagent_prompt" && call.arguments.id === handleId)];
  assert.equal(assignmentCalls.length, outcomes.length, "one original call per observed turn");
  for (const [index, call] of assignmentCalls.entries()) {
    const ownResults = results.filter((message) => message.toolCallId === call.id);
    assert.equal(ownResults.length, 1, "each original call needs exactly one native result");
    const ownResult = ownResults[0];
    assert.equal(ownResult.toolName, call.name);
    const text = ownResult.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
    assert.ok(text.includes(`Sub-agent "${name}" ${outcomes[index]}`), text);
    const details = ownResult.details;
    assert.ok(details && typeof details === "object");
    assert.equal(Reflect.get(details, "id"), handleId);
    assert.equal(Reflect.get(details, "name"), name);
    assert.equal(Reflect.get(details, "async"), false);
    assert.equal(Reflect.get(details, "status"), outcomes[index] === "asks" ? "awaiting_answer" : "finalized");
    assert.equal(typeof Reflect.get(details, "elapsed"), "number");
    assert.equal(Reflect.get(details, "exitCode"), outcomes[index] === "failed" ? 1 : 0);
    assert.equal(Reflect.get(details, "task"), call.arguments.task ?? call.arguments.message);
    if (outcomes[index] === "asks") assert.match(text, /PING/);
    else if (call.arguments.agent === "test-echo" || call.name === "subagent_prompt") {
      const childSessionFile: unknown = Reflect.get(details, "sessionFile");
      assert.ok(typeof childSessionFile === "string");
      const childMessages = parseSessionEntries(readFileSync(childSessionFile, "utf8")).flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "stop" ? [entry.message] : []);
      const summary = childMessages[index]?.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      assert.ok(summary, "child must have a nonempty final response");
      assert.ok(text.includes(summary), "original result must retain full private child response for the model");
    }
  }
  assert.deepEqual(entries.filter((entry) => entry.type === "custom_message" &&
    (entry.customType === "subagent_result" || entry.customType === "subagent_ask") &&
    ((entry.details && typeof entry.details === "object" && Reflect.get(entry.details, "id") === handleId) ||
      JSON.stringify(entry.content).includes(name))),
  [], "wait-all must not duplicate original results as completion steer messages");
}

function workspacePaneIds(env: TestEnv): string[] {
  const output = execFileSync("herdr", ["pane", "list", "--workspace", env.workspaceId], { encoding: "utf8" });
  const parsed = JSON.parse(output) as { result?: { panes?: Array<{ pane_id?: unknown }> } };
  return (parsed.result?.panes ?? [])
    .map((pane) => pane.pane_id)
    .filter((paneId): paneId is string => typeof paneId === "string");
}

async function waitForChildPane(env: TestEnv, existingPanes: Set<string>, timeout: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const children = workspacePaneIds(env).filter((paneId) => !existingPanes.has(paneId));
    if (children.length === 1) return children[0];
    await sleep(500);
  }
  throw new Error("Timed out waiting for the spawned Pi Assignment pane.");
}

async function waitForHandleId(surface: string, timeout: number): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const output = execFileSync("herdr", ["pane", "get", surface], { encoding: "utf8" });
    const parsed = JSON.parse(output) as { result?: { pane?: { agent_session?: { value?: unknown } } } };
    const sessionFile = parsed.result?.pane?.agent_session?.value;
    if (typeof sessionFile === "string" && existsSync(sessionFile)) {
      for (const entry of readSessionEntries(sessionFile).toReversed()) {
        const id = entry.data?.handle?.id;
        if (entry.customType === "subagent_handle" && typeof id === "string") return id;
      }
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for the durable Subagent handle.");
}

async function waitForChildPaneGone(env: TestEnv, pane: string, timeout: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (!workspacePaneIds(env).includes(pane)) return;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for Assignment pane ${pane} to close.`);
}

async function waitForWidgetClear(surface: string, timeout: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (!/Subagents/.test(readPane(surface, 100))) return;
    await sleep(500);
  }
  throw new Error("Timed out waiting for the Subagents widget to clear.");
}

if (backends.length === 0) {
  console.log("⚠️  herdr is unavailable — skipping subagent lifecycle integration tests");
  console.log("   Run inside herdr to enable these tests.");
}

for (const backend of backends) {
  describe(`subagent-lifecycle [${backend}]`, { timeout: PI_TIMEOUT * 3 }, () => {
    let prevMux: string | undefined;
    let env: TestEnv;

    before(() => {
      prevMux = setBackend(backend);
      env = createTestEnv(backend);
    });

    after(() => {
      cleanupTestEnv(env);
      restoreBackend(prevMux);
    });

    // ── Parent Escape hard stop ──

    it("Escape abandons an interactive Pi assignment and permits recovery", async () => {
      const id = uniqueId();
      const parentStart = `/tmp/pi-integ-escape-parent-start-${id}.txt`;
      const parentMarker = `/tmp/pi-integ-escape-parent-${id}.txt`;
      const childMarker = `/tmp/pi-integ-escape-child-${id}.txt`;
      const freshMarker = `/tmp/pi-integ-escape-fresh-${id}.txt`;
      trackTempFile(env, parentStart);
      trackTempFile(env, parentMarker);
      trackTempFile(env, childMarker);
      trackTempFile(env, freshMarker);

      const name = `HardStop-${id}`;
      const surface = createTrackedSurface(env, `hard-stop-${id}`);
      const existingPanes = new Set(workspacePaneIds(env));
      await sleep(1000);
      startPi(surface, env.dir, [
        `Call subagent exactly once with name "${name}", agent "test-echo", interactive: true,`,
        `and task "Run: sleep 90; echo CHILD_${id} > '${childMarker}'".`,
        `After the tool returns, run bash: echo START_${id} > '${parentStart}'; sleep 30; echo PARENT_${id} > '${parentMarker}'.`,
      ].join("\n"));

      const childPane = await waitForChildPane(env, existingPanes, PI_TIMEOUT);
      await waitForScreen(surface, /Subagents/, PI_TIMEOUT);
      const handleId = await waitForHandleId(surface, PI_TIMEOUT);
      await waitForFile(parentStart, PI_TIMEOUT, new RegExp(`START_${id}`));

      interruptPane(surface);
      await waitForChildPaneGone(env, childPane, PI_TIMEOUT);
      await waitForWidgetClear(surface, PI_TIMEOUT);
      assert.equal(existsSync(parentMarker), false, "Escape must abort the parent turn before its follow-up work");

      promptPane(surface, [
        `First call subagent_prompt with id "${handleId}" and message "should fail";`,
        `then call subagent exactly once with name "Fresh-${id}", agent "test-echo",`,
        `and task "Run: echo FRESH_${id} > '${freshMarker}'". Do nothing else.`,
      ].join("\n"));

      await waitForFile(freshMarker, PI_TIMEOUT, new RegExp(`FRESH_${id}`));
      const recovered = await waitForScreen(surface, /cannot be continued|abandoned/i, PI_TIMEOUT);
      assert.match(recovered, /cannot be continued|abandoned/i, "the abandoned durable handle must reject subagent_prompt");
    });

    // ── Basic spawn + completion ──

    it("spawns a subagent that writes a file and verifies the session", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `echo-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Echo-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say INTEGRATION_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: subagent created the marker file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
      assert.ok(
        content.includes(`PASS_${id}`),
        `Marker file should contain PASS_${id}. Got: ${content.trim()}`,
      );

      // Verify: outer pi received the subagent result
      const screen = await waitForScreen(
        surface,
        /INTEGRATION_COMPLETE|completed|Sub-agent.*"Echo/i,
        PI_TIMEOUT,
      );

      // Verify: session file was created (shown in steer result)
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Subagent session file should exist: ${sessionFile}`);

        const entries = readSessionEntries(sessionFile);
        assert.ok(entries.length >= 2, `Session should have ≥2 entries, got ${entries.length}`);

        const header = entries[0];
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.id, "Session header should have an id");

        // The blank-session child's task tells it that its final message is the result.
        const firstUser = entries.find((entry) => entry.message?.role === "user")?.message?.content;
        const childTask = JSON.stringify(firstUser);
        assert.match(childTask, /Your final message is your result: the agent that delegated this task sees nothing else\./);
        assert.doesNotMatch(childTask, /summarize what you accomplished/i);
      }
    });

    it("async returns before the subagent completes", async () => {
      const id = uniqueId();
      const childFile = `/tmp/pi-integ-async-child-${id}.txt`;
      const parentFile = `/tmp/pi-integ-async-parent-${id}.txt`;
      trackTempFile(env, childFile);
      trackTempFile(env, parentFile);

      const surface = createTrackedSurface(env, `async-${id}`);
      await sleep(1000);
      startPi(surface, env.dir, [
        "Call subagent exactly once with these parameters:",
        `name: "Async-${id}"`,
        'agent: "test-echo"',
        `task: "Run: sleep 20; echo 'CHILD_${id}' > '${childFile}'"`,
        `This next step is unrelated to the subagent's task, so do it right away without waiting for the subagent:`,
        `run bash: echo 'PARENT_${id}' > '${parentFile}'.`,
        "Then say ASYNC_COMPLETE.",
      ].join("\n"));

      const parent = await waitForFile(parentFile, PI_TIMEOUT, /PARENT_/);
      assert.match(parent, new RegExp(`PARENT_${id}`));
      assert.equal(existsSync(childFile), false, "async parent work must start before child completion");
      await waitForFile(childFile, PI_TIMEOUT, /CHILD_/);
      assert.ok(
        toolResultTexts(env).some((text) => text.includes(`"Async-${id}" owns this task now.`)),
        "async launch result must restate Assignment ownership",
      );
    });

    it("wait-all returns the terminal subagent result before parent work continues", async () => {
      const id = uniqueId();
      const childFile = `/tmp/pi-integ-wait-all-child-${id}.txt`;
      const parentFile = `/tmp/pi-integ-wait-all-parent-${id}.txt`;
      trackTempFile(env, childFile);
      trackTempFile(env, parentFile);
      configureWaitAll(env);

      const surface = createTrackedSurface(env, `wait-all-${id}`);
      await sleep(1000);
      startPi(surface, env.dir, [
        `Call subagent exactly once with name "WaitAll-${id}", agent "test-echo",`,
        `and task "Run: sleep 5; echo 'CHILD_${id}' > '${childFile}'".`,
        `Only after that tool call returns, run bash: echo 'PARENT_${id}' > '${parentFile}'.`,
        "Then say WAIT_ALL_COMPLETE.",
      ].join("\n"));

      const parent = await waitForFile(parentFile, PI_TIMEOUT, /PARENT_/);
      assert.match(parent, new RegExp(`PARENT_${id}`));
      assert.equal(existsSync(childFile), true, "child must finish before parent continues");
      assert.match(readFileSync(childFile, "utf8"), new RegExp(`CHILD_${id}`));
      await waitForScreen(surface, /WAIT_ALL_COMPLETE/, PI_TIMEOUT);
      assertWaitAllDelivery(surface, `WaitAll-${id}`, ["completed"]);
    });


    it("wait-all returns a resumed subagent result through its original tool call", async () => {
      const id = uniqueId();
      const firstFile = `/tmp/pi-integ-wait-all-resume-first-${id}.txt`;
      const resumedFile = `/tmp/pi-integ-wait-all-resume-result-${id}.txt`;
      const parentFile = `/tmp/pi-integ-wait-all-resume-parent-${id}.txt`;
      trackTempFile(env, firstFile);
      trackTempFile(env, resumedFile);
      trackTempFile(env, parentFile);
      configureWaitAll(env);

      const firstName = `ResumeSource-${id}`;
      const surface = createTrackedSurface(env, `resume-wait-all-${id}`);
      await sleep(1000);
      startPi(surface, env.dir, [
        `Call subagent with name "${firstName}", agent "test-echo", and task "Run: echo 'FIRST_${id}' > '${firstFile}'".`,
        `After its result returns, call subagent_prompt with immutable id from that result,`,
        `and message "Run bash: echo 'RESUMED_${id}' > '${resumedFile}'".`,
        `Only after subagent_prompt returns, run bash: echo 'PARENT_${id}' > '${parentFile}'.`,
        "Then say RESUME_WAIT_ALL_COMPLETE.",
      ].join("\n"));

      await waitForFile(parentFile, PI_TIMEOUT, /PARENT_/);
      assert.match(await waitForFile(resumedFile, PI_TIMEOUT, /RESUMED_/), new RegExp(`RESUMED_${id}`));
      await waitForScreen(surface, /RESUME_WAIT_ALL_COMPLETE/, PI_TIMEOUT);
      assertWaitAllDelivery(surface, firstName, ["completed", "completed"]);
    });

    it("wait-all settles a parallel batch with distinct success and failure results", async () => {
      const id = uniqueId();
      const successStart = `/tmp/pi-integ-parallel-success-start-${id}.txt`;
      const failureStart = `/tmp/pi-integ-parallel-failure-start-${id}.txt`;
      const successDone = `/tmp/pi-integ-parallel-success-done-${id}.txt`;
      const failureDone = `/tmp/pi-integ-parallel-failure-done-${id}.txt`;
      const parentFile = `/tmp/pi-integ-parallel-parent-${id}.txt`;
      trackTempFile(env, successStart);
      trackTempFile(env, failureStart);
      trackTempFile(env, successDone);
      trackTempFile(env, failureDone);
      trackTempFile(env, parentFile);
      configureWaitAll(env);
      writeFileSync(
        `${env.agentDir}/agents/parallel-success-${id}.md`,
        `---\nname: parallel-success-${id}\ncli: test-shell\ncommand: "date +%s%3N > '${successStart}'; sleep 20; printf done > '${successDone}'; true"\n---\n`,
      );
      writeFileSync(
        `${env.agentDir}/agents/parallel-failure-${id}.md`,
        `---\nname: parallel-failure-${id}\ncli: test-shell\ncommand: "date +%s%3N > '${failureStart}'; sleep 1; printf done > '${failureDone}'; false"\n---\n`,
      );

      const successName = `ParallelSuccess-${id}`;
      const failureName = `ParallelFailure-${id}`;
      const surface = createTrackedSurface(env, `parallel-wait-all-${id}`);
      await sleep(1000);
      startPi(surface, env.dir, [
        "Make exactly two subagent tool calls in one assistant response. Do not make any other tool calls until both return.",
        `First: name "${successName}", agent "parallel-success-${id}", task "success".`,
        `Second: name "${failureName}", agent "parallel-failure-${id}", task "failure".`,
        `After both results return, run bash: echo 'PARENT_${id}' > '${parentFile}'.`,
        "Then say PARALLEL_WAIT_ALL_COMPLETE and nothing else.",
      ].join("\n"));

      await waitForFile(parentFile, PI_TIMEOUT, /PARENT_/);
      assert.equal(existsSync(successDone), true, "successful sibling must finish before parent continues");
      assert.equal(existsSync(failureDone), true, "failed sibling must settle before parent continues");
      // Success child sleeps 20s: a sequential launch would start >20s apart, so 10s still catches it.
      assert.ok(
        Math.abs(Number(readFileSync(successStart, "utf8")) - Number(readFileSync(failureStart, "utf8"))) < 10_000,
        "siblings must launch concurrently, not after each other's terminal result",
      );

      await waitForScreen(surface, /PARALLEL_WAIT_ALL_COMPLETE/, PI_TIMEOUT);
      assertWaitAllDelivery(surface, successName, ["completed"]);
      assertWaitAllDelivery(surface, failureName, ["failed"]);
    });

    // ── In-progress activity snapshots ──

    it("keeps a long active tool call from showing stalled in the widget or messaging the Orchestrator", async () => {
      const id = uniqueId();
      const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
      const markerFile = `/tmp/pi-integ-status-${id}.txt`;
      trackTempFile(env, startFile);
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `status-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Status-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 90; echo 'STATUS_${id}' > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say STATUS_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const activeScreen = await waitForScreen(surface, /active[\s\S]*bash|bash[\s\S]*active/i, PI_TIMEOUT, 300);
      assert.doesNotMatch(activeScreen, /stalled \d+[sm]|Subagent status:/i);

      await waitForFile(startFile, PI_TIMEOUT, /START_/);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the long sleep");
      await sleep(65_000);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the watchdog assertion");
      const watchdogScreen = readPane(surface, 300);
      assert.doesNotMatch(watchdogScreen, /stalled \d+[sm]|Subagent status:/i);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
      assert.ok(content.includes(`STATUS_${id}`), `Marker file should contain STATUS_${id}`);

      const completionScreen = await waitForScreen(
        surface,
        /STATUS_TEST_DONE|completed|Sub-agent.*"Status-/i,
        PI_TIMEOUT,
        300,
      );
      assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen));
    });

    // ── Parallel subagent spawn ──

    it("spawns two subagents in parallel and both complete", async () => {
      const id = uniqueId();
      const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
      const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
      trackTempFile(env, fileA);
      trackTempFile(env, fileB);

      const surface = createTrackedSurface(env, `parallel-${id}`);
      await sleep(1000);

      const task = [
        `You must call the subagent tool TWICE. Make both calls before waiting for results.`,
        ``,
        `First call:`,
        `  name: "ParaA-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
        ``,
        `Second call:`,
        `  name: "ParaB-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
        ``,
        `Call both subagent tools NOW, do not wait between them.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Both marker files should appear
      const [contentA, contentB] = await Promise.all([
        waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
        waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
      ]);

      assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`);
      assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`);
    });

    // ── Fork mode ──

    it("fork mode creates a child session linked to the parent", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `fork-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  fork: true`,
        `  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
        `Do not set the name, agent or interactive parameters. Just set fork and task.`,
        `After you receive the result, say FORK_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: forked subagent created the file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
      assert.ok(content.includes(`FORK_OK_${id}`), `Fork marker file should exist with content`);

      // Wait for the outer pi to show the result
      const screen = await waitForScreen(
        surface,
        /FORK_COMPLETE|completed|Sub-agent.*"fork/i,
        PI_TIMEOUT,
      );

      // With no name or agent the display name falls back to "fork", never "undefined".
      await waitForToolResult(env, /"fork"/, PI_TIMEOUT);
      assert.ok(!toolResultTexts(env).some((text) => /undefined/.test(text)), "no tool result may mention undefined");

      // Receiving the result proves the bare fork auto-exited and its child pane
      // was finalized instead of remaining at the editor as an interactive run.

      // Verify: the forked session has a parent link
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Fork session file should exist: ${sessionFile}`);

        const entries = readSessionEntries(sessionFile);
        const header = entries[0];
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.parentSession, "Fork session should have parentSession field");
        // Fork sessions include parent context (model_change entries etc.)
        assert.ok(entries.length >= 2, "Fork session should have context entries beyond header");
      }
    });

    // ── subagent_ask ──

    it("subagent_ask sends question back to the parent", async () => {
      const id = uniqueId();

      const surface = createTrackedSurface(env, `ask-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these EXACT parameters:`,
        `  name: "Ping-${id}"`,
        `  agent: "test-ask"`,
        `  task: "ASK_TEST_${id}"`,
        `Just call the subagent tool once. Do not do anything else before calling it.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-ask agent calls subagent_ask, which steers its question
      // back to the outer pi. Look for it on screen.
      const screen = await waitForScreen(
        surface,
        /asks|PING|subagent_ask/i,
        PI_TIMEOUT,
      );

      assert.ok(
        /asks|PING/i.test(screen),
        `Screen should show question notification. Got:\n${screen.slice(-800)}`,
      );
    });

    it("wait-all returns subagent_ask through its original tool result", async () => {
      const id = uniqueId();
      const parentFile = `/tmp/pi-integ-wait-all-ask-parent-${id}.txt`;
      trackTempFile(env, parentFile);
      configureWaitAll(env);

      const name = `WaitAllPing-${id}`;
      const surface = createTrackedSurface(env, `wait-all-ask-${id}`);
      await sleep(1000);
      startPi(surface, env.dir, [
        `Call subagent exactly once with name "${name}", agent "test-ask", and task "ASK_${id}".`,
        `Only after that tool call returns, run bash: echo 'PARENT_${id}' > '${parentFile}'.`,
        "Then say WAIT_ALL_ASK_COMPLETE.",
      ].join("\n"));

      await waitForFile(parentFile, PI_TIMEOUT, /PARENT_/);
      await waitForScreen(surface, /WAIT_ALL_ASK_COMPLETE/, PI_TIMEOUT);
      assertWaitAllDelivery(surface, name, ["asks"]);
    });

    // ── Agent discovery ──

    it("unknown agent names are rejected without launching anything", async () => {
      const id = uniqueId();
      const surface = createTrackedSurface(env, `unknown-${id}`);
      const existingPanes = new Set(workspacePaneIds(env));
      await sleep(1000);

      startPi(surface, env.dir, [
        `Call the subagent tool exactly once with name "Typo-${id}", agent "no-such-agent-${id}", and task "anything".`,
        `Then say UNKNOWN_DONE and do nothing else, even if the call fails.`,
      ].join("\n"));

      await waitForScreen(surface, /Unknown agent "no-such-agent/, PI_TIMEOUT, 300);
      await sleep(1500); // let the session file catch up with the screen
      assert.ok(
        toolResultTexts(env).some((text) => text.startsWith(`Unknown agent "no-such-agent-${id}". Available:`)),
        "the tool result must be the unknown-agent error",
      );
      assert.deepEqual(
        workspacePaneIds(env).filter((pane) => !existingPanes.has(pane)),
        [],
        "no child pane may be launched",
      );
    });

    it("subagent finds a visible agent from the prompt catalog", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
      trackTempFile(env, markerFile);
      const agentName = `marker-writer-${id}`;
      writeFileSync(
        join(env.agentDir, "agents", `${agentName}.md`),
        [
          "---",
          `name: ${agentName}`,
          "description: Use when a file with a given marker text must be written to disk.",
          "tools: read, bash, write, edit",
          "spawning: false",
          "auto-exit: true",
          "---",
          "",
          "You are a test agent. Complete the task given to you immediately. Be direct and concise.",
          "",
        ].join("\n"),
      );

      // A malformed agent file is skipped with a warning; the good agent still loads.
      writeFileSync(join(env.agentDir, "agents", `broken-${id}.md`), "---\nname: [unclosed\n---\nbody\n");

      const surface = createTrackedSurface(env, `discovery-${id}`);
      await sleep(1000);

      // No agent name in the prompt: the model must pick it from its catalog.
      const task = [
        `Use the subagent tool once, with the available subagent whose description says it writes marker files.`,
        `  name: "Disco-${id}"`,
        `  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
        `After you receive the subagent result, say DISCOVERY_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      await waitForScreen(surface, new RegExp(`Skipped agent broken-${id}\\.md`), PI_TIMEOUT, 300);
      const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
      assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
      // The prompt never named the agent, so the model got it from its catalog.
      assert.ok(
        subagentToolCalls(env).some((call) => call.agent === agentName),
        `model must delegate to ${agentName} using the catalog`,
      );
    });

    // ── Subagent with named role instructions ──

    it("uses named agent body for subagent role instructions", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-roleprompt-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `roleprompt-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool with these parameters:`,
        `  name: "Role-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Write 'ROLEPROMPT_${id}' to ${markerFile} using bash: echo 'ROLEPROMPT_${id}' > '${markerFile}'"`,
        `After the subagent completes, say ROLEPROMPT_TEST_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT, /ROLEPROMPT/);
      assert.ok(content.includes(`ROLEPROMPT_${id}`), `Named agent role test marker should exist`);
    });
  });
}
