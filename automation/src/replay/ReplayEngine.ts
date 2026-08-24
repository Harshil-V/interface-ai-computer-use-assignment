import { interpolate, resolveValue } from '../artifact/binding.ts';
import type {
  Artifact,
  ArtifactOutcome,
  ArtifactStep,
  ArtifactTargetDescriptor,
  ArtifactValue,
} from '../artifact/schema.ts';
import type { EvidenceRecorder } from '../evidence/EvidenceRecorder.ts';
import type { SensitivityClass } from '../guardrails/redaction.ts';
import type { ControlLease } from '../hitl/ControlLease.ts';
import { raiseInterventionAndAwaitHandBack } from '../hitl/escalation.ts';
import type { InterventionStore } from '../hitl/interventions.ts';
import type {
  Action,
  ActResult,
  SurfaceDriver,
  TargetDescriptor,
  TargetFallback,
} from '../surface/SurfaceDriver.ts';
import { matchOutcome } from './outcomes.ts';
import { businessOutcomeResult, escalatedResult, failureResult, successResult, type ReplayResult } from './result.ts';

export interface ReplayOptions {
  readonly artifact: Artifact;
  readonly params: Readonly<Record<string, string>>;
  readonly driver: SurfaceDriver;
  readonly recorder: EvidenceRecorder;
  readonly lease: ControlLease;
  readonly interventions: InterventionStore;
  /** Overrides `artifact.target.entryUrl` — the `session_expired` demo needs `?forceExpireSession=1`. */
  readonly entryUrl?: string;
}

/** One executed (or unresolved) step, carrying enough to both record evidence and classify a failure. */
interface StepAttempt {
  readonly action?: Action;
  readonly result: ActResult;
  readonly description: string;
}

/**
 * Deterministic step execution over a frozen capability artifact — no LLM involved
 * anywhere in this module (brief §3.3). Every page interaction goes through
 * `driver.act()`, so the guardrail check inside it always runs; this engine never
 * talks to Playwright or the DOM directly.
 *
 * Outcomes are checked after *every* step (success or failure), not only once at the
 * end, so a business/recoverable condition is classified the moment it appears
 * rather than surfacing later as a confusing downstream failure.
 */
export async function runReplay(options: ReplayOptions): Promise<ReplayResult> {
  const { artifact, params, driver, recorder, lease, interventions } = options;
  const entryUrl = options.entryUrl ?? artifact.target.entryUrl;
  const evidencePath = `evidence/${recorder.runId}/`;

  const navigation = await driver.act({ kind: 'navigate', url: entryUrl });
  recorder.recordStep({
    type: 'navigate',
    reason: `Open the entry URL for capability "${artifact.id}".`,
    action: { kind: 'navigate', url: entryUrl },
    outcome: navigation.ok ? 'ok' : 'failed',
    ...(navigation.failure === undefined ? {} : { failure: navigation.failure }),
    url: entryUrl,
  });
  if (!navigation.ok) {
    return failureResult({
      stepId: '(entry)',
      expected: `entry URL "${entryUrl}" to load`,
      observed: navigation.failure?.message ?? 'navigation failed with no further detail',
      class: 'hard',
    });
  }

  const outputs: Record<string, unknown> = {};
  const recoveryAttemptsUsed = new Map<string, number>();
  let stepIndex = 0;

  while (stepIndex < artifact.steps.length) {
    const step = artifact.steps[stepIndex]!;
    const attempt = await executeStep(step, params, artifact, driver);
    recordStepEvidence(recorder, step, attempt, artifact);

    if (attempt.result.failure?.code === 'policy_intervention_required') {
      const escalation = await raiseInterventionAndAwaitHandBack(
        {
          runId: recorder.runId,
          capabilityId: artifact.id,
          goal: artifact.title,
          stepId: step.id,
          trigger: 'guardrail',
          stopReason: attempt.result.failure.message,
        },
        { driver, recorder, lease, interventions },
      );

      if (escalation.resolution === 'abandoned') {
        return escalatedResult(escalation.interventionId, attempt.result.failure.message, 'abandoned');
      }

      // Deliberately no bespoke "re-verify now" check here: whatever the human did is
      // validated by the same machinery that would validate it anyway — the next
      // step's `driver.resolve()` if one follows, or the checkpoint check below if
      // this was the last step (which it is for the one capability that exercises
      // this path today). Duplicating that check here would be the same assertion
      // twice for no added confidence.
      stepIndex += 1;
      continue;
    }

    const observation = await driver.perceive();
    const snapshotPath = await recorder.writeObservation(observation, `step-${step.id}-perceive`);
    recorder.recordStep({
      type: 'perceive',
      reason: `Check for a matching declared outcome after step "${step.id}".`,
      outcome: 'ok',
      url: observation.url,
      snapshotPath,
      ...(observation.screenshotPath === null ? {} : { screenshotPath: observation.screenshotPath }),
    });

    const match = matchOutcome(observation, artifact.outcomes);
    if (match !== null) {
      recorder.recordStep({
        type: 'note',
        reason: `Matched declared outcome "${match.outcome.id}" (${match.outcome.type}) after step "${step.id}": ${match.detail}`,
        outcome: 'ok',
      });

      if (match.outcome.type === 'business_outcome') {
        return businessOutcomeResult(match.outcome.id, match.detail, recorder.runId, evidencePath);
      }

      const recovery = await runRecovery(match.outcome, step.id, params, driver, recorder, recoveryAttemptsUsed);
      if (recovery.status === 'exhausted') {
        return failureResult(recovery.error);
      }
      stepIndex = requireStepIndex(artifact.steps, recovery.restartFromStep);
      continue;
    }

    if (!attempt.result.ok) {
      return failureResult({
        stepId: step.id,
        expected: `${attempt.description} to succeed`,
        observed: attempt.result.failure?.message ?? `${step.action} failed with no further detail`,
        class: 'hard',
      });
    }

    if (step.action === 'extract' && attempt.result.extracted !== undefined) {
      outputs[step.into] = attempt.result.extracted;
    }

    stepIndex += 1;
  }

  const checkpointTarget = bindTargetDescriptor(artifact.checkpoint.target, params);
  const checkpointRef = await driver.resolve(checkpointTarget);
  if (checkpointRef === null) {
    return failureResult({
      stepId: artifact.steps.at(-1)?.id ?? '(checkpoint)',
      expected: `checkpoint ${describeTarget(checkpointTarget)} to be visible`,
      observed: 'checkpoint target not found on the current page',
      class: 'hard',
    });
  }

  return successResult(outputs, recorder.runId, evidencePath);
}

