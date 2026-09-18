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
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  getAvailableBackends,
  setBackend,
  restoreBackend,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
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

        const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
        assert.ok(lines.length >= 2, `Session should have ≥2 entries, got ${lines.length}`);

        const header = JSON.parse(lines[0]);
        assert.equal(header.type, "session", "First entry should be session header");
        assert.ok(header.id, "Session header should have an id");
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
        `task: "Run: sleep 5; echo 'CHILD_${id}' > '${childFile}'"`,
        `Immediately after subagent returns, run bash: echo 'PARENT_${id}' > '${parentFile}'.`,
        "Then say ASYNC_COMPLETE.",
      ].join("\n"));

      const parent = await waitForFile(parentFile, PI_TIMEOUT, /PARENT_/);
      assert.match(parent, new RegExp(`PARENT_${id}`));
      assert.equal(existsSync(childFile), false, "async parent work must start before child completion");
      await waitForFile(childFile, PI_TIMEOUT, /CHILD_/);
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
      const screen = await waitForScreen(surface, /WAIT_ALL_COMPLETE/, PI_TIMEOUT);
      const completed = screen.match(new RegExp(`Sub-agent "WaitAll-${id}" completed`, "g")) ?? [];
      assert.equal(completed.length, 1, "wait-all must return one terminal result without a completion steer");
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
      const screen = await waitForScreen(surface, /RESUME_WAIT_ALL_COMPLETE/, PI_TIMEOUT);
      assert.equal(
        (screen.match(new RegExp(`Sub-agent "${firstName}" completed`, "g")) ?? []).length,
        2,
        "continued subagent needs one completion per turn",
      );
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
        `---\nname: parallel-success-${id}\ncli: test-shell\ncommand: "date +%s%3N > '${successStart}'; sleep 5; printf done > '${successDone}'; true"\n---\n`,
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
      assert.ok(
        Math.abs(Number(readFileSync(successStart, "utf8")) - Number(readFileSync(failureStart, "utf8"))) < 3_000,
        "siblings must launch concurrently, not after each other's terminal result",
      );

      const screen = await waitForScreen(surface, /PARALLEL_WAIT_ALL_COMPLETE/, PI_TIMEOUT);
      assert.equal(
        (screen.match(new RegExp(`Sub-agent "${successName}" completed`, "g")) ?? []).length,
        1,
        "successful sibling needs one original-call result",
      );
      assert.equal(
        (screen.match(new RegExp(`Sub-agent "${failureName}" failed`, "g")) ?? []).length,
        1,
        "failed sibling needs one original-call result",
      );
    });

    // ── In-progress activity snapshots ──

    it("keeps a long active tool call from surfacing false stalled status", async () => {
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
      assert.doesNotMatch(activeScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

      await waitForFile(startFile, PI_TIMEOUT, /START_/);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the long sleep");
      await sleep(65_000);
      assert.equal(existsSync(markerFile), false, "Completion marker should not exist before the watchdog assertion");
      const watchdogScreen = readPane(surface, 300);
      assert.doesNotMatch(watchdogScreen, /Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i);

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
        `  name: "Fork-${id}"`,
        `  fork: true`,
        `  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
        `Do not set the agent or interactive parameters. Just set name, fork, and task.`,
        `After you receive the result, say FORK_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // Verify: forked subagent created the file
      const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
      assert.ok(content.includes(`FORK_OK_${id}`), `Fork marker file should exist with content`);

      // Wait for the outer pi to show the result
      const screen = await waitForScreen(
        surface,
        /FORK_COMPLETE|completed|Sub-agent.*"Fork/i,
        PI_TIMEOUT,
      );

      // Receiving the result proves the bare fork auto-exited and its child pane
      // was finalized instead of remaining at the editor as an interactive run.

      // Verify: the forked session has a parent link
      const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
      if (sessionMatch) {
        const sessionFile = sessionMatch[1];
        assert.ok(existsSync(sessionFile), `Fork session file should exist: ${sessionFile}`);

        const entries = readFileSync(sessionFile, "utf8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
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
      const screen = await waitForScreen(surface, /WAIT_ALL_ASK_COMPLETE/, PI_TIMEOUT);
      assert.equal(
        (screen.match(new RegExp(`Sub-agent "${name}" asks`, "g")) ?? []).length,
        1,
        "subagent_ask needs one original-call result without a steer duplicate",
      );
    });

    // ── Agent discovery ──

    it("subagent discovers global test agents", async () => {
      const id = uniqueId();
      const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `discovery-${id}`);
      await sleep(1000);

      // Use subagents_list to verify test agents are discoverable,
      // then spawn one to prove it works end-to-end.
      const task = [
        `First, call the subagents_list tool to see available agents.`,
        `Then call the subagent tool:`,
        `  name: "Disco-${id}"`,
        `  agent: "test-echo"`,
        `  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
        `After you receive the subagent result, say DISCOVERY_DONE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      // The test-echo agent from isolated global config should work
      const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
      assert.ok(content.includes(`DISCO_${id}`), `Discovery test marker should exist`);
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
