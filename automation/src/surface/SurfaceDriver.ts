import type { SensitivityClass } from '../guardrails/redaction.ts';

/**
 * The seam between "how we perceive and act on a surface" and everything above it
 * (discovery, replay, evidence). A legacy-web or desktop driver must be droppable in
 * behind this interface without any caller changing, so nothing in this file — and
 * nothing that imports it — may reference Playwright, CSS, or the DOM.
 */
export interface SurfaceDriver {
  perceive(): Promise<Observation>;
  act(action: Action): Promise<ActResult>;
  resolve(target: TargetDescriptor): Promise<ElementRef | null>;
}

/**
 * Split from {@link SurfaceDriver} so that discovery/replay code, which only ever
 * observes and acts, cannot accidentally tear down a session that a human operator
 * may still be holding.
 */
export interface SurfaceSession {
  close(): Promise<void>;
}

/** Sink for binary evidence, so a driver can capture screenshots without knowing how they are stored. */
export interface ScreenshotStore {
  /** Persists a PNG and returns the path it was written to. */
  writeScreenshot(png: Uint8Array, label: string): Promise<string>;
}

/** Opaque, system-generated handle to one node of the most recent {@link Observation}. */
export interface ElementRef {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
}

export interface ObservationNode {
  /** System-generated and stable for the lifetime of the observation that produced it. */
  readonly ref: string;
  readonly role: string;
  /** Accessible name; empty string when the node has none. */
  readonly name: string;
  /** Rendered text content, e.g. a cell value or an alert message. */
  readonly text?: string;
  /** Semantic ARIA states such as `checked`, `disabled`, `invalid`, `level`. */
  readonly states?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly children: readonly ObservationNode[];
}

export interface Observation {
  readonly url: string;
  readonly title: string;
  readonly capturedAt: string;
  readonly nodes: readonly ObservationNode[];
  /** True when the node budget was exhausted and the tree below is incomplete. */
  readonly truncated: boolean;
  readonly screenshotPath: string | null;
}

export const ACTION_KINDS = ['click', 'fill', 'select', 'navigate', 'extract'] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export interface ClickAction {
  readonly kind: 'click';
  readonly ref: string;
}

export interface FillAction {
  readonly kind: 'fill';
  readonly ref: string;
  readonly value: string;
  readonly sensitivity?: SensitivityClass;
}

export interface SelectAction {
  readonly kind: 'select';
  readonly ref: string;
  readonly value: string;
  readonly sensitivity?: SensitivityClass;
}

/**
 * The one action addressed by location rather than by element: it re-establishes the
 * surface's position instead of operating a control on the current screen.
 */
export interface NavigateAction {
  readonly kind: 'navigate';
  readonly url: string;
}

export interface ExtractAction {
  readonly kind: 'extract';
  readonly ref: string;
  readonly sensitivity?: SensitivityClass;
}

export type Action = ClickAction | FillAction | SelectAction | NavigateAction | ExtractAction;

export type ActFailureCode =
  | 'unknown_ref'
  | 'target_not_found'
  | 'target_not_actionable'
  | 'timeout'
  | 'navigation_failed'
  /** The action itself, or its destination, is disallowed outright — never retry it. */
  | 'policy_blocked'
  /** The action is legitimate but irreversible-leaning; only a human may authorize it. */
  | 'policy_intervention_required';

export interface ActFailure {
  readonly code: ActFailureCode;
  readonly message: string;
}

export interface ActResult {
  readonly ok: boolean;
  readonly kind: ActionKind;
  /** Full, unmasked value for `extract`; redaction happens at the persistence boundary. */
  readonly extracted?: string;
  /**
   * Descriptor derived from the node that was actually operated on, so later milestones
   * record locators grounded in what worked rather than in what the model guessed.
   */
  readonly target?: TargetDescriptor;
  readonly failure?: ActFailure;
  readonly durationMs: number;
}

export type NameMatch = 'exact' | 'contains';

/** Narrows an ambiguous descriptor to a named ancestor, e.g. a row within a table. */
export interface TargetScope {
  readonly role: string;
  readonly name: string;
}

/**
 * Fallbacks are ordered least-desperate first. `css` is deliberately the only
 * surface-specific strategy and is explicitly labelled as such so a non-web driver can
 * reject it rather than silently misinterpret it.
 */
export type TargetFallback =
  | { readonly strategy: 'label'; readonly value: string }
  | { readonly strategy: 'text'; readonly value: string }
  | { readonly strategy: 'placeholder'; readonly value: string }
  | { readonly strategy: 'css'; readonly value: string };

/**
 * How a control is identified, in surface-agnostic terms: the role a user would
 * perceive plus the name they would read. Everything here has a counterpart in the
 * desktop accessibility APIs, which is what keeps the artifact portable.
 */
export interface TargetDescriptor {
  readonly role: string;
  readonly name: string;
  readonly nameMatch: NameMatch;
  readonly within?: TargetScope;
  /** Zero-based index among same-role, same-name nodes in surface reading order. */
  readonly ordinal: number;
  readonly fallbacks: readonly TargetFallback[];
}
