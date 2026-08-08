/**
 * Model selection tests.
 *
 * Regression cover for configured-model routing. selectModel() used to try the
 * hardcoded routing matrix first. Because ModelRegistry.initialize() re-seeds
 * the Conway/OpenAI baseline as enabled on every startup, a matrix candidate
 * was always present and the operator's configured model was never reached —
 * so an explicitly configured Ollama model still routed to Conway.
 */

import { describe, it, expect } from "vitest";
import { InferenceRouter } from "../../inference/router.js";
import type { ModelEntry } from "../../types.js";

function entry(over: Partial<ModelEntry> & { modelId: string }): ModelEntry {
  return {
    provider: "conway",
    displayName: over.modelId,
    tierMinimum: "critical",
    costPer1kInput: 1,
    costPer1kOutput: 1,
    maxTokens: 4096,
    contextWindow: 8192,
    supportsTools: true,
    supportsVision: false,
    parameterStyle: "max_tokens",
    enabled: true,
    lastSeen: null,
    createdAt: "",
    updatedAt: "",
    ...over,
  } as ModelEntry;
}

const LOCAL = entry({
  modelId: "qwen2.5:7b",
  provider: "ollama",
  costPer1kInput: 0,
  costPer1kOutput: 0,
});
const CONWAY = entry({ modelId: "gpt-5.2", provider: "conway" });

function makeRouter(
  models: ModelEntry[],
  strategy: Record<string, string | undefined>,
  usable?: (p: string) => boolean,
) {
  const registry = {
    get: (id: string) => models.find((m) => m.modelId === id),
    getAll: () => models,
  } as any;
  const budget = { config: strategy } as any;
  return new InferenceRouter({} as any, registry, budget, usable);
}

describe("selectModel", () => {
  it("prefers the configured model over a routing-matrix candidate", () => {
    const router = makeRouter([LOCAL, CONWAY], { inferenceModel: "qwen2.5:7b" });
    const picked = router.selectModel("normal", "agent_turn");
    expect(picked?.modelId).toBe("qwen2.5:7b");
    expect(picked?.provider).toBe("ollama");
  });

  it("still routes when no model is explicitly configured", () => {
    const router = makeRouter([CONWAY], {});
    expect(router.selectModel("normal", "agent_turn")?.modelId).toBe("gpt-5.2");
  });

  it("skips a configured model whose provider is unreachable", () => {
    const router = makeRouter(
      [LOCAL, CONWAY],
      { inferenceModel: "qwen2.5:7b" },
      (p) => p !== "ollama", // no ollamaBaseUrl configured
    );
    expect(router.selectModel("normal", "agent_turn")?.provider).toBe("conway");
  });

  it("never returns a matrix candidate whose provider has no credentials", () => {
    // Only Conway models are registered, and Conway is unreachable. Selecting
    // one anyway would guarantee a failed turn; null is the correct answer.
    const router = makeRouter(
      [CONWAY],
      {},
      (p) => p === "ollama", // only ollama reachable, and no ollama model exists
    );
    expect(router.selectModel("normal", "agent_turn")).toBeNull();
  });

  it("reaches an unreachable-matrix situation via the configured model", () => {
    // The matrix would offer Conway, which has no credentials; the configured
    // local model is what makes the turn possible.
    const router = makeRouter(
      [CONWAY, LOCAL],
      { inferenceModel: "qwen2.5:7b" },
      (p) => p === "ollama",
    );
    expect(router.selectModel("normal", "agent_turn")?.provider).toBe("ollama");
  });

  it("never selects a disabled model", () => {
    const disabled = { ...LOCAL, enabled: false };
    const router = makeRouter([disabled, CONWAY], { inferenceModel: "qwen2.5:7b" });
    expect(router.selectModel("normal", "agent_turn")?.modelId).toBe("gpt-5.2");
  });

  it("prefers the critical model when the tier is critical", () => {
    const cheap = entry({
      modelId: "cheap-local",
      provider: "ollama",
      costPer1kInput: 0,
      costPer1kOutput: 0,
    });
    const router = makeRouter([LOCAL, cheap], {
      inferenceModel: "qwen2.5:7b",
      criticalModel: "cheap-local",
    });
    expect(router.selectModel("critical", "agent_turn")?.modelId).toBe("cheap-local");
  });

  it("allows a free model regardless of tier minimum", () => {
    const freeButHighTier = entry({
      modelId: "free-local",
      provider: "ollama",
      tierMinimum: "normal",
      costPer1kInput: 0,
      costPer1kOutput: 0,
    });
    const router = makeRouter([freeButHighTier], { inferenceModel: "free-local" });
    expect(router.selectModel("critical", "agent_turn")?.modelId).toBe("free-local");
  });

  it("returns null when nothing is reachable", () => {
    const router = makeRouter([CONWAY], { inferenceModel: "gpt-5.2" }, () => false);
    expect(router.selectModel("normal", "agent_turn")).toBeNull();
  });

  it("returns null rather than substituting a model the tier cannot afford", () => {
    // Load-shedding at a low tier is intentional: declining work it cannot pay
    // for is the survival mechanic, so routing must not quietly find a
    // substitute.
    const expensive = entry({
      modelId: "pricey",
      provider: "conway",
      tierMinimum: "normal",
      costPer1kInput: 10,
    });
    const router = makeRouter([expensive], { inferenceModel: "pricey" }, () => true);
    expect(router.selectModel("critical", "agent_turn")).toBeNull();
  });
});
