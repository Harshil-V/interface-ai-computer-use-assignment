/**
 * Who may drive the live browser session right now. `paused` is distinct from
 * `human`: it is the moment between automation stopping itself (a guardrail
 * intervention or a discovery `stuck`) and an operator actually taking control —
 * nobody may act while paused, not even a human who hasn't clicked "Take control" yet.
 */
export type LeaseOwner = 'automation' | 'human' | 'paused';

/** A state that can be requested via {@link ControlLease.acquire}; `automation` is only reached via {@link ControlLease.release}. */
export type AcquirableOwner = Exclude<LeaseOwner, 'automation'>;

/** Thrown by `acquire()` on an illegal transition and by `assertAutomationMayAct()` while the lease is not free. */
export class LeaseHeldError extends Error {
  override readonly name = 'LeaseHeldError';
}

/**
 * The only transitions this system ever needs: automation pauses itself, an
 * operator takes control from a pause, and (separately) `release()` always frees
 * the lease back to automation. Once a human holds it, nothing but `release()`
 * moves it — not even another `acquire('human')` — so "one owner at a time" is
 * enforced by the transition table, not by convention.
 */
const LEGAL_ACQUISITIONS: Readonly<Record<LeaseOwner, ReadonlySet<AcquirableOwner>>> = {
  automation: new Set(['paused', 'human']),
  paused: new Set(['human']),
  human: new Set([]),
};

/**
 * Single-owner control lease for the one live browser session a run drives.
 * `PlaywrightWebDriver.act()` calls {@link assertAutomationMayAct} before touching
 * the page, in the same place as the guardrail check, so "automation cannot act
 * while a human holds control" is a structural property of the driver rather than
 * something callers have to remember to honor.
 */
export class ControlLease {
  private owner: LeaseOwner = 'automation';

  current(): LeaseOwner {
    return this.owner;
  }

  acquire(owner: AcquirableOwner): void {
    if (!LEGAL_ACQUISITIONS[this.owner].has(owner)) {
      throw new LeaseHeldError(
        `Cannot acquire the control lease for "${owner}": it is currently held by "${this.owner}".`,
      );
    }
    this.owner = owner;
  }

  /** Always succeeds and always returns to `automation`, regardless of who held it. */
  release(): void {
    this.owner = 'automation';
  }

  assertAutomationMayAct(): void {
    if (this.owner !== 'automation') {
      throw new LeaseHeldError(`Automation cannot act: the control lease is held by "${this.owner}".`);
    }
  }
}
