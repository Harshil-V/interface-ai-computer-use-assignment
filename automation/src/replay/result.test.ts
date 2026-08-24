import { describe, expect, it } from 'vitest';
import {
  businessOutcomeResult,
  escalatedResult,
  failureResult,
  successResult,
} from './result.ts';

describe('successResult', () => {
  it('produces a success shape carrying outputs, runId, and evidencePath', () => {
    const result = successResult({ savingsBalance: '$1,240.55' }, 'run-1', 'evidence/run-1/');

    expect(result).toEqual({
      status: 'success',
      outputs: { savingsBalance: '$1,240.55' },
      runId: 'run-1',
      evidencePath: 'evidence/run-1/',
    });
  });
});

describe('businessOutcomeResult', () => {
  it('produces a business_outcome shape, distinct from failure', () => {
    const result = businessOutcomeResult(
      'member_not_found',
      'No member found for ID 99999.',
      'run-2',
      'evidence/run-2/',
    );

    expect(result).toEqual({
      status: 'business_outcome',
      outcomeId: 'member_not_found',
      detail: 'No member found for ID 99999.',
      runId: 'run-2',
      evidencePath: 'evidence/run-2/',
    });
  });
});

describe('escalatedResult', () => {
  it('produces an escalated shape carrying the resolution', () => {
    const result = escalatedResult('intervention-1', 'model declared itself stuck', 'abandoned');

    expect(result).toEqual({
      status: 'escalated',
      interventionId: 'intervention-1',
      reason: 'model declared itself stuck',
      resolution: 'abandoned',
    });
  });
});

describe('failureResult', () => {
  it('produces a hard failure carrying step-level detail', () => {
    const result = failureResult({
      stepId: 's3',
      expected: 'click on button "View details for member 12345" to succeed',
      observed: 'target_not_found',
      class: 'hard',
    });

    expect(result.status).toBe('failure');
    expect(result.error.class).toBe('hard');
  });

  it('carries class "recoverable_exhausted", never "hard", when a recovery policy runs out of attempts', () => {
    const result = failureResult({
      stepId: 's3',
      expected: 'outcome "session_expired" to be resolved within 1 recovery attempt(s)',
      observed: 'outcome "session_expired" recurred after 1 recovery attempt(s) already used',
      class: 'recoverable_exhausted',
    });

    expect(result.error.class).toBe('recoverable_exhausted');
    expect(result.error.class).not.toBe('hard');
  });
});
