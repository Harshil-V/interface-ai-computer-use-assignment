import { parseArgs } from 'node:util';
import { saveArtifact } from './artifact/store.ts';
import { ConfigError, loadConfig, type AutomationConfig } from './config.ts';
import { runDiscovery, type DiscoveryOutcome } from './discovery/DiscoveryAgent.ts';
import { buildDraftArtifact, buildMemberSavingsBalanceArtifact } from './discovery/artifactBuilder.ts';
import { EvidenceRecorder, type RunMode } from './evidence/EvidenceRecorder.ts';
import { PlaywrightWebDriver } from './surface/PlaywrightWebDriver.ts';

const COMMAND_SNAPSHOT = 'snapshot';
const COMMAND_DISCOVER = 'discover';
const JSON_INDENT = 2;
const EXIT_FAILURE = 1;

const USAGE = `Usage: npm run automation -- <command> [options]

Commands:
  ${COMMAND_SNAPSHOT} --url <url>
    Perceives a page once and writes an evidence folder for the run. Zero LLM spend.

  ${COMMAND_DISCOVER} --goal "<goal>" --url <url>
    Runs the LLM discovery loop against the page until it declares the goal met,
    declares a dead end, or exhausts its step/time budget. Prints a rough capability
    artifact and writes a full evidence folder.

Options (all commands):
  --policy <path>        Policy JSON. Defaults to automation/config/policy.json,
                          falling back to policy.example.json.
  --evidence-dir <path>  Evidence root. Defaults to <repo>/evidence.
  --headless             Run without a visible browser window.

Discovery-only requires ANTHROPIC_API_KEY to be set (see automation/.env.example).

Observations and artifacts are printed to stdout unredacted; the copies written to
the evidence folder are redacted.`;

const options = {
  url: { type: 'string' },
  goal: { type: 'string' },
  policy: { type: 'string' },
  'evidence-dir': { type: 'string' },
  headless: { type: 'boolean' },
} as const;

type CliValues = {
  url?: string;
  goal?: string;
  policy?: string;
  'evidence-dir'?: string;
  headless?: boolean;
};

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...argv], options, allowPositionals: true });
  const [command] = positionals;

  if (command !== COMMAND_SNAPSHOT && command !== COMMAND_DISCOVER) {
    process.stderr.write(`${command === undefined ? '' : `Unknown command "${command}".\n\n`}${USAGE}\n`);
    return EXIT_FAILURE;
  }

  const url = requireOption(values, 'url');
  if (url === null) {
    return EXIT_FAILURE;
  }

  if (command === COMMAND_SNAPSHOT) {
    return await runSnapshot(url, values);
  }

  const goal = requireOption(values, 'goal');
  return goal === null ? EXIT_FAILURE : await runDiscover(goal, url, values);
}

function requireOption(values: CliValues, name: keyof CliValues): string | null {
  const value = values[name];
  if (typeof value !== 'string' || value.trim() === '') {
    process.stderr.write(`Missing required option --${name}.\n\n${USAGE}\n`);
    return null;
  }
  return value;
}

async function runSnapshot(url: string, values: CliValues): Promise<number> {
  const config = loadConfig({
    policyPath: values.policy,
    evidenceDir: values['evidence-dir'],
    headless: values.headless,
  });

  const recorder = await createRecorder(config, 'snapshot', `Perceive ${url}`);
  const driver = await launchDriver(config, recorder);

  try {
    await navigateOrThrow(driver, recorder, url);

    const observation = await driver.perceive();
    const snapshotPath = await recorder.writeObservation(observation, 'observation');

    recorder.recordStep({
      type: 'perceive',
      reason: 'Capture the accessibility tree that later milestones will reason over.',
      outcome: 'ok',
      url: observation.url,
      ...(observation.screenshotPath === null ? {} : { screenshotPath: observation.screenshotPath }),
      snapshotPath,
    });

    process.stdout.write(`${JSON.stringify(observation, null, JSON_INDENT)}\n`);

    const runLogPath = await recorder.finish({ status: 'completed' });
    process.stderr.write(`Evidence written to ${recorder.runDir}\nRun log: ${runLogPath}\n`);
    return 0;
  } catch (error) {
    return await failRun(recorder, 'Snapshot', error);
  } finally {
    await driver.close();
  }
}

