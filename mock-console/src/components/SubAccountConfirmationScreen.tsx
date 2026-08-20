import type { Member } from '../fixtures/members';
import { SUB_ACCOUNT_TYPE_LABELS, type SubAccountFormInput } from '../domain/subAccountValidation';
import { formatCurrency } from '../utils/formatCurrency';
import { SessionExpiredNotice } from './SessionExpiredNotice';

interface SubAccountConfirmationScreenProps {
  member: Member;
  formInput: SubAccountFormInput;
  isSessionExpired: boolean;
  onReestablishSession: () => void;
  onConfirm: () => void;
  onBackToEdit: () => void;
}

/**
 * Explicit confirm step so opening a sub-account reads as an irreversible action worth
 * pausing on — this is the screen guardrails/HITL (Part B) will key off later.
 */
export function SubAccountConfirmationScreen({
  member,
  formInput,
  isSessionExpired,
  onReestablishSession,
  onConfirm,
  onBackToEdit,
}: SubAccountConfirmationScreenProps) {
  if (isSessionExpired) {
    return <SessionExpiredNotice onReestablish={onReestablishSession} />;
  }

  const accountTypeLabel = formInput.accountType ? SUB_ACCOUNT_TYPE_LABELS[formInput.accountType] : '';
  const depositAmount = Number(formInput.initialDepositAmount);

  return (
    <section aria-labelledby="confirm-sub-account-heading">
      <h1 id="confirm-sub-account-heading">Confirm new sub-account</h1>
      <p>
        Review the details below before creating this sub-account for member {member.id}. This
        action cannot be undone.
      </p>
      <div className="card">
        <dl>
          <dt>Account type</dt>
          <dd>{accountTypeLabel}</dd>
          <dt>Initial deposit</dt>
          <dd>{formatCurrency(depositAmount)}</dd>
          <dt>Nickname</dt>
          <dd>{formInput.nickname}</dd>
        </dl>
      </div>
      <div className="actions">
        <button type="button" onClick={onConfirm}>
          Confirm and open sub-account
        </button>
        <button type="button" className="secondary" onClick={onBackToEdit}>
          Back to edit
        </button>
      </div>
    </section>
  );
}
