import { useState, type FormEvent } from 'react';
import type { Member } from '../fixtures/members';
import {
  SUB_ACCOUNT_TYPES,
  SUB_ACCOUNT_TYPE_LABELS,
  validateSubAccountForm,
  type SubAccountFormErrors,
  type SubAccountFormInput,
} from '../domain/subAccountValidation';
import { SessionExpiredNotice } from './SessionExpiredNotice';

interface OpenSubAccountScreenProps {
  member: Member;
  isSessionExpired: boolean;
  onReestablishSession: () => void;
  onContinueToConfirmation: (formInput: SubAccountFormInput) => void;
  onCancel: () => void;
}

const EMPTY_FORM_INPUT: SubAccountFormInput = {
  accountType: '',
  initialDepositAmount: '',
  nickname: '',
};

export function OpenSubAccountScreen({
  member,
  isSessionExpired,
  onReestablishSession,
  onContinueToConfirmation,
  onCancel,
}: OpenSubAccountScreenProps) {
  const [formInput, setFormInput] = useState<SubAccountFormInput>(EMPTY_FORM_INPUT);
  const [errors, setErrors] = useState<SubAccountFormErrors>({});

  if (isSessionExpired) {
    return <SessionExpiredNotice onReestablish={onReestablishSession} />;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = validateSubAccountForm(formInput);
    setErrors(result.errors);
    if (result.isValid) {
      onContinueToConfirmation(formInput);
    }
  }

  function updateField<K extends keyof SubAccountFormInput>(field: K, value: SubAccountFormInput[K]) {
    setFormInput((current) => ({ ...current, [field]: value }));
  }

  return (
    <section aria-labelledby="open-sub-account-heading">
      <h1 id="open-sub-account-heading">Open sub-account for member {member.id}</h1>
      <form onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="accountType">Account type</label>
          <select
            id="accountType"
            value={formInput.accountType}
            onChange={(event) => updateField('accountType', event.target.value as SubAccountFormInput['accountType'])}
            aria-invalid={Boolean(errors.accountType)}
            aria-describedby={errors.accountType ? 'accountType-error' : undefined}
          >
            <option value="">Select an account type</option>
            {SUB_ACCOUNT_TYPES.map((type) => (
              <option key={type} value={type}>
                {SUB_ACCOUNT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          {errors.accountType && (
            <p id="accountType-error" role="alert" className="error-banner">
              {errors.accountType}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="initialDepositAmount">Initial deposit amount (USD)</label>
          <input
            id="initialDepositAmount"
            name="initialDepositAmount"
            type="text"
            inputMode="decimal"
            value={formInput.initialDepositAmount}
            onChange={(event) => updateField('initialDepositAmount', event.target.value)}
            aria-invalid={Boolean(errors.initialDepositAmount)}
            aria-describedby={errors.initialDepositAmount ? 'initialDepositAmount-error' : undefined}
          />
          {errors.initialDepositAmount && (
            <p id="initialDepositAmount-error" role="alert" className="error-banner">
              {errors.initialDepositAmount}
            </p>
          )}
        </div>

        <div className="field">
          <label htmlFor="nickname">Nickname</label>
          <input
            id="nickname"
            name="nickname"
            type="text"
            value={formInput.nickname}
            onChange={(event) => updateField('nickname', event.target.value)}
            aria-invalid={Boolean(errors.nickname)}
            aria-describedby={errors.nickname ? 'nickname-error' : undefined}
          />
          {errors.nickname && (
            <p id="nickname-error" role="alert" className="error-banner">
              {errors.nickname}
            </p>
          )}
        </div>

        <div className="actions">
          <button type="submit">Continue to confirmation</button>
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