async function runDiscover(goal: string, url: string, values: CliValues): Promise<number> {
  const config = loadConfig({
    policyPath: values.policy,
    evidenceDir: values['evidence-dir'],
    headless: values.headless,
  });

  if (config.anthropicApiKey === null) {
    process.stderr.write(
      'Missing ANTHROPIC_API_KEY.\n\n' +
        'The discover command drives a real Claude model and needs an API key to do it.\n' +
        'Copy automation/.env.example to automation/.env and set ANTHROPIC_API_KEY, then retry.\n',
    );
    return EXIT_FAILURE;
  }

  const recorder = await createRecorder(config, 'discovery', goal);
  const driver = await launchDriver(config, recorder);

  try {
    await navigateOrThrow(driver, recorder, url);

    const outcome = await runDiscovery({
      goal,
      driver,
      recorder,
      policy: config.policy,
      anthropicApiKey: config.anthropicApiKey,
      model: config.anthropicModel,
    });

    const artifact = buildDraftArtifact(outcome, {
      goal,
      model: config.anthropicModel,
      discoveryRunId: recorder.runId,
    });

    process.stdout.write(`${JSON.stringify(artifact, null, JSON_INDENT)}\n`);

    const goalMet = outcome.stopReason === 'done';
    if (goalMet) {
      freezeAndSaveArtifact(outcome, recorder, config);
    }

    const runLogPath = await recorder.finish(
      goalMet
        ? { status: 'completed' }
        : { status: 'failed', detail: describeUnmetGoal(outcome.stopReason, outcome.stuckReason) },
    );
    process.stderr.write(`Evidence written to ${recorder.runDir}\nRun log: ${runLogPath}\n`);
    return goalMet ? 0 : EXIT_FAILURE;
  } catch (error) {
    return await failRun(recorder, 'Discovery', error);
  } finally {
    await driver.close();
  }
}

/**
 * `buildMemberSavingsBalanceArtifact` only recognizes this one capability's grounded
 * shape (a fill on "Member ID" plus an extract). A discovery run against some other
 * goal fails this cleanly rather than silently freezing the wrong capability, so a
 * mismatch is reported and the run still exits 0 on `goalMet` — freezing an artifact is
 * this milestone's deliverable, not a requirement of every discovery run.
 */
function freezeAndSaveArtifact(
  outcome: DiscoveryOutcome,
  recorder: EvidenceRecorder,
  config: AutomationConfig,
): void {
  try {
    const frozen = buildMemberSavingsBalanceArtifact(outcome, {
      discoveryRunId: recorder.runId,
      evidencePath: `evidence/${recorder.runId}/`,
      model: config.anthropicModel,
    });
    const savedPath = saveArtifact(frozen);
    process.stderr.write(`Frozen capability artifact written to ${savedPath}\n`);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`Could not freeze a capability artifact from this run: ${detail}\n`);
  }
}

function describeUnmetGoal(stopReason: string, stuckReason: string | undefined): string {
  if (stopReason === 'stuck') {
    return `Model declared itself stuck: ${stuckReason ?? '(no reason given)'}`;
  }
  if (stopReason === 'timeout') {
    return 'Wall-clock timeout elapsed before the goal was met.';
  }
  return 'Step budget exhausted before the goal was met.';
}

async function navigateOrThrow(
  driver: PlaywrightWebDriver,
  recorder: EvidenceRecorder,
  url: string,
): Promise<void> {
  const navigation = await driver.act({ kind: 'navigate', url });
  recorder.recordStep({
    type: 'navigate',
    reason: 'Open the target surface named on the command line.',
    action: { kind: 'navigate', url },
    outcome: navigation.ok ? 'ok' : 'failed',
    ...(navigation.failure === undefined ? {} : { failure: navigation.failure }),
    url,
  });

  if (!navigation.ok) {
    throw new Error(navigation.failure?.message ?? `Could not load ${url}.`);
  }
}

async function failRun(recorder: EvidenceRecorder, label: string, error: unknown): Promise<number> {
  const detail = error instanceof Error ? error.message : String(error);
  await recorder.finish({ status: 'failed', detail });
  process.stderr.write(`${label} failed: ${detail}\nEvidence written to ${recorder.runDir}\n`);
  return EXIT_FAILURE;
}

async function createRecorder(config: AutomationConfig, mode: RunMode, goal: string): Promise<EvidenceRecorder> {
  return await EvidenceRecorder.create({ rootDir: config.evidenceDir, mode, goal });
}

async function launchDriver(config: AutomationConfig, recorder: EvidenceRecorder): Promise<PlaywrightWebDriver> {
  return await PlaywrightWebDriver.launch({
    headless: config.headless,
    actionTimeoutMs: config.policy.limits.actionTimeoutMs,
    navigationTimeoutMs: config.policy.limits.navigationTimeoutMs,
    policy: config.policy,
    snapshotLimits: {
      maxNodes: config.policy.limits.maxObservationNodes,
      maxTextLength: config.policy.limits.maxTextLength,
    },
    screenshotStore: recorder,
  });
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const detail = error instanceof ConfigError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`${detail}\n`);
  process.exitCode = EXIT_FAILURE;
}
