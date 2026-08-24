import { describe, expect, it } from 'vitest';
import { InterventionStateError, InterventionStore } from './interventions.ts';

const baseInput = {
  runId: 'run-1',
  capabilityId: 'member.sub-account.open',
  goal: 'open a sub-account for member 12345',
  stepId: 's5',
  trigger: 'guardrail' as const,
  stopReason: 'Target name "Confirm and open sub-account" matches risky pattern /^confirm\\b/i.',
  screenshotPath: '/evidence/run-1/screenshots/003-observation.png',
};

describe('InterventionStore', () => {
  it('creates a record carrying every field an operator needs, open by default', () => {
    const store = new InterventionStore();

    const record = store.create(baseInput);

    expect(record).toMatchObject({ ...baseInput, status: 'open' });
    expect(record.interventionId).toMatch(/^intervention-\d+$/);
    expect(record.createdAt).toBeTruthy();
  });

  it('mints unique ids for successive interventions', () => {
    const store = new InterventionStore();

    const first = store.create(baseInput);
    const second = store.create({ ...baseInput, stepId: 's6' });

    expect(first.interventionId).not.toBe(second.interventionId);
  });

  it('current() returns the most recent intervention that is not resolved', () => {
    const store = new InterventionStore();
    const record = store.create(baseInput);

    expect(store.current()).toMatchObject({ interventionId: record.interventionId });
  });

  it('current() is undefined once the only intervention resolves', () => {
    const store = new InterventionStore();
    const record = store.create(baseInput);
    store.takeControl(record.interventionId);
    store.resolve(record.interventionId, 'abandoned', '');

    expect(store.current()).toBeUndefined();
  });

  it('allows the legal transition sequence: open -> in_progress -> resolved', () => {
    const store = new InterventionStore();
    const record = store.create(baseInput);

    const inProgress = store.takeControl(record.interventionId);
    expect(inProgress.status).toBe('in_progress');

    const resolved = store.resolve(record.interventionId, 'resumed', 'Confirmed on the customer\'s behalf.');
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('resumed');
    expect(resolved.note).toBe("Confirmed on the customer's behalf.");
  });

  it('rejects resolving an intervention that nobody has taken control of yet', () => {
    const store = new InterventionStore();
    const record = store.create(baseInput);

    expect(() => store.resolve(record.interventionId, 'abandoned', '')).toThrow(InterventionStateError);
  });

  it('rejects taking control of an intervention twice', () => {
    const store = new InterventionStore();
    const record = store.create(baseInput);
    store.takeControl(record.interventionId);

    expect(() => store.takeControl(record.interventionId)).toThrow(InterventionStateError);
  });

  it('rejects any transition on an already-resolved intervention', () => {
    const store = new InterventionStore();
    const record = store.create(baseInput);
    store.takeControl(record.interventionId);
    store.resolve(record.interventionId, 'abandoned', '');

    expect(() => store.takeControl(record.interventionId)).toThrow(InterventionStateError);
    expect(() => store.resolve(record.interventionId, 'resumed', '')).toThrow(InterventionStateError);
  });

  it('rejects an operation naming an intervention that does not exist', () => {
    const store = new InterventionStore();

    expect(() => store.takeControl('no-such-id')).toThrow(/no-such-id/);
  });

  it('awaitResolution() resolves once resolve() is called, carrying the resolution and note', async () => {
    const store = new InterventionStore();
    const record = store.create(baseInput);
    store.takeControl(record.interventionId);

    const pending = store.awaitResolution(record.interventionId);
    store.resolve(record.interventionId, 'resumed', 'Clicked confirm for the customer.');

    await expect(pending).resolves.toEqual({
      resolution: 'resumed',
      note: 'Clicked confirm for the customer.',
    });
  });

  it('awaitResolution() called after resolution has already happened settles immediately', async () => {
    const store = new InterventionStore();
    const record = store.create(baseInput);
    store.takeControl(record.interventionId);
    store.resolve(record.interventionId, 'abandoned', 'No transfer feature exists.');

    await expect(store.awaitResolution(record.interventionId)).resolves.toEqual({
      resolution: 'abandoned',
      note: 'No transfer feature exists.',
    });
  });

  it('supports more than one waiter on the same intervention', async () => {
    const store = new InterventionStore();
    const record = store.create(baseInput);
    store.takeControl(record.interventionId);

    const first = store.awaitResolution(record.interventionId);
    const second = store.awaitResolution(record.interventionId);
    store.resolve(record.interventionId, 'resumed', 'ok');

    await expect(Promise.all([first, second])).resolves.toEqual([
      { resolution: 'resumed', note: 'ok' },
      { resolution: 'resumed', note: 'ok' },
    ]);
  });
});
