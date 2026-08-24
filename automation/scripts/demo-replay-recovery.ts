/**
 * Demo #2 (recoverable-outcome replay, real run).
 *
 * `member.savings-balance.read.v1.json` declares `session_expired` as a `recoverable`
 * outcome with a real recovery policy: click "Start a new session", then restart the
 * replay from step `s1` (`ReplayEngine.runRecovery`). This script drives a real replay
 * of that artifact and, mid-run, forces the mock console's session to expire by clicking
 * the "Force expire session" button in `DevToolsPanel` — the same visible escape hatch a
 * human demo would use — directly on the *live* Playwright page via
 * `driver.liveOperatorPage`, exactly as `demo-replay-intervention.ts` clicks the
 * confirmation button for its own scenario. This is a different trigger than the
 * `?forceExpireSession=1` query param already exercised in
 * `evidence/20260824T004055Z-fbigz2/` (which starts a run already-expired): this script
 * expires a session that starts out live, proving the DevTools-button/`forceExpire()`
 * code path independently of the URL-param path.
 *
 * Timing: `PlaywrightWebDriver.navigate()` deliberately waits `POST_NAVIGATION_SETTLE_MS`
 * (250ms, see that constant's comment) after the entry URL loads and before the replay
 * engine's own step `s1` (fill "Member ID") runs. That settle window is the one point in
 * an otherwise machine-speed replay with real spare time — every later inter-step gap is
 * just accessibility-snapshot computation, tens of milliseconds at most, far too tight to
 * reliably win a race from a second, external Playwright call. So this script polls for
 * the "Member ID" textbox (confirming the console has mounted) and clicks through the
 * DevTools panel inside that settle window, before step `s1` executes.
 *
 * That still produces a faithful "expires mid-replay, recovers, succeeds" run: because
 * `isSessionExpired` is sticky once forced (`mock-console/src/domain/session.ts`), it
 * makes no difference that the trigger click lands before step `s1` rather than after
 * step `s3` — steps `s1` (fill) and `s2` (click "Look up member") still execute for real
 * against a live-looking lookup screen (which is not session-gated), and the expired
 * state only becomes visible once step `s3` transitions to the member detail screen,
 * which is exactly where the artifact's declared `session_expired` pattern gets checked
 * and the declared recovery fires for real.
 */
import type { Page } from 'playwright';
import { loadConfig } from '../src/config.ts';
import { artifactFilePath, loadArtifact } from '../src/artifact/store.ts';
import { EvidenceRecorder } from '../src/evidence/EvidenceRecorder.ts';
import { ControlLease } from '../src/hitl/ControlLease.ts';
import { InterventionStore } from '../src/hitl/interventions.ts';
import { runReplay } from '../src/replay/ReplayEngine.ts';
import { PlaywrightWebDriver } from '../src/surface/PlaywrightWebDriver.ts';

const MEMBER_ID = '12345';
const MEMBER_ID_TEXTBOX_NAME = 'Member ID';
const DEV_TOOLS_SUMMARY_TEXT = 'Dev tools (demo / automation only)';
const FORCE_EXPIRE_BUTTON_NAME = 'Force expire session';
const WAIT_FOR_CONSOLE_MOUNT_TIMEOUT_MS = 5000;

async function main(): Promise<void> {
  const config = loadConfig();
  const artifact = loadArtifact(artifactFilePath('member.savings-balance.read', 1));
  const params = { memberId: MEMBER_ID };

  const recorder = await EvidenceRecorder.create({
    rootDir: config.evidenceDir,
    mode: 'replay',
    goal: `Replay "${artifact.id}" v${artifact.version} with ${JSON.stringify(params)}.`,
  });

  const lease = new ControlLease();
  const interventions = new InterventionStore();

  const driver = await PlaywrightWebDriver.launch({
    headless: config.headless,
    actionTimeoutMs: config.policy.limits.actionTimeoutMs,
    navigationTimeoutMs: config.policy.limits.navigationTimeoutMs,
    policy: config.policy,
    lease,
    snapshotLimits: {
      maxNodes: config.policy.limits.maxObservationNodes,
      maxTextLength: config.policy.limits.maxTextLength,
    },
    screenshotStore: recorder,
  });

  try {
    const replayPromise = runReplay({ artifact, params, driver, recorder, lease, interventions });

    await forceExpireSessionOnLivePage(driver.liveOperatorPage);
    console.log('Clicked "Force expire session" on the live page.');

    const result = await replayPromise;
    console.log('ReplayResult:', JSON.stringify(result, null, 2));

    const runLogPath = await recorder.finish(
      result.status === 'success'
        ? { status: 'completed' }
        : { status: 'failed', detail: JSON.stringify(result) },
    );
    console.log(`Evidence written to ${recorder.runDir}`);
    console.log(`Run log: ${runLogPath}`);
  } finally {
    await driver.close();
  }
}

/**
 * Waits for the live page to reach the member lookup screen (its Member ID textbox
 * visible), then clicks through the DevTools panel exactly as a human demo would: open
 * it, then click "Force expire session". See the module comment above for why landing
 * this before step `s1` runs is deliberate rather than a timing shortcut.
 */
async function forceExpireSessionOnLivePage(page: Page): Promise<void> {
  await page
    .getByRole('textbox', { name: MEMBER_ID_TEXTBOX_NAME, exact: true })
    .waitFor({ state: 'visible', timeout: WAIT_FOR_CONSOLE_MOUNT_TIMEOUT_MS });

  await page.getByText(DEV_TOOLS_SUMMARY_TEXT, { exact: true }).click();
  await page.getByRole('button', { name: FORCE_EXPIRE_BUTTON_NAME, exact: true }).click();
}

await main();
