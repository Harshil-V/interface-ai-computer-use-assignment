/**
 * Frozen fixture data for the mock Core Banking Console.
 * These IDs and balances are contractual test cases relied on by
 * downstream automation (see "Built-in fixture cases" in ../../README.md).
 */

export interface Member {
  id: string;
  fullName: string;
  savingsBalance: number;
}

export const EXISTING_MEMBER_ID = '12345';
export const EXISTING_MEMBER_BALANCE = 1240.55;
export const NOT_FOUND_MEMBER_ID = '99999';

/**
 * A second valid member with a distinct balance shape (five digits, no decimals
 * lining up with the first). Replaying the same artifact successfully against both
 * IDs is the evidence that a capability's `memberId` is a real parameter, not a
 * value baked into a single recorded run.
 */
export const SECOND_MEMBER_ID = '67890';
export const SECOND_MEMBER_BALANCE = 84302.19;

const MEMBERS_BY_ID: Readonly<Record<string, Member>> = {
  [EXISTING_MEMBER_ID]: {
    id: EXISTING_MEMBER_ID,
    fullName: 'Jordan Ellis',
    savingsBalance: EXISTING_MEMBER_BALANCE,
  },
  [SECOND_MEMBER_ID]: {
    id: SECOND_MEMBER_ID,
    fullName: 'Priya Nakamura',
    savingsBalance: SECOND_MEMBER_BALANCE,
  },
};

export function findMemberById(memberId: string): Member | undefined {
  return MEMBERS_BY_ID[memberId];
}
