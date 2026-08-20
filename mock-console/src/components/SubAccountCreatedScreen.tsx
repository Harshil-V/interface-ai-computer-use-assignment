import type { Member } from '../fixtures/members';
import { SUB_ACCOUNT_TYPE_LABELS, type SubAccountFormInput } from '../domain/subAccountValidation';
import { formatCurrency } from '../utils/formatCurrency';

interface SubAccountCreatedScreenProps {
  member: Member;
  formInput: SubAccountFormInput;
  onBackToMemberDetail: () => void;
  onBackToLookup: () => void;
}

export function SubAccountCreatedScreen({
  member,
  formInput,
  onBackToMemberDetail,
  onBackToLookup,
}: SubAccountCreatedScreenProps) {
  const accountTypeLabel = formInput.accountType ? SUB_ACCOUNT_TYPE_LABELS[formInput.accountType] : '';
  const depositAmount = Number(formInput.initialDepositAmount);

  return (
    <section aria-labelledby="sub-account-created-heading">
      <h1 id="sub-account-created-heading">Sub-account created</h1>
      <p role="status" className="success-banner">
        A new {accountTypeLabel} sub-account "{formInput.nickname}" was opened for member{' '}
        {member.id} with an initial deposit of {formatCurrency(depositAmount)}.
      </p>
      <div className="actions">
        <button type="button" onClick={onBackToMemberDetail}>
          Back to member {member.id}
        </button>
        <button type="button" className="secondary" onClick={onBackToLookup}>
          Look up another member
        </button>
      </div>
    </section>
  );
}
