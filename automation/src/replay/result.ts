/**
 * The typed outcome of one replay run, per the plan's "Replay result contract".
 * `escalated` is produced by the HITL hand-back path: `ReplayEngine` returns it when the
 * operator abandons the intervention, while a resumed intervention continues the run to
 * one of the other three shapes.
 */

export interface ReplaySuccessResult {
  readonly status: 'success';
  readonly outputs: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly evidencePath: string;
}

export interface ReplayBusinessOutcomeResult {
  readonly status: 'business_outcome';
  readonly outcomeId: string;
  readonly detail: string;
  readonly runId: string;
  readonly evidencePath: string;
}

export type EscalationResolution = 'resumed' | 'abandoned';

export interface ReplayEscalatedResult {
  readonly status: 'escalated';
  readonly interventionId: string;
  readonly reason: string;
  readonly resolution: EscalationResolution;
}

export type ReplayFailureClass = 'hard' | 'recoverable_exhausted';

export interface ReplayFailureDetail {
  readonly stepId: string;
  readonly expected: string;
  readonly observed: string;
  readonly class: ReplayFailureClass;
}

export interface ReplayFailureResult {
  readonly status: 'failure';
  readonly error: ReplayFailureDetail;
}

export type ReplayResult =
  | ReplaySuccessResult
  | ReplayBusinessOutcomeResult
  | ReplayEscalatedResult
  | ReplayFailureResult;

export function successResult(
  outputs: Readonly<Record<string, unknown>>,
  runId: string,
  evidencePath: string,
): ReplaySuccessResult {
  return { status: 'success', outputs, runId, evidencePath };
}

export function businessOutcomeResult(
  outcomeId: string,
  detail: string,
  runId: string,
  evidencePath: string,
): ReplayBusinessOutcomeResult {
  return { status: 'business_outcome', outcomeId, detail, runId, evidencePath };
}

export function escalatedResult(
  interventionId: string,
  reason: string,
  resolution: EscalationResolution,
): ReplayEscalatedResult {
  return { status: 'escalated', interventionId, reason, resolution };
}

export function failureResult(error: ReplayFailureDetail): ReplayFailureResult {
  return { status: 'failure', error };
}
