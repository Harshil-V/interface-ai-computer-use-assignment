import { artifactSchema, CURRENT_SCHEMA_VERSION, type Artifact, type ArtifactTargetDescriptor, type ArtifactValue } from '../artifact/schema.ts';
import type { Action, TargetDescriptor, TargetFallback } from '../surface/SurfaceDriver.ts';
import type { DiscoveryOutcome, DiscoveryStopReason, GroundedAction } from './DiscoveryAgent.ts';

/**
 * One step of the rough discovery artifact. Deliberately not the frozen schema —
 * this is a goal-agnostic, human-readable dump of exactly what a discovery run
 * produced, still useful as a debugging view before/alongside freezing a specific
 * capability's artifact via {@link buildMemberSavingsBalanceArtifact}.
 */
export interface DraftArtifactStep {
  readonly stepNumber: number;
  readonly action: Action;
  readonly target?: TargetDescriptor;
  /** Present only for `extract`: the output name the model chose. */
  readonly extractedAs?: string;
}

export interface DraftArtifact {
  readonly goal: string;
  readonly model: string;
  readonly discoveredAt: string;
  readonly discoveryRunId: string;
  readonly stopReason: DiscoveryStopReason;
  readonly summary?: string;
  readonly stuckReason?: string;
  readonly steps: readonly DraftArtifactStep[];
  readonly outputs: Readonly<Record<string, string>>;
}

export interface DraftArtifactMeta {
  readonly goal: string;
  readonly model: string;
  readonly discoveryRunId: string;
  /** Injectable for tests; defaults to now. */
  readonly discoveredAt?: string;
}

/**
 * Maps a discovery run's grounded action log onto the rough artifact shape. Pure and
 * side-effect free (beyond the default clock read), so it is test-first per this
 * repo's convention for the one piece of logic in this milestone that isn't glue.
 */
export function buildDraftArtifact(outcome: DiscoveryOutcome, meta: DraftArtifactMeta): DraftArtifact {
  return {
    goal: meta.goal,
    model: meta.model,
    discoveredAt: meta.discoveredAt ?? new Date().toISOString(),
    discoveryRunId: meta.discoveryRunId,
    stopReason: outcome.stopReason,
    ...(outcome.summary === undefined ? {} : { summary: outcome.summary }),
    ...(outcome.stuckReason === undefined ? {} : { stuckReason: outcome.stuckReason }),
    steps: outcome.groundedActions.map(toDraftStep),
    outputs: outcome.outputs,
  };
}

function toDraftStep(action: GroundedAction): DraftArtifactStep {
  return {
    stepNumber: action.step,
    action: action.action,
    ...(action.target === undefined ? {} : { target: action.target }),
    ...(action.extractedAs === undefined ? {} : { extractedAs: action.extractedAs }),
  };
}

/* ---------------------------------------------------------------------------------- *
 * Frozen capability artifact: member.savings-balance.read
 *
 * A real discovery run bakes one concrete memberId into a fill value and into target
 * names ("View details for member 12345"). Freezing means detecting that literal in
 * step values/target names and templatizing it into `{memberId}` placeholders /
 * `{ "$input": "memberId" }` value objects, so the saved artifact is a reusable
 * capability rather than a transcript of this one run.
 * ---------------------------------------------------------------------------------- */

const CAPABILITY_ID = 'member.savings-balance.read';
const CAPABILITY_VERSION = 1;
const ENTRY_URL = 'http://localhost:5173/';
const MEMBER_ID_INPUT = 'memberId';
const SAVINGS_BALANCE_OUTPUT = 'savingsBalance';
const MEMBER_ID_TEXTBOX_NAME = 'Member ID';

const CHECKPOINT: Artifact['checkpoint'] = {
  assert: 'visible',
  // A namePattern/regex mode on TargetDescriptor would be a new resolution concept just
  // for this one check; "starts with Member" via nameMatch: 'contains' says the same
  // thing without touching SurfaceDriver at all.
  target: { role: 'heading', name: 'Member', nameMatch: 'contains', ordinal: 0, fallbacks: [] },
};

