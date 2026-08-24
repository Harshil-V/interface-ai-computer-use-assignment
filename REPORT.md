# REPORT — Computer-Use Automation System

## 1. Architecture

**Process model.** There are four CLI commands. `snapshot`, `discover`, and `replay` each run
as one Node process with one headed Playwright browser context; `operator` starts only the
operator HTTP server and never launches a browser.

**No orchestrator class.** The plan called for an `Orchestrator`, but each command turned out
to be a short, linear function in `cli.ts` that wires up the recorder, lease, intervention
store, and driver, then calls `runDiscovery` or `runReplay`. With only one caller per path, a
mode-switching class would add indirection without removing any.

**The interface everything else goes through** is `SurfaceDriver`
(`automation/src/surface/SurfaceDriver.ts`): `perceive(): Observation`,
`act(Action): ActResult`, `resolve(TargetDescriptor): ElementRef | null`.
`PlaywrightWebDriver` is its only implementation, and neither `DiscoveryAgent` nor
`ReplayEngine` imports Playwright directly. The guardrail check (`checkAction`) and the HITL
lease check (`assertAutomationMayAct`) are the first statements inside `act()`, before any
page interaction, so no caller can reach the page without passing both.

**Trade-off accepted.** One process per run means no shared, persistent operator service.
Each invocation starts its own embedded operator HTTP server, lease, and intervention store
(§5). Beyond one demoed run at a time, that is a real limitation (§7).

## 2. Artifact schema

`automation/src/artifact/schema.ts` (Zod) is the single source of truth; the TypeScript types
are inferred from it. Both committed artifacts are real instances;
`member.savings-balance.read` was frozen from the completed discovery run at
`evidence/20260824T000123Z-gke89c/`.

- **`schemaVersion`, `version`** — `store.ts` rejects an unrecognized `schemaVersion` on load;
  `version` distinguishes capability revisions. Evolvability without a database.
- **`target.{app,tenant,entryUrl}`, `surface.{kind,perception}`** — `tenant` is the extension
  point for multi-tenant reuse (§4); `surface` records which driver family produced the
  artifact, for a reviewer to check by eye. Nothing reads it at runtime yet — a mismatched-driver
  check would live here.
- **`inputs[]` / `outputs[]` with `sensitivity`** — the typed call contract. Per-field
  sensitivity drives redaction (§6), so redaction never depends on a field-name blocklist.
- **`steps[]`**, discriminated on `action`, each with `effect: "safe" | "irreversible"` —
  declares guardrail-relevant risk for a human reviewer, instead of re-deriving it from step
  semantics at runtime.
- **`target`** (`role`, `name`, `nameMatch`, `within`, `ordinal`, `fallbacks[]`) — a semantic
  descriptor in the role-plus-name vocabulary a desktop accessibility API also exposes (§4).
  Only the `css` fallback is surface-specific, and it is labelled as such.
- **`value: string | {"$input": name}`** — resolved by `artifact/binding.ts` against the run's
  parameters, which is what makes a step reusable across inputs.
- **`outcomes[]` with `type: "business_outcome" | "recoverable"`** — classification lives in
  the artifact, keeping `ReplayEngine` generic. A Zod `superRefine` enforces that
  `recoverable` carries a `recovery` policy and `business_outcome` carries none.
- **`checkpoint`, `provenance`, `approval.state`** — the success condition asserted at the end
  of every replay; the discovery run and evidence path, without the transcript; and an
  approval state, always `"draft"` today, which costs nothing and avoids a schema break if
  that stretch goal is picked up.

**Deviation from the plan: `namePattern` was never built.** The plan sketched a regex
`namePattern` on the target descriptor. Parameterized names such as `"View details for member
{memberId}"` are stored as `{placeholder}` strings and interpolated to an exact literal by
`binding.ts` before the driver sees them, so `TargetDescriptor` only needs
`nameMatch: "exact" | "contains"`. The only use of `"contains"` in either committed artifact
is `member.savings-balance.read`'s **checkpoint**, where `heading "Member"` contains-matches
the rendered `"Member 12345"` and `"Member 67890"`. The sub-account artifact uses `"exact"`
throughout.

