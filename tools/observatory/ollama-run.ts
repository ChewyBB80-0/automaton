/**
 * Automaton run driven by a local Ollama model.
 *
 * Same wiring as demo-run.ts — real agent loop, real policy engine, real tool
 * implementations, real SQLite, real local shell — except the model is a live
 * local one instead of a scripted sequence. The agent improvises.
 *
 * Still offline with respect to Conway: credits and transfers are stubbed, no
 * identity is registered, no money moves.
 *
 *   ollama serve &
 *   ollama pull qwen2.5:3b
 *   npx tsx tools/observatory/ollama-run.ts
 *
 * Env:
 *   OLLAMA_BASE_URL   default http://127.0.0.1:11434
 *   OLLAMA_MODEL      default qwen2.5:3b
 *   AUTOMATON_DEMO_OUT  where state.db lands
 *   GENESIS           override the genesis prompt
 */

import fs from "fs";
import path from "path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.resolve(HERE, "../../src");

const { createDatabase } = await import(`${SRC}/state/database.js`);
const { createConwayClient } = await import(`${SRC}/conway/client.js`);
const { createInferenceClient } = await import(`${SRC}/conway/inference.js`);
const { runAgentLoop } = await import(`${SRC}/agent/loop.js`);
const { PolicyEngine } = await import(`${SRC}/agent/policy-engine.js`);
const { SpendTracker } = await import(`${SRC}/agent/spend-tracker.js`);
const { createDefaultRules } = await import(`${SRC}/agent/policy-rules/index.js`);
const { getWallet } = await import(`${SRC}/identity/wallet.js`);
const { ModelRegistry } = await import(`${SRC}/inference/registry.js`);

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
const OUT = process.env.AUTOMATON_DEMO_OUT || path.join(HERE, ".live");
fs.mkdirSync(OUT, { recursive: true });

const DB_PATH = path.join(OUT, "state.db");

// LIVE=1 keeps waking the agent until the process is stopped, instead of
// running a single cycle. FRESH=1 starts from an empty database.
const LIVE = process.env.LIVE === "1";
const SLEEP_MS = Number(process.env.SLEEP_MS || 10_000);
const FRESH = process.env.FRESH === "1" || !LIVE;

if (FRESH && fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);

// Tight caps so the treasury rules actually bite within a short run.
const treasuryPolicy = {
  maxSingleTransferCents: 500,
  maxHourlyTransferCents: 1000,
  maxDailyTransferCents: 2000,
  minimumReserveCents: 100,
  maxX402PaymentCents: 100,
  x402AllowedDomains: ["conway.tech"],
  transferCooldownMs: 0,
  maxTransfersPerTurn: 2,
  maxInferenceDailyCents: 900,
  requireConfirmationAboveCents: 1000,
};

const db = createDatabase(DB_PATH);
const { account, chainIdentity } = await getWallet();

const genesis =
  process.env.GENESIS ||
  [
    "You are running on a Linux box with a shell and a small credit balance.",
    "Find out what this machine is, write a short report of your findings to",
    "~/report.md, and check your credit balance. Work in small concrete steps",
    "using your tools. When the report is written, stop and say you are done.",
  ].join(" ");

const config: any = {
  name: "halcyon-03",
  genesisPrompt: genesis,
  creatorAddress: "0xC0FFEE0000000000000000000000000000000001",
  registeredWithConway: false,
  sandboxId: "", // local exec — conway/client.ts:109
  conwayApiUrl: "https://api.conway.tech",
  conwayApiKey: "local-no-network",
  ollamaBaseUrl: OLLAMA_BASE_URL,
  inferenceModel: OLLAMA_MODEL,
  maxTokensPerTurn: 1024,
  heartbeatConfigPath: path.join(OUT, "heartbeat.yml"),
  dbPath: DB_PATH,
  logLevel: "info",
  walletAddress: chainIdentity.address,
  version: "0.2.1",
  skillsDir: path.join(OUT, "skills"),
  maxChildren: 0,
  // Base Sepolia by default — testnet, so nothing on-chain costs real money.
  rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
  chainType: "evm",
  maxTurnsPerCycle: Number(process.env.MAX_TURNS || 8),
  treasuryPolicy,
};

