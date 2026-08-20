interface SessionExpiredNoticeProps {
  onReestablish: () => void;
}

/**
 * Distinct from "member not found": this represents the session itself lapsing,
 * not a business lookup outcome, per the frozen session model (see docs §3).
 */
export function SessionExpiredNotice({ onReestablish }: SessionExpiredNoticeProps) {
  return (
    <div className="card" role="alert">
      <h2>Session expired</h2>
      <p>Your session has been idle for too long and has expired. Start a new session to continue.</p>
      <button type="button" onClick={onReestablish}>
        Start a new session
      </button>
    </div>
  );
}
