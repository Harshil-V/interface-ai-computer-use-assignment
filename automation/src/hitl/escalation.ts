import type { EvidenceRecorder } from '../evidence/EvidenceRecorder.ts';
import type { Observation, SurfaceDriver } from '../surface/SurfaceDriver.ts';
import { ControlLease } from './ControlLease.ts';
import { InterventionStore, type InterventionResolution, type InterventionTrigger } from './interventions.ts';
import { diffObservations } from './snapshotDiff.ts';

export interface EscalationContext {
  readonly runId: string;
  readonly capabilityId: string;
  readonly goal: string;
  readonly stepId: string;
  readonly trigger: InterventionTrigger;
  readonly stopReason: string;
}

export interface EscalationDeps {
  readonly driver: SurfaceDriver;
  readonly recorder: EvidenceRecorder;
  readonly lease: ControlLease;
  readonly interventions: InterventionStore;
}

export interface EscalationOutcome {
  readonly interventionId: string;
  readonly resolution: InterventionResolution;
  readonly note: string;
  readonly afterObservation: Observation;
}

/**
 * Pauses automation, raises an intervention, and blocks — in-process, via a promise,
 * never by polling a shared file or requiring a second process — until an operator
 * hands control back. Generic across replay and discovery: neither an artifact
 * checkpoint nor an LLM concept lives here. What "resumed" should mean for the
 * caller's own mode (re-verifying a checkpoint, continuing a loop, ...) is the
 * caller's job; this function only owns the pause/hand-back mechanism and the
 * before/after evidence it produces.
 *
 * No LLM import anywhere in this module or elsewhere under `hitl/` — discovery's
 * `stuck` trigger reaches this function through `DiscoveryAgent.ts`, not the other
 * way around.
 */
export async function raiseInterventionAndAwaitHandBack(
  context: EscalationContext,
  deps: EscalationDeps,
): Promise<EscalationOutcome> {
  const { driver, recorder, lease, interventions } = deps;

  const beforeObservation = await driver.perceive();
  const beforeSnapshotPath = await recorder.writeObservation(
    beforeObservation,
    `intervention-${context.stepId}-before`,
  );

  const record = interventions.create({
    runId: context.runId,
    capabilityId: context.capabilityId,
    goal: context.goal,
    stepId: context.stepId,
    trigger: context.trigger,
    stopReason: context.stopReason,
    screenshotPath: beforeObservation.screenshotPath,
  });

  recorder.recordStep({
    type: 'intervention',
    reason: `Intervention "${record.interventionId}" raised at step "${context.stepId}" (${context.trigger}): ${context.stopReason}`,
    outcome: 'ok',
    snapshotPath: beforeSnapshotPath,
    ...(beforeObservation.screenshotPath === null ? {} : { screenshotPath: beforeObservation.screenshotPath }),
  });

  // Pausing here — rather than leaving the lease at `automation` until an operator
  // calls take-control — is what makes "automation cannot act" true for the whole
  // window between the stop and the human actually picking it up, not just after.
  lease.acquire('paused');

  const { resolution, note } = await interventions.awaitResolution(record.interventionId);

  const afterObservation = await driver.perceive();
  const afterSnapshotPath = await recorder.writeObservation(
    afterObservation,
    `intervention-${context.stepId}-after`,
  );
  const diff = diffObservations(beforeObservation, afterObservation);
  const diffPath = await recorder.writeJson(diff, `intervention-${context.stepId}-diff`);

  recorder.recordStep({
    type: 'intervention',
    reason:
      `Intervention "${record.interventionId}" resolved (${resolution}). ` +
      `${diff.added.length} node(s) added, ${diff.removed.length} removed` +
      `${diff.urlChanged ? `, url changed to "${diff.afterUrl}"` : ''}.`,
    outcome: 'ok',
    snapshotPath: afterSnapshotPath,
    operatorNote: note === '' ? '(no note provided)' : note,
    ...(afterObservation.screenshotPath === null ? {} : { screenshotPath: afterObservation.screenshotPath }),
  });
  recorder.recordStep({
    type: 'note',
    reason: `Before/after accessibility-snapshot diff for intervention "${record.interventionId}" written to evidence.`,
    outcome: 'ok',
    snapshotPath: diffPath,
  });

  return { interventionId: record.interventionId, resolution, note, afterObservation };
}
