import type { Observation, ObservationNode } from '../surface/SurfaceDriver.ts';

/** A node reduced to what matters for a before/after comparison — not its ref, which is not stable across observations. */
export interface FlatNode {
  readonly role: string;
  readonly name: string;
  readonly text: string;
}

export interface ObservationDiff {
  readonly beforeUrl: string;
  readonly afterUrl: string;
  readonly urlChanged: boolean;
  /** Nodes present after hand-back that were not present before. */
  readonly added: readonly FlatNode[];
  /** Nodes present before hand-back that are gone after. */
  readonly removed: readonly FlatNode[];
}

const KEY_SEPARATOR = '\u0000';

/**
 * Pure before/after comparison of two accessibility observations, so an operator's
 * hand-back evidence answers "what did the human actually change" without needing a
 * full DOM/pixel diff. Refs are deliberately excluded from the comparison key: they
 * are assigned per-observation and carry no identity across two separate `perceive()`
 * calls, so comparing them would report spurious churn on every single node.
 */
export function diffObservations(before: Observation, after: Observation): ObservationDiff {
  const beforeNodes = flatten(before.nodes);
  const afterNodes = flatten(after.nodes);
  const beforeKeys = new Set(beforeNodes.map(keyOf));
  const afterKeys = new Set(afterNodes.map(keyOf));

  return {
    beforeUrl: before.url,
    afterUrl: after.url,
    urlChanged: before.url !== after.url,
    added: dedupeByKey(afterNodes.filter((node) => !beforeKeys.has(keyOf(node)))),
    removed: dedupeByKey(beforeNodes.filter((node) => !afterKeys.has(keyOf(node)))),
  };
}

function flatten(nodes: readonly ObservationNode[]): FlatNode[] {
  return nodes.flatMap((node) => [
    { role: node.role, name: node.name, text: node.text ?? '' },
    ...flatten(node.children),
  ]);
}

function keyOf(node: FlatNode): string {
  return `${node.role}${KEY_SEPARATOR}${node.name}${KEY_SEPARATOR}${node.text}`;
}

function dedupeByKey(nodes: readonly FlatNode[]): FlatNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    const key = keyOf(node);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