/**
 * Hand-authored: a real discovery run never hits these alert states (they're the
 * exception paths, not the happy path it was asked to demonstrate), so there is no
 * grounded log to derive them from. Strings are Part A's exact copy — see
 * `mock-console/src/domain/memberLookup.ts` and the session-expired dialog markup.
 */
const OUTCOMES: Artifact['outcomes'] = [
  {
    id: 'member_not_found',
    type: 'business_outcome',
    terminal: true,
    when: { role: 'alert', textMatches: 'No member found for ID' },
  },
  {
    id: 'validation_error',
    type: 'business_outcome',
    terminal: true,
    when: { role: 'alert', textMatches: 'Member ID is required' },
  },
  {
    id: 'session_expired',
    type: 'recoverable',
    when: { role: 'alert', textMatches: 'Session expired' },
    recovery: {
      action: 'click',
      target: { role: 'button', name: 'Start a new session', nameMatch: 'exact', ordinal: 0, fallbacks: [] },
      thenRestartFromStep: 's1',
      maxAttempts: 1,
    },
  },
];

export interface FrozenArtifactMeta {
  readonly discoveryRunId: string;
  readonly evidencePath: string;
  readonly model: string;
  /** Injectable for tests; defaults to now. */
  readonly discoveredAt?: string;
}

/** One declared input whose literal run-time value gets folded back into a `{name}` placeholder. */
interface TemplateInput {
  readonly name: string;
  readonly value: string;
}

/**
 * Turns one real, single-memberId discovery run into the reusable, parameterized
 * `member.savings-balance.read` capability. Throws if the grounded log doesn't contain
 * the steps this capability needs (a fill on "Member ID" and an extract) — a discovery
 * run against an unrelated goal must not silently freeze into a wrong capability.
 */
export function buildMemberSavingsBalanceArtifact(
  outcome: DiscoveryOutcome,
  meta: FrozenArtifactMeta,
): Artifact {
  const memberId = findInputValue(outcome.groundedActions, MEMBER_ID_TEXTBOX_NAME, 'fill');
  const inputs: readonly TemplateInput[] = [{ name: MEMBER_ID_INPUT, value: memberId }];

  const steps = outcome.groundedActions.map((grounded, index) => templatizeStep(grounded, inputs, index));
  if (!steps.some((step) => step.action === 'extract')) {
    throw new Error('Grounded action log has no "extract" step; cannot freeze a read capability without one.');
  }

  const artifact: Artifact = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: CAPABILITY_ID,
    version: CAPABILITY_VERSION,
    title: 'Read member savings balance',
    target: { app: 'core-banking-console', tenant: 'base', entryUrl: ENTRY_URL },
    surface: { kind: 'web', perception: 'accessibility-tree' },
    inputs: [
      { name: MEMBER_ID_INPUT, type: 'string', required: true, example: memberId, sensitivity: 'quasi-identifier' },
    ],
    outputs: [{ name: SAVINGS_BALANCE_OUTPUT, type: 'currency', sensitivity: 'sensitive' }],
    steps,
    checkpoint: CHECKPOINT,
    outcomes: OUTCOMES,
    provenance: {
      discoveredAt: meta.discoveredAt ?? new Date().toISOString(),
      model: meta.model,
      discoveryRunId: meta.discoveryRunId,
      evidencePath: meta.evidencePath,
    },
    approval: { state: 'draft' },
  };

  // Validates what was just built, on top of the type system, so a bug in the
  // templatizing above fails loudly here rather than reaching disk via store.ts.
  return artifactSchema.parse(artifact);
}

/** Shared by every frozen capability: pulls the one real value a discovery run entered into a named control. */
function findInputValue(
  groundedActions: readonly GroundedAction[],
  controlName: string,
  actionKind: 'fill' | 'select',
): string {
  const step = groundedActions.find(
    (grounded) => grounded.action.kind === actionKind && grounded.target?.name === controlName,
  );
  if (step === undefined || step.action.kind !== actionKind) {
    throw new Error(`Grounded action log has no "${actionKind}" on a control named "${controlName}".`);
  }
  return step.action.value;
}

