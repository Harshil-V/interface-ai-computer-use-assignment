import { describe, expect, it } from 'vitest';
import type { RawAccessibilityNode } from './ariaYaml.ts';
import { buildSnapshot, DEFAULT_SNAPSHOT_LIMITS, type SnapshotLimits } from './snapshot.ts';

function raw(role: string, overrides: Partial<RawAccessibilityNode> = {}): RawAccessibilityNode {
  return {
    role,
    name: '',
    text: '',
    attributes: {},
    url: null,
    children: [],
    ...overrides,
  };
}

function build(nodes: readonly RawAccessibilityNode[], limits: Partial<SnapshotLimits> = {}) {
  return buildSnapshot(nodes, { ...DEFAULT_SNAPSHOT_LIMITS, ...limits });
}

function flatten(
  nodes: readonly { ref: string; children: readonly unknown[] }[],
): { ref: string }[] {
  return nodes.flatMap((node) => [
    node,
    ...flatten(node.children as readonly { ref: string; children: readonly unknown[] }[]),
  ]);
}

describe('buildSnapshot ref assignment', () => {
  it('assigns sequential refs in reading order', () => {
    const result = build([
      raw('main', {
        children: [raw('textbox', { name: 'Member ID' }), raw('button', { name: 'Look up' })],
      }),
    ]);

    expect(flatten(result.nodes).map((node) => node.ref)).toEqual(['n1', 'n2', 'n3']);
  });

  it('produces identical refs for identical input', () => {
    const input = [raw('button', { name: 'Look up' })];

    expect(build(input).nodes).toEqual(build(input).nodes);
  });
});

describe('buildSnapshot filtering', () => {
  it('keeps an actionable control that has neither name nor text', () => {
    const result = build([raw('textbox')]);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]?.role).toBe('textbox');
  });

  it('keeps a status-bearing node because business outcomes are classified off it', () => {
    const result = build([raw('alert', { text: 'No member found' })]);

    expect(result.nodes[0]).toMatchObject({ role: 'alert', text: 'No member found' });
  });

  it('drops a decorative node that carries no name, text, or kept descendant', () => {
    const result = build([raw('generic'), raw('button', { name: 'Go' })]);

    expect(result.nodes.map((node) => node.role)).toEqual(['button']);
  });

  it('lifts kept descendants out of a dropped container rather than losing them', () => {
    const result = build([
      raw('generic', {
        children: [raw('generic', { children: [raw('button', { name: 'Go' })] })],
      }),
    ]);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({ role: 'button', name: 'Go', ref: 'n1' });
  });

  it('keeps an unnamed container that has a kept descendant', () => {
    const result = build([raw('rowgroup', { children: [raw('cell', { name: '12345' })] })]);

    expect(result.nodes[0]?.role).toBe('rowgroup');
    expect(result.nodes[0]?.children[0]?.name).toBe('12345');
  });

  it('drops a text node that only restates a sibling control name', () => {
    const result = build([
      raw('region', {
        name: 'Member lookup',
        children: [raw('text', { text: 'Member ID' }), raw('textbox', { name: 'Member ID' })],
      }),
    ]);

    expect(result.nodes[0]?.children.map((node) => node.role)).toEqual(['textbox']);
  });

  it('drops a caption that only restates the name of its own container', () => {
    const result = build([
      raw('table', {
        name: 'Search result',
        children: [raw('caption', { text: 'Search result' }), raw('cell', { name: '12345' })],
      }),
    ]);

    expect(result.nodes[0]?.children.map((node) => node.role)).toEqual(['cell']);
  });

  it('keeps a text node whose content is not a restatement', () => {
    const result = build([
      raw('region', {
        name: 'Member detail',
        children: [raw('text', { text: 'Savings balance $1,240.55' })],
      }),
    ]);

    expect(result.nodes[0]?.children[0]?.text).toBe('Savings balance $1,240.55');
  });
});

describe('buildSnapshot state and text normalisation', () => {
  it('keeps semantic aria states', () => {
    const result = build([
      raw('textbox', { name: 'Member ID', attributes: { invalid: 'true', level: '1' } }),
    ]);

    expect(result.nodes[0]?.states).toEqual({ invalid: 'true', level: '1' });
  });

  it('drops presentational attributes that carry no semantics', () => {
    const result = build([
      raw('button', { name: 'Go', attributes: { cursor: 'pointer', box: '0,0,10,10' } }),
    ]);

    expect(result.nodes[0]?.states).toBeUndefined();
  });

  it('collapses whitespace in names and text', () => {
    const result = build([raw('alert', { text: 'No   member\n  found' })]);

    expect(result.nodes[0]?.text).toBe('No member found');
  });

  it('truncates text beyond the configured limit', () => {
    const result = build([raw('alert', { text: 'x'.repeat(50) })], { maxTextLength: 10 });

    expect(result.nodes[0]?.text).toBe(`${'x'.repeat(10)}…`);
  });
});

