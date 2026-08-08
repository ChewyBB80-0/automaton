/**
 * Capability probe tests.
 *
 * The gating rule that matters: withhold a tool only on a positive finding
 * that its backend is absent. A failed probe must never remove capability.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  probeCapabilities,
  gateToolsByCapability,
  CAPABILITY_TOOLS,
  formatCapabilityReport,
  type CapabilityReport,
} from "../../agent/capability-probe.js";

const ALL_TOOLS = [
  { name: "exec" },
  { name: "search_domains" },
  { name: "register_domain" },
  { name: "manage_dns" },
  { name: "create_sandbox" },
  { name: "register_erc8004" },
  { name: "discover_agents" },
  { name: "check_credits" },
];

function reportWith(overrides: Partial<CapabilityReport>): CapabilityReport {
  const base: CapabilityReport = {
    "conway.domains": { capability: "conway.domains", status: "available", detail: "" },
    "conway.sandboxes": { capability: "conway.sandboxes", status: "available", detail: "" },
    "conway.credits": { capability: "conway.credits", status: "available", detail: "" },
    "chain.erc8004": { capability: "chain.erc8004", status: "available", detail: "" },
  };
  return { ...base, ...overrides };
}

describe("gateToolsByCapability", () => {
  it("keeps everything when all capabilities are available", () => {
    const { tools, gated } = gateToolsByCapability(ALL_TOOLS, reportWith({}));
    expect(tools).toHaveLength(ALL_TOOLS.length);
    expect(gated).toEqual([]);
  });

  it("withholds the tools of an unavailable capability", () => {
    const { tools, gated } = gateToolsByCapability(
      ALL_TOOLS,
      reportWith({
        "conway.domains": {
          capability: "conway.domains",
          status: "unavailable",
          detail: "endpoint returns 404",
        },
      }),
    );

    const names = tools.map((t) => t.name);
    expect(names).not.toContain("search_domains");
    expect(names).not.toContain("register_domain");
    expect(names).not.toContain("manage_dns");
    expect(names).toContain("exec");
    expect(gated.map((g) => g.name).sort()).toEqual(
      ["manage_dns", "register_domain", "search_domains"].sort(),
    );
  });

  it("does NOT withhold on an inconclusive probe", () => {
    const { tools, gated } = gateToolsByCapability(
      ALL_TOOLS,
      reportWith({
        "conway.domains": {
          capability: "conway.domains",
          status: "unknown",
          detail: "probe failed (timeout)",
        },
      }),
    );
    expect(tools.map((t) => t.name)).toContain("search_domains");
    expect(gated).toEqual([]);
  });

  it("reports the reason alongside each gated tool", () => {
    const { gated } = gateToolsByCapability(
      ALL_TOOLS,
      reportWith({
        "chain.erc8004": {
          capability: "chain.erc8004",
          status: "unavailable",
          detail: "no contract deployed at 0x8004…",
        },
      }),
    );
    expect(gated[0].capability).toBe("chain.erc8004");
    expect(gated[0].reason).toContain("no contract deployed");
  });

  it("never gates tools outside the capability map", () => {
    const mapped = new Set(Object.values(CAPABILITY_TOOLS).flat());
    expect(mapped.has("exec")).toBe(false);
    expect(mapped.has("write_file")).toBe(false);
    expect(mapped.has("edit_own_file")).toBe(false);
  });
});

describe("probeCapabilities", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("treats 404 as unavailable and 401 as available", async () => {
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes("/v1/domains/")) return { status: 404 } as any;
      return { status: 401 } as any;
    }) as any;

    const report = await probeCapabilities({ conwayApiUrl: "https://api.example.test" });

    expect(report["conway.domains"].status).toBe("unavailable");
    expect(report["conway.domains"].detail).toContain("404");
    // 401 means the route exists and wants credentials — not a missing capability.
    expect(report["conway.sandboxes"].status).toBe("available");
    expect(report["conway.credits"].status).toBe("available");
  });

  it("reports unknown when the network fails, never unavailable", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as any;

    const report = await probeCapabilities({ conwayApiUrl: "https://api.example.test" });

    for (const finding of Object.values(report)) {
      expect(finding.status).not.toBe("unavailable");
    }
    expect(report["conway.domains"].status).toBe("unknown");
  });

  it("flags an undeployed ERC-8004 registry as unavailable", async () => {
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      if (init?.method === "POST") {
        return { json: async () => ({ result: "0x" }) } as any;
      }
      return { status: 401 } as any;
    }) as any;

    const report = await probeCapabilities({
      conwayApiUrl: "https://api.example.test",
      rpcUrl: "https://rpc.example.test",
    });

    expect(report["chain.erc8004"].status).toBe("unavailable");
    expect(report["chain.erc8004"].detail).toContain("no contract deployed");
  });

  it("accepts a deployed registry", async () => {
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      if (init?.method === "POST") {
        return { json: async () => ({ result: "0x60806040" }) } as any;
      }
      return { status: 401 } as any;
    }) as any;

    const report = await probeCapabilities({
      conwayApiUrl: "https://api.example.test",
      rpcUrl: "https://rpc.example.test",
    });

    expect(report["chain.erc8004"].status).toBe("available");
  });

  it("leaves the registry enabled when no rpcUrl is configured", async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 401 })) as any;
    const report = await probeCapabilities({ conwayApiUrl: "https://api.example.test" });
    expect(report["chain.erc8004"].status).toBe("unknown");
  });

  it("formats a readable summary", async () => {
    globalThis.fetch = vi.fn(async () => ({ status: 404 })) as any;
    const report = await probeCapabilities({ conwayApiUrl: "https://api.example.test" });
    const text = formatCapabilityReport(report);
    expect(text).toContain("conway.domains");
    expect(text).toContain("unavailable");
  });
});
