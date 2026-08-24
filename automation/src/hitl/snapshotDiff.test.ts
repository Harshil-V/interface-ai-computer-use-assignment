import { describe, expect, it } from 'vitest';
import type { Observation, ObservationNode } from '../surface/SurfaceDriver.ts';
import { diffObservations } from './snapshotDiff.ts';

function node(partial: Partial<ObservationNode> & { role: string }): ObservationNode {
  return { ref: 'n1', name: '', children: [], ...partial };
}

function observation(url: string, ...nodes: readonly ObservationNode[]): Observation {
  return {
    url,
    title: 'Mock console',
    capturedAt: new Date().toISOString(),
    nodes,
    truncated: false,
    screenshotPath: null,
  };
}

const CONFIRM_PAGE = observation(
  'http://localhost:5173/',
  node({ role: 'heading', name: 'Confirm new sub-account' }),
  node({ role: 'button', name: 'Confirm and open sub-account' }),
  node({ role: 'button', name: 'Back to edit' }),
);

const CREATED_PAGE = observation(
  'http://localhost:5173/',
  node({ role: 'heading', name: 'Sub-account created' }),
  node({ role: 'status', text: 'A new Savings sub-account "Rainy day" was opened.' }),
  node({ role: 'button', name: 'Back to member 12345' }),
);

describe('diffObservations', () => {
  it('reports no changes for two identical observations', () => {
    const diff = diffObservations(CONFIRM_PAGE, CONFIRM_PAGE);

    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.urlChanged).toBe(false);
  });

  it('reports nodes that disappeared as removed and nodes that appeared as added', () => {
    const diff = diffObservations(CONFIRM_PAGE, CREATED_PAGE);

    expect(diff.removed).toEqual(
      expect.arrayContaining([
        { role: 'heading', name: 'Confirm new sub-account', text: '' },
        { role: 'button', name: 'Confirm and open sub-account', text: '' },
      ]),
    );
    expect(diff.added).toEqual(
      expect.arrayContaining([
        { role: 'heading', name: 'Sub-account created', text: '' },
        { role: 'button', name: 'Back to member 12345', text: '' },
      ]),
    );
  });

  it('flattens nested children into the comparison', () => {
    const before = observation(
      'http://localhost:5173/',
      node({ role: 'region', name: 'Member 12345', children: [node({ role: 'definition', text: '$1,240.55' })] }),
    );
    const after = observation(
      'http://localhost:5173/',
      node({ role: 'region', name: 'Member 12345', children: [node({ role: 'definition', text: '$1,300.00' })] }),
    );

    const diff = diffObservations(before, after);

    expect(diff.removed).toEqual([{ role: 'definition', name: '', text: '$1,240.55' }]);
    expect(diff.added).toEqual([{ role: 'definition', name: '', text: '$1,300.00' }]);
  });

  it('detects a URL change independent of node changes', () => {
    const diff = diffObservations(
      observation('http://localhost:5173/?forceExpireSession=1'),
      observation('http://localhost:5173/'),
    );

    expect(diff.urlChanged).toBe(true);
    expect(diff.beforeUrl).toBe('http://localhost:5173/?forceExpireSession=1');
    expect(diff.afterUrl).toBe('http://localhost:5173/');
  });

  it('does not report duplicate same-shaped nodes more than once per side', () => {
    const before = observation('http://localhost:5173/', node({ role: 'cell', text: 'x' }));
    const after = observation(
      'http://localhost:5173/',
      node({ role: 'cell', text: 'x' }),
      node({ role: 'cell', text: 'x' }),
      node({ role: 'cell', text: 'y' }),
    );

    const diff = diffObservations(before, after);

    expect(diff.added).toEqual([{ role: 'cell', name: '', text: 'y' }]);
    expect(diff.removed).toEqual([]);
  });
});
