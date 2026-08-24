import type { ArtifactOutcome } from '../artifact/schema.ts';
import type { Observation, ObservationNode } from '../surface/SurfaceDriver.ts';

export interface OutcomeMatch {
  readonly outcome: ArtifactOutcome;
  /** The actual rendered text that matched, for the run's evidence — not just the declared substring. */
  readonly detail: string;
}

/**
 * Matches an observation against an artifact's declared `outcomes[]`, in declaration
 * order, returning the first hit or `null`. Pure and side-effect free: the engine
 * calls this after every step so a business/recoverable condition is caught the
 * moment it appears, never inferred after the fact from a downstream failure.
 */
export function matchOutcome(
  observation: Observation,
  outcomes: readonly ArtifactOutcome[],
): OutcomeMatch | null {
  for (const outcome of outcomes) {
    const detail = firstMatchingText(observation.nodes, outcome);
    if (detail !== null) {
      return { outcome, detail };
    }
  }
  return null;
}

/**
 * `textMatches` is checked as substring containment against the *aggregated* text of
 * a candidate node and its descendants, not just the node's own `text` field: Part
 * A's "Session expired" alert carries no text of its own — the message lives on a
 * nested `<h2>` — while "No member found for ID ..." is the alert's own rendered
 * text. Aggregating handles both shapes without the artifact needing to know which
 * one applies.
 */
function firstMatchingText(nodes: readonly ObservationNode[], outcome: ArtifactOutcome): string | null {
  for (const node of nodes) {
    if (node.role === outcome.when.role) {
      const aggregated = aggregateText(node);
      if (aggregated.includes(outcome.when.textMatches)) {
        return aggregated;
      }
    }
    const fromChildren = firstMatchingText(node.children, outcome);
    if (fromChildren !== null) {
      return fromChildren;
    }
  }
  return null;
}

function aggregateText(node: ObservationNode): string {
  const parts = [node.name, node.text ?? '', ...node.children.map(aggregateText)];
  return parts.filter((part) => part !== '').join(' ');
}
