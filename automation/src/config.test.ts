import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError, EXAMPLE_POLICY_PATH, parseEnvironment, parsePolicy } from './config.ts';

const validPolicy = {
  allowedOrigins: ['http://localhost:5173'],
  allowedRoutePatterns: ['^/$'],
  allowedActionTypes: ['click', 'fill', 'select', 'navigate', 'extract'],
  riskClassification: {
    defaultRisk: 'safe',
    safeActionTypes: ['navigate', 'extract'],
    riskyActionTypes: [],
    riskyTargetNamePatterns: ['^confirm\\b'],
  },
  limits: {
    maxStepsPerRun: 40,
    actionTimeoutMs: 10_000,
    navigationTimeoutMs: 20_000,
    maxObservationNodes: 200,
    maxTextLength: 240,
  },
};

function withPolicy(overrides: Record<string, unknown>): unknown {
  return { ...validPolicy, ...overrides };
}

describe('parsePolicy', () => {
  it('accepts a well-formed policy', () => {
    const policy = parsePolicy(validPolicy, 'test');

    expect(policy.allowedOrigins).toEqual(['http://localhost:5173']);
    expect(policy.limits.maxStepsPerRun).toBe(40);
  });

  it('accepts the policy example shipped with the repo', () => {
    const raw: unknown = JSON.parse(readFileSync(EXAMPLE_POLICY_PATH, 'utf8'));
    const policy = parsePolicy(raw, EXAMPLE_POLICY_PATH);

    expect(policy.allowedOrigins).toContain('http://localhost:5173');
    expect(policy.allowedActionTypes).toContain('extract');
  });

  it('ignores documentation keys that are not part of the schema', () => {
    const policy = parsePolicy(withPolicy({ $comment: 'notes' }), 'test');

    expect(policy).not.toHaveProperty('$comment');
  });

  it('rejects a policy that is not an object', () => {
    expect(() => parsePolicy('nope', 'test')).toThrow(ConfigError);
  });

  it('names the offending field and the config source in the error', () => {
    expect(() => parsePolicy(withPolicy({ allowedOrigins: undefined }), 'policy.json')).toThrow(
      /policy\.json[\s\S]*allowedOrigins/,
    );
  });

  it('rejects an empty origin allowlist, because that is never an intended policy', () => {
    expect(() => parsePolicy(withPolicy({ allowedOrigins: [] }), 'test')).toThrow(ConfigError);
  });

  it('rejects an origin that is not a bare http(s) origin', () => {
    expect(() => parsePolicy(withPolicy({ allowedOrigins: ['localhost:5173'] }), 'test')).toThrow(
      ConfigError,
    );
    expect(() =>
      parsePolicy(withPolicy({ allowedOrigins: ['http://localhost:5173/members'] }), 'test'),
    ).toThrow(ConfigError);
  });

  it('normalises origins so a trailing slash cannot silently create a mismatch', () => {
    const policy = parsePolicy(withPolicy({ allowedOrigins: ['http://localhost:5173/'] }), 'test');

    expect(policy.allowedOrigins).toEqual(['http://localhost:5173']);
  });

  it('rejects an unknown action type', () => {
    expect(() =>
      parsePolicy(withPolicy({ allowedActionTypes: ['click', 'levitate'] }), 'test'),
    ).toThrow(/levitate|allowedActionTypes/);
  });

  it('rejects a route pattern that is not a valid regular expression', () => {
    expect(() => parsePolicy(withPolicy({ allowedRoutePatterns: ['^/(']  }), 'test')).toThrow(
      ConfigError,
    );
  });

  it('rejects a risky-name pattern that is not a valid regular expression', () => {
    const broken = {
      ...validPolicy.riskClassification,
      riskyTargetNamePatterns: ['[unterminated'],
    };

    expect(() => parsePolicy(withPolicy({ riskClassification: broken }), 'test')).toThrow(
      ConfigError,
    );
  });

  it('rejects an action type classified as both safe and risky', () => {
    const contradictory = {
      ...validPolicy.riskClassification,
      safeActionTypes: ['click'],
      riskyActionTypes: ['click'],
    };

    expect(() => parsePolicy(withPolicy({ riskClassification: contradictory }), 'test')).toThrow(
      /both safe and risky|click/,
    );
  });

  it('rejects non-positive limits', () => {
    const limits = { ...validPolicy.limits, maxStepsPerRun: 0 };

    expect(() => parsePolicy(withPolicy({ limits }), 'test')).toThrow(ConfigError);
  });

  it('rejects a fractional timeout', () => {
    const limits = { ...validPolicy.limits, actionTimeoutMs: 1.5 };

    expect(() => parsePolicy(withPolicy({ limits }), 'test')).toThrow(ConfigError);
  });
});

describe('parseEnvironment', () => {
  it('treats a missing api key as absent rather than failing', () => {
    expect(parseEnvironment({}).anthropicApiKey).toBeNull();
  });

  it('treats a blank api key as absent', () => {
    expect(parseEnvironment({ ANTHROPIC_API_KEY: '   ' }).anthropicApiKey).toBeNull();
  });

  it('reads an api key that is present', () => {
    expect(parseEnvironment({ ANTHROPIC_API_KEY: 'sk-test' }).anthropicApiKey).toBe('sk-test');
  });

  it('runs headed by default, because runs are meant to be watchable and handed to a human', () => {
    expect(parseEnvironment({}).headless).toBe(false);
  });

  it('accepts the usual spellings of a boolean flag', () => {
    expect(parseEnvironment({ AUTOMATION_HEADLESS: 'true' }).headless).toBe(true);
    expect(parseEnvironment({ AUTOMATION_HEADLESS: 'TRUE' }).headless).toBe(true);
    expect(parseEnvironment({ AUTOMATION_HEADLESS: '1' }).headless).toBe(true);
    expect(parseEnvironment({ AUTOMATION_HEADLESS: 'false' }).headless).toBe(false);
    expect(parseEnvironment({ AUTOMATION_HEADLESS: '0' }).headless).toBe(false);
  });

  it('fails loudly on an uninterpretable boolean rather than guessing', () => {
    expect(() => parseEnvironment({ AUTOMATION_HEADLESS: 'sometimes' })).toThrow(
      /AUTOMATION_HEADLESS/,
    );
  });

  it('leaves path overrides unset when absent', () => {
    const env = parseEnvironment({});

    expect(env.policyPath).toBeNull();
    expect(env.evidenceDir).toBeNull();
  });

  it('reads path overrides when present', () => {
    const env = parseEnvironment({
      AUTOMATION_POLICY_PATH: 'config/policy.json',
      AUTOMATION_EVIDENCE_DIR: '/tmp/evidence',
    });

    expect(env.policyPath).toBe('config/policy.json');
    expect(env.evidenceDir).toBe('/tmp/evidence');
  });
});
