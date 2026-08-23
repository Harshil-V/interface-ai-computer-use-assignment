import type { RawAccessibilityNode } from './ariaYaml.ts';
import type {
  ObservationNode,
  TargetDescriptor,
  TargetFallback,
  TargetScope,
} from './SurfaceDriver.ts';

/** Controls a user can operate. Always kept, named or not — they are the action surface. */
const ACTIONABLE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
]);

/**
 * Nodes that announce an outcome. Always kept, because classifying a replay result as
 * a business outcome rather than a failure depends on exactly these appearing.
 */
const STATUS_ROLES: ReadonlySet<string> = new Set([
  'alert',
  'alertdialog',
  'dialog',
  'log',
  'progressbar',
  'status',
]);

/** Wrappers with no semantics of their own; dropped, with any kept descendants lifted up. */
const DECORATIVE_ROLES: ReadonlySet<string> = new Set([
  'generic',
  'none',
  'presentation',
  'separator',
]);

/** Roles that commonly restate a neighbouring control's accessible name verbatim. */
const RESTATEMENT_ROLES: ReadonlySet<string> = new Set(['caption', 'text']);

/** Controls whose name comes from a `<label>`, so a label lookup is a sound fallback. */
const LABELLED_CONTROL_ROLES: ReadonlySet<string> = new Set([
  'checkbox',
  'combobox',
  'listbox',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'textbox',
]);

/**
 * ARIA states worth carrying. Everything else Playwright can emit — `cursor`, `box` —
 * is presentational and would only cost context.
 */
const SEMANTIC_STATE_ATTRIBUTES: readonly string[] = [
  'checked',
  'disabled',
  'expanded',
  'invalid',
  'level',
  'pressed',
  'readonly',
  'required',
  'selected',
];

const REF_PREFIX = 'n';
const TRUNCATION_SUFFIX = '…';
const WHITESPACE_RUN = /\s+/g;
const ORDINAL_KEY_SEPARATOR = '\u0000';

export interface SnapshotLimits {
  /** Hard ceiling on emitted nodes, so an observation can never blow a model's context. */
  readonly maxNodes: number;
  readonly maxTextLength: number;
}

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = {
  maxNodes: 200,
  maxTextLength: 240,
};

export interface SnapshotResult {
  readonly nodes: readonly ObservationNode[];
  /** Durable, surface-agnostic descriptor for every emitted ref. */
  readonly targets: ReadonlyMap<string, TargetDescriptor>;
  readonly truncated: boolean;
}

interface KeptNode {
  readonly source: RawAccessibilityNode;
  readonly ordinal: number;
  readonly children: readonly KeptNode[];
}

interface EmitContext {
  emitted: number;
  truncated: boolean;
  readonly limits: SnapshotLimits;
  readonly targets: Map<string, TargetDescriptor>;
}

/**
 * Compacts a raw accessibility tree into an observation: noise removed, a
 * system-generated ref on every surviving node, and a locator descriptor derived from
 * the node itself rather than guessed later.
 */
export function buildSnapshot(
  raw: readonly RawAccessibilityNode[],
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): SnapshotResult {
  const ordinals = assignOrdinals(raw);
  const kept = raw.flatMap((node) => keepNode(node, ordinals, '', raw));

  const context: EmitContext = { emitted: 0, truncated: false, limits, targets: new Map() };
  const nodes = emitNodes(kept, context, undefined);

  return { nodes, targets: context.targets, truncated: context.truncated };
}

/**
 * Numbers same-role, same-name nodes over the *raw* tree rather than the filtered one:
 * a replay resolves its locator against the live surface, which still contains the
 * nodes we chose not to show.
 *
 * Bucketed by role + accessible name only, matching exactly what `PlaywrightWebDriver`'s
 * `byRole()` disambiguates on (`getByRole(role, { name })`). Text content must NOT factor
 * into the key: several unnamed same-role siblings (e.g. a `<dl>`'s `<dd>` elements) can
 * have distinct text, but `getByRole` still returns them as one ordered collection, so
 * they must share one ordinal sequence rather than each independently landing on `0`.
 */
function assignOrdinals(raw: readonly RawAccessibilityNode[]): Map<RawAccessibilityNode, number> {
  const ordinals = new Map<RawAccessibilityNode, number>();
  const seen = new Map<string, number>();

  const visit = (node: RawAccessibilityNode): void => {
    const key = `${node.role}${ORDINAL_KEY_SEPARATOR}${normalise(node.name)}`;
    const next = seen.get(key) ?? 0;
    ordinals.set(node, next);
    seen.set(key, next + 1);
    node.children.forEach(visit);
  };

  raw.forEach(visit);
  return ordinals;
}

