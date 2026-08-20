import { describe, expect, it } from 'vitest';
import { lookupMember, MEMBER_ID_REQUIRED_MESSAGE } from './memberLookup';
import {
  EXISTING_MEMBER_BALANCE,
  EXISTING_MEMBER_ID,
  NOT_FOUND_MEMBER_ID,
  SECOND_MEMBER_BALANCE,
  SECOND_MEMBER_ID,
} from '../fixtures/members';

describe('lookupMember', () => {
  it('returns a found result with the savings balance for a known member', () => {
    const result = lookupMember(EXISTING_MEMBER_ID);

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.member.id).toBe(EXISTING_MEMBER_ID);
      expect(result.member.savingsBalance).toBe(EXISTING_MEMBER_BALANCE);
    }
  });

  it('returns a found result with a different balance for a second known member', () => {
    const result = lookupMember(SECOND_MEMBER_ID);

    expect(result.status).toBe('found');
    if (result.status === 'found') {
      expect(result.member.id).toBe(SECOND_MEMBER_ID);
      expect(result.member.savingsBalance).toBe(SECOND_MEMBER_BALANCE);
    }
  });

  it('returns a not-found result for an unknown member id', () => {
    const result = lookupMember(NOT_FOUND_MEMBER_ID);

    expect(result.status).toBe('not_found');
    if (result.status === 'not_found') {
      expect(result.memberId).toBe(NOT_FOUND_MEMBER_ID);
    }
  });

  it('returns an invalid result with a validation message for an empty string', () => {
    const result = lookupMember('');

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe(MEMBER_ID_REQUIRED_MESSAGE);
    }
  });

  it('returns an invalid result for a whitespace-only string', () => {
    const result = lookupMember('   ');

    expect(result.status).toBe('invalid');
  });

  it('trims surrounding whitespace before matching a known member', () => {
    const result = lookupMember(`  ${EXISTING_MEMBER_ID}  `);

    expect(result.status).toBe('found');
  });
});
