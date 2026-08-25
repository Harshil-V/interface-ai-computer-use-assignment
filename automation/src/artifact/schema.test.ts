import { describe, expect, it } from 'vitest';
import { artifactSchema, CURRENT_SCHEMA_VERSION } from './schema.ts';

/** The running example from the plan's "Artifact schema" section, adapted to the real `TargetDescriptor` shape. */
function canonicalArtifact(): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'member.savings-balance.read',
    version: 1,
    title: 'Read member savings balance',
    target: { app: 'core-banking-console', tenant: 'base', entryUrl: 'http://localhost:5173/' },
    surface: { kind: 'web', perception: 'accessibility-tree' },
    inputs: [
      { name: 'memberId', type: 'string', required: true, example: '12345', sensitivity: 'quasi-identifier' },
    ],
    outputs: [{ name: 'savingsBalance', type: 'currency', sensitivity: 'sensitive' }],
    steps: [
      {
        id: 's1',
        action: 'fill',
        effect: 'safe',
        target: { role: 'textbox', name: 'Member ID', fallbacks: [{ strategy: 'css', value: '#memberId' }] },
        value: { $input: 'memberId' },
        wait: { until: 'target-visible', timeoutMs: 5000 },
      },
      {
        id: 's2',
        action: 'click',
        effect: 'safe',
        target: { role: 'button', name: 'Look up member' },
      },
      {
        id: 's3',
        action: 'click',
        effect: 'safe',
        target: { role: 'button', name: 'View details for member {memberId}' },
      },
      {
        id: 's4',
        action: 'extract',
        effect: 'safe',
        target: { role: 'definition', name: '', within: { role: 'region', name: 'Member {memberId}' } },
        into: 'savingsBalance',
      },
    ],
    checkpoint: { assert: 'visible', target: { role: 'heading', name: 'Member', nameMatch: 'contains' } },
    outcomes: [
      {
        id: 'member_not_found',
        type: 'business_outcome',
        terminal: true,
        when: { role: 'alert', textMatches: 'No member found for ID' },
      },
      {
        id: 'validation_error',
        type: 'business_outcome',
        terminal: true,
        when: { role: 'alert', textMatches: 'Member ID is required' },
      },
      {
        id: 'session_expired',
        type: 'recoverable',
        when: { role: 'alert', textMatches: 'Session expired' },
        recovery: {
          action: 'click',
          target: { role: 'button', name: 'Start a new session' },
          thenRestartFromStep: 's1',
          maxAttempts: 1,
        },
      },
    ],
    provenance: {
      discoveredAt: '2026-08-23T23:17:31.123Z',
      model: 'claude-sonnet-5',
      discoveryRunId: '20260823T231731Z-abwo2d',
      evidencePath: 'evidence/20260823T231731Z-abwo2d/',
    },
    approval: { state: 'draft' },
  };
}

describe('artifactSchema', () => {
  it('validates the canonical member.savings-balance.read example', () => {
    const artifact = artifactSchema.parse(canonicalArtifact());

    expect(artifact.id).toBe('member.savings-balance.read');
    expect(artifact.steps).toHaveLength(4);
  });

  it('fills in nameMatch/ordinal/fallbacks defaults on a terse hand-authored target', () => {
    const artifact = artifactSchema.parse(canonicalArtifact());

    expect(artifact.steps[1]).toMatchObject({
      target: { role: 'button', name: 'Look up member', nameMatch: 'exact', ordinal: 0, fallbacks: [] },
    });
    expect(artifact.checkpoint.target).toEqual({
      role: 'heading',
      name: 'Member',
      nameMatch: 'contains',
      ordinal: 0,
      fallbacks: [],
    });
  });

  it('rejects an artifact missing checkpoint', () => {
    const withoutCheckpoint = canonicalArtifact();
    delete withoutCheckpoint['checkpoint'];

    expect(() => artifactSchema.parse(withoutCheckpoint)).toThrow();
  });

  it('rejects a step with an unknown effect value', () => {
    const invalid = canonicalArtifact();
    const steps = invalid['steps'] as Array<Record<string, unknown>>;
    steps[0] = { ...steps[0], effect: 'dangerous' };

    expect(() => artifactSchema.parse(invalid)).toThrow(/effect/);
  });

  it('rejects an outcome with an unknown type', () => {
    const invalid = canonicalArtifact();
    const outcomes = invalid['outcomes'] as Array<Record<string, unknown>>;
    outcomes[0] = { ...outcomes[0], type: 'crash' };

    expect(() => artifactSchema.parse(invalid)).toThrow();
  });

  it('rejects a recoverable outcome that declares no recovery policy', () => {
    const invalid = canonicalArtifact();
    const outcomes = invalid['outcomes'] as Array<Record<string, unknown>>;
    const sessionExpired = { ...outcomes[2] };
    delete sessionExpired['recovery'];
    outcomes[2] = sessionExpired;

    expect(() => artifactSchema.parse(invalid)).toThrow(/recovery/);
  });

  it('rejects a business_outcome that declares a recovery policy', () => {
    const invalid = canonicalArtifact();
    const outcomes = invalid['outcomes'] as Array<Record<string, unknown>>;
    outcomes[0] = { ...outcomes[0], recovery: (outcomes[2] as { recovery: unknown })['recovery'] };

    expect(() => artifactSchema.parse(invalid)).toThrow(/recovery/);
  });

  it('rejects an empty steps array', () => {
    const invalid = { ...canonicalArtifact(), steps: [] };

    expect(() => artifactSchema.parse(invalid)).toThrow();
  });

  it('accepts both approval states', () => {
    const draft = artifactSchema.parse(canonicalArtifact());
    const approved = artifactSchema.parse({ ...canonicalArtifact(), approval: { state: 'approved' } });

    expect(draft.approval.state).toBe('draft');
    expect(approved.approval.state).toBe('approved');
  });

  it('rejects an unknown approval state', () => {
    const invalid = { ...canonicalArtifact(), approval: { state: 'rubber-stamped' } };

    expect(() => artifactSchema.parse(invalid)).toThrow();
  });

  it('rejects a target scope with a non-http entryUrl', () => {
    const invalid = canonicalArtifact();
    invalid['target'] = { ...(invalid['target'] as Record<string, unknown>), entryUrl: 'not-a-url' };

    expect(() => artifactSchema.parse(invalid)).toThrow();
  });
});
