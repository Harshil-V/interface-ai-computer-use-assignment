import { describe, expect, it } from 'vitest';
import { maskValue, REDACTED_PLACEHOLDER, redactText, VISIBLE_SUFFIX_LENGTH } from './redaction.ts';

describe('maskValue', () => {
  it('returns low-sensitivity values verbatim', () => {
    expect(maskValue('Look up member', 'low')).toBe('Look up member');
  });

  it('keeps only the last few characters of a quasi-identifier', () => {
    expect(maskValue('123456789', 'quasi-identifier')).toBe('*****6789');
  });

  it('preserves the length of a masked quasi-identifier so evidence stays comparable', () => {
    const memberId = '00012345';

    expect(maskValue(memberId, 'quasi-identifier')).toHaveLength(memberId.length);
  });

  it('masks a quasi-identifier entirely when it is too short to partially reveal', () => {
    expect(maskValue('1234', 'quasi-identifier')).toBe('****');
    expect(maskValue('12', 'quasi-identifier')).toBe('**');
  });

  it('leaves no residue of a sensitive value', () => {
    const masked = maskValue('4111111111111111', 'sensitive');

    expect(masked).toBe(REDACTED_PLACEHOLDER);
    expect(masked).not.toContain('1111');
  });

  it('returns empty input unchanged for every class', () => {
    expect(maskValue('', 'low')).toBe('');
    expect(maskValue('', 'quasi-identifier')).toBe('');
    expect(maskValue('', 'sensitive')).toBe('');
  });

  it('reveals exactly VISIBLE_SUFFIX_LENGTH characters', () => {
    const masked = maskValue('abcdefghij', 'quasi-identifier');

    expect(masked.slice(-VISIBLE_SUFFIX_LENGTH)).toBe('ghij');
    expect(masked.slice(0, -VISIBLE_SUFFIX_LENGTH)).toBe('******');
  });
});

describe('redactText', () => {
  it('leaves ordinary UI copy untouched', () => {
    expect(redactText('Member ID is required')).toBe('Member ID is required');
  });

  it('does not mistake a currency amount for a payment card number', () => {
    expect(redactText('$1,240.55')).toBe('$1,240.55');
  });

  it('redacts a social security number', () => {
    expect(redactText('SSN 123-45-6789 on file')).toBe(`SSN ${REDACTED_PLACEHOLDER} on file`);
  });

  it('redacts a payment card number regardless of separators', () => {
    expect(redactText('card 4111 1111 1111 1111')).toBe(`card ${REDACTED_PLACEHOLDER}`);
    expect(redactText('card 4111-1111-1111-1111')).toBe(`card ${REDACTED_PLACEHOLDER}`);
  });

  it('redacts an api-key style bearer token', () => {
    expect(redactText('Authorization: Bearer sk-ant-abcdef0123456789abcdef')).toBe(
      `Authorization: ${REDACTED_PLACEHOLDER}`,
    );
  });

  it('applies caller-supplied rules using the class-appropriate mask', () => {
    const text = 'Member 987654321 has balance $84,302.19';
    const redacted = redactText(text, [
      { value: '987654321', sensitivity: 'quasi-identifier' },
      { value: '$84,302.19', sensitivity: 'sensitive' },
    ]);

    expect(redacted).toBe(`Member *****4321 has balance ${REDACTED_PLACEHOLDER}`);
  });

  it('replaces every occurrence of a rule value', () => {
    const redacted = redactText('12345 then 12345', [
      { value: '12345', sensitivity: 'sensitive' },
    ]);

    expect(redacted).toBe(`${REDACTED_PLACEHOLDER} then ${REDACTED_PLACEHOLDER}`);
  });

  it('treats rule values as literals rather than regular expressions', () => {
    const redacted = redactText('balance a.c', [{ value: 'a.c', sensitivity: 'sensitive' }]);

    expect(redacted).toBe(`balance ${REDACTED_PLACEHOLDER}`);
    expect(redactText('abc', [{ value: 'a.c', sensitivity: 'sensitive' }])).toBe('abc');
  });

  it('ignores rules whose value is empty so it cannot mangle the whole string', () => {
    expect(redactText('anything', [{ value: '', sensitivity: 'sensitive' }])).toBe('anything');
  });

  it('skips low-sensitivity rules entirely', () => {
    expect(redactText('member 12345', [{ value: '12345', sensitivity: 'low' }])).toBe(
      'member 12345',
    );
  });
});
