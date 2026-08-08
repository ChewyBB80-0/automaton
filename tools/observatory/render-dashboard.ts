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

// A tool can be stopped two ways: the policy engine refuses it (error), or
// the tool's own guard returns a "Blocked:" string with no error set.
const isPolicyDenied = (c: any) => !!c.error;
const isInlineBlocked = (c: any) =>
  !c.error && typeof c.result === "string" && c.result.startsWith("Blocked:");
const isBlocked = (c: any) => isPolicyDenied(c) || isInlineBlocked(c);

const blockedCalls = toolCalls.filter(isBlocked);
const inlineBlocked = toolCalls.filter(isInlineBlocked);

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

const outcomePill = (c: any) => {
  if (isPolicyDenied(c)) return `<span class="pill pill-critical">denied</span>`;
  if (isInlineBlocked(c)) return `<span class="pill pill-warning">blocked</span>`;
  return `<span class="pill pill-good">ok</span>`;
};

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
                  : isInlineBlocked(c)
                    ? "chip chip-blocked"
                    : "chip";
                const suffix = isPolicyDenied(c)
                  ? " · denied"
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
