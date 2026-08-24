import { describe, expect, it } from 'vitest';
import { ControlLease, LeaseHeldError } from './ControlLease.ts';

describe('ControlLease', () => {
  it('starts out held by automation', () => {
    const lease = new ControlLease();

    expect(lease.current()).toBe('automation');
  });

  it('lets automation pause itself, then lets an operator take control from the pause', () => {
    const lease = new ControlLease();

    lease.acquire('paused');
    expect(lease.current()).toBe('paused');

    lease.acquire('human');
    expect(lease.current()).toBe('human');
  });

  it('lets a human take control directly, without an intervening pause', () => {
    const lease = new ControlLease();

    lease.acquire('human');

    expect(lease.current()).toBe('human');
  });

  it('is only one owner at a time: a second acquire while already held by a human fails', () => {
    const lease = new ControlLease();
    lease.acquire('human');

    expect(() => lease.acquire('human')).toThrow(LeaseHeldError);
    expect(lease.current()).toBe('human');
  });

  it('rejects re-pausing a lease that is already paused', () => {
    const lease = new ControlLease();
    lease.acquire('paused');

    expect(() => lease.acquire('paused')).toThrow(LeaseHeldError);
  });

  it('rejects a human trying to take control while another human already holds it', () => {
    const lease = new ControlLease();
    lease.acquire('paused');
    lease.acquire('human');

    expect(() => lease.acquire('human')).toThrow(LeaseHeldError);
  });

  it('release() returns the lease to automation from any owner', () => {
    const lease = new ControlLease();
    lease.acquire('paused');
    lease.acquire('human');

    lease.release();

    expect(lease.current()).toBe('automation');
  });

  it('release() is a no-op (not an error) when automation already holds the lease', () => {
    const lease = new ControlLease();

    expect(() => lease.release()).not.toThrow();
    expect(lease.current()).toBe('automation');
  });

  it('after a release, the lease can be paused and taken again for a second intervention', () => {
    const lease = new ControlLease();
    lease.acquire('paused');
    lease.acquire('human');
    lease.release();

    lease.acquire('paused');
    lease.acquire('human');

    expect(lease.current()).toBe('human');
  });

  it('assertAutomationMayAct() does not throw while automation holds the lease', () => {
    const lease = new ControlLease();

    expect(() => lease.assertAutomationMayAct()).not.toThrow();
  });

  it('assertAutomationMayAct() throws when a human holds the lease', () => {
    const lease = new ControlLease();
    lease.acquire('human');

    expect(() => lease.assertAutomationMayAct()).toThrow(LeaseHeldError);
  });

  it('assertAutomationMayAct() throws while the lease is merely paused, before any human has taken it', () => {
    const lease = new ControlLease();
    lease.acquire('paused');

    expect(() => lease.assertAutomationMayAct()).toThrow(LeaseHeldError);
  });
});
