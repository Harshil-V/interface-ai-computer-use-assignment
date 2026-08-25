import type { Artifact } from './schema.ts';

export type ApprovalState = Artifact['approval']['state'];

/**
 * Both arms carry a reason so the caller can report *why* it proceeded, not just that it
 * did: permitting a draft under `--allow-draft` is a different event from replaying an
 * approved capability, and a silent permit would hide that difference.
 */
export type ApprovalDecision =
  | { readonly outcome: 'permit'; readonly reason: string }
  | { readonly outcome: 'refuse'; readonly reason: string };

function permit(reason: string): ApprovalDecision {
  return { outcome: 'permit', reason };
}

function refuse(reason: string): ApprovalDecision {
  return { outcome: 'refuse', reason };
}

/**
 * Decides whether a capability may be replayed unattended. Pure and side-effect free, in
 * the same shape as `guardrails/policy.ts`'s `checkAction`: this function owns the rule,
 * the CLI owns enforcement and the message it prints.
 *
 * Replay is the path an AI agent triggers in production with no human watching, so the
 * default is deny: a capability the model discovered but nobody reviewed does not get to
 * run on its own. `allowDraft` is the one override, granted per invocation by whoever
 * typed the command — never by config, which would make the gate ambient and invisible.
 */
export function checkUnattendedReplay(state: ApprovalState, allowDraft: boolean): ApprovalDecision {
  if (state === 'approved') {
    return permit('Artifact approval state is "approved".');
  }
  if (allowDraft) {
    return permit('Artifact approval state is "draft"; --allow-draft was passed for this run.');
  }
  return refuse('Artifact approval state is "draft", so unattended replay is refused.');
}
