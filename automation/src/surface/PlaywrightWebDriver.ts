import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Policy } from '../config.ts';
import { checkAction, type GuardrailDecision } from '../guardrails/policy.ts';
import { parseAriaSnapshot } from './ariaYaml.ts';
import { buildSnapshot, DEFAULT_SNAPSHOT_LIMITS, type SnapshotLimits } from './snapshot.ts';
import type {
  ActFailureCode,
  ActResult,
  Action,
  ElementRef,
  Observation,
  ScreenshotStore,
  SurfaceDriver,
  SurfaceSession,
  TargetDescriptor,
} from './SurfaceDriver.ts';

type AriaRole = Parameters<Page['getByRole']>[0];

/** Playwright's aria snapshot labels bare text runs with a pseudo-role that `getByRole` rejects. */
const TEXT_PSEUDO_ROLE = 'text';

/** Roles whose displayed value lives in the control's value rather than its text content. */
const INPUT_VALUE_ROLES: ReadonlySet<string> = new Set([
  'combobox',
  'searchbox',
  'spinbutton',
  'textbox',
]);

const OBSERVATION_LABEL = 'observation';
const RESOLVED_REF_PREFIX = 'r';

/**
 * Client-rendered apps mount after `load` fires, so the accessibility tree is briefly
 * empty. A short settle beats `networkidle`, which never arrives under a dev server
 * holding an HMR socket open.
 */
const POST_NAVIGATION_SETTLE_MS = 250;

export interface PlaywrightWebDriverOptions {
  readonly headless: boolean;
  readonly actionTimeoutMs: number;
  readonly navigationTimeoutMs: number;
  readonly policy: Policy;
  readonly snapshotLimits?: SnapshotLimits;
  readonly screenshotStore?: ScreenshotStore | null;
}

/**
 * The web implementation of {@link SurfaceDriver}.
 *
 * One browser, one context, one page for the whole run: the same live session is what a
 * human operator takes over during escalation, so nothing here may create a throwaway
 * context to do a piece of work in.
 */
export class PlaywrightWebDriver implements SurfaceDriver, SurfaceSession {
  private readonly targets = new Map<string, TargetDescriptor>();
  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly options: PlaywrightWebDriverOptions;
  private resolvedRefCount = 0;
  private closed = false;

