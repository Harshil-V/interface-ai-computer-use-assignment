# Implementation Plan — Approval Gate on Unattended Replay

**Date:** 2026-08-24
**Repo:** `interface-ai-computer-use-assignment`
**Scope:** `automation/` (Part B), plus the two committed files under `artifacts/`.
**Stretch goal:** brief §8, "Confidence & approval: score artifacts by how reliably they replay, and
gate unattended replay on an approval state (draft → approved)."
**Predecessor plan:** [`2026-08-20-part-b-automation-system-plan.md`](2026-08-20-part-b-automation-system-plan.md)
**Authoritative requirements:** `Assignment A — Computer-Use Automation System.pdf` (repo root)

> **There is no separate PRD or design spec for this work.** It is one stretch goal on top of a
> complete vertical slice. The brief's §8 bullet is the requirement; this plan is the build order,
> the scope line, and the reasoning behind both.

---

## Goal

`replay` refuses to run an artifact whose `approval.state` is `"draft"`, unless the operator says
`--allow-draft` on that invocation. An `approve` subcommand promotes an artifact from `draft` to
`approved`. Discovery keeps producing drafts, so the sequence is: the model discovers, a human
approves, and only then can an AI agent invoke the capability unattended.

The precondition this adds is deliberately narrow. It does not change how a replay *runs*, only
whether it may *start*.

---

## Scope: the gate half only, not the scoring half

The §8 bullet has two halves. **This plan implements the approval gate and deliberately does not
implement reliability scoring.**

Replay here is deterministic against a stable local mock app with a synchronous UI. A score computed
from repeated replays of that surface would be structurally 1.0 for every artifact that works at all,
and would move only when Playwright timing noise made a run flake. That is a number that looks like
signal and is not one: it would measure this machine's scheduling jitter, not the capability's
reliability. Publishing it would be exactly the kind of claim the rest of this repo's documentation
has been pruned to avoid.

Approval, by contrast, is a human sign-off, and it does not need a synthetic surface to be
meaningful. It is also closer to how the real domain works: you do not get to open member accounts
unattended because a script went green N times, someone reviews the capability and signs for it.

**The omission is disclosed, not hidden.** `REPORT.md` §7 must state which half was built and why the
other was not. Shipping a gate under a "Confidence & approval" heading without saying the scoring
half is absent would be an overclaim.

---

## Design decisions

### A. The gate is a precondition, not a replay outcome

`ReplayResult` (`automation/src/replay/result.ts`) has exactly four members: `success`,
`business_outcome`, `escalated`, `failure`. **No fifth member is added.** `README.md` says "one of
four outcomes" and `REPORT.md` §3 tabulates four classes; both stay true.

A refused replay is not a way a replay ends — it is a run that never began, in the same category as
"you did not supply a required input." Modelling it as a result status would put a non-execution into
a union whose whole purpose is to describe what happened on the page.

### B. The gate lives in the CLI, not the engine

The check goes in `runReplayCommand` in `automation/src/cli.ts`, after `loadArtifact` and before
`loadConfig`, alongside the existing missing-required-input check. That check is the same shape of
failure — a precondition the caller can fix — so it gets the same treatment: a message on stderr and
a non-zero exit.

Putting it in `ReplayEngine` would mean the engine has an opinion about who is allowed to invoke it,
which is an authorization concern, not an execution concern.

**The cost of that placement, which must be disclosed in `REPORT.md` §6:** the gate is weaker than
the guardrail check, which lives inside `act()` specifically so no caller can bypass it. An
in-process caller of `runReplay` is not gated — and two committed scripts,
`scripts/demo-replay-intervention.ts` and `scripts/demo-replay-recovery.ts`, are exactly that
caller. This is also what keeps the intervention demo working on the draft sub-account artifact, so
it needs saying in `README.md` too, or a reader hits an apparent contradiction between the refusal
in the approval section and the demo script that replays the same artifact.

A root `npm run approve` pass-through script is added alongside the existing `snapshot`/`discover`/
`replay`/`operator` ones, so the documented command form matches every other subcommand.

### C. Default-deny, with one explicit per-run escape hatch

