/**
 * Automaton console renderer.
 *
 * Read-only. Opens the runtime's own state.db, derives the operator view,
 * and writes a static HTML page. Re-run it after any loop to refresh.
 *
 *   npx tsx render-dashboard.ts <path-to-state.db> <out.html>
 */

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const DB_PATH = process.argv[2];
const OUT_PATH = process.argv[3];

if (!DB_PATH || !OUT_PATH) {
  console.error("usage: render-dashboard.ts <state.db> <out.html>");
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const one = (sql: string, ...p: unknown[]): any => db.prepare(sql).get(...p);
const all = (sql: string, ...p: unknown[]): any[] => db.prepare(sql).all(...p);

const has = (t: string): boolean =>
  !!one(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, t);

// ─── Identity ──────────────────────────────────────────────────────
const ident = (k: string): string =>
  one(`SELECT value FROM identity WHERE key=?`, k)?.value ?? "—";

const name = ident("name");
const address = ident("address");
const creator = ident("creator");

// ─── Turns ─────────────────────────────────────────────────────────
const turns = all(
  `SELECT id, timestamp, state, thinking, cost_cents, token_usage
   FROM turns ORDER BY rowid DESC`,
);
const turnCount = turns.length;
const totalCost = turns.reduce((a, t) => a + (t.cost_cents || 0), 0);
const totalTokens = turns.reduce((a, t) => {
  try {
    return a + (JSON.parse(t.token_usage || "{}").totalTokens || 0);
  } catch {
    return a;
  }
}, 0);
const state = turns[0]?.state ?? "unknown";

// ─── Tool calls ────────────────────────────────────────────────────
const toolCalls = all(
  `SELECT id, turn_id, name, arguments, result, error, duration_ms
   FROM tool_calls ORDER BY rowid DESC`,
);

const callsByTurn = new Map<string, any[]>();
for (const c of toolCalls) {
  if (!callsByTurn.has(c.turn_id)) callsByTurn.set(c.turn_id, []);
  callsByTurn.get(c.turn_id)!.push(c);
}

// A tool call can end four different ways that all look like "not ok", and
// conflating them hides real problems:
//   1. the policy engine refused it        → error starts with "Policy denied:"
//   2. arguments failed validation         → error starts with "Invalid arguments:"
//   3. the tool implementation threw       → error set, none of the above
//   4. the tool's own guard refused it     → no error, result starts "Blocked:"
// Only (1) lands in policy_decisions as a denial. (4) is logged there as allow.
const isPolicyDenied = (c: any) =>
  !!c.error && String(c.error).startsWith("Policy denied:");
const isInvalidArgs = (c: any) =>
  !!c.error && String(c.error).startsWith("Invalid arguments:");
const isCrash = (c: any) =>
  !!c.error && !isPolicyDenied(c) && !isInvalidArgs(c);
const isInlineBlocked = (c: any) =>
  !c.error && typeof c.result === "string" && c.result.startsWith("Blocked:");
const isBlocked = (c: any) => isPolicyDenied(c) || isInlineBlocked(c);

const blockedCalls = toolCalls.filter(isBlocked);
const inlineBlocked = toolCalls.filter(isInlineBlocked);
const crashed = toolCalls.filter(isCrash);
const invalidArgs = toolCalls.filter(isInvalidArgs);

// ─── Policy decisions ──────────────────────────────────────────────
const decisions = has("policy_decisions")
  ? all(
      `SELECT tool_name, decision, rules_triggered, reason, risk_level, created_at
       FROM policy_decisions ORDER BY rowid DESC`,
    )
  : [];
const denied = decisions.filter((d) => d.decision !== "allow");

// ─── Spend ─────────────────────────────────────────────────────────
const spend = has("spend_tracking")
  ? all(`SELECT * FROM spend_tracking ORDER BY rowid DESC`)
  : [];
const spendByCategory = new Map<string, number>();
for (const s of spend) {
  spendByCategory.set(
    s.category,
    (spendByCategory.get(s.category) || 0) + (s.amount_cents || 0),
  );
}

// ─── Cash ──────────────────────────────────────────────────────────
// The runner holds the credit balance in memory and snapshots it into
// `transactions` each cycle, so balance history lives in the database.
const balanceHistory = has("transactions")
  ? all(
      `SELECT balance_after_cents AS c, created_at FROM transactions
       WHERE balance_after_cents IS NOT NULL ORDER BY rowid ASC`,
    )
  : [];

const kvBalance = one(`SELECT value FROM kv WHERE key = 'balance_cents'`)?.value;
const currentBalance =
  kvBalance !== undefined
    ? Number(kvBalance)
    : balanceHistory.length
      ? Number(balanceHistory[balanceHistory.length - 1].c)
      : null;

const openingBalance = balanceHistory.length ? Number(balanceHistory[0].c) : null;
const spentSoFar =
  openingBalance !== null && currentBalance !== null
    ? openingBalance - currentBalance
    : null;

// ─── Self-mod + lineage ────────────────────────────────────────────
const mods = has("modifications")
  ? all(`SELECT * FROM modifications ORDER BY rowid DESC LIMIT 20`)
  : [];
const children = has("children")
  ? all(`SELECT * FROM children ORDER BY rowid DESC`)
  : [];

// ─── Caps (mirrors DEFAULT_TREASURY_POLICY, overridden per-run) ────
const caps = {
  transferHourly: 1000,
  transferDaily: 2000,
  inferenceDaily: 900,
  x402Daily: 100 * 50,
};
const transferSpend = spendByCategory.get("transfer") || 0;
const x402Spend = spendByCategory.get("x402") || 0;

const pct = (n: number, d: number) =>
  d <= 0 ? 0 : Math.min(100, Math.round((n / d) * 100));

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

const shortArgs = (a: string) => {
  try {
    const o = JSON.parse(a);
    const k = Object.keys(o)[0];
    if (!k) return "";
    let v = String(o[k]);
    if (v.length > 90) v = v.slice(0, 90) + "…";
    return v;
  } catch {
    return "";
  }
};

const timeOf = (ts: string) => {
  const d = new Date(ts.includes("T") ? ts : ts.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? ts : d.toISOString().slice(11, 19);
};

const firstLine = (s: string) =>
  String(s || "").split("\n")[0].slice(0, 160);

// The audit-gap callout is only true when the two counts actually disagree.
const auditGap = inlineBlocked.length > 0;
const AUDIT_CALLOUT = auditGap
  ? `<div class="callout">
      <h2>The two counts above don't match — and that's a real gap</h2>
      <p><strong>${blockedCalls.length}</strong> tool calls were stopped, but <code>policy_decisions</code>
      only recorded <strong>${denied.length}</strong> of them as denials. The other
      <strong>${inlineBlocked.length}</strong> were refused <em>inside</em> the tool implementation —
      <code>write_file</code>'s path confinement returns a plain <code>"Blocked: …"</code> string with no
      error set, so the policy engine logged the call as <code>allow</code>. Any audit built only on
      <code>policy_decisions</code> under-reports what the agent actually attempted.</p>
    </div>`
  : "";

const ARGS_CALLOUT = invalidArgs.length > 0
  ? `<div class="callout">
      <h2>${invalidArgs.length} call${invalidArgs.length === 1 ? "" : "s"} rejected for malformed arguments</h2>
      <p>Caught by schema validation in <code>executeTool</code> before the implementation ran, so the
      model got a message naming the missing argument instead of a <code>TypeError</code> from inside
      the tool. The turn is still spent, but the model can correct itself:</p>
      ${invalidArgs
        .map((c) => `<p class="crash-line mono">${esc(c.name)} → ${esc(firstLine(c.error))}</p>`)
        .join("")}
    </div>`
  : "";

const CRASH_CALLOUT = crashed.length > 0
  ? `<div class="callout callout-crash">
      <h2>${crashed.length} tool call${crashed.length === 1 ? "" : "s"} crashed on malformed arguments</h2>
      <p>Not a policy refusal — the tool implementation threw. Tool arguments are cast
      (<code>args.title as string</code>) rather than validated, so a model that omits a field
      declared <code>required</code> in the schema hits a <code>TypeError</code> at runtime. The loop
      catches it, but the turn is burnt and the model gets an opaque message it cannot act on:</p>
      ${crashed
        .map(
          (c) => `<p class="crash-line mono">${esc(c.name)} → ${esc(firstLine(c.error))}</p>`,
        )
        .join("")}
    </div>`
  : "";

// ─── Cash panel ────────────────────────────────────────────────────
const balSeries = balanceHistory.map((r: any) => Number(r.c));
const balMax = balSeries.length ? Math.max(...balSeries) : 0;
const balMin = balSeries.length ? Math.min(...balSeries) : 0;
// Give a flat line room to sit mid-band instead of collapsing onto an edge.
const spanTop = balMax === balMin ? balMax + Math.max(100, balMax * 0.1) : balMax;
const spanBot = balMax === balMin ? Math.max(0, balMin - Math.max(100, balMax * 0.1)) : balMin;

const balPath = (() => {
  if (balSeries.length < 2) return "";
  const W = 720, H = 90;
  const range = spanTop - spanBot || 1;
  return balSeries
    .map((v, i) => {
      const x = (i / (balSeries.length - 1)) * W;
      const y = H - ((v - spanBot) / range) * H;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join("");
})();

const transferOut = spendByCategory.get("transfer") || 0;
const inferenceSpend = totalCost;

const CASH_PANEL = `
  <section class="panel">
    <div class="panel-head">
      <div>
        <h2 class="panel-title">Cash</h2>
        <p class="panel-note">Credit balance snapshotted to <span class="mono">transactions</span> each cycle.</p>
      </div>
      <span class="pill ${
        currentBalance === null ? "pill-neutral"
          : currentBalance <= 0 ? "pill-critical"
          : currentBalance < 1000 ? "pill-warning"
          : "pill-good"
      }">${currentBalance === null ? "no data" : money(currentBalance)}</span>
    </div>
    <div class="cash-grid">
      <div class="cash-cell">
        <span class="label">Balance now</span>
        <span class="cash-value mono">${currentBalance === null ? "—" : money(currentBalance)}</span>
        <span class="sub">${openingBalance === null ? "" : `opened at ${money(openingBalance)}`}</span>
      </div>
      <div class="cash-cell">
        <span class="label">Spent this run</span>
        <span class="cash-value mono">${spentSoFar === null ? "—" : money(spentSoFar)}</span>
        <span class="sub">${
          spentSoFar === 0 ? "nothing has moved" : "credits out"
        }</span>
      </div>
      <div class="cash-cell">
        <span class="label">Transfers out</span>
        <span class="cash-value mono">${money(transferOut)}</span>
        <span class="sub">from spend_tracking</span>
      </div>
      <div class="cash-cell">
        <span class="label">Inference</span>
        <span class="cash-value mono">${money(inferenceSpend)}</span>
        <span class="sub">${totalTokens.toLocaleString("en-US")} tokens</span>
      </div>
    </div>
    ${
      balPath
        ? `<div class="cash-chart">
             <svg viewBox="0 0 720 90" preserveAspectRatio="none" role="img"
                  aria-label="Credit balance across cycles, ${money(openingBalance ?? 0)} to ${money(currentBalance ?? 0)}">
               <path d="${balPath}" fill="none" stroke="var(--series-1)" stroke-width="2"
                     stroke-linejoin="round" vector-effect="non-scaling-stroke"></path>
             </svg>
             <div class="cash-axis">
               <span class="mono">${money(openingBalance ?? 0)} at start</span>
               <span class="mono">${balanceHistory.length} snapshots</span>
               <span class="mono">${money(currentBalance ?? 0)} now</span>
             </div>
           </div>`
        : `<div class="empty-block">Balance history appears once the agent completes a cycle.</div>`
    }
  </section>`;

// ─── Sparkline over per-turn cost ──────────────────────────────────
const costSeries = turns.slice().reverse().map((t) => t.cost_cents || 0);

const template = fs.readFileSync(
  path.join(path.dirname(new URL(import.meta.url).pathname), "console-template.html"),
  "utf-8",
);

const rows = {
  TURNS: String(turnCount),
  TOOLCALLS: String(toolCalls.length),
  BLOCKED: String(blockedCalls.length),
  CRASHED: String(crashed.length),
  AUDIT_CALLOUT,
  CRASH_CALLOUT,
  ARGS_CALLOUT,
  CASH_PANEL,
  BALANCE_NOW: currentBalance === null ? "—" : money(currentBalance),
  INVALID_ARGS: String(invalidArgs.length),
  DENIED_POLICY: String(denied.length),
  INLINE_BLOCKED: String(inlineBlocked.length),
  NAME: esc(name),
  ADDRESS: esc(address.slice(0, 6) + "…" + address.slice(-4)),
  CREATOR: esc(creator.slice(0, 6) + "…" + creator.slice(-4)),
  STATE: esc(state),
  STATE_CLASS:
    state === "sleeping" ? "pill-neutral" :
    state === "running" ? "pill-good" :
    state === "critical" || state === "dead" ? "pill-critical" : "pill-warning",
  COST: money(totalCost),
  TOKENS: totalTokens.toLocaleString("en-US"),
  DECISION_COUNT: String(decisions.length),

  TRANSFER_SPEND: money(transferSpend),
  TRANSFER_CAP: money(caps.transferHourly),
  TRANSFER_PCT: String(pct(transferSpend, caps.transferHourly)),
  X402_SPEND: money(x402Spend),
  X402_CAP: money(caps.x402Daily),
  X402_PCT: String(pct(x402Spend, caps.x402Daily)),
  INFERENCE_SPEND: money(totalCost),
  INFERENCE_CAP: money(caps.inferenceDaily),
  INFERENCE_PCT: String(pct(totalCost, caps.inferenceDaily)),

  SPARK: JSON.stringify(costSeries),

  DECISION_ROWS:
    decisions.length === 0
      ? `<tr><td colspan="4" class="empty">No policy decisions recorded.</td></tr>`
      : decisions
          .map((d) => {
            const isDeny = d.decision !== "allow";
            let rules = "—";
            try {
              const parsed = JSON.parse(d.rules_triggered || "[]");
              if (parsed.length) rules = parsed.join(", ");
            } catch {}
            return `<tr data-kind="${isDeny ? "blocked" : "allowed"}"${isDeny ? "" : " hidden"}>
              <td class="stripe ${isDeny ? "stripe-critical" : "stripe-good"} mono">${esc(d.tool_name)}</td>
              <td><span class="mono">${esc(rules)}</span>${
                isDeny ? `<span class="reason">${esc(firstLine(d.reason))}</span>` : ""
              }</td>
              <td>${
                d.decision === "allow"
                  ? `<span class="pill pill-good">allow</span>`
                  : d.decision === "quarantine"
                    ? `<span class="pill pill-warning">quarantine</span>`
                    : `<span class="pill pill-critical">deny</span>`
              }</td>
              <td class="t-time mono">${esc(timeOf(d.created_at))}</td>
            </tr>`;
          })
          .join(""),

  ALLOWED_COUNT: String(decisions.filter((d) => d.decision === "allow").length),
  BLOCKED_COUNT: String(denied.length),

  MOD_ROWS:
    mods.length === 0
      ? `<tr><td colspan="4" class="empty">No self-modifications in this run.</td></tr>`
      : mods
          .map(
            (m) => `<tr>
              <td class="stripe mono">${esc(m.file_path ?? m.path ?? "—")}</td>
              <td class="mono">${esc(m.summary ?? m.description ?? "—")}</td>
              <td><span class="pill pill-good">applied</span></td>
              <td class="t-time mono">${esc(timeOf(m.created_at ?? ""))}</td>
            </tr>`,
          )
          .join(""),

  KID_ROWS:
    children.length === 0
      ? `<div class="empty-block">No children spawned. <span class="dim">2 spawn slots free — depth below this node is uncapped.</span></div>`
      : children
          .map(
            (c) => `<div class="kid">
              <span class="k-name mono">${esc(c.name ?? c.id)}</span>
              <span class="pill pill-neutral">${esc(c.status ?? "unknown")}</span>
              <span class="k-meta mono">${esc(c.address ?? "")}</span>
            </div>`,
          )
          .join(""),

  STREAM:
    turns.length === 0
      ? `<div class="empty-block">No turns recorded.</div>`
      : turns
          .map((t) => {
            const calls = callsByTurn.get(t.id) || [];
            const chips = calls
              .map((c) => {
                const cls = isPolicyDenied(c)
                  ? "chip chip-denied"
                  : isCrash(c)
                    ? "chip chip-crash"
                    : isInvalidArgs(c)
                      ? "chip chip-blocked"
                    : isInlineBlocked(c)
                      ? "chip chip-blocked"
                      : "chip";
                const suffix = isPolicyDenied(c)
                  ? " · denied"
                  : isCrash(c)
                    ? " · crashed"
                    : isInvalidArgs(c)
                      ? " · bad args"
                    : isInlineBlocked(c)
                      ? " · blocked"
                      : "";
                return `<span class="${cls}">${esc(c.name)}${suffix}</span>`;
              })
              .join("");
            const detail = calls
              .map((c) => {
                const args = shortArgs(c.arguments);
                const out = firstLine(c.error || c.result || "");
                return `<div class="io">
                  <div class="io-in mono">$ ${esc(args)}</div>
                  <div class="io-out mono">${esc(out)}</div>
                </div>`;
              })
              .join("");
            return `<div class="turn">
              <span class="t-stamp mono">${esc(timeOf(t.timestamp))}</span>
              <div>
                <div class="t-think">${esc(t.thinking || "—")}</div>
                ${chips ? `<div class="t-calls">${chips}</div>` : ""}
                ${detail}
              </div>
            </div>`;
          })
          .join(""),
};

let html = template;
for (const [k, v] of Object.entries(rows)) {
  html = html.split(`{{${k}}}`).join(v as string);
}

fs.writeFileSync(OUT_PATH, html);
console.log(
  `rendered ${OUT_PATH}\n  turns=${turnCount} toolCalls=${toolCalls.length} ` +
    `policyDenied=${denied.length} inlineBlocked=${inlineBlocked.length}`,
);
db.close();
