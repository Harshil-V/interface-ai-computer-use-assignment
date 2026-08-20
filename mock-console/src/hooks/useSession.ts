import { useCallback, useEffect, useRef, useState } from 'react';
import { isSessionExpired, nextExpiredState, toForceExpiredTimestamp } from '../domain/session';

/** URL query param that force-expires the session on load, for reliable automation/demo setup. */
export const FORCE_EXPIRE_SESSION_QUERY_PARAM = 'forceExpireSession';

/** Global hook Playwright-style automation can call to force-expire the session deterministically. */
export const FORCE_EXPIRE_SESSION_WINDOW_HOOK = '__forceExpireSession';

/** Frequent enough that a demo timeout (minutes) reads as near-instant once it's crossed. */
const EXPIRY_CHECK_INTERVAL_MS = 1000;

export interface SessionController {
  isExpired: boolean;
  /** Resets the idle clock. Never clears an existing expiry — expiry is sticky. */
  recordActivity: () => void;
  /** The only way out of the expired state: the user acknowledged "session expired". */
  reestablishSession: () => void;
  /** Test-only escape hatch: skips waiting out SESSION_IDLE_TIMEOUT_MS in real time. */
  forceExpire: () => void;
}

function hasForceExpireQueryParam(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  return new URLSearchParams(window.location.search).get(FORCE_EXPIRE_SESSION_QUERY_PARAM) === '1';
}

/** Reads the ?forceExpireSession=1 URL param once so the session can start already-expired. */
function getInitialLastActivityAt(): number {
  const now = Date.now();
  return hasForceExpireQueryParam() ? toForceExpiredTimestamp(now) : now;
}

export function useSession(): SessionController {
  const [lastActivityAt, setLastActivityAt] = useState(getInitialLastActivityAt);
  const [isExpired, setIsExpired] = useState(() => isSessionExpired(lastActivityAt, Date.now()));
  const lastActivityRef = useRef(lastActivityAt);

  useEffect(() => {
    lastActivityRef.current = lastActivityAt;
  }, [lastActivityAt]);

  const recordActivity = useCallback(() => {
    setLastActivityAt(Date.now());
  }, []);

  const reestablishSession = useCallback(() => {
    setLastActivityAt(Date.now());
    setIsExpired(false);
  }, []);

  const forceExpire = useCallback(() => {
    const forcedTimestamp = toForceExpiredTimestamp(Date.now());
    setLastActivityAt(forcedTimestamp);
    setIsExpired(true);
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setIsExpired((wasExpired) => nextExpiredState(wasExpired, lastActivityRef.current, Date.now()));
    }, EXPIRY_CHECK_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const globalWindow = window as typeof window & Record<string, unknown>;
    globalWindow[FORCE_EXPIRE_SESSION_WINDOW_HOOK] = forceExpire;
    return () => {
      delete globalWindow[FORCE_EXPIRE_SESSION_WINDOW_HOOK];
    };
  }, [forceExpire]);

  return { isExpired, recordActivity, reestablishSession, forceExpire };
}
