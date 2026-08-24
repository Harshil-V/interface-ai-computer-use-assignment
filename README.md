# Computer-Use Automation System

An LLM works out how to drive a mock banking console once. The system records those steps
as a reusable **capability artifact**. From then on, a **replay engine** runs that capability
again with new inputs, without calling an LLM at all.

Every replay ends in one of four outcomes: success, a business outcome (such as "member not
found"), an escalation to a human operator for anything it can't safely finish alone, or a
failure. A recoverable error is retried on its own first, and becomes a failure only once its
declared retry policy is exhausted.

## The two committed capabilities

- **`member.savings-balance.read`** — looks up a member by ID and reads their savings
  balance back out as a typed `currency` output.
- **`member.sub-account.open`** — fills out and submits the multi-field "open sub-account"
  form for a member and confirms it. Its final step is `effect: "irreversible"` and is
  guardrail-gated: unattended replay pauses and escalates to a human before that step runs.
  See [`REPORT.md`](REPORT.md) §5 and §2 for why, and for how that step ended up in the
  artifact.

Both are versioned JSON under [`artifacts/`](artifacts/). Both have real discovery-run and
replay-run evidence under [`evidence/`](evidence/). Each artifact's `provenance.discoveryRunId`
and `provenance.evidencePath` fields point at the evidence run that produced it. Every replay's
own `evidence/<runId>/run.json` records which capability it replayed in its `goal` string.

## Repo layout

Two npm workspaces:

- **`mock-console/`** (Part A) — the target application: a local mock "Core Banking
  Console" (Vite + React + TypeScript). See [`mock-console/README.md`](mock-console/README.md)
  for its screens, fixtures, and session model.
- **`automation/`** (Part B) — the automation system itself: discovery agent, artifact
  schema, replay engine, guardrails, and HITL escalation.

The design rationale and trade-offs are in [`REPORT.md`](REPORT.md).

## Setup

```bash
npm install                        # installs both workspaces (mock-console + automation)
npx playwright install chromium    # one-time browser download; no postinstall hook runs this for you
cp automation/.env.example automation/.env
```

Then open `automation/.env` and set `ANTHROPIC_API_KEY` to your own Anthropic API key. Never
commit a real key. `.env` is gitignored; only `.env.example` is committed, and it contains
the key name with no value.

`ANTHROPIC_API_KEY` is needed for `npm run discover` and for `scripts/demo-discovery-stuck.ts`.
Every other command makes zero LLM calls and works without it.

## The demo path

`discover`, `replay`, and `snapshot` all drive a real Chromium browser (headed by default)
against the mock console, so the console has to be up first. Start it in its own terminal and
leave it running:

```bash
npm run dev
# Vite prints http://localhost:5173 — leave this terminal open
```

Run everything below in a second terminal, from the repo root.

### 1. Discover a capability (real LLM run)

```bash
npm run discover -- --goal "look up member 12345, open their detail page, and read their savings balance from that detail page" --url http://localhost:5173
```

This drives Claude through an observe → decide → act loop against the live console. On
success it prints a draft artifact to stdout and writes a full evidence trail under
`evidence/<runId>/`. The goal is deliberately explicit about the detail page: a vaguer one
lets the model shortcut to reading the balance straight off the search-results table.

> **Warning: a successful run overwrites a committed artifact file.** This goal matches the
> shape of the `member.savings-balance.read` capability, so discovery freezes its result over
> `artifacts/member.savings-balance.read.v1.json`, replacing the copy committed in this repo.

You don't have to run this step to see the system work: step 2 replays what is already
saved. This goal is the one behind `member.savings-balance.read`; `member.sub-account.open`
came from a separate discovery run on a different goal, and its final irreversible step was
appended by hand rather than discovered ([`REPORT.md`](REPORT.md) §2).

### 2. Replay it deterministically: parameterization and a business outcome

No LLM is called anywhere in this step. `ReplayEngine` never imports an LLM client.

```bash
# Same artifact, two different inputs, two different real balances:
npm run replay -- --artifact member.savings-balance.read --input memberId=12345
npm run replay -- --artifact member.savings-balance.read --input memberId=67890

# A structured "not found" rather than a crash:
npm run replay -- --artifact member.savings-balance.read --input memberId=99999
```

- `memberId=12345` → `{"status":"success","outputs":{"savingsBalance":"$1,240.55"}}`
- `memberId=67890` → `{"status":"success","outputs":{"savingsBalance":"$84,302.19"}}`. Same
  artifact, different input, different real output. This is what proves replay actually
  parameterizes rather than replaying a baked-in value.
- `memberId=99999` → `{"status":"business_outcome","outcomeId":"member_not_found",...}`. A
  legitimate domain result, reported as a structured classification rather than a failure.

A fourth run shows the **recoverable** classification: a forced session timeout, then
automatic recovery and a successful retry.

```bash
npm run replay -- --artifact member.savings-balance.read --input memberId=12345 \
  --url "http://localhost:5173/?forceExpireSession=1"
```

### 3. Inspect the operator surface (HITL)

```bash
npm run operator
```

Starts a standalone operator HTTP server and prints its URL. This instance has no live run
attached; it exists only to inspect the static operator page in isolation.

A real human-in-the-loop escalation happens automatically, with its own embedded operator
server, whenever a `discover` or `replay` run raises an intervention. That means an
irreversible step during replay, or a model-declared `stuck` during discovery. Recordings of
both are committed: [`evidence/20260824T031952Z-0dpfqy/`](evidence/20260824T031952Z-0dpfqy/)
and [`evidence/20260824T032209Z-tgj1rm/`](evidence/20260824T032209Z-tgj1rm/). To reproduce
them, run the scripts that produced them:

```bash
cd automation
npx tsx scripts/demo-replay-intervention.ts   # risky-action intervention: take control, click, hand back
npx tsx scripts/demo-discovery-stuck.ts        # forced-stuck discovery: escalate, then abandon
```

## Checks and zero-LLM commands

None of these need an `ANTHROPIC_API_KEY`, and none of them make an LLM call.

```bash
npm run typecheck   # tsc -b in automation/ (mock-console has no typecheck script)
npm test            # vitest in automation/, plus mock-console's tests
```

Those two need nothing running: they check and exercise pure logic, and don't touch a browser
or the network. `npm run snapshot` does need the mock console running, and is the debugging
entry point for perception:

```bash
npm run snapshot -- --url http://localhost:5173
```

It perceives the page once and dumps the filtered accessibility snapshot, which shows what
the discovery agent actually sees, at zero LLM spend.

## More detail

- Part A's screens, fixtures, and session/expiry model: [`mock-console/README.md`](mock-console/README.md)
- Architecture, artifact schema, determinism/error handling, heterogeneity, escalation,
  safety, and what was cut: [`REPORT.md`](REPORT.md)
- Full CLI reference (`snapshot` / `discover` / `replay` / `operator`, all flags): run
  `npm run automation` with no arguments, or read the `USAGE` string at the top of
  [`automation/src/cli.ts`](automation/src/cli.ts).