function keepNode(
  node: RawAccessibilityNode,
  ordinals: Map<RawAccessibilityNode, number>,
  parentName: string,
  siblings: readonly RawAccessibilityNode[],
): KeptNode[] {
  if (DECORATIVE_ROLES.has(node.role)) {
    return keepChildren(node, ordinals);
  }

  if (isRestatement(node, parentName, siblings)) {
    return [];
  }

  const children = keepChildren(node, ordinals);
  if (!isWorthKeeping(node, children)) {
    return children;
  }

  return [{ source: node, ordinal: ordinals.get(node) ?? 0, children }];
}

function keepChildren(
  node: RawAccessibilityNode,
  ordinals: Map<RawAccessibilityNode, number>,
): KeptNode[] {
  return node.children.flatMap((child) =>
    keepNode(child, ordinals, normalise(node.name), node.children),
  );
}

function isWorthKeeping(node: RawAccessibilityNode, children: readonly KeptNode[]): boolean {
  return (
    ACTIONABLE_ROLES.has(node.role) ||
    STATUS_ROLES.has(node.role) ||
    normalise(node.text) !== '' ||
    normalise(node.name) !== '' ||
    children.length > 0
  );
}

/**
 * A `<label>` rendered next to its input, or a `<caption>` inside its table, produces a
 * text node that repeats an accessible name the observation already carries.
 */
function isRestatement(
  node: RawAccessibilityNode,
  parentName: string,
  siblings: readonly RawAccessibilityNode[],
): boolean {
  if (!RESTATEMENT_ROLES.has(node.role)) {
    return false;
  }

  const text = normalise(node.text);
  if (text === '') {
    return false;
  }

  if (text === parentName) {
    return true;
  }

  return siblings.some((sibling) => sibling !== node && normalise(sibling.name) === text);
}

function emitNodes(
  kept: readonly KeptNode[],
  context: EmitContext,
  scope: TargetScope | undefined,
): ObservationNode[] {
  const emitted: ObservationNode[] = [];

  for (const node of kept) {
    if (context.emitted >= context.limits.maxNodes) {
      context.truncated = true;
      break;
    }
    emitted.push(emitNode(node, context, scope));
  }

  return emitted;
}

function emitNode(
  kept: KeptNode,
  context: EmitContext,
  scope: TargetScope | undefined,
): ObservationNode {
  context.emitted += 1;
  const ref = `${REF_PREFIX}${context.emitted}`;

  const { source } = kept;
  const name = normalise(source.name);
  const text = truncate(normalise(source.text), context.limits.maxTextLength);
  const states = semanticStates(source.attributes);

  context.targets.set(ref, describeTarget(source.role, name, text, kept.ordinal, scope));

  const childScope = name === '' ? scope : { role: source.role, name };

  return {
    ref,
    role: source.role,
    name,
    ...(text === '' ? {} : { text }),
    ...(states === null ? {} : { states }),
    ...(source.url === null ? {} : { url: source.url }),
    children: emitNodes(kept.children, context, childScope),
  };
}

function describeTarget(
  role: string,
  name: string,
  text: string,
  ordinal: number,
  scope: TargetScope | undefined,
): TargetDescriptor {
  return {
    role,
    name,
    nameMatch: 'exact',
    ordinal,
    ...(scope === undefined ? {} : { within: scope }),
    fallbacks: buildFallbacks(role, name, text),
  };
}

/**
 * Status and text nodes carry no accessible name, so their rendered content is the
 * only handle a replay has on them.
 */
function buildFallbacks(role: string, name: string, text: string): TargetFallback[] {
  if (name === '') {
    return text === '' ? [] : [{ strategy: 'text', value: text }];
  }

  const fallbacks: TargetFallback[] = [];
  if (LABELLED_CONTROL_ROLES.has(role)) {
    fallbacks.push({ strategy: 'label', value: name });
  }
  fallbacks.push({ strategy: 'text', value: name });

  return fallbacks;
}

function semanticStates(
  attributes: Readonly<Record<string, string>>,
): Record<string, string> | null {
  const states: Record<string, string> = {};

  for (const attribute of SEMANTIC_STATE_ATTRIBUTES) {
    const value = attributes[attribute];
    if (value !== undefined) {
      states[attribute] = value;
    }
  }

  return Object.keys(states).length === 0 ? null : states;
}

/**
 * Accessible names are intentionally not truncated: they are the locator, and a
 * shortened name would resolve to nothing on replay. The node budget is what bounds size.
 */
function normalise(value: string): string {
  return value.replace(WHITESPACE_RUN, ' ').trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}${TRUNCATION_SUFFIX}`;
}
