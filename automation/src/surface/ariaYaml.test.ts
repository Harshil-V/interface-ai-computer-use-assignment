import { describe, expect, it } from 'vitest';
import { parseAriaSnapshot } from './ariaYaml.ts';

describe('parseAriaSnapshot', () => {
  it('returns nothing for an empty snapshot', () => {
    expect(parseAriaSnapshot('')).toEqual([]);
    expect(parseAriaSnapshot('   \n  ')).toEqual([]);
  });

  it('parses a leaf node that has only a role', () => {
    const [node] = parseAriaSnapshot('- separator');

    expect(node).toMatchObject({ role: 'separator', name: '', text: '', children: [] });
  });

  it('parses a role with an accessible name', () => {
    const [node] = parseAriaSnapshot('- button "Look up member"');

    expect(node).toMatchObject({ role: 'button', name: 'Look up member', text: '' });
  });

  it('parses a role whose scalar value is its text content', () => {
    const [node] = parseAriaSnapshot('- alert: Member ID is required');

    expect(node).toMatchObject({ role: 'alert', name: '', text: 'Member ID is required' });
  });

  it('parses a node that has both an accessible name and text content', () => {
    const [node] = parseAriaSnapshot('- textbox "Member ID": "12345"');

    expect(node).toMatchObject({ role: 'textbox', name: 'Member ID', text: '12345' });
  });

  it('parses bare attributes as the string "true"', () => {
    const [node] = parseAriaSnapshot('- textbox "Member ID" [invalid]');

    expect(node?.attributes).toEqual({ invalid: 'true' });
  });

  it('parses keyed attributes and keeps every one of them', () => {
    const [node] = parseAriaSnapshot('- heading "Member lookup" [level=1] [cursor=pointer]');

    expect(node).toMatchObject({ role: 'heading', name: 'Member lookup' });
    expect(node?.attributes).toEqual({ level: '1', cursor: 'pointer' });
  });

  it('parses nested children', () => {
    const nodes = parseAriaSnapshot(
      ['- main:', '  - region "Member lookup":', '    - button "Look up member"'].join('\n'),
    );

    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.role).toBe('main');
    expect(nodes[0]?.children[0]?.role).toBe('region');
    expect(nodes[0]?.children[0]?.children[0]).toMatchObject({
      role: 'button',
      name: 'Look up member',
    });
  });

  it('keeps repeated sibling roles as distinct nodes', () => {
    const nodes = parseAriaSnapshot(
      ['- rowgroup:', '  - cell "12345"', '  - cell "$1,240.55"'].join('\n'),
    );

    expect(nodes[0]?.children.map((child) => child.name)).toEqual(['12345', '$1,240.55']);
  });

  it('lifts the /url property off a link instead of treating it as a child', () => {
    const nodes = parseAriaSnapshot(
      ['- link "Read more":', '  - /url: "#more-info"'].join('\n'),
    );

    expect(nodes[0]).toMatchObject({ role: 'link', name: 'Read more', url: '#more-info' });
    expect(nodes[0]?.children).toEqual([]);
  });

  it('reports no url for nodes that have none', () => {
    expect(parseAriaSnapshot('- button "Go"')[0]?.url).toBeNull();
  });

  it('parses an accessible name containing escaped quotes', () => {
    const [node] = parseAriaSnapshot('- button "Say \\"hello\\""');

    expect(node?.name).toBe('Say "hello"');
  });

  it('parses a real Playwright snapshot of the member lookup screen', () => {
    const nodes = parseAriaSnapshot(
      [
        '- main:',
        '  - region "Member lookup":',
        '    - heading "Member lookup" [level=1]',
        '    - text: Member ID',
        '    - textbox "Member ID"',
        '    - button "Look up member"',
        '  - group: Dev tools (demo / automation only)',
      ].join('\n'),
    );

    const region = nodes[0]?.children[0];
    expect(region?.name).toBe('Member lookup');
    expect(region?.children.map((child) => child.role)).toEqual([
      'heading',
      'text',
      'textbox',
      'button',
    ]);
    expect(nodes[0]?.children[1]).toMatchObject({
      role: 'group',
      text: 'Dev tools (demo / automation only)',
    });
  });

  it('throws a descriptive error when the snapshot is not a node sequence', () => {
    expect(() => parseAriaSnapshot('just: a mapping')).toThrow(/sequence/i);
  });
});
