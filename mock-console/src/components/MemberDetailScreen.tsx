import type { Member } from '../fixtures/members';
import { formatCurrency } from '../utils/formatCurrency';
import { SessionExpiredNotice } from './SessionExpiredNotice';

interface MemberDetailScreenProps {
  member: Member;
  isSessionExpired: boolean;
  onReestablishSession: () => void;
  onOpenSubAccount: () => void;
  onBackToLookup: () => void;
}

export function MemberDetailScreen({
  member,
  isSessionExpired,
  onReestablishSession,
  onOpenSubAccount,
  onBackToLookup,
}: MemberDetailScreenProps) {
  if (isSessionExpired) {
    return <SessionExpiredNotice onReestablish={onReestablishSession} />;
  }

  return (
    <section aria-labelledby="member-detail-heading">
      <h1 id="member-detail-heading">Member {member.id}</h1>
      <div className="card">
        <dl>
          <dt>Full name</dt>
          <dd>{member.fullName}</dd>
          <dt>Savings balance</dt>
          <dd>{formatCurrency(member.savingsBalance)}</dd>
        </dl>
      </div>
      <div className="actions">
        <button type="button" onClick={onOpenSubAccount}>
          Open sub-account
        </button>
        <button type="button" className="secondary" onClick={onBackToLookup}>
          Back to member lookup
        </button>
      </div>
    </section>
  );
}
