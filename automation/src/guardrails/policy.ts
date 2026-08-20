import type { Policy } from '../config.ts';
import type { Action, ActionKind } from '../surface/SurfaceDriver.ts';

/**
 * `block` and `require-intervention` are deliberately distinct outcomes rather than a
 * single "refused" shape: a blocked action is a policy violation the run should never
 * retry, while an intervention-required action is legitimate work that only a human may
 * authorize. Milestone 7's HITL routing depends on being able to tell them apart.
 */
export type GuardrailDecision =
  | { readonly outcome: 'allow' }
  | { readonly outcome: 'block'; readonly reason: string }
  | { readonly outcome: 'require-intervention'; readonly reason: string };

function allow(): GuardrailDecision {
  return { outcome: 'allow' };
}

function block(reason: string): GuardrailDecision {
  return { outcome: 'block', reason };
}

function requireIntervention(reason: string): GuardrailDecision {
  return { outcome: 'require-intervention', reason };
}

/**
 * Decides what an action is allowed to do before a driver touches the page. Pure and
 * side-effect free so the enforcement point (`PlaywrightWebDriver.act()`) stays a thin
 * wrapper: this function owns every rule, the driver only owns dispatch.
 *
 * `targetName` is the resolved target's accessible name. It is unknown for `navigate`
 * (which has no target) and optional for the rest, since a caller may need to run the
 * action-kind check before a target has been resolved.
 */
export function checkAction(
  action: Action,
  policy: Policy,
  targetName?: string,
): GuardrailDecision {
  if (!isAllowedActionType(action.kind, policy)) {
    return block(`Action type "${action.kind}" is not in the allowed action types.`);
  }

  if (action.kind === 'navigate') {
    return checkNavigation(action.url, policy);
  }

  return classifyRisk(action.kind, targetName ?? '', policy);
}

function isAllowedActionType(kind: ActionKind, policy: Policy): boolean {
  return policy.allowedActionTypes.includes(kind);
}

function checkNavigation(url: string, policy: Policy): GuardrailDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return block(`"${url}" is not a valid URL.`);
  }

  if (!policy.allowedOrigins.includes(parsed.origin)) {
    return block(`Origin "${parsed.origin}" is not in the allowed origins.`);
  }

  const matchesRoute = policy.allowedRoutePatterns.some((pattern) =>
    new RegExp(pattern).test(parsed.pathname),
  );
  if (!matchesRoute) {
    return block(`Path "${parsed.pathname}" does not match any allowed route pattern.`);
  }

  return allow();
}

function classifyRisk(kind: ActionKind, targetName: string, policy: Policy): GuardrailDecision {
  const { riskClassification } = policy;

  if (riskClassification.riskyActionTypes.includes(kind)) {
    return requireIntervention(`Action type "${kind}" is classified as risky.`);
  }

  const matchedPattern = riskClassification.riskyTargetNamePatterns.find((pattern) =>
    new RegExp(pattern, 'i').test(targetName),
  );
  if (matchedPattern !== undefined) {
    return requireIntervention(
      `Target name "${targetName}" matches risky pattern /${matchedPattern}/i.`,
    );
  }

  if (riskClassification.safeActionTypes.includes(kind)) {
    return allow();
  }

  return riskClassification.defaultRisk === 'risky'
    ? requireIntervention(
        `Action type "${kind}" defaults to risky and is not explicitly marked safe.`,
      )
    : allow();
}