/* ---------------------------------------------------------------------------------- *
 * Frozen capability artifact: member.sub-account.open
 *
 * Shares every templatizing helper below with the read capability — the underlying
 * "replace this run's literal values with placeholders" logic is identical regardless
 * of which capability is being frozen, so only the capability-specific shape (inputs,
 * outputs, checkpoint, outcomes, and the one hand-authored irreversible step) differs.
 * ---------------------------------------------------------------------------------- */

const SUB_ACCOUNT_CAPABILITY_ID = 'member.sub-account.open';
const SUB_ACCOUNT_CAPABILITY_VERSION = 1;
const ACCOUNT_TYPE_COMBOBOX_NAME = 'Account type';
const INITIAL_DEPOSIT_TEXTBOX_NAME = 'Initial deposit amount (USD)';
const NICKNAME_TEXTBOX_NAME = 'Nickname';
const ACCOUNT_TYPE_INPUT = 'accountType';
const INITIAL_DEPOSIT_INPUT = 'initialDepositAmount';
const NICKNAME_INPUT = 'nickname';

/**
 * The confirmation button's own text is the irreversible action. Discovery is
 * guaranteed to stop before ever clicking it (the guardrail's `riskyTargetNamePatterns`
 * would require an intervention discovery has no human to hand off to yet), so this
 * exact ground-truth target — see `mock-console/src/components/SubAccountConfirmationScreen.tsx`
 * — is hand-authored onto the end of the frozen artifact, exactly mirroring how
 * `OUTCOMES` above was hand-authored for the read capability: it is real and correct,
 * simply not something a grounded discovery log could ever legitimately contain.
 */
const CONFIRM_SUB_ACCOUNT_STEP: Artifact['steps'][number] = {
  id: '__confirm__',
  action: 'click',
  effect: 'irreversible',
  target: { role: 'button', name: 'Confirm and open sub-account', nameMatch: 'exact', ordinal: 0, fallbacks: [] },
};

const SUB_ACCOUNT_CHECKPOINT: Artifact['checkpoint'] = {
  assert: 'visible',
  target: { role: 'heading', name: 'Sub-account created', nameMatch: 'exact', ordinal: 0, fallbacks: [] },
};

/**
 * Turns one real discovery run — stopped at the confirmation screen, per the
 * assignment brief's own example goal (§2) — into the reusable
 * `member.sub-account.open` capability, then appends the one step discovery could
 * never safely take itself. Throws if the grounded log doesn't contain a fill/select
 * on every field the open-sub-account form requires.
 */
export function buildSubAccountOpenArtifact(outcome: DiscoveryOutcome, meta: FrozenArtifactMeta): Artifact {
  const memberId = findInputValue(outcome.groundedActions, MEMBER_ID_TEXTBOX_NAME, 'fill');
  const accountType = findInputValue(outcome.groundedActions, ACCOUNT_TYPE_COMBOBOX_NAME, 'select');
  const initialDepositAmount = findInputValue(outcome.groundedActions, INITIAL_DEPOSIT_TEXTBOX_NAME, 'fill');
  const nickname = findInputValue(outcome.groundedActions, NICKNAME_TEXTBOX_NAME, 'fill');
  const inputs: readonly TemplateInput[] = [
    { name: MEMBER_ID_INPUT, value: memberId },
    { name: ACCOUNT_TYPE_INPUT, value: accountType },
    { name: INITIAL_DEPOSIT_INPUT, value: initialDepositAmount },
    { name: NICKNAME_INPUT, value: nickname },
  ];

  const discoveredSteps = outcome.groundedActions.map((grounded, index) => templatizeStep(grounded, inputs, index));
  const steps = [...discoveredSteps, { ...CONFIRM_SUB_ACCOUNT_STEP, id: `s${discoveredSteps.length + 1}` }];

  const artifact: Artifact = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: SUB_ACCOUNT_CAPABILITY_ID,
    version: SUB_ACCOUNT_CAPABILITY_VERSION,
    title: 'Open a sub-account for a member',
    target: { app: 'core-banking-console', tenant: 'base', entryUrl: ENTRY_URL },
    surface: { kind: 'web', perception: 'accessibility-tree' },
    inputs: [
      { name: MEMBER_ID_INPUT, type: 'string', required: true, example: memberId, sensitivity: 'quasi-identifier' },
      { name: ACCOUNT_TYPE_INPUT, type: 'string', required: true, example: accountType, sensitivity: 'low' },
      {
        name: INITIAL_DEPOSIT_INPUT,
        type: 'string',
        required: true,
        example: initialDepositAmount,
        sensitivity: 'sensitive',
      },
      { name: NICKNAME_INPUT, type: 'string', required: true, example: nickname, sensitivity: 'low' },
    ],
    outputs: [],
    steps,
    checkpoint: SUB_ACCOUNT_CHECKPOINT,
    outcomes: OUTCOMES,
    provenance: {
      discoveredAt: meta.discoveredAt ?? new Date().toISOString(),
      model: meta.model,
      discoveryRunId: meta.discoveryRunId,
      evidencePath: meta.evidencePath,
    },
    approval: { state: 'draft' },
  };

  return artifactSchema.parse(artifact);
}

