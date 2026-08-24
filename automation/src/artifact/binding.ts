import type { ArtifactValue } from './schema.ts';

/** Thrown for a `{name}`/`$input` reference the caller's params don't cover — never resolved to a literal brace string. */
export class UnboundReferenceError extends Error {
  override readonly name = 'UnboundReferenceError';
}

const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/g;

/** Replaces every `{name}` placeholder in `template` with its bound param value. */
export function interpolate(template: string, params: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER_PATTERN, (_match, name: string) => requireParam(name, params));
}

/** Resolves a step's `value`: a plain string is interpolated, `{ $input: name }` resolves directly. */
export function resolveValue(value: ArtifactValue, params: Readonly<Record<string, string>>): string {
  return typeof value === 'string' ? interpolate(value, params) : requireParam(value.$input, params);
}

function requireParam(name: string, params: Readonly<Record<string, string>>): string {
  const value = params[name];
  if (value === undefined) {
    throw new UnboundReferenceError(`No value bound for input "${name}".`);
  }
  return value;
}