async function executeStep(
  step: ArtifactStep,
  params: Readonly<Record<string, string>>,
  artifact: Artifact,
  driver: SurfaceDriver,
): Promise<StepAttempt> {
  if (step.action === 'navigate') {
    const url = interpolate(step.url, params);
    const action: Action = { kind: 'navigate', url };
    return { action, result: await driver.act(action), description: `navigate to "${url}"` };
  }

  const target = bindTargetDescriptor(step.target, params);
  const description = `${step.action} on ${describeTarget(target)}`;
  const ref = await driver.resolve(target);
  if (ref === null) {
    return {
      result: {
        ok: false,
        kind: step.action,
        target,
        failure: {
          code: 'target_not_found',
          message: `Could not resolve ${describeTarget(target)} on the current page.`,
        },
        durationMs: 0,
      },
      description,
    };
  }

  const action = buildAction(step, ref.ref, params, artifact);
  return { action, result: await driver.act(action), description };
}

function buildAction(
  step: Exclude<ArtifactStep, { action: 'navigate' }>,
  ref: string,
  params: Readonly<Record<string, string>>,
  artifact: Artifact,
): Action {
  switch (step.action) {
    case 'click':
      return { kind: 'click', ref };
    case 'fill':
      return {
        kind: 'fill',
        ref,
        value: resolveValue(step.value, params),
        ...withSensitivity(sensitivityOfInputValue(step.value, artifact)),
      };
    case 'select':
      return {
        kind: 'select',
        ref,
        value: resolveValue(step.value, params),
        ...withSensitivity(sensitivityOfInputValue(step.value, artifact)),
      };
    case 'extract':
      return { kind: 'extract', ref };
  }
}

function sensitivityOfInputValue(value: ArtifactValue, artifact: Artifact): SensitivityClass | undefined {
  return typeof value === 'string' ? undefined : artifact.inputs.find((input) => input.name === value.$input)?.sensitivity;
}

function sensitivityOfOutput(outputName: string, artifact: Artifact): SensitivityClass | undefined {
  return artifact.outputs.find((output) => output.name === outputName)?.sensitivity;
}

function withSensitivity(sensitivity: SensitivityClass | undefined): { sensitivity?: SensitivityClass } {
  return sensitivity === undefined ? {} : { sensitivity };
}

function recordStepEvidence(
  recorder: EvidenceRecorder,
  step: ArtifactStep,
  attempt: StepAttempt,
  artifact: Artifact,
): void {
  const extractSensitivity = step.action === 'extract' ? sensitivityOfOutput(step.into, artifact) : undefined;

  recorder.recordStep({
    type: step.action === 'navigate' ? 'navigate' : 'act',
    reason: `Step "${step.id}": ${attempt.description}.`,
    ...(attempt.action === undefined ? {} : { action: attempt.action }),
    outcome: attempt.result.ok ? 'ok' : 'failed',
    ...(attempt.result.failure === undefined ? {} : { failure: attempt.result.failure }),
    ...(attempt.result.extracted === undefined ? {} : { extracted: attempt.result.extracted }),
    ...(extractSensitivity === undefined ? {} : { extractSensitivity }),
  });
}

