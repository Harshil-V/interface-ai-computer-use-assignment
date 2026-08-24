/**
 * Milestone 7 demo #1 (risky action, real replay run).
 *
 * Replays `member.sub-account.open` for a real member. Its last step ("Confirm and
 * open sub-account") is `effect: "irreversible"` and matches the guardrail's
 * `^confirm\b` risky-name pattern, so `driver.act()` returns `policy_intervention_required`
 * and `runReplay` escalates instead of failing.
 *
 * This script then stands in for "the human" exactly as the assignment brief allows
 * ("mock the operator UI if needed, but make the handoff mechanism and the
 * control-transfer model real"): it calls the *real* operator HTTP API
 * (`/api/take-control`, `/api/hand-back`) against the *real* `ControlLease` and
 * `InterventionStore` this replay run is using, and clicks the confirmation button on
 * the *same, already-open* Playwright page via `driver.liveOperatorPage` — never
 * through `driver.act()`, which is reserved for automation and would refuse to act
 * anyway while the lease is held by "human".
 *
 * Everything here runs in one Node process with one browser context, matching this
 * project's concurrency model: the operator server and the paused replay run
 * genuinely coexist in the same process, sharing the same lease/interventions/driver.
 */
import { loadConfig } from '../src/config.ts';
import { artifactFilePath, loadArtifact } from '../src/artifact/store.ts';
import { EvidenceRecorder } from '../src/evidence/EvidenceRecorder.ts';
import { ControlLease } from '../src/hitl/ControlLease.ts';
import { InterventionStore, type InterventionRecord } from '../src/hitl/interventions.ts';
import { startOperatorServer } from '../src/hitl/operatorServer.ts';
import { runReplay } from '../src/replay/ReplayEngine.ts';
import { PlaywrightWebDriver } from '../src/surface/PlaywrightWebDriver.ts';

const OPERATOR_PORT = 4311;
const MEMBER_ID = '12345';
const CONFIRM_BUTTON_NAME = 'Confirm and open sub-account';
const POLL_INTERVAL_MS = 200;
const WAIT_FOR_INTERVENTION_TIMEOUT_MS = 20000;
const OPERATOR_NOTE =
  'Reviewed the confirmation summary against the request (Savings, $250, "Demo HITL sub-account") ' +
  'and it matches; clicking Confirm on the operator\'s behalf for this demo.';

async function main(): Promise<void> {
  const config = loadConfig();
  const artifact = loadArtifact(artifactFilePath('member.sub-account.open', 1));

  const recorder = await EvidenceRecorder.create({
    rootDir: config.evidenceDir,
    mode: 'replay',
    goal: `Demo #1: risky-action HITL replay of "${artifact.id}" for member ${MEMBER_ID}.`,
  });

  const lease = new ControlLease();
  const interventions = new InterventionStore();
  const operator = await startOperatorServer({
    port: OPERATOR_PORT,
    lease,
    interventions,
    evidenceRootDir: config.evidenceDir,
  });
  console.log(`Operator UI: ${operator.url}`);

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
    const params = {
      memberId: MEMBER_ID,
      accountType: 'Savings',
      initialDepositAmount: '250',
      nickname: 'Demo HITL sub-account',
    };

    const replayPromise = runReplay({ artifact, params, driver, recorder, lease, interventions });

    const record = await waitForOpenIntervention(interventions);
    console.log('Intervention raised:', record);
    console.log('Lease owner while paused:', lease.current());

    await postJson(`${operator.url}api/take-control`, { interventionId: record.interventionId });
    console.log('Took control. Lease owner:', lease.current());

    // The human's actual physical action: a real click on the real, already-open
    // page — the exact page the paused replay run was driving, not a fresh session.
    await driver.liveOperatorPage
      .getByRole('button', { name: CONFIRM_BUTTON_NAME, exact: true })
      .click();
    console.log(`Clicked "${CONFIRM_BUTTON_NAME}" directly on the live page.`);

    await postJson(`${operator.url}api/hand-back`, {
      interventionId: record.interventionId,
      resolution: 'resumed',
      note: OPERATOR_NOTE,
    });
    console.log('Handed back. Lease owner:', lease.current());

    const result = await replayPromise;
    console.log('ReplayResult:', JSON.stringify(result, null, 2));

    const runLogPath = await recorder.finish(
      result.status === 'escalated'
        ? { status: result.resolution === 'resumed' ? 'completed' : 'failed', detail: `Escalated (${result.resolution}): ${result.reason}` }
        : { status: 'completed' },
    );
    console.log(`Evidence written to ${recorder.runDir}`);
    console.log(`Run log: ${runLogPath}`);
  } finally {
    await driver.close();
    await operator.close();
  }
}

async function waitForOpenIntervention(interventions: InterventionStore): Promise<InterventionRecord> {
  const deadline = Date.now() + WAIT_FOR_INTERVENTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = interventions.current();
    if (current !== undefined && current.status === 'open') {
      return current;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('Timed out waiting for the replay run to raise an intervention.');
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`POST ${url} failed with ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