const identity: any = {
  name: config.name,
  address: chainIdentity.address,
  account,
  creatorAddress: config.creatorAddress,
  sandboxId: "",
  apiKey: config.conwayApiKey,
  createdAt: new Date().toISOString(),
  chainType: "evm",
  chainIdentity,
};

db.setIdentity("name", config.name);
db.setIdentity("address", chainIdentity.address);
db.setIdentity("creator", config.creatorAddress);

// ─── Conway: real local exec/files, stubbed money ──────────────────
const realConway = createConwayClient({
  apiUrl: config.conwayApiUrl,
  apiKey: config.conwayApiKey,
  sandboxId: "",
});

let balanceCents = 1844;
const conway: any = new Proxy(realConway, {
  get(target, prop) {
    if (prop === "getCreditsBalance") return async () => balanceCents;
    if (prop === "transferCredits") {
      return async (to: string, amountCents: number) => {
        balanceCents -= amountCents;
        return {
          transferId: `txn_local_${Date.now()}`,
          status: "completed",
          toAddress: to,
          amountCents,
          balanceAfterCents: balanceCents,
        };
      };
    }
    if (prop === "registerAutomaton") return async () => ({ automaton: {} });
    return (target as any)[prop];
  },
});

// ─── Register the Ollama model so routing resolves to it ───────────
const registry = new ModelRegistry(db.raw);
registry.initialize();

const { discoverOllamaModels } = await import(`${SRC}/ollama/discover.js`);
const found = await discoverOllamaModels(OLLAMA_BASE_URL, db.raw);
if (!found.includes(OLLAMA_MODEL)) {
  console.error(
    `Model "${OLLAMA_MODEL}" is not loaded in Ollama.\n` +
      `  discovered: ${found.join(", ") || "(none)"}\n` +
      `  fix: ollama pull ${OLLAMA_MODEL}`,
  );
  process.exit(1);
}

// Force local-only routing.
//
// InferenceRouter.selectModel() tries the hardcoded routing-matrix candidates
// BEFORE the operator's configured model, and ModelRegistry.initialize() always
// seeds those Conway/OpenAI baseline models as enabled. So an explicitly
// configured Ollama model is never reached, and the turn silently goes to
// api.conway.tech instead. Disabling the non-Ollama rows makes step 1 miss so
// the configured-model fallback actually runs.
//
// initialize() preserves `enabled` for rows that already exist, so this sticks
// even though the agent loop calls initialize() again on startup.
const disabled = db.raw
  .prepare(`UPDATE model_registry SET enabled = 0 WHERE provider != 'ollama'`)
  .run();
console.log(`local-only: disabled ${disabled.changes} non-Ollama models in the registry`);

config.modelStrategy = {
  inferenceModel: OLLAMA_MODEL,
  lowComputeModel: OLLAMA_MODEL,
  criticalModel: OLLAMA_MODEL,
};

const inference = createInferenceClient({
  apiUrl: config.conwayApiUrl,
  apiKey: config.conwayApiKey,
  defaultModel: OLLAMA_MODEL,
  maxTokens: config.maxTokensPerTurn,
  ollamaBaseUrl: OLLAMA_BASE_URL,
  getModelProvider: (id: string) => registry.get(id)?.provider,
});

const rules = createDefaultRules(treasuryPolicy);
const policyEngine = new PolicyEngine(db.raw, rules);
const spendTracker = new SpendTracker(db.raw);

console.log("─".repeat(72));
console.log(`  automaton — live model: ${OLLAMA_MODEL} @ ${OLLAMA_BASE_URL}`);
console.log(`  sandboxId empty → exec runs on THIS host`);
console.log(`  db: ${DB_PATH}`);
console.log("─".repeat(72));

