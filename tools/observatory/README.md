# Observatory

> Running without Conway Cloud is tracked in **[OFFLINE.md](./OFFLINE.md)** —
> what already works locally, what blocks a clean offline run, and the changes
> needed.

A read-only operator console for the automaton runtime.

The runtime already records everything an operator needs — `turns`, `tool_calls`,
`policy_decisions`, `spend_tracking`, `modifications`, `children` — but the only
way to see any of it is to query SQLite by hand. This renders it as a page.

## Render a console

```bash
npx tsx tools/observatory/render-dashboard.ts ~/.automaton/state.db console.html
```

Read-only: it opens the database with `readonly: true` and writes a single
self-contained HTML file. Re-run it after any loop to refresh.

## Demo run

`demo-run.ts` drives the **real** agent loop — real policy engine, real tool
implementations, real SQLite persistence, real local shell — against a scripted
inference backend. No network calls, no credits spent, no identity registered.
Only the model's decisions are faked.

```bash
npx tsx tools/observatory/demo-run.ts
npx tsx tools/observatory/render-dashboard.ts \
  tools/observatory/.demo/state.db tools/observatory/.demo/console.html
```

Output lands in `tools/observatory/.demo/` (override with `AUTOMATON_DEMO_OUT`).

## Serve it live

```bash
npx tsx tools/observatory/serve.ts ~/.automaton/state.db 7717
```

Serves on `127.0.0.1:7717` and re-renders from the database on every request, so
the page tracks the agent while it runs. It reloads itself every few seconds;
there is a live/paused toggle in the corner, and scroll position survives the
reload. Nothing is cached and the database is only ever opened read-only.

## Run it against a local model

`ollama-run.ts` drives the real loop with a live local model instead of a
scripted one, so the agent actually improvises. Conway stays stubbed — no
credits move, no identity is registered.

```bash
ollama serve &
ollama pull qwen2.5:3b

# one cycle
npx tsx tools/observatory/ollama-run.ts

# or keep it running until you stop it
LIVE=1 npx tsx tools/observatory/ollama-run.ts

# watch it in a browser
npx tsx tools/observatory/serve.ts tools/observatory/.live/state.db
```

`LIVE=1` wakes the agent repeatedly instead of running one cycle and exiting.
A failed cycle is logged and the supervisor continues. `SLEEP_MS` sets the gap
between wakes (default 10s), `MAX_TURNS` caps turns per cycle, and `FRESH=1`
starts from an empty database — live mode otherwise accumulates across restarts.

### Configuring Ollama is not enough on its own

Setting `ollamaBaseUrl` and `inferenceModel` does **not** route inference to
Ollama. `InferenceRouter.selectModel()` tries the hardcoded routing-matrix
candidates before the operator's configured model, and
`ModelRegistry.initialize()` seeds those Conway/OpenAI baseline models as
enabled on every startup. The configured-model fallback below it is commented
"handles local/Ollama setups where routing-matrix models are absent" — but they
are never absent, so it is unreachable in practice.

The result is a turn that goes to `api.conway.tech` with your API key while the
log says otherwise. `ollama-run.ts` works around it by disabling the non-Ollama
rows in `model_registry` before the loop starts.

Two things worth fixing upstream:

- `selectModel()` should prefer the operator's explicitly configured model over
  the routing matrix, or skip matrix candidates whose provider has no usable
  credentials.
- `[THINK] Routing inference (…, model: X)` logs `inference.getDefaultModel()`,
  not the model the router actually selected. When these disagree — exactly when
  you need the log — it prints the wrong one.

## Two things the console surfaces

**Blocked calls are undercounted by `policy_decisions`.** A tool call can be
stopped two ways: the policy engine denies it (the call comes back with `error`
set and a row lands in `policy_decisions`), or the tool's own guard returns a
plain `"Blocked: …"` string with no error. `write_file`'s path confinement takes
the second path, so the engine logs the call as `allow`. An audit built only on
`policy_decisions` misses those. The renderer counts both and shows the split.

**x402 spend is always recorded as 0¢.** `executeTool` records x402 payments with
`amountCents: 0`, so the hourly and daily x402 envelopes derived from
`maxX402PaymentCents` can never trip. The meter is labelled accordingly rather
than showing a reassuring empty bar.

## Tool arguments are cast, not validated

A live model produced this on its first unscripted run:

```
create_goal → Cannot read properties of undefined (reading 'trim')
```

`create_goal` declares `required: ["title", "description"]` in its JSON schema,
but the schema is advisory — nothing checks it at runtime. The implementation
does `(args.title as string).trim()`, so a model that supplies only
`description` hits a `TypeError`. `executeTool` catches it, so the loop
survives, but the turn is wasted and the model receives an opaque message with
no indication of which argument was missing.

This is not exotic. Weaker or cheaper models omit required fields routinely, and
the same `as string` cast pattern appears across `tools.ts`. A generic
required-field check in `executeTool`, returning a message naming the missing
argument, would convert a crash into a turn the model can recover from.

The console separates the three ways a call can fail — policy denial, tool
crash, and in-tool guard — because they mean different things and only the first
is recorded in `policy_decisions`.
