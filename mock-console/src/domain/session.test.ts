import { describe, expect, it } from 'vitest';
import { isSessionExpired, SESSION_IDLE_TIMEOUT_MS, toForceExpiredTimestamp } from './session';

describe('isSessionExpired', () => {
  it('is not expired when no idle time has passed', () => {
    const lastActivityAt = 1_000_000;
    const now = lastActivityAt;

    expect(isSessionExpired(lastActivityAt, now)).toBe(false);
  });

  it('is not expired just under the idle timeout', () => {
    const lastActivityAt = 1_000_000;
    const now = lastActivityAt + SESSION_IDLE_TIMEOUT_MS - 1;

    expect(isSessionExpired(lastActivityAt, now)).toBe(false);
  });

  it('is expired exactly at the idle timeout boundary', () => {
    const lastActivityAt = 1_000_000;
    const now = lastActivityAt + SESSION_IDLE_TIMEOUT_MS;

    expect(isSessionExpired(lastActivityAt, now)).toBe(true);
  });

  it('is expired well past the idle timeout', () => {
    const lastActivityAt = 1_000_000;
    const now = lastActivityAt + SESSION_IDLE_TIMEOUT_MS * 10;

    expect(isSessionExpired(lastActivityAt, now)).toBe(true);
  });
});

describe('toForceExpiredTimestamp', () => {
  it('produces a last-activity timestamp that isSessionExpired treats as expired', () => {
    const now = 5_000_000;
    const forced = toForceExpiredTimestamp(now);

    expect(isSessionExpired(forced, now)).toBe(true);
  });
});
