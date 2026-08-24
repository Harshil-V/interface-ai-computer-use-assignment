/** Which mechanism raised this intervention — the two triggers Milestone 7 routes into HITL. */
export type InterventionTrigger = 'guardrail' | 'stuck';

export type InterventionStatus = 'open' | 'in_progress' | 'resolved';

export type InterventionResolution = 'resumed' | 'abandoned';

/**
 * Everything an operator needs to decide what to do, plus everything a reviewer
 * needs afterward to see that the handoff was real. `capabilityId`/`goal` describe
 * *what* was being attempted; `stepId`/`stopReason` describe *where* and *why* it
 * stopped; `screenshotPath` is what the operator actually saw.
 */
export interface InterventionRecord {
  readonly interventionId: string;
  readonly runId: string;
  readonly capabilityId: string;
  readonly goal: string;
  readonly stepId: string;
  readonly trigger: InterventionTrigger;
  readonly stopReason: string;
  readonly screenshotPath: string | null;
  readonly status: InterventionStatus;
  readonly createdAt: string;
  readonly resolution?: InterventionResolution;
  readonly note?: string;
}

export interface CreateInterventionInput {
  readonly runId: string;
  readonly capabilityId: string;
  readonly goal: string;
  readonly stepId: string;
  readonly trigger: InterventionTrigger;
  readonly stopReason: string;
  readonly screenshotPath: string | null;
}

/** An operation attempted an illegal status transition, or named an intervention that does not exist. */
export class InterventionStateError extends Error {
  override readonly name = 'InterventionStateError';
}

type ResolutionWaiter = (value: { resolution: InterventionResolution; note: string }) => void;

const LEGAL_TRANSITIONS: Readonly<Record<InterventionStatus, ReadonlySet<InterventionStatus>>> = {
  open: new Set(['in_progress']),
  in_progress: new Set(['resolved']),
  resolved: new Set([]),
};

/**
 * In-memory store for the interventions raised during this process's lifetime.
 * One process drives one live browser session (see the plan's concurrency model),
 * so there is at most one *unresolved* intervention at a time in practice — but the
 * store keeps every record, resolved or not, as part of the run's evidence trail.
 *
 * {@link awaitResolution} is the in-process hand-back mechanism: the engine calling
 * it gets back a promise that only settles when an operator calls {@link resolve},
 * so resuming never requires polling a shared file or a second process.
 */
export class InterventionStore {
  private readonly records = new Map<string, InterventionRecord>();
  private readonly waiters = new Map<string, ResolutionWaiter[]>();
  private sequence = 0;

  create(input: CreateInterventionInput): InterventionRecord {
    this.sequence += 1;
    const record: InterventionRecord = {
      ...input,
      interventionId: `intervention-${this.sequence}`,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.records.set(record.interventionId, record);
    return record;
  }

  get(interventionId: string): InterventionRecord | undefined {
    return this.records.get(interventionId);
  }

  /** The most recently created intervention that isn't resolved yet — what the operator page shows by default. */
  current(): InterventionRecord | undefined {
    let latest: InterventionRecord | undefined;
    for (const record of this.records.values()) {
      if (record.status !== 'resolved') {
        latest = record;
      }
    }
    return latest;
  }

  takeControl(interventionId: string): InterventionRecord {
    return this.transition(interventionId, 'in_progress', {});
  }

  resolve(interventionId: string, resolution: InterventionResolution, note: string): InterventionRecord {
    const updated = this.transition(interventionId, 'resolved', { resolution, note });
    const pending = this.waiters.get(interventionId) ?? [];
    this.waiters.delete(interventionId);
    for (const notify of pending) {
      notify({ resolution, note });
    }
    return updated;
  }

  /**
   * Resolves once {@link resolve} is called for this intervention. Returns
   * immediately if it already has been — the caller may start waiting either
   * before or after the HTTP hand-back request lands.
   */
  awaitResolution(interventionId: string): Promise<{ resolution: InterventionResolution; note: string }> {
    const existing = this.records.get(interventionId);
    if (existing?.status === 'resolved') {
      return Promise.resolve({ resolution: existing.resolution ?? 'abandoned', note: existing.note ?? '' });
    }

    return new Promise((notify) => {
      const pending = this.waiters.get(interventionId) ?? [];
      pending.push(notify);
      this.waiters.set(interventionId, pending);
    });
  }

  private transition(
    interventionId: string,
    next: InterventionStatus,
    extra: Partial<Pick<InterventionRecord, 'resolution' | 'note'>>,
  ): InterventionRecord {
    const current = this.records.get(interventionId);
    if (current === undefined) {
      throw new InterventionStateError(`No intervention with id "${interventionId}".`);
    }
    if (!LEGAL_TRANSITIONS[current.status].has(next)) {
      throw new InterventionStateError(
        `Cannot move intervention "${interventionId}" from "${current.status}" to "${next}".`,
      );
    }

    const updated: InterventionRecord = { ...current, ...extra, status: next };
    this.records.set(interventionId, updated);
    return updated;
  }
}