const started = Date.now();

const loopOnce = () =>
  runAgentLoop({
    identity,
    config,
    db,
    conway,
    inference,
    policyEngine,
    spendTracker,
    ollamaBaseUrl: OLLAMA_BASE_URL,
  });

if (LIVE) {
  let stopping = false;
  const stop = () => {
    stopping = true;
    console.log("\nstopping after the current cycle…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`live mode: waking every ${SLEEP_MS}ms until stopped\n`);

  // Mark the provenance of this number. The Conway client is stubbed here, so
  // the credit balance is a local constant, not a real ledger. The console
  // reads this key and labels the figure rather than presenting it as money.
  db.setKV("balance_source", "stub");
  db.setKV("chain_rpc", config.rpcUrl);
  db.setKV("balance_cents", String(balanceCents));
  db.insertTransaction({
    id: `bal_${Date.now()}_0`,
    type: "credit_check",
    balanceAfterCents: balanceCents,
    description: "opening balance",
    timestamp: new Date().toISOString(),
  });

  let cycle = 0;
  while (!stopping) {
    cycle++;
    const t0 = Date.now();
    try {
      await loopOnce();
    } catch (err: any) {
      // One bad cycle must not end the run — that is the whole point of a
      // continuously running agent.
      console.error(`cycle ${cycle} failed: ${err?.message || err}`);
    }
    const turnsNow = (db.raw.prepare(`SELECT COUNT(*) c FROM turns`).get() as any).c;

    // Persist the balance so the console can show and chart it. The runner
    // holds it in memory; without this the dashboard has no view of cash.
    db.setKV("balance_cents", String(balanceCents));
    db.insertTransaction({
      id: `bal_${Date.now()}_${cycle}`,
      type: "credit_check",
      balanceAfterCents: balanceCents,
      description: `cycle ${cycle} — ${turnsNow} turns`,
      timestamp: new Date().toISOString(),
    });
    console.log(
      `cycle ${cycle} done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
        `${turnsNow} turns total, balance ${(balanceCents / 100).toFixed(2)}`,
    );
    if (stopping) break;
    await new Promise((r) => setTimeout(r, SLEEP_MS));
  }
} else {
  await loopOnce();
}

// ─── Summary ───────────────────────────────────────────────────────
const raw = db.raw;
const decisions = raw
  .prepare(
    `SELECT tool_name, decision, rules_triggered FROM policy_decisions ORDER BY rowid ASC`,
  )
  .all();
const toolCalls = raw
  .prepare(`SELECT name, arguments, result, error FROM tool_calls ORDER BY rowid ASC`)
  .all();
const turnCount = (raw.prepare(`SELECT COUNT(*) c FROM turns`).get() as any).c;

// A tool call can fail two different ways and they must not be conflated:
// the policy engine refusing it, or the tool implementation throwing.
const deniedArgsHashes = new Set(
  (decisions as any[]).filter((d) => d.decision !== "allow").map((d) => d.tool_name),
);

console.log("\n─── what the model chose to do ───");
for (const t of toolCalls as any[]) {
  const status = !t.error
    ? "ok    "
    : String(t.error).startsWith("Policy denied:")
      ? "DENIED"
      : "CRASH ";
  let args = "";
  try {
    const o = JSON.parse(t.arguments);
    args = String(o[Object.keys(o)[0]] ?? "").slice(0, 70);
  } catch {}
  console.log(`  ${status} ${String(t.name).padEnd(18)} ${args}`);
}

console.log(
  `\nturns=${turnCount} toolCalls=${toolCalls.length} ` +
    `denied=${(decisions as any[]).filter((d) => d.decision !== "allow").length} ` +
    `elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`,
);
console.log(`\nrender:  npx tsx tools/observatory/render-dashboard.ts ${DB_PATH} console.html`);
console.log(`serve:   npx tsx tools/observatory/serve.ts ${DB_PATH}`);

db.close();
