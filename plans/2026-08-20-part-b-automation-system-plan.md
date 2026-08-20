# Implementation Plan — Part B: Computer-Use Automation System

**Date:** 2026-08-20
**Repo:** `interface-ai-computer-use-assignment`
**Scope:** `automation/` (Part B). Part A (`mock-console/`) is complete and committed.
**Planning source of truth:** [`docs/2026-08-13-computer-use-automation-notes.md`](../docs/2026-08-13-computer-use-automation-notes.md) + `Assignment A — Computer-Use Automation System.pdf` (repo root).

> **There is no separate PRD or design spec for this project.** The working notes doc plus the
> assignment brief serve that role jointly: the brief is the authoritative requirements source,
> the notes doc holds the frozen product/architecture decisions. This plan is the build order and
> task breakdown only — where it deviates from the notes doc it says so explicitly and gives the
> reason (see [Milestone ordering](#milestone-ordering--why-it-deviates-from-notes-12)).

---

## Goal

Deliver a complete end-to-end **vertical slice**, not a broad feature set:

> natural-language goal → a **real** LLM-driven discovery run against the live mock console →
> a saved **typed capability artifact** → **deterministic, LLM-free replay** with typed
> params/outputs and error classification → **human-in-the-loop escalation** that takes over the
> *same live session* → **evidence** for both runs.

Every one of the brief's §3.1–3.7 requirements must be touched by something real. Depth goes into
the three load-bearing pieces the brief names: the artifact schema, deterministic replay + error
taxonomy, and the safety/escalation model.

## Architecture summary

One Node process, one headed Playwright browser context per run, three modes
(`discovering | replaying | human`) and one control owner (`automation | human | paused`).

```
                 ┌──────────────────────────────────────────────┐
   CLI ─────────▶│ Orchestrator  (mode + run lifecycle)          │
                 └───┬───────────────┬───────────────┬──────────┘
                     │               │               │
            ┌────────▼──────┐ ┌──────▼───────┐ ┌─────▼─────────┐
            │ DiscoveryAgent│ │ ReplayEngine │ │ HITL          │
            │ (LLM loop)    │ │ (no LLM)     │ │ ControlLease  │
            └────────┬──────┘ └──────┬───────┘ │ operatorServer│
                     │               │         └─────┬─────────┘
                     └───────┬───────┘               │
                             ▼                       │
                  ┌──────────────────────┐           │
                  │ SurfaceDriver        │◀──────────┘  lease checked
                  │ (PlaywrightWebDriver)│              before every act()
                  │  perceive/act/resolve│
                  │  ├─ guardrail policy │  ← enforced INSIDE act()
                  └──────────┬───────────┘
                             ▼
                   live mock console (http://localhost:5173)

  outputs:  artifacts/<id>.v<n>.json          evidence/<runId>/{run.json,*.png,*.a11y.json,result.json}
```

Two load-bearing invariants drive the whole design; both are explained in full under
[Design invariants](#design-invariants-the-two-decisions-everything-else-follows-from).

1. **The LLM never authors locators.** It acts on system-assigned refs; the *system* derives the
   durable target descriptor from the node an action demonstrably hit.
2. **The artifact never encodes Playwright.** Steps carry semantic targets; a `SurfaceDriver`
   resolves them. This is what keeps the §3.7 heterogeneity story credible.

## Tech stack

| Concern | Choice | Note |
|---|---|---|
| Language / runtime | TypeScript on Node (ESM), run via `tsx` | Matches Part A's TS setup |
| Browser control | Playwright (`chromium`, **headed**) | Headed is load-bearing for HITL — see Milestone 7 |
| Perception | Playwright accessibility snapshot + screenshots | Primary locator surface; DOM only as fallback |
| LLM | **Anthropic (Claude)** via the official Anthropic TypeScript SDK, tool use | Locked; see below |
| Schema / validation | `zod` | Artifact schema is the single source of truth, types inferred from it |
| Artifacts | Versioned JSON on disk under `artifacts/` | No DB |
| Tests | Vitest, colocated `*.test.ts` | Same convention as Part A |
| CLI | Plain `node`/`tsx` entry points wired to root `npm run` scripts | No CLI framework dependency |
| Operator UI | One static HTML page + a tiny Node HTTP server | No frontend framework |

**Model ID:** the exact Claude model identifier must be **confirmed against Anthropic's current
documentation at implementation time**, not hardcoded from memory or from this document. Put it in
`automation/src/config/env.ts` behind an env-overridable constant so it is a one-line change.

## Global constraints

- **Secrets:** `ANTHROPIC_API_KEY` is read from `.env` (already gitignored — `.gitignore` ignores
  `.env` / `.env.*` but not `.env.example`). `.env.example` gets committed with the key name and an
  empty value. No key value ever appears in this repo, in logs, or in evidence.
- **Boundary rule (from notes §6):** Part A never imports Part B. Part B reaches Part A only over
  HTTP through Playwright. No shared runtime code.
- **Replay must not call the LLM.** Brief §3.3 forbids it. The only sanctioned exception is the
  "assisted fallback" *stretch* goal, which is not in this plan.
- **Guardrails live inside `SurfaceDriver.act()`**, never as a wrapper around it — see Milestone 3.
- **No real PII, no real credentials, no real bank systems.** Fixture data only.
- **Deliverable paths are fixed by the brief §6:** `/README.md`, `/REPORT.md` (seven exact
  headings), `/evidence/`. Do not rename or reorganize these.
- **TDD scope (established repo convention):** test-first applies **narrowly to pure logic** —
  snapshot filtering, redaction masking, outcome matching, `$input` binding, schema validation. It
  does **not** apply to Playwright integration glue or UI markup, which are verified by running the
  demo path. Part A followed exactly this split (`mock-console/src/domain/*.test.ts` tested;
  components not unit tested).
- **Time discipline:** stretch goals are out of scope until milestones 1–8 are demoable
  (notes §12).

---

## The automation target (Part A facts this plan depends on)

Part A is a pure client-side Vite + React + TS app; `npm run dev` from the repo root serves it at
`http://localhost:5173`. Facts the automation is built against (full detail in
`mock-console/README.md`):

| Case | Behavior | Accessible surface |
|---|---|---|
| Member `12345` | Found, savings balance `$1,240.55` | Results `<table>` with `<caption>Search result</caption>`; row button `aria-label="View details for member 12345"` |
| Member `67890` | Found, savings balance `$84,302.19` | **Exists solely to prove replay parameterizes** rather than replaying a baked value |
| Member `99999` | "No member found for ID 99999." | `role="alert"` → **business outcome**, not a crash |
| Empty submit | "Member ID is required" | `role="alert"` → business outcome (validation) |
| Idle past timeout | "Session expired" + "Start a new session" button | `role="alert"` → **recoverable** |
| Sub-account flow | Multi-field form → "Continue to confirmation" → **"Confirm and open sub-account"** | The one genuinely **irreversible** action; guardrails/HITL key off it |

There is **no login screen** by design (notes §3). Session expiry is force-triggerable three ways —
dev-tools panel button, `?forceExpireSession=1` query param, and `window.__forceExpireSession()` —
so the recoverable-condition demo is deterministic rather than a five-minute wait. Automation should
prefer the query param (fresh page load straight into the expired state) or the `window` hook.

Expiry is **sticky**: activity resets the idle clock but never un-expires, so a session expired at
page load survives the lookup clicks and is still expired when member detail renders. Clicking
"Start a new session" is the only thing that clears it — which is why the `session_expired` recovery
policy needs only `maxAttempts: 1`: the retry starts from a genuinely active session and cannot
re-trip the same condition.

Member detail exposes `Member <id>` as an `<h1>`, and the balance as a `<dt>Savings balance</dt>` /
`<dd>` pair — hence the `role: "definition"` + `describedBy: "Savings balance"` extraction target in
the schema below.

---

## Design invariants (the two decisions everything else follows from)

### 1. The LLM must never author locators

**Rule:** the driver's `perceive()` returns an accessibility snapshot in which every interactive or
status-bearing node carries a **system-assigned `ref`** (`e1`, `e2`, …). The model's action tools
accept **only a `ref`** — never a CSS selector, XPath, or Playwright locator string. There is no
tool parameter through which a model-invented selector can enter the system.

**Why this matters.** A model asked to produce a selector will produce a plausible one. Plausible is
not the same as correct, and the failure is silent: the artifact looks fine, replays green on the
recorded page, and breaks on the first variation. Worse, you cannot tell from the artifact whether a
locator was *observed* or *hallucinated*.

**What we do instead:** after an action **succeeds**, the system inspects the node it actually hit
and derives the durable `TargetDescriptor` itself — role, accessible name (or name pattern), and any
scoping needed for uniqueness (e.g. "the button inside the row whose first cell is the member ID").
A CSS fallback may be recorded alongside, but always as a *secondary* strategy derived from the same
real node.

Recorded locators are therefore **grounded in what demonstrably worked**, not in what the model
claimed. That is the concrete answer to brief §3.2's requirement to explain locator-robustness
reasoning, and it belongs in REPORT.md §2 and §3.

### 2. The artifact must not encode Playwright

If steps carry Playwright/CSS selector syntax, the §3.7 heterogeneity story collapses — the artifact
becomes a Playwright script with extra JSON around it, and "port this to a desktop surface" means
"rewrite every artifact."

**Rule:** steps carry *semantic* targets. A `SurfaceDriver` resolves them against whatever surface
it owns.

```ts
interface SurfaceDriver {
  perceive(): Promise<Observation>;          // a11y tree + refs + screenshot
  act(action: Action): Promise<ActResult>;   // click/fill/select/navigate/extract
  resolve(target: TargetDescriptor): Promise<ElementHandleRef | null>;
}
```

The seam is exactly `perceive` / `resolve`. A **legacy-web driver** swaps perception for DOM
heuristics and frameset walking (visible-text proximity, table-position addressing, label-adjacency)
and resolution for the same. A **desktop driver** swaps in OS accessibility APIs (UIA/AX), where
`role` + `name` are natively available. **The artifact is unchanged in both cases.** Only one driver
gets built; the others are described in REPORT.md §4.

---

## Artifact schema

The full shape, with the running example (`member.savings-balance.read`) that the vertical slice
actually produces:

```jsonc
{
  "schemaVersion": "1.0.0",
  "id": "member.savings-balance.read",
  "version": 1,
  "title": "Read member savings balance",
  "target": { "app": "core-banking-console", "tenant": "base", "entryUrl": "http://localhost:5173/" },
  "surface": { "kind": "web", "perception": "accessibility-tree" },
  "inputs":  [{ "name": "memberId", "type": "string", "required": true, "example": "12345", "sensitivity": "quasi-identifier" }],
  "outputs": [{ "name": "savingsBalance", "type": "currency", "sensitivity": "sensitive" }],
  "steps": [
    { "id": "s1", "action": "fill", "effect": "safe",
      "target": { "role": "textbox", "name": "Member ID", "fallbacks": [{ "css": "#memberId" }] },
      "value": { "$input": "memberId" },
      "wait": { "until": "target-visible", "timeoutMs": 5000 } },
    { "id": "s2", "action": "click", "effect": "safe", "target": { "role": "button", "name": "Look up member" } },
    { "id": "s3", "action": "click", "effect": "safe", "target": { "role": "button", "name": "View details for member {memberId}" } },
    { "id": "s4", "action": "extract", "effect": "safe", "target": { "role": "definition", "describedBy": "Savings balance" }, "into": "savingsBalance" }
  ],
  "checkpoint": { "assert": "visible", "target": { "role": "heading", "namePattern": "^Member \\d+$" } },
  "outcomes": [
    { "id": "member_not_found", "type": "business_outcome", "terminal": true, "when": { "role": "alert", "textMatches": "No member found for ID" } },
    { "id": "validation_error", "type": "business_outcome", "terminal": true, "when": { "role": "alert", "textMatches": "Member ID is required" } },
    { "id": "session_expired", "type": "recoverable", "when": { "role": "alert", "textMatches": "Session expired" },
      "recovery": { "action": "click", "target": { "role": "button", "name": "Start a new session" }, "thenRestartFromStep": "s1", "maxAttempts": 1 } }
  ],
  "provenance": { "discoveredAt": "...", "model": "...", "discoveryRunId": "...", "evidencePath": "evidence/<runId>/" },
  "approval": { "state": "draft" }
}
```

### Why each field group exists

| Field group | Justification |
|---|---|
| `outcomes[]` with a **`type`** | This is what prevents "no such member" being reported as a crash. The brief's glossary names conflating business outcomes with failures as *the most common design mistake here*. Just as important: classification lives **in the artifact, not in the engine**. Each capability declares its own known outcomes, so the engine stays generic and a reviewer can see, in one file, exactly which runtime conditions this capability understands. A generic engine-side taxonomy would have to guess. |
| `effect: "safe" \| "irreversible"` | Makes guardrail decisions **declarative and reviewable** rather than buried in engine conditionals. A human approving an artifact can see at a glance which steps mutate state. The policy engine reads this field; it does not re-derive risk from step semantics. |
| `value: { "$input": "memberId" }` and `{memberId}` name interpolation | Proves **real parameterization**, not a replay of recorded literals. Member `67890` exists in Part A specifically so a second replay with a different input returns a *different* balance — otherwise "parameterized" is unfalsifiable. |
| `provenance` (references, does not embed) | Points at `discoveryRunId` / `evidencePath` instead of inlining the model transcript. This is the concrete mechanism satisfying §3.2's "**decoupled from the raw model transcript**" requirement, and it keeps model output out of the reviewable contract. |
| `target.tenant`, `schemaVersion`, `version` | The multi-tenant and evolvability **seam** without building multi-tenancy. `tenant: "base"` plus a future per-tenant override file is the story for REPORT §4; `schemaVersion` lets the loader reject/migrate old artifacts; `version` versions the capability itself. Design-only, per notes §4 (3.7 = REPORT only). |
| `checkpoint` | §3.2 requires an explicit success condition; §3.3 requires replay to verify it. Also re-verified after HITL hand-back. |
| `surface.kind` / `surface.perception` | Declares which driver family the artifact was recorded against, so a mismatched driver fails loudly instead of subtly. |
| `approval.state` | Currently always `"draft"`. Present because the confidence/approval stretch goal would gate unattended replay on it; costs one field now, avoids a schema break later. |
| `inputs[].sensitivity` / `outputs[].sensitivity` | Drives redaction (see below). Redaction policy is data-driven from the artifact rather than a hardcoded field-name blocklist. |

---

## Replay result contract

```ts
type ReplayResult =
  | { status: 'success';          outputs: Record<string, unknown>; runId: string; evidencePath: string }
  | { status: 'business_outcome'; outcomeId: string; detail: string; runId: string; evidencePath: string }
  | { status: 'escalated';        interventionId: string; reason: string; resolution: 'resumed' | 'abandoned' }
  | { status: 'failure';          error: { stepId: string; expected: string; observed: string; class: 'hard' | 'recoverable_exhausted' } };
```

Rules:

- **Recoverable conditions retry per the artifact's declared policy** (`recovery.maxAttempts`,
  `thenRestartFromStep`). Only after exhausting them does the run become a
  `failure` with `class: 'recoverable_exhausted'`.
- **Anything undeclared and unclassifiable is a hard failure** carrying step-level detail
  (`stepId`, `expected`, `observed`) — never a silent proceed. "The click didn't land but we
  continued anyway" is the failure mode this contract exists to make impossible.
- `escalated` is a distinct terminal status, not a flavor of failure: a human took over, and the
  caller needs to know whether the run `resumed` or was `abandoned`.

---

## Guardrails

**Enforcement point: inside `SurfaceDriver.act()`.** Not a wrapper, not a decorator applied by the
ReplayEngine. If the policy check lives in a wrapper, discovery — which holds the driver
directly — bypasses it, and only replay ends up guarded. That is backwards: **discovery is the mode
where an unpredictable actor is choosing the actions.** Putting the check in the one function that
touches the page means every caller is covered by construction.

Config lives in `automation/config/policy.json`:

| Policy | Content |
|---|---|
| Allowlisted origins/routes | `http://localhost:5173` and its routes only. Navigation outside → hard failure, no exception. |
| Allowlisted action types | `click`, `fill`, `select`, `navigate`, `extract`. Anything else is rejected. |
| Risk classification | Rules mapping observed targets to `safe` / `irreversible`, e.g. accessible name matching `Confirm and open sub-account`. |

**Irreversible actions are blocked from unattended execution and raise an intervention.**

*Justifying the conservative default:* the asymmetry is total. Blocking a safe action costs one
human confirmation click; permitting an irreversible one costs an account that got opened, or money
that moved, in a regulated financial system — and there is no undo path in a UI-driving system,
because the UI itself often has no undo. In a domain where the error is unrecoverable and the
false-positive cost is seconds of a human's time, "block and ask" is the only defensible default.
The escape hatch is an explicit, per-run, human-granted approval — not a config flag that quietly
disables the check.

---

## Human-in-the-loop

**The insight that avoids building co-browsing:** the browser is already **headed**. "Give the human
the live session" is literally "stop driving and let them use the window that is already open on
their screen." There is no streaming, no VNC, no remote input channel to build. The brief explicitly
puts a real-time co-browsing console out of scope; this is how we get a *real* handoff anyway.

**The real engineering is the control model.** A `ControlLease` holds exactly one owner:

```
automation | human | paused
```

The driver checks the lease **before every action**. When the human owns it, automation
**cannot** act — the check is in the same place as the guardrail check, inside `act()`, so it is not
bypassable by whichever component happens to hold the driver. This is what makes "who is in
control" an enforced property rather than a convention.

**Operator surface:** one minimal local page (served by `operatorServer`) showing the capability,
the goal, the current step, the stop reason, and the last screenshot, with two actions: **Take
control** and **Hand back**. It polls; it does not stream.

**On hand-back the engine re-perceives and re-verifies the checkpoint.** It must never assume the
page is where it left it — the human may have navigated, submitted, or backed out. Re-verification
is the difference between a handoff and a hope.

**Capturing what the human did:** a before/after accessibility-snapshot **diff**, plus screenshots
on either side, plus a free-text operator note submitted with the hand-back.
**Keystroke-level capture is an explicit, documented cut** (REPORT §7): it is a large build for
marginal evidentiary value here, and the snapshot diff already answers "what changed and did the run
resume from a valid state."

---

## Evidence layout

```
evidence/<runId>/
├── run.json          # structured step log: step id, action, target, decision/rationale, timings, lease owner
├── 001-<label>.png   # numbered screenshots in execution order
├── 002-<label>.png
├── s2.a11y.json      # accessibility snapshots at key steps (masked before write)
└── result.json       # final ReplayResult / discovery outcome
```

**Discovery and replay write the same shape.** One recorder, one format, one thing to learn when
debugging — and it means the discovery run's evidence is directly comparable to the replay's.

---

## Locked decisions (recorded here and in the notes doc)

- **LLM provider:** Anthropic (Claude) via the Anthropic TypeScript SDK, using tool use.
  `ANTHROPIC_API_KEY` from `.env`; `.env.example` committed. **Exact model ID confirmed against
  Anthropic's current docs at implementation time.**
- **Tool surface exposed to the model:**

  | Tool | Purpose |
  |---|---|
  | `perceive()` | Return the current filtered a11y snapshot with refs |
  | `click(ref)` | Click a ref |
  | `fill(ref, value)` | Type into a ref |
  | `select(ref, value)` | Choose an option in a ref |
  | `navigate(url)` | Navigate (allowlist-checked) |
  | `extract(ref, as)` | Read a value out of a ref into a named output |
  | `done(summary)` | Declare the goal met |
  | `stuck(reason)` | Declare a dead end |

  Two things to note about this surface. **`stuck` gives a first-class, model-declared dead-end
  signal** — HITL detection does not have to *infer* stuckness from step exhaustion or oscillation
  heuristics, which are exactly the kind of guesswork that produces both false escalations and
  missed ones. And **every action tool accepts refs only, never selectors**, which is what makes
  invariant #1 structural rather than aspirational.
- **Redaction stance:** mask sensitive values in **persisted** logs/evidence, driven by the
  artifact's `sensitivity` classification; **return full values to the in-process caller** (an agent
  invoking the capability legitimately needs the real balance). Accessibility-snapshot text is
  masked before persisting. **Screenshots are accepted unmasked** — pixel-level redaction is a
  disproportionate build for this exercise — and that limit is **disclosed in REPORT.md §6
  "Safety"** rather than left for a reviewer to discover.

---

## Intended `automation/` file structure

Every file, with its one-line responsibility. Nothing here is speculative — each is created by a
task below.

```
automation/
├── package.json                          # workspace package: deps (playwright, @anthropic-ai/sdk, zod, vitest, tsx), scripts
├── tsconfig.json                         # strict TS, ESM, node types
├── config/
│   └── policy.json                       # allowlisted origins/routes, allowed action types, risk classification rules
└── src/
    ├── config/
    │   ├── env.ts                        # loads .env; exposes ANTHROPIC_API_KEY + model id constant; fails fast if missing
    │   └── policy.ts                     # types + loader/validator for config/policy.json
    ├── surface/
    │   ├── types.ts                      # SurfaceDriver, Observation, Action, ActResult, TargetDescriptor, ElementHandleRef
    │   ├── PlaywrightWebDriver.ts        # the one concrete driver: perceive/act/resolve over a headed Chromium page
    │   ├── snapshot.ts                   # captures Playwright a11y tree, assigns refs, keeps ref→node map for the run
    │   ├── snapshotFilter.ts             # PURE: filter to interactive + status-bearing nodes, cap size (TDD)
    │   └── targetDescriptor.ts           # PURE: derive a durable TargetDescriptor from the node an action actually hit (TDD)
    ├── guardrails/
    │   ├── policy.ts                     # PURE decision fn: (action, observedTarget, policy) → allow | block | require-intervention (TDD)
    │   └── redaction.ts                  # PURE: mask values by sensitivity; mask a11y snapshot text before persist (TDD)
    ├── artifact/
    │   ├── schema.ts                     # zod schema = single source of truth; TS types inferred from it
    │   ├── store.ts                      # load/save artifacts/<id>.v<n>.json, validate on both read and write
    │   └── binding.ts                    # PURE: resolve { $input } values and {name} interpolation against params (TDD)
    ├── evidence/
    │   ├── EvidenceRecorder.ts           # owns evidence/<runId>/: run.json, numbered screenshots, a11y snapshots, result.json
    │   └── paths.ts                      # PURE: runId generation + evidence path helpers (TDD)
    ├── discovery/
    │   ├── DiscoveryAgent.ts             # the observe→decide→act loop; stopping conditions; owns the Anthropic conversation
    │   ├── tools.ts                      # Anthropic tool definitions + dispatch to SurfaceDriver (refs only, no selectors)
    │   ├── prompt.ts                     # system prompt: goal framing, ref-only rule, done/stuck contract
    │   ├── groundedActionLog.ts          # records each SUCCEEDED action + the node it hit — the grounding record
    │   └── artifactBuilder.ts            # PURE-ish: grounded action log + extracted outputs → draft artifact (TDD on the mapping)
    ├── replay/
    │   ├── ReplayEngine.ts               # deterministic step execution, waits, checkpoint verification, retry policy
    │   ├── outcomes.ts                   # PURE: match an Observation against artifact.outcomes[] → classification (TDD)
    │   └── result.ts                     # the ReplayResult union + constructors
    ├── hitl/
    │   ├── ControlLease.ts               # single-owner lease (automation|human|paused); the driver checks it before every act
    │   ├── interventions.ts              # intervention record: runId, capability, goal, step, reason, screenshot path, status
    │   ├── operatorServer.ts             # tiny HTTP server: serves the operator page + take-control/hand-back/status endpoints
    │   └── operator-ui/
    │       └── index.html                # one page: context + last screenshot, poll loop, "Take control" / "Hand back"
    ├── orchestrator/
    │   └── Orchestrator.ts               # mode switches, run lifecycle, wires driver + lease + evidence + agent/engine
    └── cli/
        ├── snapshot.ts                   # `npm run snapshot` — perceive + dump filtered a11y snapshot, zero LLM spend
        ├── discover.ts                   # `npm run discover -- --goal "..." --url ...`
        ├── replay.ts                     # `npm run replay -- --artifact ... --input k=v`
        └── operator.ts                   # `npm run operator` — starts the operator surface
```

Repo-root outputs (already in the notes §6 layout): `artifacts/` (saved capability JSON) and
`evidence/` (run folders). `.env.example` at the repo root.

---

## Milestone ordering — why it deviates from notes §12

The notes doc's §12 phase list puts the **discovery loop at phase 4** and **deterministic replay at
phase 6**, after artifact schema work. **This plan front-loads the real LLM run to milestone 4, and
deliberately builds a rough artifact before freezing any schema.**

The reason: the discovery run is *the one thing the brief says cannot be faked* ("the discovery run
has to be real… we can't assess a description of it"), and it carries all the genuinely unknown
risk — how well tool-calling behaves in this loop, whether the filtered snapshot is good enough to
reason over, whether the context size holds. Everything downstream of it is work whose difficulty we
can already estimate.

Designing a polished schema and *then* discovering the model can't produce the grounded actions it
assumes is the expensive failure mode: it invalidates the most carefully-built artifact in the
project. Running the model first and shaping the schema around what actually came out inverts that
risk. This also matches the notes' **own §15 item 1**, which already leans "freeze schema after
first discovery emit" — so this is following the notes' stated lean, not contradicting it.

---

## Milestones

### Milestone 1 — Workspace + config skeleton

**Tasks (ordered)**

1. Add `"automation"` to `workspaces` in the root `package.json`.
2. Create `automation/package.json` — deps: `playwright`, `@anthropic-ai/sdk`, `zod`;
   devDeps: `typescript`, `tsx`, `vitest`, `@types/node`. Scripts: `snapshot`, `discover`,
   `replay`, `operator`, `test`.
3. Add root pass-through scripts: `discover`, `replay`, `operator`, `snapshot`, and extend the root
   `test` script to run both workspaces.
4. Create `automation/tsconfig.json` (strict, ESM, `moduleResolution: "bundler"` or `"node16"` to
   match the SDK's shipped types — verify against the installed package, don't assume).
5. Create `.env.example` at the repo root containing `ANTHROPIC_API_KEY=` (name only, empty value).
   Confirm `.gitignore` still ignores `.env` and `.env.*` while allowing `!.env.example` — it
   already does; verify, don't change.
6. Create `automation/src/config/env.ts` — reads `.env`, fails fast with a clear message if
   `ANTHROPIC_API_KEY` is absent, exports the model-id constant (env-overridable).
7. Create `automation/config/policy.json` with the localhost origin allowlist, the five allowed
   action types, and one risk rule matching the accessible name `Confirm and open sub-account`.
8. Create `automation/src/config/policy.ts` — zod-validated loader for that file.

**Tests:** `config/policy.test.ts` — a valid policy file parses; a policy with an unknown action
type is rejected; a policy missing `allowedOrigins` is rejected. (`env.ts` is not unit tested; it is
exercised by every CLI run.)

**Demoable:** `npm run test` passes in both workspaces; `npx tsc -b` clean in `automation/`.

---

### Milestone 2 — Perception + evidence

Nothing here spends a single LLM token, which is exactly the point: the perception layer is
debuggable in isolation before it is fed to a model.

**Tasks (ordered)**

1. **Verify Playwright's current accessibility-snapshot API against the real Playwright docs**
   before writing `snapshot.ts`. Do not assume the shape from memory — confirm the current
   accessor, its options, and its return shape, then code to what it actually returns.
2. `automation/src/surface/types.ts` — define `SurfaceDriver`, `Observation`
   (`{ url, nodes: SnapshotNode[], screenshotPath }`), `SnapshotNode`
   (`{ ref, role, name, value?, disabled?, children? }`), `Action`, `ActResult`,
   `TargetDescriptor`, `ElementHandleRef`.
3. `automation/src/surface/snapshotFilter.ts` — **pure, test-first.** Keep interactive roles
   (button, textbox, combobox, link, checkbox…) and status-bearing roles (alert, status, heading,
   definition, term, cell, caption). Drop pure-presentational nodes. Cap total serialized size and
   truncate long text values, preserving the highest-value nodes.
4. `automation/src/surface/snapshot.ts` — capture via Playwright, run the filter, assign sequential
   `ref` ids, maintain the run-scoped `ref → element handle` map.
5. `automation/src/surface/targetDescriptor.ts` — **pure, test-first.** Given the node an action
   hit plus the surrounding snapshot, produce a durable descriptor: role + name, `namePattern` when
   the name embeds a parameter value, and scoping when role+name is not unique.
6. `automation/src/evidence/paths.ts` — **pure, test-first.** `runId` generation and path helpers.
7. `automation/src/evidence/EvidenceRecorder.ts` — creates `evidence/<runId>/`, appends structured
   step entries to `run.json`, writes numbered screenshots, writes a11y snapshots, writes
   `result.json`.
8. `automation/src/surface/PlaywrightWebDriver.ts` — launch headed Chromium, implement `perceive()`
   and `resolve()`. `act()` is stubbed to throw until Milestone 3 installs the policy check, so
   there is no window in which an unguarded `act()` exists.
9. `automation/src/cli/snapshot.ts` — navigate to a URL, perceive, print + persist the filtered
   snapshot.

**Tests:**
- `snapshotFilter.test.ts` — interactive nodes kept; presentational nodes dropped; `role="alert"`
  kept; output stays under the size cap for an oversized synthetic tree; truncation preserves node
  identity.
- `targetDescriptor.test.ts` — unique role+name yields a plain descriptor; a name containing the
  member ID yields a `namePattern`; duplicate role+name yields a scoped descriptor.
- `paths.test.ts` — runIds are unique and filesystem-safe; paths nest under `evidence/<runId>/`.
- Playwright glue is **not** unit tested — verified by running the CLI.

**Demoable:** `npm run snapshot -- --url http://localhost:5173` prints a compact, readable node list
with refs for the member-lookup screen, and writes `evidence/<runId>/` containing a screenshot and
the snapshot JSON. Zero LLM spend.

---

### Milestone 3 — Guardrails in the action path

**Tasks (ordered)**

1. `automation/src/guardrails/policy.ts` — **pure, test-first.** `(action, observedTarget, policy)`
   → `{ decision: 'allow' } | { decision: 'block', reason } | { decision: 'require-intervention', reason }`.
   Navigation outside the allowlist → `block`. Disallowed action type → `block`. Target matching a
   risk rule (or a step declaring `effect: "irreversible"`) → `require-intervention`.
2. `automation/src/guardrails/redaction.ts` — **pure, test-first.** `mask(value, sensitivity)`
   (last-4 style for `sensitive`, configurable for `quasi-identifier`), plus
   `maskSnapshotText(nodes, sensitivityMap)` applied before persistence.
3. Implement `PlaywrightWebDriver.act()` with the policy check as its **first statement**, before
   any page interaction. Blocked actions throw a typed `PolicyViolation`;
   `require-intervention` raises the intervention path (wired for real in Milestone 7, recorded as
   a hard stop until then).
4. Wire `redaction.ts` into `EvidenceRecorder` so every persisted write goes through masking.

**Tests:**
- `policy.test.ts` — allowlisted origin allowed; off-allowlist navigation blocked; unknown action
  type blocked; the sub-account confirm target returns `require-intervention`; a safe click on the
  same page is allowed.
- `redaction.test.ts` — a currency value masks to a last-4 form; a `quasi-identifier` masks per
  config; masking is idempotent; snapshot text masking leaves roles/names intact while masking
  values.

**Demoable:** a scripted `act()` attempt to navigate off-origin is refused with a typed violation
and a recorded evidence entry; the snapshot CLI's persisted output shows masked values while the
in-memory object retains full ones.

---

### Milestone 4 — Discovery spike: the real LLM run *(the de-risking milestone)*

**Goal for the run:** `"look up member 12345 and read their savings balance"`.

**Tasks (ordered)**

1. `automation/src/discovery/prompt.ts` — system prompt stating the goal contract, the **refs-only**
   rule, when to call `done(summary)` vs `stuck(reason)`, and that the model must not invent
   selectors.
2. `automation/src/discovery/tools.ts` — Anthropic tool definitions for `perceive`, `click`, `fill`,
   `select`, `navigate`, `extract`, `done`, `stuck`, each dispatching to `SurfaceDriver`. Ref
   parameters are typed as refs; there is no selector parameter anywhere in the schema.
   **Verify the SDK's current tool-use request/response shape against Anthropic's docs** rather than
   coding from memory.
3. `automation/src/discovery/groundedActionLog.ts` — on each **successful** action, record the
   action, the ref, and the descriptor derived by `targetDescriptor.ts` from the node actually hit.
4. `automation/src/discovery/DiscoveryAgent.ts` — the observe→decide→act loop. **Stopping
   conditions: goal met (`done`) / max steps / wall-clock timeout / model-declared dead-end
   (`stuck`).** Every turn is written to evidence with the model's stated rationale.
5. `automation/src/discovery/artifactBuilder.ts` — grounded action log + declared outputs → a
   **rough** artifact (no frozen schema yet; this milestone is about learning what the model can
   actually produce).
6. `automation/src/orchestrator/Orchestrator.ts` — run lifecycle for the discovery mode.
7. `automation/src/cli/discover.ts` — `--goal`, `--url`; writes artifact + evidence.

**Tests:** `artifactBuilder.test.ts` against a **recorded/synthetic** grounded action log — the
right number of steps in order, `fill` steps carry values, the extract step carries `into`. The LLM
loop itself is not unit tested; it is validated by the real run, which is the deliverable.

**Demoable:** `npm run discover -- --goal "look up member 12345 and read their savings balance"
--url http://localhost:5173` completes against the live console, writes a draft artifact, and leaves
a full `evidence/<runId>/` with per-turn rationale and screenshots. **This is the brief's
non-negotiable "the discovery run has to be real" evidence.**

---

### Milestone 5 — Freeze the schema

**Tasks (ordered)**

1. `automation/src/artifact/schema.ts` — zod schema derived from **what milestone 4 actually
   produced**, extended to the full shape documented above (`outcomes[]`, `effect`, `checkpoint`,
   `provenance`, `approval`, `target.tenant`, `schemaVersion`). Infer all TS types from the zod
   schema — one source of truth.
2. `automation/src/artifact/binding.ts` — **pure, test-first.** `$input` resolution and `{name}`
   interpolation inside target names, with a clear error for an unbound reference.
3. `automation/src/artifact/store.ts` — save/load `artifacts/<id>.v<n>.json`, **validating on both
   read and write**; reject unknown `schemaVersion` with an explicit message.
4. Update `artifactBuilder.ts` to emit the frozen shape, including `provenance` pointing at the
   discovery `runId`/evidence path and the three `outcomes[]` entries for this capability.
5. Re-run discovery (or re-emit from the milestone-4 grounded log) to produce the canonical
   committed artifact.

**Tests:**
- `schema.test.ts` — the canonical example artifact validates; a missing `checkpoint` is rejected;
  an unknown `effect` value is rejected; an outcome with an unknown `type` is rejected.
- `binding.test.ts` — `{ $input: "memberId" }` resolves; `"View details for member {memberId}"`
  interpolates; an unknown input name errors rather than silently producing a literal brace string.
- `store.test.ts` — round-trip save/load preserves the artifact; loading a malformed file throws
  a validation error naming the offending field.

**Demoable:** `artifacts/member.savings-balance.read.v1.json` exists, validates, and reads as a
reviewable contract to someone who has never seen the console.

---

### Milestone 6 — Replay engine

**Tasks (ordered)**

1. `automation/src/replay/result.ts` — the `ReplayResult` union + constructors.
2. `automation/src/replay/outcomes.ts` — **pure, test-first.** Match an `Observation` against
   `artifact.outcomes[]`, returning the matching outcome (with its `type`) or `null`. Checked after
   every step, not just at the end — the point is to detect the alert the moment it appears.
3. `automation/src/replay/ReplayEngine.ts` — resolve each step's target via `SurfaceDriver.resolve`,
   honor `wait.until` / `timeoutMs`, execute through `act()` (so guardrails apply), classify after
   each step, apply `recovery` for recoverable outcomes up to `maxAttempts` (including
   `thenRestartFromStep`), verify the `checkpoint`, and return the typed result.
4. `automation/src/cli/replay.ts` — `--artifact`, repeated `--input k=v`; prints the structured
   result; exit code reflects status class.
5. Evidence parity — replay writes the identical `evidence/<runId>/` shape as discovery.

**Tests:**
- `outcomes.test.ts` — a "No member found for ID 99999." alert matches `member_not_found` with type
  `business_outcome`; "Member ID is required" matches `validation_error`; "Session expired" matches
  `session_expired` with type `recoverable`; an unrelated alert matches nothing.
- `result.test.ts` — constructors produce the discriminated shapes; a `recoverable` outcome that
  exhausts `maxAttempts` yields `class: 'recoverable_exhausted'`, not `'hard'`.
- Engine integration is verified by the four demo runs below, not by unit tests.

**Demoable — four runs, each proving a distinct requirement:**

| Run | Input | Expected result |
|---|---|---|
| 1 | `memberId=12345` | `success`, `savingsBalance: "$1,240.55"` |
| 2 | `memberId=67890` | `success`, `savingsBalance: "$84,302.19"` — **parameterization proof**: same artifact, different input, different output |
| 3 | `memberId=99999` | `business_outcome`, `outcomeId: "member_not_found"` — **not** a failure |
| 4 | entry URL with `?forceExpireSession=1`, then `memberId=12345` | `session_expired` detected → recovery clicks "Start a new session" → restart from `s1` → `success` |

---

### Milestone 7 — Human-in-the-loop

**Tasks (ordered)**

1. `automation/src/hitl/ControlLease.ts` — single-owner lease (`automation | human | paused`) with
   `acquire`/`release`/`current`, plus an assertion helper the driver calls.
2. Add the lease check to `PlaywrightWebDriver.act()`, alongside the policy check: if the owner is
   not `automation`, the action does not happen. Automation **cannot** act while the human holds
   the lease.
3. `automation/src/hitl/interventions.ts` — the intervention record (`interventionId`, `runId`,
   capability id, goal, current step, stop reason, screenshot path, status) plus in-memory store
   and status transitions.
4. `automation/src/hitl/operatorServer.ts` — tiny HTTP server: `GET /` (page),
   `GET /api/intervention` (current context + last screenshot), `POST /api/take-control`,
   `POST /api/hand-back` (accepts the free-text operator note).
5. `automation/src/hitl/operator-ui/index.html` — one page: capability, goal, current step, stop
   reason, last screenshot, poll loop, two buttons, a note field. **No framework, no build step.**
6. Hand-back path in the orchestrator: re-`perceive()`, capture the after-snapshot, write the
   **before/after a11y diff** + both screenshots + the operator note to evidence,
   **re-verify the checkpoint**, then resume or return `escalated` with
   `resolution: 'resumed' | 'abandoned'`.
7. Route both triggers into interventions: `require-intervention` from the guardrail, and `stuck`
   from the discovery agent.
8. `automation/src/cli/operator.ts`.

**Tests:**
- `ControlLease.test.ts` — only one owner at a time; a second `acquire` while held fails;
  release returns to `automation`; the driver's assertion throws when the human holds it.
- `interventions.test.ts` — an intervention record carries every field an operator needs; status
  transitions are legal only in the intended order.
- The server and page are verified by the demo, not unit tested.

**Demoable — both triggers:**
1. **Risky action:** replay a sub-account artifact; the `Confirm and open sub-account` step raises an
   intervention; the operator page shows the context; the human takes control, clicks confirm in the
   already-open browser window, hands back with a note; the engine re-verifies and completes.
2. **Forced stuck:** a discovery goal the console cannot satisfy; the model calls `stuck(reason)`;
   the same intervention path runs; the operator abandons; the run returns `escalated` with
   `resolution: 'abandoned'`.

---

### Milestone 8 — Deliverables

**Tasks (ordered)**

1. `/README.md` — setup (`npm install`, Playwright browser install, `.env` from `.env.example`,
   `ANTHROPIC_API_KEY` **by name only**), and the copy-pasteable demo path (below).
2. `/REPORT.md` — the **seven exact headings** from brief §6, in order:
   1. **Architecture** — one process/one session, the three modes, the driver seam, trade-offs.
   2. **Artifact schema** — the schema plus the per-field-group justifications above.
   3. **Determinism & error handling** — refs-only grounding, `resolve()` strategy, waits,
      checkpoint verification, the three-way taxonomy, and the `ReplayResult` contract.
   4. **Heterogeneity & multi-tenant** — the `SurfaceDriver` seam for legacy-web and desktop;
      `tenant`/`schemaVersion`/`version` as the cross-tenant reuse and drift seam. **Include the
      honest weakness** (below).
   5. **Escalation & handoff** — `stuck` as a first-class signal, the `ControlLease` model, headed
      browser as the handoff mechanism, hand-back re-verification.
   6. **Safety** — allowlist, the conservative irreversible-action default and its justification,
      the redaction stance, and **the explicit disclosure that screenshots are not masked**.
   7. **Cuts** — keystroke-level capture, co-browsing console, multi-tenant infra, desktop driver,
      LLM-in-replay, plus notes §13's standing cut list, and what comes next.
3. Tidy `/evidence/` — keep one clean discovery run and the four replay runs (including the
   not-found and session-expired ones the brief specifically asks for), remove noise.
4. Final cross-check of every deliverable against brief §6 and the notes §14 reminder.

**Tests:** no new unit tests. The check is executing the README demo path top to bottom on a clean
clone and confirming each documented output appears.

**Demoable:** the whole submission.

---

## Proposed CLI / demo path

```bash
npm run dev                                                    # start Part A mock console (http://localhost:5173)

npm run discover -- --goal "look up member 12345 and read their savings balance" --url http://localhost:5173

npm run replay -- --artifact artifacts/member.savings-balance.read.v1.json --input memberId=12345
npm run replay -- --artifact artifacts/member.savings-balance.read.v1.json --input memberId=67890
npm run replay -- --artifact artifacts/member.savings-balance.read.v1.json --input memberId=99999

npm run operator                                               # HITL operator surface
```

`npm run snapshot -- --url http://localhost:5173` is also available as a zero-LLM-spend debugging
entry point into the perception layer.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| **A fully serialized a11y snapshot blows the context window.** This is the most likely cause of a failed or wildly expensive discovery run. | `snapshotFilter.ts` keeps only interactive + status-bearing nodes and enforces a hard size cap with truncation. Built and tested at Milestone 2, *before* any token is spent. |
| **Drift toward letting replay call the LLM** when a step is ambiguous. It is a tempting one-line fix and it is **forbidden by §3.3**. | Replay has no LLM client in scope — `ReplayEngine` never imports the Anthropic SDK, so the shortcut isn't reachable. The only sanctioned version is the documented "assisted fallback" stretch goal, which is out of scope here. |
| **The operator UI is the classic time sink** — it invites building a real console. | Hard cap: one HTML page, a poll loop, two buttons, a note field. No framework, no build step, no streaming. The *control model* is where the engineering effort goes. |
| Playwright's a11y API shape differs from assumption. | Milestone 2 task 1 verifies it against current docs before code is written. Same discipline for the Anthropic tool-use shape at Milestone 4. |
| Discovery run non-determinism makes the demo unrepeatable. | The committed artifact + evidence are the deliverable; replay (which is deterministic) is what the demo path re-runs. |

### The honest weakness to pre-empt in REPORT §4

**Part A is a clean, semantic React app — the accessibility tree is easy mode.** Every control is a
real `<button>`, every input has a `<label htmlFor>`, every alert has `role="alert"`. That is a
best-case surface, and an a11y-tree-first strategy validated only against it has **not been
stress-tested** against the legacy reality the brief describes (framesets, table layouts,
non-semantic markup, no test IDs).

The write-up must **say this plainly** rather than implying robustness that was never demonstrated,
and then explain how the driver degrades: what `perceive()` falls back to when the a11y tree is
sparse or absent (visible-text proximity, table-position addressing, label adjacency, frame
walking), and why that fallback lives behind the `SurfaceDriver` seam so the artifact format doesn't
change. Stating a known limit with a credible degradation path reads as judgment; overselling reads
as not having thought about it.

---

## Still open (do not decide now)

| # | Question | Why deferred |
|---|---|---|
| 1 | **Which stretch goal, if any** | Defer until the vertical slice runs end to end (notes §12: don't start stretch until 1–9 are demoable). The **agent-facing capability catalog** is the natural fit if there's room, since the artifact is already a typed, callable contract with declared inputs/outputs — the catalog is mostly exposure, not new design. |
| 2 | **Whether Part A needs an artificial loading delay** so replay's wait strategy has something real to prove | Revisit at Milestone 6. Right now every state change in Part A is synchronous, so `wait.until` is untested by construction. Adding a small delay would make the wait strategy demonstrable — but it touches Part A, which is done and committed, so it needs a real justification before reopening. |

---

## Cross-references

- Frozen decisions, demo scenarios, error taxonomy, and cut list:
  [`docs/2026-08-13-computer-use-automation-notes.md`](../docs/2026-08-13-computer-use-automation-notes.md)
- Part A behavior, fixtures, session model, and accessibility contract: `mock-console/README.md`
- Authoritative requirements: `Assignment A — Computer-Use Automation System.pdf` (repo root)