**Disclosed simplification: one step is hand-authored.** `member.sub-account.open`'s final
step (`"Confirm and open sub-account"`, `effect: "irreversible"`) is written by
`artifactBuilder.ts` and appended after the discovered steps, which are turned into a
template. Discovery did not produce it, and could not: an unattended run is correctly blocked
by the guardrail on that exact button, so no real discovery log could contain a successful
click on it. Discovery ran only as far as the brief's own example goal, "reach the
confirmation screen." The appended step mirrors how the read capability's `outcomes[]` were
also hand-authored, for the same reason: a happy-path run never trips either. The discovery
run behind it (`evidence/20260824T031637Z-g46a6e/`) is real and unmodified.

## 3. Determinism & error handling

**The LLM never authors a locator.** Every discovery tool takes a system-assigned `ref`; a
selector is never part of the tool surface. After a successful action the system derives the
`TargetDescriptor` from the node that demonstrably worked, so every locator comes from an
element that actually resolved on the live page. `PlaywrightWebDriver.locate` tries three things
in order: the page-wide role-plus-name match at the recorded `ordinal`; then, if the descriptor
declares a `within` scope, the same match inside that scope, taking the first hit; then each
declared fallback in order. It stops at the first match.

**Outcomes are checked continuously.** `ReplayEngine.runReplay` checks `artifact.outcomes[]`
against the observation after **every** step, so a business or recoverable condition is
classified the moment it appears. The result is one of four shapes:

```ts
type ReplayResult =
  | { status: 'success'; outputs; runId; evidencePath }
  | { status: 'business_outcome'; outcomeId; detail; runId; evidencePath }
  | { status: 'escalated'; interventionId; reason; resolution: 'resumed' | 'abandoned' }
  | { status: 'failure'; error: { stepId; expected; observed; class: 'hard' | 'recoverable_exhausted' } };
```

A `recoverable` outcome retries its declared policy (`recovery.maxAttempts`,
`thenRestartFromStep`) through `act()`, so guardrails apply to the recovery click too. Once
attempts are exhausted it becomes a `failure` with class `recoverable_exhausted`, distinct
from `hard`. Anything unclassified is a `hard` failure carrying `stepId`, `expected`, and
`observed`. The engine never proceeds silently past a condition it did not classify.

**The four-way proof, real evidence (post-cleanup):**

| Class | Run | Input | Result |
|---|---|---|---|
| Success | `20260824T004034Z-crmzb1` | `memberId=12345` | `success`, `$1,240.55` |
| Parameterization | `20260824T004042Z-4r527p` | `memberId=67890` | `success`, `$84,302.19` — same artifact, different real output |
| Business outcome | `20260824T004048Z-j3wtux` | `memberId=99999` | `business_outcome: member_not_found` |
| Recoverable | `20260824T004055Z-fbigz2` | `12345` + `?forceExpireSession=1` | `session_expired` → recovery clicks "Start a new session" → restarts `s1` → `success` |

**Disclosed gap.** The schema's `wait.until: "target-visible"` and `timeoutMs` fields exist,
but `ReplayEngine.ts` never reads them. Playwright's own locator auto-wait, bounded by
`policy.limits.actionTimeoutMs`, has covered every case so far, because Part A's UI is
synchronous. They stay in the schema as a documented, currently unused extension point for a
genuinely async surface.

## 4. Heterogeneity & multi-tenant

**The extension point is `SurfaceDriver.perceive` and `SurfaceDriver.resolve`.** Nothing above
it references Playwright, CSS, or the DOM, apart from the one explicitly labelled `css`
fallback. A **legacy-web driver** would swap `perceive()` for DOM heuristics (frame and
frameset walking, table-position addressing, visible-text proximity, label adjacency) and
`resolve()` for the matching resolution logic; an artifact recorded against the accessibility
driver keeps its shape, because `role`, `name`, `within`, and `ordinal` are surface-agnostic.
A **desktop driver** would swap in OS accessibility APIs (UIA, AX), where role and name are
native concepts. Only the web driver is built; the abstraction has one implementation behind
it.

