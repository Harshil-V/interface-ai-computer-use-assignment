/**
 * Sensitivity classes for values the automation reads from or writes to a surface.
 *
 * - `low` — operational text with no privacy weight (button labels, headings).
 * - `quasi-identifier` — cannot identify a person alone but can in combination
 *   (member IDs, account numbers, dates of birth).
 * - `sensitive` — regulated or secret in its own right (balances, SSNs, card
 *   numbers, credentials, tokens).
 */
export type SensitivityClass = 'low' | 'quasi-identifier' | 'sensitive';

export const REDACTED_PLACEHOLDER = '[redacted]';

const MASK_CHARACTER = '*';

/**
 * Quasi-identifiers keep a short suffix so an operator can still correlate a run
 * against evidence, which is the whole point of keeping the log.
 */
export const VISIBLE_SUFFIX_LENGTH = 4;

export interface RedactionRule {
  readonly value: string;
  readonly sensitivity: SensitivityClass;
}

/**
 * Patterns applied to any text before it is persisted, so a value nobody classified
 * still cannot leak. Ordered most-specific first.
 */
const HIGH_RISK_PATTERNS: readonly RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/g,
  /\b(?:[Bb]earer|[Tt]oken)\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/g,
  /\b(?:\d[ -]?){13,19}\b/g,
];

/**
 * Masks a single value for persistence. Callers in-process keep the full value; only
 * the evidence and log boundary calls this.
 */
export function maskValue(value: string, sensitivity: SensitivityClass): string {
  if (value === '' || sensitivity === 'low') {
    return value;
  }

  if (sensitivity === 'sensitive') {
    return REDACTED_PLACEHOLDER;
  }

  if (value.length <= VISIBLE_SUFFIX_LENGTH) {
    return MASK_CHARACTER.repeat(value.length);
  }

  const hidden = MASK_CHARACTER.repeat(value.length - VISIBLE_SUFFIX_LENGTH);
  return `${hidden}${value.slice(-VISIBLE_SUFFIX_LENGTH)}`;
}

/**
 * Masks known values by literal match, then sweeps for high-risk shapes the caller
 * did not know about.
 */
export function redactText(text: string, rules: readonly RedactionRule[] = []): string {
  let redacted = text;

  for (const rule of rules) {
    if (rule.value === '' || rule.sensitivity === 'low') {
      continue;
    }
    const mask = maskValue(rule.value, rule.sensitivity);
    redacted = redacted.replaceAll(rule.value, () => mask);
  }

  for (const pattern of HIGH_RISK_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED_PLACEHOLDER);
  }

  return redacted;
}