function templatizeStep(
  grounded: GroundedAction,
  inputs: readonly TemplateInput[],
  index: number,
): Artifact['steps'][number] {
  const id = `s${index + 1}`;
  const effect = 'safe' as const;
  const { action } = grounded;

  if (action.kind === 'navigate') {
    return { id, action: 'navigate', effect, url: templatizeText(action.url, inputs) };
  }

  const { target } = grounded;
  if (target === undefined) {
    throw new Error(`Grounded action at step ${grounded.step} ("${action.kind}") has no target to freeze.`);
  }
  const templatedTarget = templatizeTarget(target, inputs);

  switch (action.kind) {
    case 'fill':
      return {
        id,
        action: 'fill',
        effect,
        target: templatedTarget,
        value: templatizeValue(action.value, inputs),
      };
    case 'select':
      return {
        id,
        action: 'select',
        effect,
        target: templatedTarget,
        value: templatizeValue(action.value, inputs),
      };
    case 'click':
      return { id, action: 'click', effect, target: templatedTarget };
    case 'extract': {
      if (grounded.extractedAs === undefined) {
        throw new Error(`Extract action at step ${grounded.step} has no declared output name ("as").`);
      }
      return { id, action: 'extract', effect, target: templatedTarget, into: grounded.extractedAs };
    }
  }
}

function templatizeTarget(target: TargetDescriptor, inputs: readonly TemplateInput[]): ArtifactTargetDescriptor {
  return {
    role: target.role,
    name: templatizeText(target.name, inputs),
    nameMatch: target.nameMatch,
    ordinal: target.ordinal,
    fallbacks: target.fallbacks.map((fallback) => templatizeFallback(fallback, inputs)),
    ...(target.within === undefined
      ? {}
      : { within: { role: target.within.role, name: templatizeText(target.within.name, inputs) } }),
  };
}

function templatizeFallback(fallback: TargetFallback, inputs: readonly TemplateInput[]): TargetFallback {
  return fallback.strategy === 'css' ? fallback : { ...fallback, value: templatizeText(fallback.value, inputs) };
}

/** An exact-match fill/select value becomes a reusable `$input` reference, not a templated string. */
function templatizeValue(value: string, inputs: readonly TemplateInput[]): ArtifactValue {
  const exact = inputs.find((input) => input.value !== '' && input.value === value);
  return exact === undefined ? templatizeText(value, inputs) : { $input: exact.name };
}

/** Replaces every literal occurrence of each input's run-time value with its `{name}` placeholder. */
function templatizeText(text: string, inputs: readonly TemplateInput[]): string {
  return inputs.reduce(
    (result, input) => (input.value === '' ? result : result.split(input.value).join(`{${input.name}}`)),
    text,
  );
}
