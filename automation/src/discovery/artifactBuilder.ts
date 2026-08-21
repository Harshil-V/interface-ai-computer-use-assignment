import type { Action, TargetDescriptor } from '../surface/SurfaceDriver.ts';
import type { DiscoveryOutcome, DiscoveryStopReason, GroundedAction } from './DiscoveryAgent.ts';

/**
 * One step of the rough discovery artifact. Deliberately not the frozen schema —
 * Milestone 5 decides that shape once it can see what a real run actually produces.
 * This exists to let a human (and Milestone 5) look at that output honestly.
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
