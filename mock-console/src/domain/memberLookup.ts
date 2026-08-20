import { findMemberById, type Member } from '../fixtures/members';

export const MEMBER_ID_REQUIRED_MESSAGE = 'Member ID is required';

export type MemberLookupResult =
  | { status: 'invalid'; reason: string }
  | { status: 'not_found'; memberId: string }
  | { status: 'found'; member: Member };

export function lookupMember(rawMemberId: string): MemberLookupResult {
  const memberId = rawMemberId.trim();

  if (memberId.length === 0) {
    return { status: 'invalid', reason: MEMBER_ID_REQUIRED_MESSAGE };
  }

  const member = findMemberById(memberId);
  if (!member) {
    return { status: 'not_found', memberId };
  }

  return { status: 'found', member };
}