`replay` requires `approval.state === 'approved'`. The only override is `--allow-draft`, typed on the
command line for that one invocation.

This mirrors the guardrail posture `REPORT.md` §6 already argues for: the escape hatch from a
conservative default is an explicit, per-run, human action, and no config flag silently disables the
check. **No policy-file option for this.** A config key would make the gate ambient and invisible,
which is the failure mode the flag exists to prevent.

### D. A refusal writes no evidence directory

Because the gate runs before `createRecorder`, a refused replay produces no `evidence/<runId>/`. An
evidence folder recording that nothing happened is worse than no folder: it pollutes the run history
with non-runs. The refusal is demonstrated by its terminal output, quoted in `README.md`.

### E. Promotion is a new `approve` subcommand

`approve --artifact <path-or-id>` loads the artifact, sets `approval.state` to `approved`, and
re-saves through the existing `saveArtifact`, which already re-validates against the schema on write.
Enforcement comes for free from the store's existing invariant rather than a second validation path.

### F. The two committed artifacts get different states, on purpose

- `artifacts/member.savings-balance.read.v1.json` → `"approved"`
- `artifacts/member.sub-account.open.v1.json` → stays `"draft"`

Justified by risk, not convenience. The savings-balance capability is read-only and idempotent:
replaying it a thousand times changes nothing. The sub-account capability opens a real account, has
no UI-level undo, and already trips the `^confirm\b` risky-name pattern in
`automation/config/policy.example.json` into a human intervention mid-run.

So after this change the irreversible capability has **two independent human controls** — approval at
invocation time and a guardrail intervention at step time — and the safe one has neither. That
asymmetry is the point of the feature; a gate that says yes to everything demonstrates nothing.

It also keeps every `npm run replay` command already in `README.md` working verbatim, since all of
them target the savings-balance capability.

---

## Milestones

### Milestone 1 — Schema

`automation/src/artifact/schema.ts`: widen `approval.state` from `z.enum(['draft'])` to
`z.enum(['draft', 'approved'])`. Replace the comment that anticipated this stretch goal with one that
says what the two states now mean.

`store.ts` needs no change: it validates through this same schema on both read and write, so
widening the enum is the whole of the persistence change.

**Tests** (`schema.test.ts`): `"approved"` validates; `"draft"` still validates; an unknown state is
rejected.

### Milestone 2 — The gate function

New module `automation/src/artifact/approval.ts`. One pure function taking the approval state and
whether draft was explicitly allowed, returning a permit/refuse decision that carries a reason
string.

Modelled on `checkAction` in `automation/src/guardrails/policy.ts` — same discriminated-decision
convention, same purity, same "the caller owns enforcement, this function owns the rule" split. No
new decision vocabulary invented for one call site.

**Tests** (`approval.test.ts`): all four combinations of (`draft` | `approved`) × (`--allow-draft` on
| off). Approved permits either way; draft refuses without the flag and permits with it, and the
permit reason distinguishes the two permit paths.

### Milestone 3 — CLI wiring

`automation/src/cli.ts`:

1. `allow-draft` added to the `options` block and the `CliValues` type.
2. The gate called in `runReplayCommand` per decision B. Refusal message names both remedies:
   `approve` the artifact, or pass `--allow-draft`.
3. `COMMAND_APPROVE` constant, `runApproveCommand`, wired into `main()`.
4. `USAGE` extended for the new command and the new flag, in the existing voice.

### Milestone 4 — Discovery keeps producing drafts

Verify, do not change: `buildDraftArtifact` and both frozen-capability builders in
`automation/src/discovery/artifactBuilder.ts` emit `approval: { state: 'draft' }`. That is the
correct semantic — discovery cannot approve its own output — and it is what makes the draft state
load-bearing rather than decorative.

### Milestone 5 — Artifact files

Apply decision F. Check first whether any test asserts on `approval` or `'draft'`; both existing
references are fixtures that stay valid under a widened enum.

### Milestone 6 — Evidence and documentation

1. One real replay evidence run of the now-approved capability, proving the gate permits and the
   happy path is intact. Replay needs no `ANTHROPIC_API_KEY`.