  private constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    options: PlaywrightWebDriverOptions,
  ) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.options = options;
  }

  static async launch(options: PlaywrightWebDriverOptions): Promise<PlaywrightWebDriver> {
    const browser = await chromium.launch({ headless: options.headless });
    const context = await browser.newContext();
    context.setDefaultTimeout(options.actionTimeoutMs);
    context.setDefaultNavigationTimeout(options.navigationTimeoutMs);
    const page = await context.newPage();

    return new PlaywrightWebDriver(browser, context, page, options);
  }

  async perceive(): Promise<Observation> {
    const yamlSnapshot = await this.page.ariaSnapshot({ timeout: this.options.actionTimeoutMs });
    const limits = this.options.snapshotLimits ?? DEFAULT_SNAPSHOT_LIMITS;
    const { nodes, targets, truncated } = buildSnapshot(parseAriaSnapshot(yamlSnapshot), limits);

    this.targets.clear();
    for (const [ref, descriptor] of targets) {
      this.targets.set(ref, descriptor);
    }

    return {
      url: this.page.url(),
      title: await this.page.title(),
      capturedAt: new Date().toISOString(),
      nodes,
      truncated,
      screenshotPath: await this.captureScreenshot(OBSERVATION_LABEL),
    };
  }

  /**
   * Guardrails run first and unconditionally, before any page interaction, so nothing
   * that holds this driver — discovery, replay, or a future caller — can reach the page
   * without passing the same check.
   *
   * The plan's prose describes blocked actions as throwing a typed `PolicyViolation`.
   * This driver returns a normal `ActResult` with `failure.code` set to
   * `'policy_blocked'` or `'policy_intervention_required'` instead: every other failure
   * mode here (`unknown_ref`, `timeout`, ...) already reports through that same typed
   * result, and a thrown exception would be the one caller-visible divergence from that
   * contract — forcing discovery and replay to special-case guardrail failures instead
   * of handling one uniform shape. The two outcomes stay distinguishable by failure
   * code precisely so Milestone 7 can route `policy_intervention_required` to the HITL
   * path without redesigning this result.
   */
  async act(action: Action): Promise<ActResult> {
    const startedAt = Date.now();

    if (action.kind === 'navigate') {
      const decision = checkAction(action, this.options.policy);
      return decision.outcome === 'allow'
        ? this.navigate(action.url, startedAt)
        : this.policyFailed(action.kind, startedAt, decision);
    }

    const target = this.targets.get(action.ref);
    if (target === undefined) {
      return this.failed(action.kind, startedAt, 'unknown_ref', `No such ref "${action.ref}".`);
    }

    const decision = checkAction(action, this.options.policy, target.name);
    if (decision.outcome !== 'allow') {
      return this.policyFailed(action.kind, startedAt, decision, target);
    }

    const locator = await this.locate(target);
    if (locator === null) {
      return this.failed(
        action.kind,
        startedAt,
        'target_not_found',
        `Could not resolve ${describeTarget(target)} on the current page.`,
        target,
      );
    }

    try {
      const extracted = await this.perform(action, locator, target);
      return {
        ok: true,
        kind: action.kind,
        target,
        ...(extracted === null ? {} : { extracted }),
        durationMs: Date.now() - startedAt,
      };
    } catch (cause) {
      return this.failed(
        action.kind,
        startedAt,
        failureCodeFor(cause),
        `${action.kind} on ${describeTarget(target)} failed: ${messageOf(cause)}`,
        target,
      );
    }
  }

  /**
   * Returns a ref for a descriptor, reusing the ref from the current observation when the
   * descriptor names a node we already saw, and minting one when it was reached via a fallback.
   */
  async resolve(target: TargetDescriptor): Promise<ElementRef | null> {
    for (const [ref, candidate] of this.targets) {
      if (isSameTarget(candidate, target)) {
        return { ref, role: candidate.role, name: candidate.name };
      }
    }

    if ((await this.locate(target)) === null) {
      return null;
    }

    this.resolvedRefCount += 1;
    const ref = `${RESOLVED_REF_PREFIX}${this.resolvedRefCount}`;
    this.targets.set(ref, target);
    return { ref, role: target.role, name: target.name };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.context.close();
    await this.browser.close();
  }

  private async navigate(url: string, startedAt: number): Promise<ActResult> {
    try {
      await this.page.goto(url, {
        waitUntil: 'load',
        timeout: this.options.navigationTimeoutMs,
      });
      await this.page.waitForTimeout(POST_NAVIGATION_SETTLE_MS);
      return { ok: true, kind: 'navigate', durationMs: Date.now() - startedAt };
    } catch (cause) {
      return this.failed(
        'navigate',
        startedAt,
        'navigation_failed',
        `Could not load ${url}: ${messageOf(cause)}`,
      );
    }
  }

  private async perform(
    action: Exclude<Action, { kind: 'navigate' }>,
    locator: Locator,
    target: TargetDescriptor,
  ): Promise<string | null> {
    const timeout = this.options.actionTimeoutMs;

    switch (action.kind) {
      case 'click':
        await locator.click({ timeout });
        return null;
      case 'fill':
        await locator.fill(action.value, { timeout });
        return null;
      case 'select':
        await locator.selectOption(action.value, { timeout });
        return null;
      case 'extract':
        return await readValue(locator, target.role, timeout);
    }
  }

  /** Tries the exact descriptor first, then its scope, then each declared fallback in order. */
  private async locate(target: TargetDescriptor): Promise<Locator | null> {
    for (const candidate of this.candidates(target)) {
      try {
        if ((await candidate.count()) > 0) {
          return candidate;
        }
      } catch {
        // An unusable strategy (for example a role this surface does not know) is not an
        // error here; it just means the next fallback gets its turn.
      }
    }
    return null;
  }

  private *candidates(target: TargetDescriptor): Generator<Locator> {
    if (target.role !== TEXT_PSEUDO_ROLE) {
      yield this.byRole(this.page, target.role, target.name, target.nameMatch).nth(target.ordinal);

      if (target.within !== undefined) {
        const scope = this.byRole(this.page, target.within.role, target.within.name, 'exact');
        yield this.byRole(scope.first(), target.role, target.name, target.nameMatch).first();
      }
    }

    for (const fallback of target.fallbacks) {
      yield this.byFallback(fallback).first();
    }
  }

  private byRole(
    root: Page | Locator,
    role: string,
    name: string,
    nameMatch: TargetDescriptor['nameMatch'],
  ): Locator {
    // An empty accessible name means "unnamed", not "named the empty string", so the
    // name filter has to be left off entirely rather than passed as ''.
    return name === ''
      ? root.getByRole(role as AriaRole)
      : root.getByRole(role as AriaRole, { name, exact: nameMatch === 'exact' });
  }

  private byFallback(fallback: TargetDescriptor['fallbacks'][number]): Locator {
    switch (fallback.strategy) {
      case 'label':
        return this.page.getByLabel(fallback.value, { exact: true });
      case 'text':
        return this.page.getByText(fallback.value, { exact: true });
      case 'placeholder':
        return this.page.getByPlaceholder(fallback.value, { exact: true });
      case 'css':
        return this.page.locator(fallback.value);
    }
  }

  private async captureScreenshot(label: string): Promise<string | null> {
    const store = this.options.screenshotStore;
    if (store === null || store === undefined) {
      return null;
    }
    return await store.writeScreenshot(await this.page.screenshot(), label);
  }

  private policyFailed(
    kind: ActResult['kind'],
    startedAt: number,
    decision: Exclude<GuardrailDecision, { readonly outcome: 'allow' }>,
    target?: TargetDescriptor,
  ): ActResult {
    const code: ActFailureCode =
      decision.outcome === 'block' ? 'policy_blocked' : 'policy_intervention_required';
    return this.failed(kind, startedAt, code, decision.reason, target);
  }

  private failed(
    kind: ActResult['kind'],
    startedAt: number,
    code: ActFailureCode,
    message: string,
    target?: TargetDescriptor,
  ): ActResult {
    return {
      ok: false,
      kind,
      ...(target === undefined ? {} : { target }),
      failure: { code, message },
      durationMs: Date.now() - startedAt,
    };
  }
}

async function readValue(locator: Locator, role: string, timeout: number): Promise<string> {
  if (INPUT_VALUE_ROLES.has(role)) {
    return await locator.inputValue({ timeout });
  }
  return (await locator.innerText({ timeout })).trim();
}

function isSameTarget(left: TargetDescriptor, right: TargetDescriptor): boolean {
  return (
    left.role === right.role && left.name === right.name && left.ordinal === right.ordinal
  );
}

function describeTarget(target: TargetDescriptor): string {
  const name = target.name === '' ? '(unnamed)' : `"${target.name}"`;
  return `${target.role} ${name} #${target.ordinal}`;
}

function failureCodeFor(cause: unknown): ActFailureCode {
  return cause instanceof Error && cause.name === 'TimeoutError'
    ? 'timeout'
    : 'target_not_actionable';
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message.split('\n')[0] ?? cause.message : String(cause);
}
