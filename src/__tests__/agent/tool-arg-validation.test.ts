/**
 * Tool argument validation tests.
 *
 * Regression cover for a live model calling create_goal with only
 * `description`, which reached `(args.title as string).trim()` and threw
 * "Cannot read properties of undefined (reading 'trim')".
 */

import { describe, it, expect } from "vitest";
import { validateToolArgs, executeTool } from "../../agent/tools.js";
import type { AutomatonTool, ToolContext } from "../../types.js";

function makeTool(overrides?: Partial<AutomatonTool>): AutomatonTool {
  return {
    name: "create_goal",
    description: "Create a goal",
    category: "orchestration",
    riskLevel: "caution",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        strategy: { type: "string" },
      },
      required: ["title", "description"],
    },
    execute: async (args) => `ok:${(args.title as string).trim()}`,
    ...overrides,
  } as AutomatonTool;
}

describe("validateToolArgs", () => {
  it("accepts a call with every required argument", () => {
    expect(
      validateToolArgs(makeTool(), { title: "T", description: "D" }),
    ).toBeNull();
  });

  it("accepts extra optional arguments", () => {
    expect(
      validateToolArgs(makeTool(), {
        title: "T",
        description: "D",
        strategy: "fast",
      }),
    ).toBeNull();
  });

  it("names the single missing argument", () => {
    const err = validateToolArgs(makeTool(), { description: "D" });
    expect(err).toContain("missing required argument: title");
    expect(err).toContain("Required: title, description");
  });

  it("names every missing argument", () => {
    const err = validateToolArgs(makeTool(), {});
    expect(err).toContain("missing required arguments: title, description");
  });

  it("treats null like a missing argument", () => {
    const err = validateToolArgs(makeTool(), { title: null, description: "D" });
    expect(err).toContain("missing required argument: title");
  });

  it("rejects a required argument of the wrong primitive type", () => {
    const err = validateToolArgs(makeTool(), { title: 42, description: "D" });
    expect(err).toContain("wrong type");
    expect(err).toContain("title (expected string, got number)");
  });

  it("allows an empty string — emptiness is the tool's own concern", () => {
    expect(
      validateToolArgs(makeTool(), { title: "", description: "D" }),
    ).toBeNull();
  });

  it("passes tools that declare no required arguments", () => {
    const tool = makeTool({
      name: "check_credits",
      parameters: { type: "object", properties: {} },
      execute: async () => "ok",
    });
    expect(validateToolArgs(tool, {})).toBeNull();
  });

  it("ignores a malformed required array", () => {
    const tool = makeTool({
      parameters: { type: "object", properties: {}, required: "title" },
    });
    expect(validateToolArgs(tool, {})).toBeNull();
  });

  it("does not type-check non-primitive declarations", () => {
    const tool = makeTool({
      parameters: {
        type: "object",
        properties: { items: { type: "array" } },
        required: ["items"],
      },
      execute: async () => "ok",
    });
    expect(validateToolArgs(tool, { items: { not: "an array" } })).toBeNull();
  });
});

describe("executeTool argument validation", () => {
  const ctx = {} as ToolContext;

  it("returns an actionable error instead of throwing a TypeError", async () => {
    const result = await executeTool(
      "create_goal",
      { description: "Build a thing" },
      [makeTool()],
      ctx,
    );

    expect(result.error).toBeDefined();
    expect(result.error).toContain("missing required argument: title");
    // The pre-fix failure mode — must not resurface.
    expect(result.error).not.toContain("Cannot read properties of undefined");
  });

  it("does not invoke the tool when arguments are invalid", async () => {
    let called = false;
    const tool = makeTool({
      execute: async (args) => {
        called = true;
        return `ok:${(args.title as string).trim()}`;
      },
    });

    await executeTool("create_goal", { description: "D" }, [tool], ctx);
    expect(called).toBe(false);
  });

  it("still executes when arguments are valid", async () => {
    const result = await executeTool(
      "create_goal",
      { title: " T ", description: "D" },
      [makeTool()],
      ctx,
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("ok:T");
  });
});
