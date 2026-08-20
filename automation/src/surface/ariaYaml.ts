import { parse as parseYaml } from 'yaml';

/**
 * One node of a surface's accessibility tree, before any filtering or ref assignment.
 * Deliberately shaped as plain data so the compaction step in `snapshot.ts` can be
 * unit-tested without a browser, and so a non-web driver can produce the same shape.
 */
export interface RawAccessibilityNode {
  readonly role: string;
  /** Accessible name; empty string when the node has none. */
  readonly name: string;
  /** Rendered text content or control value; empty string when the node has none. */
  readonly text: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly url: string | null;
  readonly children: readonly RawAccessibilityNode[];
}

/** `role "escaped name" [attr] [attr=value]` — the header of one aria-snapshot entry. */
const NODE_HEADER = /^([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*$/;
const ATTRIBUTE = /\[([^\]]*)\]/g;
const ESCAPED_CHARACTER = /\\(.)/g;

/** Playwright emits node properties, as opposed to child nodes, under slash-prefixed keys. */
const PROPERTY_KEY_PREFIX = '/';
const URL_PROPERTY_KEY = '/url';

const BARE_ATTRIBUTE_VALUE = 'true';

/**
 * Parses the YAML accessibility snapshot produced by Playwright's `ariaSnapshot()`
 * into a plain tree. Kept separate from the driver so the wire format can change
 * without touching perception logic.
 */
export function parseAriaSnapshot(yamlText: string): RawAccessibilityNode[] {
  if (yamlText.trim() === '') {
    return [];
  }

  let document: unknown;
  try {
    document = parseYaml(yamlText);
  } catch (cause) {
    throw new Error(`Accessibility snapshot is not valid YAML: ${describe(cause)}`, { cause });
  }

  if (document === null || document === undefined) {
    return [];
  }

  if (!Array.isArray(document)) {
    throw new Error(
      `Accessibility snapshot must be a sequence of nodes, received ${typeName(document)}.`,
    );
  }

  return toNodes(document);
}

function toNodes(items: readonly unknown[]): RawAccessibilityNode[] {
  return items.flatMap(toNodesFromItem);
}

function toNodesFromItem(item: unknown): RawAccessibilityNode[] {
  if (typeof item === 'string') {
    return [buildNode(item, undefined)];
  }

  if (isPlainObject(item)) {
    return Object.entries(item)
      .filter(([key]) => !key.startsWith(PROPERTY_KEY_PREFIX))
      .map(([header, body]) => buildNode(header, body));
  }

  throw new Error(`Accessibility snapshot entry must be a node, received ${typeName(item)}.`);
}

function buildNode(header: string, body: unknown): RawAccessibilityNode {
  const { role, name, attributes } = parseHeader(header);
  const { children, url, text } = parseBody(body);

  return { role, name, text, attributes, url, children };
}

function parseHeader(header: string): {
  role: string;
  name: string;
  attributes: Record<string, string>;
} {
  const match = NODE_HEADER.exec(header.trim());
  if (match === null) {
    throw new Error(`Unrecognised accessibility snapshot node header: "${header}".`);
  }

  const [, role = '', quotedName, attributeText = ''] = match;

  return {
    role,
    name: quotedName === undefined ? '' : unescape(quotedName),
    attributes: parseAttributes(attributeText),
  };
}

function parseAttributes(attributeText: string): Record<string, string> {
  const attributes: Record<string, string> = {};

  for (const [, content = ''] of attributeText.matchAll(ATTRIBUTE)) {
    const separatorIndex = content.indexOf('=');
    if (separatorIndex === -1) {
      attributes[content.trim()] = BARE_ATTRIBUTE_VALUE;
      continue;
    }
    attributes[content.slice(0, separatorIndex).trim()] = content.slice(separatorIndex + 1).trim();
  }

  return attributes;
}

function parseBody(body: unknown): {
  children: RawAccessibilityNode[];
  url: string | null;
  text: string;
} {
  if (body === null || body === undefined) {
    return { children: [], url: null, text: '' };
  }

  if (Array.isArray(body)) {
    return { children: toNodes(body), url: findUrlProperty(body), text: '' };
  }

  return { children: [], url: null, text: String(body) };
}

function findUrlProperty(items: readonly unknown[]): string | null {
  for (const item of items) {
    if (isPlainObject(item) && URL_PROPERTY_KEY in item) {
      return String(item[URL_PROPERTY_KEY]);
    }
  }
  return null;
}

function unescape(value: string): string {
  return value.replace(ESCAPED_CHARACTER, '$1');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  return value === null ? 'null' : typeof value;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