describe('buildSnapshot size cap', () => {
  it('does not flag truncation when the tree fits the budget', () => {
    const result = build([raw('button', { name: 'Go' })], { maxNodes: 5 });

    expect(result.truncated).toBe(false);
  });

  it('stops emitting nodes once the budget is exhausted and says so', () => {
    const buttons = Array.from({ length: 10 }, (_, index) => raw('button', { name: `B${index}` }));
    const result = build(buttons, { maxNodes: 3 });

    expect(flatten(result.nodes)).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('applies the budget across nesting levels', () => {
    const result = build(
      [
        raw('region', {
          name: 'Outer',
          children: [raw('button', { name: 'A' }), raw('button', { name: 'B' })],
        }),
      ],
      { maxNodes: 2 },
    );

    expect(flatten(result.nodes)).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

describe('buildSnapshot target descriptors', () => {
  it('derives a descriptor from the node itself', () => {
    const result = build([raw('button', { name: 'Look up member' })]);

    expect(result.targets.get('n1')).toMatchObject({
      role: 'button',
      name: 'Look up member',
      nameMatch: 'exact',
      ordinal: 0,
    });
  });

  it('numbers ambiguous role and name pairs in reading order', () => {
    const result = build([
      raw('button', { name: 'View details' }),
      raw('button', { name: 'View details' }),
    ]);

    expect(result.targets.get('n1')?.ordinal).toBe(0);
    expect(result.targets.get('n2')?.ordinal).toBe(1);
  });

  it('numbers unnamed same-role siblings by position, not by their differing text', () => {
    // Mirrors a <dl> with two <dd> elements: both `definition`-role with no accessible
    // name, but different rendered text. `getByRole('definition')` (what a replay
    // actually resolves against) can only disambiguate by role + name, so both must
    // land in one ordinal sequence rather than each independently computing ordinal 0.
    const result = build([
      raw('definition', { text: 'Jordan Ellis' }),
      raw('definition', { text: '$1,240.55' }),
    ]);

    expect(result.targets.get('n1')?.ordinal).toBe(0);
    expect(result.targets.get('n2')?.ordinal).toBe(1);
  });

  it('counts filtered-out nodes when numbering, because the live surface still has them', () => {
    const result = build([
      raw('region', {
        name: 'Row',
        children: [raw('cell', { name: 'Total' }), raw('text', { text: 'Total' })],
      }),
      raw('text', { text: 'Total' }),
    ]);

    const keptText = flatten(result.nodes).find((node) => result.targets.get(node.ref)?.role === 'text');
    expect(result.targets.get(keptText?.ref ?? '')?.ordinal).toBe(1);
  });

  it('scopes a descriptor to its nearest named ancestor', () => {
    const result = build([
      raw('table', {
        name: 'Search result',
        children: [raw('button', { name: 'View details' })],
      }),
    ]);

    expect(result.targets.get('n2')?.within).toEqual({ role: 'table', name: 'Search result' });
  });

  it('leaves a top-level descriptor unscoped', () => {
    const result = build([raw('button', { name: 'Go' })]);

    expect(result.targets.get('n1')?.within).toBeUndefined();
  });

  it('offers a label fallback for named form controls', () => {
    const result = build([raw('textbox', { name: 'Member ID' })]);

    expect(result.targets.get('n1')?.fallbacks).toEqual([
      { strategy: 'label', value: 'Member ID' },
      { strategy: 'text', value: 'Member ID' },
    ]);
  });

  it('offers only a text fallback for a named non-input control', () => {
    const result = build([raw('button', { name: 'Look up member' })]);

    expect(result.targets.get('n1')?.fallbacks).toEqual([
      { strategy: 'text', value: 'Look up member' },
    ]);
  });

  it('falls back to text content for a status node that has no accessible name', () => {
    const result = build([raw('alert', { text: 'No member found' })]);

    expect(result.targets.get('n1')?.fallbacks).toEqual([
      { strategy: 'text', value: 'No member found' },
    ]);
  });

  it('prefers the accessible name over text content when both are present', () => {
    const result = build([raw('button', { name: 'View details', text: 'View' })]);

    expect(result.targets.get('n1')?.fallbacks).toEqual([
      { strategy: 'text', value: 'View details' },
    ]);
  });

  it('offers no fallback when there is neither a name nor text to fall back to', () => {
    const result = build([raw('textbox')]);

    expect(result.targets.get('n1')?.fallbacks).toEqual([]);
  });

  it('has a descriptor for every emitted node', () => {
    const result = build([
      raw('main', {
        children: [
          raw('region', { name: 'Member lookup', children: [raw('textbox', { name: 'Member ID' })] }),
        ],
      }),
    ]);

    for (const node of flatten(result.nodes)) {
      expect(result.targets.get(node.ref)).toBeDefined();
    }
  });
});