2. Capture the real refusal terminal output for the README. No evidence run for it, per decision D.
3. `README.md`: the `approve` command, the `--allow-draft` flag, the captured refusal, and the
   draft/approved asymmetry. No restructuring of existing sections.
4. `REPORT.md` §7 first bullet currently opens "No stretch goal (§8) was attempted." That becomes
   false and must be rewritten: which goal, which half, and why the other half was skipped.
5. `REPORT.md` §2 currently defends `approval.state` as a field nothing reads. It is now read; that
   passage has to change.
6. `REPORT.md` §6: the gate is a second human control on the irreversible capability. Tie it to the
   existing conservative-default argument only if it reads naturally.

---

## Test strategy

Same split the predecessor plan established: **test-first on pure logic, demo path for integration.**

| Layer | How it is verified |
|---|---|
| Widened enum | `schema.test.ts` — accepts both states, rejects an unknown one |
| Gate decision | `approval.test.ts` — all four state × flag combinations |
| `approve` round-trip | `store.test.ts` — a flipped state saves and reloads as `approved` |
| CLI wiring | The demo path: a real refusal on the draft artifact, a real successful replay on the approved one |

`cli.ts` is not unit tested, consistent with the rest of the repo — it is argument parsing and
process wiring, exercised by running it.

**Regression bar: 202 tests (24 `mock-console` + 178 `automation`) and a clean `tsc -b` before this
work starts.** Neither may regress. `oxlint` is clean in both workspaces and stays clean.

---

## Ordered task list

1. Write this plan.
2. Widen the enum; update its comment.
3. Add `schema.test.ts` cases for both states and an unknown one.
4. Write `approval.test.ts` for the four combinations, then `approval.ts` to satisfy it.
5. Wire the gate, the flag, the `approve` command, and `USAGE` into `cli.ts`.
6. Verify `artifactBuilder.ts` still emits drafts.
7. Flip `member.savings-balance.read.v1.json` to `approved`; leave the sub-account artifact `draft`.
8. Add the `approve` round-trip test to `store.test.ts`.
9. Run the refusal against the sub-account artifact; capture the terminal output verbatim.
10. Run one real replay of the approved capability against the live mock console.
11. Update `README.md` and `REPORT.md` §2, §6, §7.
12. `npm run typecheck`, `npm test`, `oxlint` in both workspaces; re-read every new documentation
    sentence against the source.

---

## Risks

| Risk | Mitigation |
|---|---|
| **A fifth `ReplayResult` member creeps in**, falsifying "one of four outcomes" in `README.md` and the four-row table in `REPORT.md` §3. | Decision A. The gate returns its own decision type from its own module and never touches `replay/result.ts`. |
| **Documentation outruns the code** — the exact failure mode this repo's recent history has been correcting. | Every new sentence is checked against the source before it ships. The scoring half is named as absent in `REPORT.md` §7 rather than left for a reader to notice. |
| **Approving both artifacts** would make the gate a formality that never refuses anything. | Decision F, justified by irreversibility rather than by what is convenient to demo. |
| **A README command breaks.** | Decision F approves exactly the capability every documented `replay` command targets. Verified by re-running them. |

---

## Deliberately not in scope

- **Reliability scoring** — reasoned above, and disclosed in `REPORT.md` §7.
- **An `unapprove`/demotion command.** Nothing in the gate needs it, and `approval.state` is one
  field in a JSON file a reviewer can edit. Adding a command to write `"draft"` over `"approved"`
  would be surface area with no reader.
- **Approval identity, timestamps, or a signature.** Who approved a capability and when is real
  audit metadata in a production system, and it belongs in `approval` next to `state`. It is out of
  scope here because nothing in this repo would read it, and an unread field defended as
  future-proofing is the argument §2 is being rewritten to retire.
- **Gating `discover`.** Discovery produces drafts; there is nothing to approve yet.

---

## Cross-references

- Build order and frozen decisions for the system this extends:
  [`2026-08-20-part-b-automation-system-plan.md`](2026-08-20-part-b-automation-system-plan.md)
- Design write-up the documentation tasks above amend: [`../REPORT.md`](../REPORT.md)
- Demo path the gate must not break: [`../README.md`](../README.md)
