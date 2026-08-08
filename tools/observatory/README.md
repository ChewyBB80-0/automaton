# Observatory

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
