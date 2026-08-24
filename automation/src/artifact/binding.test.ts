import { describe, expect, it } from 'vitest';
import { interpolate, resolveValue, UnboundReferenceError } from './binding.ts';

describe('interpolate', () => {
  it('replaces a single {name} placeholder with its bound value', () => {
    expect(interpolate('View details for member {memberId}', { memberId: '67890' })).toBe(
      'View details for member 67890',
    );
  });

  it('leaves a string with no placeholders unchanged', () => {
    expect(interpolate('Look up member', { memberId: '67890' })).toBe('Look up member');
  });

  it('replaces multiple distinct placeholders in one string', () => {
    expect(interpolate('{greeting}, {name}!', { greeting: 'Hello', name: 'Jordan' })).toBe('Hello, Jordan!');
  });

  it('replaces repeated occurrences of the same placeholder', () => {
    expect(interpolate('{x}-{x}', { x: 'a' })).toBe('a-a');
  });

  it('throws UnboundReferenceError for a placeholder with no bound param, rather than emitting a literal brace string', () => {
    expect(() => interpolate('Member {memberId}', {})).toThrow(UnboundReferenceError);
    expect(() => interpolate('Member {memberId}', {})).toThrow(/memberId/);
  });
});

describe('resolveValue', () => {
  it('resolves a { $input } reference to the bound param value', () => {
    expect(resolveValue({ $input: 'memberId' }, { memberId: '12345' })).toBe('12345');
  });

  it('interpolates a plain string value', () => {
    expect(resolveValue('prefix-{memberId}', { memberId: '12345' })).toBe('prefix-12345');
  });

  it('passes through a literal string with no placeholders', () => {
    expect(resolveValue('a literal value', {})).toBe('a literal value');
  });

  it('throws UnboundReferenceError for an unknown $input name', () => {
    expect(() => resolveValue({ $input: 'unknownField' }, { memberId: '12345' })).toThrow(
      UnboundReferenceError,
    );
    expect(() => resolveValue({ $input: 'unknownField' }, { memberId: '12345' })).toThrow(/unknownField/);
  });
});
