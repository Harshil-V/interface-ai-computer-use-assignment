/**
 * Session model that replaces a login screen (see docs/2026-08-13-computer-use-automation-notes.md §3):
 * a session is established in-memory on first app load and expires after an idle period,
 * giving automation a real "session expired" state to exercise without a full auth flow.
 */

export const SESSION_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** One millisecond of margin keeps this comfortably past the boundary the tests assert on. */
const FORCE_EXPIRE_MARGIN_MS = 1;

export function isSessionExpired(lastActivityAt: number, now: number): boolean {
  return now - lastActivityAt >= SESSION_IDLE_TIMEOUT_MS;
}

/** Backdates "last activity" so the session reads as expired on the very next check. */
export function toForceExpiredTimestamp(now: number): number {
  return now - SESSION_IDLE_TIMEOUT_MS - FORCE_EXPIRE_MARGIN_MS;
}
