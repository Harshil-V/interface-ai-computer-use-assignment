/**
 * Milestone 7 demo #2 (forced stuck, real discovery run).
 *
 * Runs real LLM discovery against a goal the mock console cannot satisfy — there is
 * no funds-transfer feature anywhere in Part A. The model is expected to call the
 * `stuck` tool, which `DiscoveryAgent.ts` routes into the same intervention path a
 * guardrail block uses during replay (see `handleStuck` in `DiscoveryAgent.ts`).
 *
 * This script stands in for "the human" the same way demo #1 does: real HTTP calls
 * against the real operator server sharing this run's real `ControlLease` /
 * `InterventionStore`. Here the human's decision is to abandon — there is nothing to
 * fix on the page, since the capability genuinely does not exist — so this demo never
 * touches `driver.liveOperatorPage`.
 */
import { loadConfig } from '../src/config.ts';
import { runDiscovery } from '../src/discovery/DiscoveryAgent.ts';
import { EvidenceRecorder } from '../src/evidence/EvidenceRecorder.ts';
import { ControlLease } from '../src/hitl/ControlLease.ts';
import { InterventionStore, type InterventionRecord } from '../src/hitl/interventions.ts';
import { startOperatorServer } from '../src/hitl/operatorServer.ts';
import { PlaywrightWebDriver } from '../src/surface/PlaywrightWebDriver.ts';

const OPERATOR_PORT = 4312;
const ENTRY_URL = 'http://localhost:5173/';
const GOAL = "Transfer $500 from member 12345's savings sub-account into a checking account.";
const POLL_INTERVAL_MS = 200;
// Generous: the model genuinely explores before giving up (it has no way to know in
// advance that no transfer feature exists), and the policy's own `maxRunDurationMs`
// budget is 5 minutes — this just needs to stay a bit under that.
const WAIT_FOR_INTERVENTION_TIMEOUT_MS = 280000;
const OPERATOR_NOTE =
  'Confirmed: there is no funds-transfer feature anywhere in this console. Abandoning — ' +
  'this capability does not exist to build a discovery run against.';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.anthropicApiKey === null) {
    throw new Error('Missing ANTHROPIC_API_KEY — see automation/.env.example.');
  }

  const recorder = await EvidenceRecorder.create({
    rootDir: config.evidenceDir,
    mode: 'discovery',
    goal: `Demo #2: forced-stuck HITL discovery. Goal: ${GOAL}`,
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
    const navigation = await driver.act({ kind: 'navigate', url: ENTRY_URL });
    recorder.recordStep({
      type: 'navigate',
      reason: 'Open the target surface for this demo.',
      action: { kind: 'navigate', url: ENTRY_URL },
      outcome: navigation.ok ? 'ok' : 'failed',
      url: ENTRY_URL,
    });
    if (!navigation.ok) {
      throw new Error(navigation.failure?.message ?? `Could not load ${ENTRY_URL}.`);
    }

    const discoveryPromise = runDiscovery({
      goal: GOAL,
      driver,
      recorder,
      policy: config.policy,
      anthropicApiKey: config.anthropicApiKey,
      model: config.anthropicModel,
      hitl: { lease, interventions },
    });

    const record = await waitForOpenIntervention(interventions);
    console.log('Intervention raised (trigger should be "stuck"):', record);
    console.log('Lease owner while paused:', lease.current());

    await postJson(`${operator.url}api/take-control`, { interventionId: record.interventionId });
    console.log('Took control. Lease owner:', lease.current());

    // The human's decision here is to abandon — there is nothing on the page to fix.
    await postJson(`${operator.url}api/hand-back`, {
      interventionId: record.interventionId,
      resolution: 'abandoned',
      note: OPERATOR_NOTE,
    });
    console.log('Handed back (abandoned). Lease owner:', lease.current());

    const outcome = await discoveryPromise;
    console.log('DiscoveryOutcome:', JSON.stringify(outcome, null, 2));

    const runLogPath = await recorder.finish({
      status: 'failed',
      detail: `Model declared itself stuck: ${outcome.stuckReason ?? '(no reason given)'} ` +
        `(intervention "${outcome.interventionId}", resolution: ${outcome.escalationResolution})`,
    });
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
  throw new Error('Timed out waiting for the discovery run to raise an intervention (model never called "stuck").');
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
