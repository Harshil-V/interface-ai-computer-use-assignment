import { describe, expect, it } from 'vitest';
import { checkUnattendedReplay } from './approval.ts';

describe('checkUnattendedReplay', () => {
  it('permits an approved artifact', () => {
    const decision = checkUnattendedReplay('approved', false);

    expect(decision.outcome).toBe('permit');
    expect(decision.reason).toContain('approved');
  });

  it('permits an approved artifact even when draft was explicitly allowed', () => {
    const decision = checkUnattendedReplay('approved', true);

    expect(decision.outcome).toBe('permit');
  });

  it('refuses a draft artifact by default', () => {
    const decision = checkUnattendedReplay('draft', false);

    expect(decision.outcome).toBe('refuse');
    expect(decision.reason).toContain('draft');
  });

  it('permits a draft artifact when draft was explicitly allowed, and says so', () => {
    const decision = checkUnattendedReplay('draft', true);

    expect(decision.outcome).toBe('permit');
    expect(decision.reason).toContain('--allow-draft');
  });

  it('distinguishes the two permit paths, so a caller can report an override', () => {
    const approved = checkUnattendedReplay('approved', true);
    const overridden = checkUnattendedReplay('draft', true);

    expect(approved.reason).not.toBe(overridden.reason);
  });
});
