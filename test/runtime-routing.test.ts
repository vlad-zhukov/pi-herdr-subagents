import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RuntimeResolutionError,
  resolveRuntimePlan,
  wrapPiModelRegistry,
  type ParentRuntime,
  type RuntimeDefaults,
} from "../pi-extension/subagents/runtime-routing.ts";

const parent: ParentRuntime = {
  provider: "fake",
  modelId: "parent",
  thinking: "medium",
};

function model(
  provider: string,
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    provider,
    id,
    reasoning: true,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_000,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
}

function registry(entries = [model("fake", "parent"), model("other", "fast")]) {
  const byRef = new Map(entries.map((entry) => [`${entry.provider}/${entry.id}`, entry]));
  return wrapPiModelRegistry({
    find(provider: string, modelId: string) {
      return byRef.get(`${provider}/${modelId}`);
    },
    getAvailable() {
      return entries;
    },
    getAll() {
      return entries;
    },
    hasConfiguredAuth(candidate: { provider: string; id: string }) {
      return byRef.has(`${candidate.provider}/${candidate.id}`) && candidate.id !== "unauthed";
    },
  });
}

function resolve(defaults: RuntimeDefaults = {}) {
  return resolveRuntimePlan(defaults, parent, registry());
}

describe("runtime routing", () => {
  it("inherits the parent model and thinking when no config is present", () => {
    assert.deepEqual(resolve(), {
      provider: "fake",
      modelId: "parent",
      model: "fake/parent",
      thinking: "medium",
      modelSource: "parent",
      thinkingSource: "parent",
    });
  });

  it("resolves configured model and thinking together", () => {
    assert.deepEqual(
      resolve({ model: "other/fast", thinking: "high" }),
      {
        provider: "other",
        modelId: "fast",
        model: "other/fast",
        thinking: "high",
        modelSource: "config",
        thinkingSource: "config",
      },
    );
  });

  it("parses exact model references at the first slash", () => {
    const nested = model("other", "family/reasoner");
    const plan = resolveRuntimePlan(
      { model: "other/family/reasoner" },
      parent,
      registry([model("fake", "parent"), nested]),
    );
    assert.equal(plan.provider, "other");
    assert.equal(plan.modelId, "family/reasoner");
  });

  it("rejects fuzzy, unknown, and unauthenticated configured models", () => {
    for (const defaults of [
      { model: "fast" },
      { model: "other/missing" },
      { model: "other/unauthed" },
    ]) {
      const entries = [model("fake", "parent"), model("other", "unauthed")];
      assert.throws(
        () => resolveRuntimePlan(defaults, parent, registry(entries)),
        RuntimeResolutionError,
      );
    }
  });

  it("rejects unsupported configured thinking with supported alternatives", () => {
    const plain = model("other", "plain", { reasoning: false });
    assert.throws(
      () =>
        resolveRuntimePlan(
          { model: "other/plain", thinking: "high" },
          parent,
          registry([model("fake", "parent"), plain]),
        ),
      /thinking "high" is not supported.*supported: off/,
    );
  });

  it("uses configured thinking when present", () => {
    const plan = resolveRuntimePlan({ thinking: "low" }, parent, registry());
    assert.equal(plan.thinking, "low");
    assert.equal(plan.thinkingSource, "config");
  });

  it("clamps inherited thinking for a reasoning model with a sparse level map", () => {
    const sparse = model("other", "sparse", {
      thinkingLevelMap: {
        off: "off",
        minimal: "minimal",
        low: "low",
        medium: null,
        high: "high",
      },
    });
    const plan = resolveRuntimePlan(
      { model: "other/sparse" },
      parent,
      registry([model("fake", "parent"), sparse]),
    );
    assert.equal(plan.thinking, "high");
    assert.deepEqual(plan.thinkingAdjustment, {
      from: "medium",
      to: "high",
      reason: "inherited-clamp",
    });
  });

  it("clamps inherited thinking for a non-reasoning selected model", () => {
    const plain = model("other", "plain", { reasoning: false });
    const plan = resolveRuntimePlan(
      { model: "other/plain" },
      parent,
      registry([model("fake", "parent"), plain]),
    );
    assert.equal(plan.thinking, "off");
    assert.equal(plan.thinkingSource, "parent");
    assert.deepEqual(plan.thinkingAdjustment, {
      from: "medium",
      to: "off",
      reason: "non-reasoning",
    });
  });
});
