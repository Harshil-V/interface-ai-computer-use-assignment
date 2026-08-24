import { describe, expect, it } from 'vitest';
import type { ArtifactOutcome } from '../artifact/schema.ts';
import type { Observation, ObservationNode } from '../surface/SurfaceDriver.ts';
import { matchOutcome } from './outcomes.ts';

/** Mirrors `buildMemberSavingsBalanceArtifact`'s `OUTCOMES` — the three real declared outcomes. */
const OUTCOMES: readonly ArtifactOutcome[] = [
  {
    id: 'member_not_found',
    type: 'business_outcome',
    terminal: true,
    when: { role: 'alert', textMatches: 'No member found for ID' },
  },
  {
    id: 'validation_error',
    type: 'business_outcome',
    terminal: true,
    when: { role: 'alert', textMatches: 'Member ID is required' },
  },
  {
    id: 'session_expired',
    type: 'recoverable',
    when: { role: 'alert', textMatches: 'Session expired' },
    recovery: {
      action: 'click',
      target: { role: 'button', name: 'Start a new session', nameMatch: 'exact', ordinal: 0, fallbacks: [] },
      thenRestartFromStep: 's1',
      maxAttempts: 1,
    },
  },
];

function node(partial: Partial<ObservationNode> & { role: string }): ObservationNode {
  return { ref: 'n1', name: '', children: [], ...partial };
}

function observationWith(...nodes: readonly ObservationNode[]): Observation {
  return {
    url: 'http://localhost:5173/',
    title: 'Mock console',
    capturedAt: new Date().toISOString(),
    nodes,
    truncated: false,
    screenshotPath: null,
  };
}

describe('matchOutcome', () => {
  it('matches "No member found for ID ..." as the business_outcome member_not_found', () => {
    const observation = observationWith(node({ role: 'alert', text: 'No member found for ID 99999.' }));

    const match = matchOutcome(observation, OUTCOMES);

    expect(match?.outcome.id).toBe('member_not_found');
    expect(match?.outcome.type).toBe('business_outcome');
    expect(match?.detail).toBe('No member found for ID 99999.');
  });

  it('matches "Member ID is required" as the business_outcome validation_error', () => {
    const observation = observationWith(node({ role: 'alert', text: 'Member ID is required' }));

    const match = matchOutcome(observation, OUTCOMES);

    expect(match?.outcome.id).toBe('validation_error');
    expect(match?.outcome.type).toBe('business_outcome');
  });

  it('matches a "Session expired" alert whose message lives on a nested heading, as recoverable', () => {
    // Real Part A markup: the <div role="alert"> itself carries no text; the message
    // is on a child <h2>. This is the case aggregation exists to handle.
    const observation = observationWith(
      node({
        role: 'alert',
        children: [
          node({ role: 'heading', name: 'Session expired' }),
          node({ role: 'paragraph', text: 'Your session has been idle for too long and has expired.' }),
          node({ role: 'button', name: 'Start a new session' }),
        ],
      }),
    );

    const match = matchOutcome(observation, OUTCOMES);

    expect(match?.outcome.id).toBe('session_expired');
    expect(match?.outcome.type).toBe('recoverable');
    expect(match?.detail).toContain('Session expired');
  });

  it('returns null for an alert that matches none of the declared outcomes', () => {
    const observation = observationWith(node({ role: 'alert', text: 'Something unrelated happened.' }));

    expect(matchOutcome(observation, OUTCOMES)).toBeNull();
  });

  it('returns null when there is no matching-role node at all', () => {
    const observation = observationWith(node({ role: 'heading', name: 'Member lookup' }));

    expect(matchOutcome(observation, OUTCOMES)).toBeNull();
  });

  it('returns the first declared outcome that matches when more than one could apply', () => {
    // member_not_found is declared before validation_error; an alert containing both
    // fragments should resolve to whichever the artifact author listed first.
    const ambiguousOutcomes: readonly ArtifactOutcome[] = [
      OUTCOMES[1] as ArtifactOutcome,
      OUTCOMES[0] as ArtifactOutcome,
    ];
    const observation = observationWith(
      node({ role: 'alert', text: 'Member ID is required and No member found for ID 1.' }),
    );

    expect(matchOutcome(observation, ambiguousOutcomes)?.outcome.id).toBe('validation_error');
  });
});
