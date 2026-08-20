interface DevToolsPanelProps {
  isSessionExpired: boolean;
  onForceExpireSession: () => void;
}

/**
 * Visible, discoverable escape hatch so a demo or an automation agent can produce the
 * session-expired state on demand instead of waiting out SESSION_IDLE_TIMEOUT_MS.
 * A matching window.__forceExpireSession() hook (see hooks/useSession.ts) covers
 * script-driven automation that can't click through the UI.
 */
export function DevToolsPanel({ isSessionExpired, onForceExpireSession }: DevToolsPanelProps) {
  return (
    // Clicks/keypresses here must not bubble to the app's global activity listener
    // (App.tsx), or forcing the session to expire would immediately re-activate it.
    <details className="dev-tools" onClick={(event) => event.stopPropagation()}>
      <summary>Dev tools (demo / automation only)</summary>
      <div className="panel">
        <p className="session-status" aria-live="polite">
          Session status: {isSessionExpired ? 'expired' : 'active'}
        </p>
        <button type="button" className="secondary" onClick={onForceExpireSession}>
          Force expire session
        </button>
      </div>
    </details>
  );
}