type RecoveryOutcome =
  | { readonly status: 'recovered'; readonly restartFromStep: string }
  | { readonly status: 'exhausted'; readonly error: Parameters<typeof failureResult>[0] };

/**
 * Runs one recoverable outcome's declared policy: click its recovery target through
 * `act()` (so guardrails still apply to the recovery click itself), then hand back
 * the step id to restart from. `maxAttempts` is tracked per outcome id across the
 * whole run, so a `session_expired` that recurs after the single allowed attempt
 * yields `class: 'recoverable_exhausted'` rather than looping forever.
 */
async function runRecovery(
  outcome: ArtifactOutcome,
  detectedAtStepId: string,
  params: Readonly<Record<string, string>>,
  driver: SurfaceDriver,
  recorder: EvidenceRecorder,
  attemptsUsed: Map<string, number>,
): Promise<RecoveryOutcome> {
  const { recovery } = outcome;
  if (recovery === undefined) {
    // Unreachable given the schema's refinement (a "recoverable" outcome always
    // declares a recovery policy), but keeps this function total rather than `!`-asserting.
    return {
      status: 'exhausted',
      error: {
        stepId: detectedAtStepId,
        expected: `outcome "${outcome.id}" to declare a recovery policy`,
        observed: 'no recovery policy present on the matched outcome',
        class: 'hard',
      },
    };
  }

  const used = attemptsUsed.get(outcome.id) ?? 0;
  if (used >= recovery.maxAttempts) {
    return {
      status: 'exhausted',
      error: {
        stepId: detectedAtStepId,
        expected: `outcome "${outcome.id}" to be resolved within ${recovery.maxAttempts} recovery attempt(s)`,
        observed: `outcome "${outcome.id}" recurred after ${used} recovery attempt(s) already used`,
        class: 'recoverable_exhausted',
      },
    };
  }
  attemptsUsed.set(outcome.id, used + 1);

  const target = bindTargetDescriptor(recovery.target, params);
  const ref = await driver.resolve(target);
  if (ref === null) {
    return {
      status: 'exhausted',
      error: {
        stepId: detectedAtStepId,
        expected: `recovery target ${describeTarget(target)} for outcome "${outcome.id}" to be present`,
        observed: 'recovery target not found on the current page',
        class: 'hard',
      },
    };
  }

  const clickAction: Action = { kind: 'click', ref: ref.ref };
  const clickResult = await driver.act(clickAction);
  recorder.recordStep({
    type: 'act',
    reason: `Recovery for outcome "${outcome.id}": click ${describeTarget(target)}.`,
    action: clickAction,
    outcome: clickResult.ok ? 'ok' : 'failed',
    ...(clickResult.failure === undefined ? {} : { failure: clickResult.failure }),
  });

  if (!clickResult.ok) {
    return {
      status: 'exhausted',
      error: {
        stepId: detectedAtStepId,
        expected: `recovery click on ${describeTarget(target)} to succeed`,
        observed: clickResult.failure?.message ?? 'recovery click failed with no further detail',
        class: 'hard',
      },
    };
  }

  return { status: 'recovered', restartFromStep: recovery.thenRestartFromStep };
}

function requireStepIndex(steps: readonly ArtifactStep[], stepId: string): number {
  const index = steps.findIndex((step) => step.id === stepId);
  if (index === -1) {
    throw new Error(`Recovery policy references unknown step id "${stepId}".`);
  }
  return index;
}

/** Binds `{name}` placeholders in a step/checkpoint/recovery target's name(s) against the run's params. */
function bindTargetDescriptor(
  target: ArtifactTargetDescriptor,
  params: Readonly<Record<string, string>>,
): TargetDescriptor {
  return {
    role: target.role,
    name: interpolate(target.name, params),
    nameMatch: target.nameMatch,
    ordinal: target.ordinal,
    fallbacks: target.fallbacks.map((fallback) => bindFallback(fallback, params)),
    ...(target.within === undefined
      ? {}
      : { within: { role: target.within.role, name: interpolate(target.within.name, params) } }),
  };
}

function bindFallback(fallback: TargetFallback, params: Readonly<Record<string, string>>): TargetFallback {
  return fallback.strategy === 'css' ? fallback : { ...fallback, value: interpolate(fallback.value, params) };
}

function describeTarget(target: TargetDescriptor): string {
  const name = target.name === '' ? '(unnamed)' : `"${target.name}"`;
  return `${target.role} ${name}`;
}
