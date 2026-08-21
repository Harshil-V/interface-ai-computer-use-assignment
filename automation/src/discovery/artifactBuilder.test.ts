import { describe, expect, it } from 'vitest';
import type { TargetDescriptor } from '../surface/SurfaceDriver.ts';
import { buildDraftArtifact } from './artifactBuilder.ts';
import type { DiscoveryOutcome, GroundedAction } from './DiscoveryAgent.ts';

function target(role: string, name: string): TargetDescriptor {
  return { role, name, nameMatch: 'exact', ordinal: 0, fallbacks: [] };
}

const groundedActions: readonly GroundedAction[] = [
  { step: 1, action: { kind: 'fill', ref: 'n1', value: '12345' }, target: target('textbox', 'Member ID') },
  { step: 2, action: { kind: 'click', ref: 'n2' }, target: target('button', 'Look up member') },
  {
    step: 3,
    action: { kind: 'click', ref: 'n3' },
    target: target('button', 'View details for member 12345'),
  },
  {
    step: 4,
    action: { kind: 'extract', ref: 'n4' },
    target: target('definition', 'Savings balance'),
    extractedAs: 'savingsBalance',
  },
];

const outcome: DiscoveryOutcome = {
  stopReason: 'done',
  summary: 'Looked up member 12345 and read the savings balance.',
  steps: 5,
  groundedActions,
  outputs: { savingsBalance: '$1,240.55' },
};

const baseMeta = {
  goal: 'look up member 12345 and read their savings balance',
  model: 'claude-sonnet-5',
  discoveryRunId: '20260820T000000Z-abc123',
};

describe('buildDraftArtifact', () => {
  it('emits one step per grounded action, in the same order', () => {
    const artifact = buildDraftArtifact(outcome, baseMeta);

    expect(artifact.steps).toHaveLength(4);
    expect(artifact.steps.map((step) => step.stepNumber)).toEqual([1, 2, 3, 4]);
    expect(artifact.steps.map((step) => step.action.kind)).toEqual(['fill', 'click', 'click', 'extract']);
  });

  it('carries the typed value on a fill step', () => {
    const artifact = buildDraftArtifact(outcome, baseMeta);

    expect(artifact.steps[0]?.action).toMatchObject({ kind: 'fill', ref: 'n1', value: '12345' });
  });

  it('carries the grounded target name on an extract step, plus its declared output name', () => {
    const artifact = buildDraftArtifact(outcome, baseMeta);

    const extractStep = artifact.steps[3];
    expect(extractStep?.target).toMatchObject({ role: 'definition', name: 'Savings balance' });
    expect(extractStep?.extractedAs).toBe('savingsBalance');
  });

  it('omits target and extractedAs when a step has none', () => {
    const withoutTarget: DiscoveryOutcome = {
      ...outcome,
      groundedActions: [{ step: 1, action: { kind: 'navigate', url: 'http://localhost:5173/' } }],
    };

    const artifact = buildDraftArtifact(withoutTarget, baseMeta);

    expect(artifact.steps[0]).not.toHaveProperty('target');
    expect(artifact.steps[0]).not.toHaveProperty('extractedAs');
  });

  it('carries the reported outputs, stop reason, and summary through', () => {
    const artifact = buildDraftArtifact(outcome, { ...baseMeta, discoveredAt: '2026-08-20T00:00:00.000Z' });

    expect(artifact.outputs).toEqual({ savingsBalance: '$1,240.55' });
    expect(artifact.stopReason).toBe('done');
    expect(artifact.summary).toBe('Looked up member 12345 and read the savings balance.');
    expect(artifact.discoveredAt).toBe('2026-08-20T00:00:00.000Z');
    expect(artifact.discoveryRunId).toBe('20260820T000000Z-abc123');
  });

  it('carries a stuck reason through instead of a summary when the run got stuck', () => {
    const stuck: DiscoveryOutcome = {
      stopReason: 'stuck',
      stuckReason: 'The lookup form is not visible after three attempts.',
      steps: 3,
      groundedActions: [],
      outputs: {},
    };

    const artifact = buildDraftArtifact(stuck, baseMeta);

    expect(artifact.stopReason).toBe('stuck');
    expect(artifact.stuckReason).toBe('The lookup form is not visible after three attempts.');
    expect(artifact).not.toHaveProperty('summary');
  });
});