**Multi-tenant reuse.** `target.tenant` (`"base"` today) is where a per-tenant override file
would layer on top of a base artifact: a tenant whose vendor product renders the same flow
with different copy needs only a different `target.name` for the same `role`, with no
re-recording of the flow. Drift is detected through `schemaVersion` and `version`, and
`store.ts` rejects outright any `schemaVersion` it does not understand. None of this
per-tenant infrastructure is built, per the brief's own instruction to design for it rather
than build it.

**The honest weakness.** Part A is a clean, semantic React app: every control is a real
`<button>`, every alert carries `role="alert"`. The accessibility-tree-first strategy has been
validated only against this best-case surface, and has **not been stress-tested** against a
genuinely legacy, non-semantic surface. The degradation path above is a credible design that
has not been demonstrated.

## 5. Escalation & handoff

**Two triggers reach the same mechanism** (`hitl/escalation.ts`), and behave differently by
design:

- **During replay**, a guardrail `require-intervention` surfaces from `act()` as
  `ActFailure.code === 'policy_intervention_required'`. `ReplayEngine` checks for this code
  explicitly and escalates immediately. Production replay must never proceed past an
  irreversible step unattended.
- **During discovery**, the same guardrail block is **not** auto-escalated. `dispatchTool`
  returns it as an ordinary failed tool result, which the model can retry or work around. Only
  an explicit, model-declared `stuck(reason)` routes into an intervention. Discovery is
  exploratory, so one blocked click should not necessarily end the run, while a
  model-recognized dead end should. Verified in `DiscoveryAgent.ts`'s `handleAction` and
  `handleStuck`.

**Control is a single-owner lease.** `ControlLease` holds one of `automation`, `human`, or
`paused`, and is checked before the guardrail check and before any page interaction. `paused`
is distinct from `human`: automation stops the instant it escalates, before an operator has
clicked "take control," so "automation cannot act" holds for the whole window. Only
`automation → {paused, human}` and `paused → human` are legal acquisitions, and only
`release()` returns control to `automation`.

**The handoff mechanism is the already-open, headed browser window.** No co-browsing
infrastructure was built. `driver.liveOperatorPage` is an explicit escape hatch, used only by
`automation/scripts/demo-replay-intervention.ts`, which stands in for a human operator: it
calls the real `/api/take-control` and `/api/hand-back` endpoints and clicks the live page
directly. That path never goes through `act()`, which would refuse it while the lease is held
by `human`. On hand-back,
`escalation.ts` writes a before/after accessibility-snapshot diff, screenshots, and the
operator's note to evidence.

Both triggers are demoed with real evidence. `20260824T031952Z-0dpfqy`: a risky-action
intervention on the sub-account confirm step — take control, real click, hand back with a
note, run resumed. `20260824T032209Z-tgj1rm`: an unsatisfiable discovery goal — the model
calls `stuck`, the operator abandons, and the run returns `escalated` / `abandoned`.

**Correction against the plan.** The plan describes re-verifying the checkpoint explicitly on
hand-back. The engine re-perceives the page for the diff, but has no bespoke "re-verify now"
step. It relies on whatever check runs next anyway: the following step's `resolve()`, or the
final checkpoint if the intervention was on the last step, which it is for the capability that
exercises this path.

**The standalone `operator` command has no live run attached.** Every real `discover` or
`replay` invocation starts its own embedded operator server, sharing that run's own lease and
interventions.

## 6. Safety

**Allowlist** (`automation/config/policy.example.json`): allowed origins, route regex
patterns, and allowed action types. `checkAction` is pure and runs first inside `act()`.
Off-allowlist navigation or an unlisted action type is `block`ed outright and never retried.

