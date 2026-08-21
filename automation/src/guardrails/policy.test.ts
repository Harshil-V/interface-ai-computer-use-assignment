import { describe, expect, it } from 'vitest';
import type { Policy } from '../config.ts';
import { checkAction } from './policy.ts';

const basePolicy: Policy = {
  allowedOrigins: ['http://localhost:5173'],
  allowedRoutePatterns: ['^/$', '^/members(/.*)?$'],
  allowedActionTypes: ['click', 'fill', 'navigate', 'extract'],
  riskClassification: {
    defaultRisk: 'safe',
    safeActionTypes: ['navigate', 'extract', 'fill'],
    riskyActionTypes: [],
    riskyTargetNamePatterns: ['^confirm\\b', '\\bopen sub-account\\b'],
  },
  limits: {
    maxStepsPerRun: 40,
    maxRunDurationMs: 300_000,
    actionTimeoutMs: 10_000,
    navigationTimeoutMs: 20_000,
    maxObservationNodes: 200,
    maxTextLength: 240,
  },
};

function withRiskClassification(overrides: Partial<Policy['riskClassification']>): Policy {
  return { ...basePolicy, riskClassification: { ...basePolicy.riskClassification, ...overrides } };
}

describe('checkAction', () => {
  it('allows navigation to an allowlisted origin and route', () => {
    const decision = checkAction({ kind: 'navigate', url: 'http://localhost:5173/' }, basePolicy);

    expect(decision).toEqual({ outcome: 'allow' });
  });

  it('blocks navigation to an origin outside the allowlist', () => {
    const decision = checkAction(
      { kind: 'navigate', url: 'https://evil.example.com/' },
      basePolicy,
    );

    expect(decision.outcome).toBe('block');
    expect(decision).toMatchObject({ reason: expect.stringContaining('evil.example.com') });
  });

  it('blocks navigation to a route outside the allowed route patterns', () => {
    const decision = checkAction(
      { kind: 'navigate', url: 'http://localhost:5173/admin' },
      basePolicy,
    );

    expect(decision.outcome).toBe('block');
    expect(decision).toMatchObject({ reason: expect.stringContaining('/admin') });
  });

  it('blocks navigation given an unparseable URL', () => {
    const decision = checkAction({ kind: 'navigate', url: 'not-a-url' }, basePolicy);

    expect(decision.outcome).toBe('block');
  });

  it('blocks an action kind that is not in the allowed action types', () => {
    const decision = checkAction({ kind: 'select', ref: 'n1', value: 'a' }, basePolicy);

    expect(decision.outcome).toBe('block');
    expect(decision).toMatchObject({ reason: expect.stringContaining('select') });
  });

  it('requires intervention for a target whose accessible name matches a risky pattern', () => {
    const decision = checkAction(
      { kind: 'click', ref: 'n1' },
      basePolicy,
      'Confirm and open sub-account',
    );

    expect(decision.outcome).toBe('require-intervention');
    expect(decision).toMatchObject({ reason: expect.stringContaining('Confirm and open sub-account') });
  });

  it('matches risky name patterns case-insensitively', () => {
    const decision = checkAction({ kind: 'click', ref: 'n1' }, basePolicy, 'CONFIRM AND PROCEED');

    expect(decision.outcome).toBe('require-intervention');
  });

  it('allows an ordinary safe click whose name matches no risky pattern', () => {
    const decision = checkAction({ kind: 'click', ref: 'n1' }, basePolicy, 'Look up member');

    expect(decision).toEqual({ outcome: 'allow' });
  });

  it('allows a click when no target name is known and nothing else marks it risky', () => {
    const decision = checkAction({ kind: 'click', ref: 'n1' }, basePolicy);

    expect(decision).toEqual({ outcome: 'allow' });
  });

  it('requires intervention for an action kind explicitly classified as risky', () => {
    const policy = withRiskClassification({ riskyActionTypes: ['click'] });
    const decision = checkAction({ kind: 'click', ref: 'n1' }, policy, 'Look up member');

    expect(decision.outcome).toBe('require-intervention');
    expect(decision).toMatchObject({ reason: expect.stringContaining('click') });
  });

  it('falls back to the policy default risk when the action kind is neither safe nor risky', () => {
    const policy = withRiskClassification({ defaultRisk: 'risky', safeActionTypes: [] });
    const decision = checkAction({ kind: 'click', ref: 'n1' }, policy, 'Look up member');

    expect(decision.outcome).toBe('require-intervention');
  });

  it('allows an action kind covered by defaultRisk: safe when nothing else flags it', () => {
    const policy = withRiskClassification({ defaultRisk: 'safe', safeActionTypes: [] });
    const decision = checkAction({ kind: 'click', ref: 'n1' }, policy, 'Look up member');

    expect(decision).toEqual({ outcome: 'allow' });
  });

  it('classifies fill and extract the same way as click', () => {
    const risky = checkAction(
      { kind: 'fill', ref: 'n1', value: 'x' },
      basePolicy,
      'Confirm and open sub-account',
    );
    const safe = checkAction({ kind: 'extract', ref: 'n1' }, basePolicy, 'Savings balance');

    expect(risky.outcome).toBe('require-intervention');
    expect(safe).toEqual({ outcome: 'allow' });
  });
});
