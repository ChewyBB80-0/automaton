/**
 * Startup Capability Probe
 *
 * The tool catalogue is static: all 77 builtin tools are offered to the model
 * every turn regardless of whether their backing service exists. When an
 * endpoint is gone, the model cannot tell — it calls the tool, gets an error,
 * and tries again. In one observed run the agent spent the majority of its
 * tool calls on `/v1/domains/*`, which returns 404 on every request with and
 * without credentials.
 *
 * This probes the backing services once at startup and reports which
 * capabilities are definitively unavailable, so those tools can be withheld
 * from the model rather than advertised and denied.
 *
 * Gating is deliberately conservative: a tool is withheld only on a *positive*
 * finding that its backend is absent. An inconclusive probe — timeout, DNS
 * failure, connection refused — leaves the tool in place. Removing capability
 * because a network blip happened during startup would be worse than the
 * problem being solved.
 */

import { createLogger } from "../observability/logger.js";

const logger = createLogger("capability");

export type Capability =
  | "conway.domains"
  | "conway.sandboxes"
  | "conway.credits"
  | "chain.erc8004";

export type CapabilityStatus = "available" | "unavailable" | "unknown";

export interface CapabilityFinding {
  capability: Capability;
  status: CapabilityStatus;
  detail: string;
}

export type CapabilityReport = Record<Capability, CapabilityFinding>;

/** Tools withheld when their capability is positively unavailable. */
export const CAPABILITY_TOOLS: Record<Capability, string[]> = {
  "conway.domains": ["search_domains", "register_domain", "manage_dns"],
  "conway.sandboxes": [
    "create_sandbox",
    "delete_sandbox",
    "list_sandboxes",
    "expose_port",
    "remove_port",
  ],
  "conway.credits": ["topup_credits", "transfer_credits"],
  "chain.erc8004": [
    "register_erc8004",
    "update_agent_card",
    "discover_agents",
    "give_feedback",
    "check_reputation",
  ],
};

const PROBE_TIMEOUT_MS = 6_000;

interface ProbeOptions {
  conwayApiUrl?: string;
  apiKey?: string;
  rpcUrl?: string;
  /** ERC-8004 identity registry address to check for deployed bytecode. */
  registryAddress?: string;
  timeoutMs?: number;
}

/**
 * Conway answers 401 for endpoints that exist but require authentication, and
 * 404 for paths that do not exist. That distinction is what makes "absent"
 * separable from "unauthenticated" without holding valid credentials.
 */
async function probeHttp(
  url: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<{ status: number } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: apiKey ? { Authorization: apiKey } : undefined,
      signal: controller.signal,
    });
    return { status: resp.status };
  } catch (err: any) {
    return { error: err?.name === "AbortError" ? "timeout" : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

function classifyHttp(
  capability: Capability,
  result: { status: number } | { error: string },
): CapabilityFinding {
  if ("error" in result) {
    // Inconclusive — do not gate on it.
    return {
      capability,
      status: "unknown",
      detail: `probe failed (${result.error}) — leaving enabled`,
    };
  }
  if (result.status === 404) {
    return {
      capability,
      status: "unavailable",
      detail: "endpoint returns 404 — not present on this server",
    };
  }
  // 401/403 mean the route exists and wants credentials; that is a
  // configuration problem, not a missing capability.
  return {
    capability,
    status: "available",
    detail: `endpoint reachable (HTTP ${result.status})`,
  };
}

/**
 * Probe every capability. Never throws — a probe that cannot complete reports
 * "unknown" and the corresponding tools stay enabled.
 */
export async function probeCapabilities(
  options: ProbeOptions = {},
): Promise<CapabilityReport> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const apiUrl = (options.conwayApiUrl || "https://api.conway.tech").replace(/\/$/, "");
  const { apiKey } = options;

  const [domains, sandboxes, credits, erc8004] = await Promise.all([
    probeHttp(`${apiUrl}/v1/domains/search?query=probe`, apiKey, timeoutMs).then((r) =>
      classifyHttp("conway.domains", r),
    ),
    probeHttp(`${apiUrl}/v1/sandboxes`, apiKey, timeoutMs).then((r) =>
      classifyHttp("conway.sandboxes", r),
    ),
    probeHttp(`${apiUrl}/v1/credits/balance`, apiKey, timeoutMs).then((r) =>
      classifyHttp("conway.credits", r),
    ),
    probeRegistry(options, timeoutMs),
  ]);

  const report: CapabilityReport = {
    "conway.domains": domains,
    "conway.sandboxes": sandboxes,
    "conway.credits": credits,
    "chain.erc8004": erc8004,
  };

  for (const finding of Object.values(report)) {
    if (finding.status === "unavailable") {
      logger.warn(
        `Capability unavailable: ${finding.capability} — ${finding.detail}`,
      );
    }
  }

  return report;
}

/**
 * The ERC-8004 registry addresses are identical for mainnet and testnet in
 * CONTRACTS, but the contracts are only deployed on mainnet. Calling a
 * codeless address does not revert, so registration would appear to succeed
 * while doing nothing — checking for bytecode is the only reliable signal.
 */
async function probeRegistry(
  options: ProbeOptions,
  timeoutMs: number,
): Promise<CapabilityFinding> {
  const capability: Capability = "chain.erc8004";
  const rpcUrl = options.rpcUrl;
  const address =
    options.registryAddress || "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

  if (!rpcUrl) {
    return {
      capability,
      status: "unknown",
      detail: "no rpcUrl configured — leaving enabled",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getCode",
        params: [address, "latest"],
      }),
      signal: controller.signal,
    });
    const json: any = await resp.json();
    const code: string | undefined = json?.result;
    if (typeof code !== "string") {
      return { capability, status: "unknown", detail: "malformed RPC response — leaving enabled" };
    }
    if (code === "0x" || code === "") {
      return {
        capability,
        status: "unavailable",
        detail: `no contract deployed at ${address} on this chain`,
      };
    }
    return { capability, status: "available", detail: `registry deployed at ${address}` };
  } catch (err: any) {
    return {
      capability,
      status: "unknown",
      detail: `probe failed (${err?.name === "AbortError" ? "timeout" : err?.message}) — leaving enabled`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface GateResult<T> {
  tools: T[];
  gated: { name: string; capability: Capability; reason: string }[];
}

/**
 * Withhold tools whose capability was positively found unavailable.
 * "unknown" and "available" both keep the tool.
 */
export function gateToolsByCapability<T extends { name: string }>(
  tools: T[],
  report: CapabilityReport,
): GateResult<T> {
  const blocked = new Map<string, CapabilityFinding>();
  for (const finding of Object.values(report)) {
    if (finding.status !== "unavailable") continue;
    for (const name of CAPABILITY_TOOLS[finding.capability] ?? []) {
      blocked.set(name, finding);
    }
  }

  if (blocked.size === 0) return { tools, gated: [] };

  const gated: GateResult<T>["gated"] = [];
  const kept = tools.filter((tool) => {
    const finding = blocked.get(tool.name);
    if (!finding) return true;
    gated.push({
      name: tool.name,
      capability: finding.capability,
      reason: finding.detail,
    });
    return false;
  });

  return { tools: kept, gated };
}

/** One-line-per-capability summary for logs. */
export function formatCapabilityReport(report: CapabilityReport): string {
  return Object.values(report)
    .map((f) => `  ${f.capability.padEnd(18)} ${f.status.padEnd(12)} ${f.detail}`)
    .join("\n");
}
