export const SUB_ACCOUNT_TYPES = ['checking', 'savings', 'money_market'] as const;
export type SubAccountType = (typeof SUB_ACCOUNT_TYPES)[number];

export const SUB_ACCOUNT_TYPE_LABELS: Record<SubAccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  money_market: 'Money Market',
};

export const MIN_INITIAL_DEPOSIT_AMOUNT = 0.01;

export const ACCOUNT_TYPE_REQUIRED_MESSAGE = 'Account type is required';
export const NICKNAME_REQUIRED_MESSAGE = 'Nickname is required';
export const DEPOSIT_AMOUNT_REQUIRED_MESSAGE = 'Initial deposit amount is required';
export const DEPOSIT_AMOUNT_INVALID_MESSAGE = 'Initial deposit amount must be a positive number';

export interface SubAccountFormInput {
  accountType: SubAccountType | '';
  initialDepositAmount: string;
  nickname: string;
}

export type SubAccountFormErrors = Partial<Record<keyof SubAccountFormInput, string>>;

export interface SubAccountValidationResult {
  isValid: boolean;
  errors: SubAccountFormErrors;
}

export function validateSubAccountForm(input: SubAccountFormInput): SubAccountValidationResult {
  const errors: SubAccountFormErrors = {};

  if (input.accountType.trim().length === 0) {
    errors.accountType = ACCOUNT_TYPE_REQUIRED_MESSAGE;
  }

  if (input.nickname.trim().length === 0) {
    errors.nickname = NICKNAME_REQUIRED_MESSAGE;
  }

  const depositError = validateDepositAmount(input.initialDepositAmount);
  if (depositError) {
    errors.initialDepositAmount = depositError;
  }

  return { isValid: Object.keys(errors).length === 0, errors };
}

function validateDepositAmount(rawAmount: string): string | undefined {
  const trimmed = rawAmount.trim();
  if (trimmed.length === 0) {
    return DEPOSIT_AMOUNT_REQUIRED_MESSAGE;
  }

  const amount = Number(trimmed);
  if (Number.isNaN(amount) || amount < MIN_INITIAL_DEPOSIT_AMOUNT) {
    return DEPOSIT_AMOUNT_INVALID_MESSAGE;
  }

  return undefined;
}
