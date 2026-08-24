import { describe, expect, it } from 'vitest';
import { artifactSchema } from '../artifact/schema.ts';
import { interpolate } from '../artifact/binding.ts';
import type { TargetDescriptor } from '../surface/SurfaceDriver.ts';
import { buildDraftArtifact, buildMemberSavingsBalanceArtifact, type FrozenArtifactMeta } from './artifactBuilder.ts';
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

/**
 * Grounded action log shaped like the real corrected discovery run
 * (`evidence/20260823T231731Z-abwo2d/`): fill "Member ID" -> click "Look up member" ->
 * click "View details for member {id}" -> extract a "Savings balance" definition
 * scoped to the "Member {id}" detail region.
 */
function memberDetailGroundedLog(memberId: string, balanceText: string): readonly GroundedAction[] {
  return [
    {
      step: 1,
      action: { kind: 'fill', ref: 'n4', value: memberId },
      target: {
        role: 'textbox',
        name: 'Member ID',
        nameMatch: 'exact',
        ordinal: 0,
        within: { role: 'region', name: 'Member lookup' },
        fallbacks: [
          { strategy: 'label', value: 'Member ID' },
          { strategy: 'text', value: 'Member ID' },
        ],
      },
    },
    {
      step: 2,
      action: { kind: 'click', ref: 'n5' },
      target: {
        role: 'button',
        name: 'Look up member',
        nameMatch: 'exact',
        ordinal: 0,
        within: { role: 'region', name: 'Member lookup' },
        fallbacks: [{ strategy: 'text', value: 'Look up member' }],
      },
    },
    {
      step: 3,
      action: { kind: 'click', ref: 'n17' },
      target: {
        role: 'button',
        name: `View details for member ${memberId}`,
        nameMatch: 'exact',
        ordinal: 0,
        within: { role: 'cell', name: `View details for member ${memberId}` },
        fallbacks: [{ strategy: 'text', value: `View details for member ${memberId}` }],
      },
    },
    {
      step: 4,
      action: { kind: 'extract', ref: 'n7' },
      target: {
        role: 'definition',
        name: '',
        nameMatch: 'exact',
        ordinal: 1,
        within: { role: 'region', name: `Member ${memberId}` },
        fallbacks: [{ strategy: 'text', value: balanceText }],
      },
      extractedAs: 'savingsBalance',
    },
  ];
}

function memberDetailOutcome(memberId: string, balanceText: string): DiscoveryOutcome {
  return {
    stopReason: 'done',
    summary: `Looked up member ${memberId}, opened their detail page, and read the savings balance.`,
    steps: 6,
    groundedActions: memberDetailGroundedLog(memberId, balanceText),
    outputs: { savingsBalance: balanceText },
  };
}

const frozenMeta: FrozenArtifactMeta = {
  discoveryRunId: '20260823T231731Z-abwo2d',
  evidencePath: 'evidence/20260823T231731Z-abwo2d/',
  model: 'claude-sonnet-5',
  discoveredAt: '2026-08-23T23:17:47.457Z',
};

describe('buildMemberSavingsBalanceArtifact', () => {
  it('produces a schema-valid frozen artifact with the hand-authored checkpoint and outcomes', () => {
    const artifact = buildMemberSavingsBalanceArtifact(memberDetailOutcome('12345', '$1,240.55'), frozenMeta);

    expect(() => artifactSchema.parse(artifact)).not.toThrow();
    expect(artifact.id).toBe('member.savings-balance.read');
    expect(artifact.checkpoint).toEqual({
      assert: 'visible',
      target: { role: 'heading', name: 'Member', nameMatch: 'contains', ordinal: 0, fallbacks: [] },
    });
    expect(artifact.outcomes.map((outcome) => outcome.id)).toEqual([
      'member_not_found',
      'validation_error',
      'session_expired',
    ]);
  });

  it('turns the fill value on "Member ID" into an $input reference, not a baked literal', () => {
    const artifact = buildMemberSavingsBalanceArtifact(memberDetailOutcome('12345', '$1,240.55'), frozenMeta);

    const fillStep = artifact.steps.find((step) => step.action === 'fill');
    expect(fillStep).toMatchObject({ value: { $input: 'memberId' } });
  });

  it('templatizes the memberId literal out of a step target name and its scope', () => {
    const artifact = buildMemberSavingsBalanceArtifact(memberDetailOutcome('12345', '$1,240.55'), frozenMeta);

    const detailStep = artifact.steps.find(
      (step) => step.action === 'click' && step.target.name.startsWith('View details'),
    );
    expect(detailStep).toMatchObject({
      target: {
        name: 'View details for member {memberId}',
        within: { role: 'cell', name: 'View details for member {memberId}' },
      },
    });
  });

  it('templatizes the memberId literal out of the extract step scope', () => {
    const artifact = buildMemberSavingsBalanceArtifact(memberDetailOutcome('12345', '$1,240.55'), frozenMeta);

    const extractStep = artifact.steps.find((step) => step.action === 'extract');
    expect(extractStep).toMatchObject({
      into: 'savingsBalance',
      target: { within: { role: 'region', name: 'Member {memberId}' } },
    });
  });

  it('produces identical templated steps for a different memberId run — the parameterization proof', () => {
    const first = buildMemberSavingsBalanceArtifact(memberDetailOutcome('12345', '$1,240.55'), frozenMeta);
    const second = buildMemberSavingsBalanceArtifact(memberDetailOutcome('67890', '$1,240.55'), frozenMeta);

    expect(second.steps).toEqual(first.steps);
  });

  it('binds a templated target back to the exact literal name for a given memberId', () => {
    const artifact = buildMemberSavingsBalanceArtifact(memberDetailOutcome('12345', '$1,240.55'), frozenMeta);

    const detailStep = artifact.steps.find(
      (step) => step.action === 'click' && step.target.name.includes('{memberId}'),
    );
    if (detailStep?.action !== 'click') {
      throw new Error('expected a click step with a templated name');
    }

    expect(interpolate(detailStep.target.name, { memberId: '67890' })).toBe('View details for member 67890');
  });

  it('carries provenance pointing at the real discovery run, not an inlined transcript', () => {
    const artifact = buildMemberSavingsBalanceArtifact(memberDetailOutcome('12345', '$1,240.55'), frozenMeta);

    expect(artifact.provenance).toEqual({
      discoveredAt: frozenMeta.discoveredAt,
      model: frozenMeta.model,
      discoveryRunId: frozenMeta.discoveryRunId,
      evidencePath: frozenMeta.evidencePath,
    });
  });

  it('throws when the grounded log has no fill on the "Member ID" textbox', () => {
    const outcome: DiscoveryOutcome = { stopReason: 'done', steps: 0, groundedActions: [], outputs: {} };

    expect(() => buildMemberSavingsBalanceArtifact(outcome, frozenMeta)).toThrow(/Member ID/);
  });

  it('throws when the grounded log has no extract step', () => {
    const outcome: DiscoveryOutcome = {
      stopReason: 'done',
      steps: 1,
      groundedActions: [
        {
          step: 1,
          action: { kind: 'fill', ref: 'n1', value: '12345' },
          target: { role: 'textbox', name: 'Member ID', nameMatch: 'exact', ordinal: 0, fallbacks: [] },
        },
      ],
      outputs: {},
    };

    expect(() => buildMemberSavingsBalanceArtifact(outcome, frozenMeta)).toThrow(/extract/);
  });
});
