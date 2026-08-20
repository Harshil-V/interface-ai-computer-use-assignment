import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config.ts';
import { EvidenceRecorder } from './evidence/EvidenceRecorder.ts';
import { PlaywrightWebDriver } from './surface/PlaywrightWebDriver.ts';

const COMMAND_SNAPSHOT = 'snapshot';
const JSON_INDENT = 2;
const EXIT_FAILURE = 1;

const USAGE = `Usage: npm run automation -- ${COMMAND_SNAPSHOT} --url <url> [options]

Perceives a page once and writes an evidence folder for the run.

Options:
  --url <url>            Page to open. Required.
  --policy <path>        Policy JSON. Defaults to automation/config/policy.json,
                         falling back to policy.example.json.
  --evidence-dir <path>  Evidence root. Defaults to <repo>/evidence.
  --headless             Run without a visible browser window.

The observation is printed to stdout unredacted; the copy written to the evidence
folder is redacted.`;

const options = {
  url: { type: 'string' },
  policy: { type: 'string' },
  'evidence-dir': { type: 'string' },
  headless: { type: 'boolean' },
} as const;

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...argv], options, allowPositionals: true });
  const [command] = positionals;

  if (command !== COMMAND_SNAPSHOT) {
    process.stderr.write(`${command === undefined ? '' : `Unknown command "${command}".\n\n`}${USAGE}\n`);
    return EXIT_FAILURE;
  }

  const url = values.url;
  if (url === undefined || url.trim() === '') {
    process.stderr.write(`Missing required option --url.\n\n${USAGE}\n`);
    return EXIT_FAILURE;
  }

  return await runSnapshot(url, values);
}

async function runSnapshot(
  url: string,
  values: { policy?: string; 'evidence-dir'?: string; headless?: boolean },
): Promise<number> {
  const config = loadConfig({
    policyPath: values.policy,
    evidenceDir: values['evidence-dir'],
    headless: values.headless,
  });

  const recorder = await EvidenceRecorder.create({
    rootDir: config.evidenceDir,
    mode: 'snapshot',
    goal: `Perceive ${url}`,
  });

  const driver = await PlaywrightWebDriver.launch({
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

  try {
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

    const observation = await driver.perceive();
    const snapshotPath = await recorder.writeObservation(observation, 'observation');

    recorder.recordStep({
      type: 'perceive',
      reason: 'Capture the accessibility tree that later milestones will reason over.',
      outcome: 'ok',
      url: observation.url,
      ...(observation.screenshotPath === null
        ? {}
        : { screenshotPath: observation.screenshotPath }),
      snapshotPath,
    });

    process.stdout.write(`${JSON.stringify(observation, null, JSON_INDENT)}\n`);

    const runLogPath = await recorder.finish({ status: 'completed' });
    process.stderr.write(`Evidence written to ${recorder.runDir}\nRun log: ${runLogPath}\n`);
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await recorder.finish({ status: 'failed', detail });
    process.stderr.write(`Snapshot failed: ${detail}\nEvidence written to ${recorder.runDir}\n`);
    return EXIT_FAILURE;
  } finally {
    await driver.close();
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const detail = error instanceof ConfigError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`${detail}\n`);
  process.exitCode = EXIT_FAILURE;
}
