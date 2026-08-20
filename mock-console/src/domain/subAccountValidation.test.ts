import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_TYPE_REQUIRED_MESSAGE,
  DEPOSIT_AMOUNT_INVALID_MESSAGE,
  DEPOSIT_AMOUNT_REQUIRED_MESSAGE,
  NICKNAME_REQUIRED_MESSAGE,
  validateSubAccountForm,
  type SubAccountFormInput,
} from './subAccountValidation';

function validInput(overrides: Partial<SubAccountFormInput> = {}): SubAccountFormInput {
  return {
    accountType: 'savings',
    initialDepositAmount: '100.50',
    nickname: 'Vacation fund',
    ...overrides,
  };
}

describe('validateSubAccountForm', () => {
  it('is valid when every field is filled in correctly', () => {
    const result = validateSubAccountForm(validInput());

    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual({});
  });

  it('requires an account type', () => {
    const result = validateSubAccountForm(validInput({ accountType: '' }));

    expect(result.isValid).toBe(false);
    expect(result.errors.accountType).toBe(ACCOUNT_TYPE_REQUIRED_MESSAGE);
  });

  it('requires a non-empty nickname', () => {
    const result = validateSubAccountForm(validInput({ nickname: '   ' }));

    expect(result.isValid).toBe(false);
    expect(result.errors.nickname).toBe(NICKNAME_REQUIRED_MESSAGE);
  });

  it('requires an initial deposit amount', () => {
    const result = validateSubAccountForm(validInput({ initialDepositAmount: '' }));

    expect(result.isValid).toBe(false);
    expect(result.errors.initialDepositAmount).toBe(DEPOSIT_AMOUNT_REQUIRED_MESSAGE);
  });

  it('rejects a non-numeric deposit amount', () => {
    const result = validateSubAccountForm(validInput({ initialDepositAmount: 'abc' }));

    expect(result.isValid).toBe(false);
    expect(result.errors.initialDepositAmount).toBe(DEPOSIT_AMOUNT_INVALID_MESSAGE);
  });

  it('rejects a zero deposit amount', () => {
    const result = validateSubAccountForm(validInput({ initialDepositAmount: '0' }));

    expect(result.isValid).toBe(false);
    expect(result.errors.initialDepositAmount).toBe(DEPOSIT_AMOUNT_INVALID_MESSAGE);
  });

  it('rejects a negative deposit amount', () => {
    const result = validateSubAccountForm(validInput({ initialDepositAmount: '-5' }));

    expect(result.isValid).toBe(false);
    expect(result.errors.initialDepositAmount).toBe(DEPOSIT_AMOUNT_INVALID_MESSAGE);
  });

  it('accepts a decimal deposit amount', () => {
    const result = validateSubAccountForm(validInput({ initialDepositAmount: '25.75' }));

    expect(result.isValid).toBe(true);
  });
});
