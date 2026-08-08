# Running without Conway Cloud

**Goal: make the automaton run fully locally, with no dependency on
`api.conway.tech`.**

This is a working note, written while Conway Cloud was unavailable. It records
what already works offline, what blocks a clean offline run today, and the
specific changes needed. Everything below was verified against the live services
on 2026-08-08 rather than inferred from the code.

## What already works without Conway

Most of the runtime does not need Conway at all:

| Capability | Offline? | How |
|---|---|---|
| Shell, file read/write | **Yes** | With an empty `sandboxId`, `conway/client.ts:109` runs `execSync` locally |
| Inference | **Yes** | Ollama, via `ollamaBaseUrl` — free and local |
| Self-modification, git, skills | **Yes** | Entirely local |
| Memory, soul, heartbeat, policy engine | **Yes** | SQLite only |
| On-chain identity, USDC balance, x402 | **Yes** | Needs a chain RPC, not Conway |
| Credit balance | No | Conway only |
| Sandbox provisioning, port exposure | No | Conway only |
| Replication (children need sandboxes) | No | Conway only |

A full run driven by a local model completed 496 turns with no Conway
credentials, so the capability story is already most of the way there.

## What blocks a clean offline run

### 1. `--run` hard-exits without a Conway API key

`src/index.ts:200` refuses to start when no key is present, before any of the
local machinery is reached — even when the config specifies Ollama for
inference. This is the single blocker that forces a custom runner instead of the
shipped entrypoint.

**Change:** treat the key as required only for the capabilities that use it.
Start without one, and let the capability probe withhold the Conway-backed
tools (`tools/observatory` already does this via `capability-probe.ts`).

### 2. The credit balance has no offline source

`getCreditsBalance()` is Conway-only, and the survival tier is derived from it.
Without a source the loop cannot compute a tier, and the observatory runner
currently supplies a constant — which is not money and is deliberately not
rendered as a figure in the console.

**Options, roughly in order of honesty:**

- **No-economy mode.** Report the tier as `unknown`, skip survival gating, and
  make the console say there is no credit source. Truthful, and it makes the
  absence of the economy explicit rather than simulating one.
- **Local ledger.** Persist a real balance in SQLite that only decreases from
  metered local costs (inference tokens at a configured rate). Real bookkeeping
  of local spend, without pretending it is Conway credit.
- **On-chain balance as the economy.** Use the wallet's USDC balance as the
  survival signal. This is the most faithful to the project's premise — the
  agent genuinely dies when the wallet empties — and needs only an RPC.

The third is the most interesting: it removes the Conway dependency from the
survival mechanic entirely and makes the economics real rather than reported.

### 3. Inference routing ignores the configured model

`InferenceRouter.selectModel()` tries the hardcoded routing-matrix candidates
before the operator's configured model, and `ModelRegistry.initialize()`
re-seeds the Conway/OpenAI baseline as enabled on every startup. The result is
that setting `ollamaBaseUrl` and `inferenceModel` does **not** route to Ollama —
the turn goes to `api.conway.tech` instead, while the log prints the local model
name. See the README section on this.

**Change:** prefer the explicitly configured model over the matrix, or skip
matrix candidates whose provider has no usable credentials. Until then,
`ollama-run.ts` works around it by disabling non-Ollama rows in
`model_registry`.

### 4. Sandboxing disappears, and that matters

With no Conway sandbox, `exec` runs on the host. Offline mode is not a lesser
version of the hosted one — it removes both the economics *and* the isolation
boundary. Anything running this way should be in a VM or container that is
acceptable to lose, and the regex denylist in `command-safety.ts` should not be
mistaken for a substitute (`cat wallet.json` is blocked; `head wallet.json` is
not).

## Dead Conway endpoints (verified 2026-08-08)

Worth knowing before building around them. Conway returns 401 for endpoints that
exist and 404 for paths that do not:

- `/v1/domains/*` → **404** with and without credentials. `search_domains`,
  `register_domain` and `manage_dns` cannot work.
- `social.conway.tech` → **no DNS record at all**. This is the default
  `socialRelayUrl`, so agent-to-agent messaging and the parent/child relay have
  no host.
- `/v1/models` → 200, but returns 12 models, all OpenAI. The README's Claude,
  Gemini and Kimi are not offered.
- `/v1/sandboxes`, `/v1/credits/balance` → 401. These are real and gated.

The capability probe already withholds the domain tools and the ERC-8004 tools
when their backends are absent.

## Suggested order of work

1. Relax the `--run` key requirement and let the capability probe do the gating.
2. Fix model routing so a configured local model is actually used.
3. Pick a credit-balance strategy — on-chain USDC is the most faithful.
4. Document that offline mode has no sandbox isolation, prominently.

Steps 1–3 would let `node dist/index.js --run` work end to end with Ollama and a
chain RPC, and no Conway account.