**Risk classification** is config-driven: `riskyActionTypes`, `riskyTargetNamePatterns` (regex
against the resolved accessible name, for example `^confirm\b`), and a `defaultRisk`. A match
returns `require-intervention`, not `block`. The distinction matters: a blocked action is a
policy violation that should never be retried, while an intervention-required action is
legitimate work that only a human may authorize. The artifact's `effect` field mirrors this at
the schema level (§2).

**Conservative default, justified by asymmetry.** Blocking a safe action costs one human
confirmation click. Permitting an irreversible one in a regulated financial system risks an
account opened or money moved with no UI-level undo. The only escape hatch is an explicit,
per-run, human-granted hand-back. No config flag silently disables the check.

**Redaction happens at the persistence boundary, not the call boundary.** `EvidenceRecorder`
masks two things by declared sensitivity: the `value` on a `fill`/`select` step (sensitivity
from `artifact.inputs[]`) and the `extracted` value on an extract step (from
`artifact.outputs[]`, defaulting to `sensitive`). The in-process return value stays unmasked,
because an agent invoking this capability legitimately needs the real balance.

Everything else persisted gets less. Accessibility snapshots and the operator's hand-back note
pass only through a static sweep for SSN-, bearer-token-, and card-number-shaped strings, which
nothing Part A renders ever matches — so a displayed balance sits in snapshot text in the clear.
The step `reason`, the run `goal`, the recorded page `url`, the `code` and `message` on a failed
step, the run's `outcome.detail`, the hand-back diff, and the saved artifact are not redacted at
all. `outcome.detail` is assembled in `cli.ts` from the matched outcome's own text, the
escalation reason, or the failure's `expected` and `observed` strings, so that text reaches the
run log verbatim: `evidence/20260824T004048Z-j3wtux/run.json` records "No member found for ID
99999." Wiring declared sensitivity through to snapshot text is unfinished.

**The run log overstates its own redaction.** `EvidenceRecorder.finish` writes a hardcoded
`redaction.appliedTo` array that lists "persisted accessibility snapshots," the same claim the
paragraph above retracts, and a `classifiedValueCount` that is `0` in every run because
`classify()` has no production caller. All eight committed runs carry that wording. The
paragraph above is the accurate account; the field was left as recorded rather than rewritten
after the fact.

**Screenshots are not redacted, only text and logs are.** A screenshot can show a balance in
the clear. Pixel-level redaction was judged disproportionate for this exercise.

## 7. Cuts

- **No stretch goal (§8) was attempted.** Time went into making the required vertical slice
  (§3.1–§3.6, plus a design answer for §3.7) real and correct. Next would be the
  **agent-facing capability catalog**: the artifacts are already typed, callable contracts, so
  the work is exposing the existing `artifacts/` store as a name-addressable, invokable one.
- **No `Orchestrator.ts`** (§1) — four linear CLI commands never needed a shared
  mode-switching abstraction.
- **`wait.until` and `timeoutMs` are schema-only, unread by the engine** (§3) — kept as a
  documented extension point for a surface that would actually need them.
- **Keystroke-level capture of a human handoff** was cut for the before/after
  accessibility-snapshot diff, screenshots, and an operator note: a large build for marginal
  evidentiary value, when the diff already answers "what changed, and did the run resume from
  a valid state."
- **A real-time co-browsing operator console** was cut for the headed-browser handoff (§5).
  The brief explicitly allows this, and it avoids building streaming and remote-input
  infrastructure.
- **No desktop driver and no real multi-tenant infrastructure** — out of scope per the brief.
  §4 gives the design answer and names the one untested weakness.
- **Pixel-level screenshot redaction** — disclosed in §6.
- **Declared sensitivity does not reach snapshot text** (§6) — accessibility snapshots and the
  hand-back note fall back to a static pattern sweep instead, and nothing Part A renders matches
  those patterns.
- **LLM-in-replay ("assisted fallback")** was never built and is structurally unreachable:
  `ReplayEngine.ts` has no Anthropic SDK import in scope, so the shortcut brief §3.3 forbids
  cannot be reached.
