import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Artifact } from './artifact/schema.ts';
import { artifactFilePath, loadArtifact, saveArtifact } from './artifact/store.ts';
import { ConfigError, loadConfig, type AutomationConfig } from './config.ts';
import { runDiscovery, type DiscoveryOutcome } from './discovery/DiscoveryAgent.ts';
import {
  buildDraftArtifact,
  buildMemberSavingsBalanceArtifact,
  buildSubAccountOpenArtifact,
} from './discovery/artifactBuilder.ts';
import { EvidenceRecorder, type RunMode, type RunOutcome } from './evidence/EvidenceRecorder.ts';
import { ControlLease } from './hitl/ControlLease.ts';
import { InterventionStore } from './hitl/interventions.ts';
import { startOperatorServer } from './hitl/operatorServer.ts';
import { runReplay } from './replay/ReplayEngine.ts';
import type { ReplayResult } from './replay/result.ts';
import { PlaywrightWebDriver } from './surface/PlaywrightWebDriver.ts';

const COMMAND_SNAPSHOT = 'snapshot';
const COMMAND_DISCOVER = 'discover';
const COMMAND_REPLAY = 'replay';
const COMMAND_OPERATOR = 'operator';
const DEFAULT_ARTIFACT_VERSION = 1;
const DEFAULT_OPERATOR_PORT = 4310;
const CAPABILITY_SAVINGS_BALANCE_READ = 'member.savings-balance.read';
const CAPABILITY_SUB_ACCOUNT_OPEN = 'member.sub-account.open';
const JSON_INDENT = 2;
const EXIT_FAILURE = 1;
const EXIT_SUCCESS = 0;

const USAGE = `Usage: npm run automation -- <command> [options]

Commands:
  ${COMMAND_SNAPSHOT} --url <url>
    Perceives a page once and writes an evidence folder for the run. Zero LLM spend.

  ${COMMAND_DISCOVER} --goal "<goal>" --url <url>
    Runs the LLM discovery loop against the page until it declares the goal met,
    declares a dead end, or exhausts its step/time budget. Prints a rough capability
    artifact and writes a full evidence folder.

  ${COMMAND_REPLAY} --artifact <path-or-id> [--input name=value ...] [--url <entryUrl>]
    Deterministically replays a frozen capability artifact. Zero LLM spend — this
    command never imports an LLM client. <path-or-id> is either a path to an artifact
    JSON file, or a bare capability id (optionally "id@version", defaulting to
    version ${DEFAULT_ARTIFACT_VERSION}) resolved under artifacts/. Repeat --input once per
    declared input. --url overrides the artifact's target.entryUrl, e.g. to append
    "?forceExpireSession=1" for the session_expired recovery demo.
    Starts an embedded operator HTTP server (see --operator-port) for the run's own
    lease/interventions, in case a step requires human intervention.
    Prints the structured ReplayResult to stdout. Exit code: 0 for "success" and
    "business_outcome" (a business outcome is a successful classification, not a
    crash) or an "escalated" run that resumed; non-zero for "failure" and an
    "escalated" run that was abandoned.

  ${COMMAND_OPERATOR} [--operator-port <port>]
    Starts a standalone operator HTTP server and blocks until Ctrl+C. Has no live
    automation run attached (each ${COMMAND_REPLAY}/${COMMAND_DISCOVER} run starts its own,
    sharing that run's own lease and interventions) — useful only to inspect the
    static operator page in isolation.

Options (all commands):
  --policy <path>        Policy JSON. Defaults to automation/config/policy.json,
                          falling back to policy.example.json.
  --evidence-dir <path>  Evidence root. Defaults to <repo>/evidence.
  --headless             Run without a visible browser window.
  --operator-port <port> Port for the operator HTTP server. Defaults to ${DEFAULT_OPERATOR_PORT}.

${COMMAND_DISCOVER}-only:
  --capability <id>      Which frozen capability to build if the goal is met:
                          "${CAPABILITY_SAVINGS_BALANCE_READ}" (default) or
                          "${CAPABILITY_SUB_ACCOUNT_OPEN}".

Discovery-only requires ANTHROPIC_API_KEY to be set (see automation/.env.example).

Observations and artifacts are printed to stdout unredacted; the copies written to
the evidence folder are redacted.`;

const options = {
  url: { type: 'string' },
  goal: { type: 'string' },
  policy: { type: 'string' },
  'evidence-dir': { type: 'string' },
  headless: { type: 'boolean' },
  artifact: { type: 'string' },
  input: { type: 'string', multiple: true },
  'operator-port': { type: 'string' },
  capability: { type: 'string' },
} as const;

type CliValues = {
  url?: string;
  goal?: string;
  policy?: string;
  'evidence-dir'?: string;
  headless?: boolean;
  artifact?: string;
  input?: string[];
  'operator-port'?: string;
  capability?: string;
};

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...argv], options, allowPositionals: true });
  const [command] = positionals;

  if (command === COMMAND_OPERATOR) {
    return await runOperatorCommand(values);
  }

  if (command === COMMAND_REPLAY) {
    return await runReplayCommand(values);
  }

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
  // A fresh, never-touched lease: `snapshot` only ever perceives/navigates, so there is
  // no path to an intervention and no operator server to start for it.
  const driver = await launchDriver(config, recorder, new ControlLease());

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
  const lease = new ControlLease();
  const interventions = new InterventionStore();
  const operator = await startOperatorServer({
    port: parseOperatorPort(values['operator-port']),
    lease,
    interventions,
    evidenceRootDir: config.evidenceDir,
  });
  process.stderr.write(`Operator UI (for a "stuck" escalation, if this run hits one): ${operator.url}\n`);
  const driver = await launchDriver(config, recorder, lease);

  try {
    await navigateOrThrow(driver, recorder, url);

    const outcome = await runDiscovery({
      goal,
      driver,
      recorder,
      policy: config.policy,
      anthropicApiKey: config.anthropicApiKey,
      model: config.anthropicModel,
      hitl: { lease, interventions },
    });

    const artifact = buildDraftArtifact(outcome, {
      goal,
      model: config.anthropicModel,
      discoveryRunId: recorder.runId,
    });

    process.stdout.write(`${JSON.stringify(artifact, null, JSON_INDENT)}\n`);

    const goalMet = outcome.stopReason === 'done';
    if (goalMet) {
      freezeAndSaveArtifact(outcome, recorder, config, values.capability ?? CAPABILITY_SAVINGS_BALANCE_READ);
    }

    const runLogPath = await recorder.finish(
      goalMet ? { status: 'completed' } : { status: 'failed', detail: describeUnmetGoal(outcome) },
    );
    process.stderr.write(`Evidence written to ${recorder.runDir}\nRun log: ${runLogPath}\n`);
    return goalMet ? 0 : EXIT_FAILURE;
  } catch (error) {
    return await failRun(recorder, 'Discovery', error);
  } finally {
    await driver.close();
    await operator.close();
  }
}

async function runReplayCommand(values: CliValues): Promise<number> {
  const artifactSpec = requireOption(values, 'artifact');
  if (artifactSpec === null) {
    return EXIT_FAILURE;
  }

  let artifact: Artifact;
  try {
    artifact = loadArtifact(resolveArtifactPath(artifactSpec));
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n`);
    return EXIT_FAILURE;
  }

  let params: Record<string, string>;
  try {
    params = parseInputs(values.input ?? []);
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n\n${USAGE}\n`);
    return EXIT_FAILURE;
  }

  const missingInputs = artifact.inputs.filter(
    (input) => input.required && params[input.name] === undefined,
  );
  if (missingInputs.length > 0) {
    process.stderr.write(
      `Missing required --input for: ${missingInputs.map((input) => input.name).join(', ')}.\n\n${USAGE}\n`,
    );
    return EXIT_FAILURE;
  }

  const config = loadConfig({
    policyPath: values.policy,
    evidenceDir: values['evidence-dir'],
    headless: values.headless,
  });

  const recorder = await createRecorder(
    config,
    'replay',
    `Replay "${artifact.id}" v${artifact.version} with ${JSON.stringify(params)}.`,
  );
  const lease = new ControlLease();
  const interventions = new InterventionStore();
  const operator = await startOperatorServer({
    port: parseOperatorPort(values['operator-port']),
    lease,
    interventions,
    evidenceRootDir: config.evidenceDir,
  });
  process.stderr.write(`Operator UI (for a guardrail escalation, if this run hits one): ${operator.url}\n`);
  const driver = await launchDriver(config, recorder, lease);

  try {
    const result = await runReplay({
      artifact,
      params,
      driver,
      recorder,
      lease,
      interventions,
      ...(values.url === undefined ? {} : { entryUrl: values.url }),
    });

    process.stdout.write(`${JSON.stringify(result, null, JSON_INDENT)}\n`);

    const runLogPath = await recorder.finish(runOutcomeFor(result));
    process.stderr.write(`Evidence written to ${recorder.runDir}\nRun log: ${runLogPath}\n`);
    return exitCodeFor(result);
  } catch (error) {
    return await failRun(recorder, 'Replay', error);
  } finally {
    await driver.close();
    await operator.close();
  }
}

/**
 * No live run is attached: each `replay`/`discover` invocation is its own process
 * and starts its own operator server against its own in-process lease and
 * interventions (per the plan's one-process-per-run concurrency model), so a
 * standalone instance can never show a real intervention. It exists for symmetry
 * with the other subcommands and to let the static page be inspected on its own.
 */
async function runOperatorCommand(values: CliValues): Promise<number> {
  const config = loadConfig({
    policyPath: values.policy,
    evidenceDir: values['evidence-dir'],
    headless: values.headless,
  });

  const handle = await startOperatorServer({
    port: parseOperatorPort(values['operator-port']),
    lease: new ControlLease(),
    interventions: new InterventionStore(),
    evidenceRootDir: config.evidenceDir,
  });

  process.stderr.write(
    `Operator UI listening at ${handle.url}\n` +
      `No live run is attached to this standalone instance — each ${COMMAND_REPLAY}/${COMMAND_DISCOVER} ` +
      'run starts its own operator server against its own lease and interventions, and prints its URL. ' +
      'Press Ctrl+C to stop.\n',
  );

  return await new Promise<number>((resolve) => {
    process.once('SIGINT', () => {
      void handle.close().then(() => resolve(EXIT_SUCCESS));
    });
  });
}

function parseOperatorPort(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_OPERATOR_PORT;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? DEFAULT_OPERATOR_PORT : parsed;
}

/** `<path>.json` is a file path; anything else is a capability id, optionally `id@version`. */
function resolveArtifactPath(spec: string): string {
  if (spec.endsWith('.json')) {
    // npm sets INIT_CWD to where the user actually ran `npm run` from, which is the
    // repo root for the root pass-through scripts — not `automation/`, which is what
    // `process.cwd()` would give us and would silently mis-resolve a repo-relative path.
    return path.resolve(process.env.INIT_CWD ?? process.cwd(), spec);
  }
  const separatorIndex = spec.lastIndexOf('@');
  if (separatorIndex === -1) {
    return artifactFilePath(spec, DEFAULT_ARTIFACT_VERSION);
  }
  const version = Number.parseInt(spec.slice(separatorIndex + 1), 10);
  return artifactFilePath(spec.slice(0, separatorIndex), version);
}

function parseInputs(pairs: readonly string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of pairs) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) {
      throw new Error(`--input "${pair}" is not in "name=value" form.`);
    }
    params[pair.slice(0, separatorIndex)] = pair.slice(separatorIndex + 1);
  }
  return params;
}

/**
 * A `business_outcome` is the capability's own declared classification of a known
 * runtime condition, not a crash — so it is recorded as `completed`, same as `success`.
 */
function runOutcomeFor(result: ReplayResult): RunOutcome {
  switch (result.status) {
    case 'success':
      return { status: 'completed' };
    case 'business_outcome':
      return { status: 'completed', detail: `Business outcome "${result.outcomeId}": ${result.detail}` };
    case 'escalated':
      return {
        status: result.resolution === 'resumed' ? 'completed' : 'failed',
        detail: `Escalated (${result.resolution}): ${result.reason}`,
      };
    case 'failure':
      return {
        status: 'failed',
        detail: `${result.error.class} failure at step "${result.error.stepId}": expected ${result.error.expected}, observed ${result.error.observed}`,
      };
  }
}

function exitCodeFor(result: ReplayResult): number {
  if (result.status === 'failure') {
    return EXIT_FAILURE;
  }
  if (result.status === 'escalated') {
    return result.resolution === 'resumed' ? EXIT_SUCCESS : EXIT_FAILURE;
  }
  return EXIT_SUCCESS;
}

/**
 * Each builder only recognizes its own capability's grounded shape (e.g.
 * `buildMemberSavingsBalanceArtifact` needs a fill on "Member ID" plus an extract).
 * A discovery run whose `--capability` doesn't match what actually happened fails
 * this cleanly rather than silently freezing the wrong capability, so a mismatch is
 * reported and the run still exits 0 on `goalMet` — freezing an artifact is this
 * milestone's deliverable, not a requirement of every discovery run.
 */
function freezeAndSaveArtifact(
  outcome: DiscoveryOutcome,
  recorder: EvidenceRecorder,
  config: AutomationConfig,
  capabilityId: string,
): void {
  try {
    const meta = {
      discoveryRunId: recorder.runId,
      evidencePath: `evidence/${recorder.runId}/`,
      model: config.anthropicModel,
    };
    const frozen =
      capabilityId === CAPABILITY_SUB_ACCOUNT_OPEN
        ? buildSubAccountOpenArtifact(outcome, meta)
        : buildMemberSavingsBalanceArtifact(outcome, meta);
    const savedPath = saveArtifact(frozen);
    process.stderr.write(`Frozen capability artifact written to ${savedPath}\n`);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`Could not freeze a capability artifact from this run: ${detail}\n`);
  }
}

function describeUnmetGoal(outcome: DiscoveryOutcome): string {
  if (outcome.stopReason === 'stuck') {
    const escalation =
      outcome.interventionId === undefined
        ? ''
        : ` (raised intervention "${outcome.interventionId}", resolution: ${outcome.escalationResolution ?? 'unresolved'})`;
    return `Model declared itself stuck: ${outcome.stuckReason ?? '(no reason given)'}${escalation}`;
  }
  if (outcome.stopReason === 'timeout') {
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
  const detail = messageOf(error);
  await recorder.finish({ status: 'failed', detail });
  process.stderr.write(`${label} failed: ${detail}\nEvidence written to ${recorder.runDir}\n`);
  return EXIT_FAILURE;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function createRecorder(config: AutomationConfig, mode: RunMode, goal: string): Promise<EvidenceRecorder> {
  return await EvidenceRecorder.create({ rootDir: config.evidenceDir, mode, goal });
}

async function launchDriver(
  config: AutomationConfig,
  recorder: EvidenceRecorder,
  lease: ControlLease,
): Promise<PlaywrightWebDriver> {
  return await PlaywrightWebDriver.launch({
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
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  const detail = error instanceof ConfigError || error instanceof Error ? error.message : String(error);
  process.stderr.write(`${detail}\n`);
  process.exitCode = EXIT_FAILURE;
}
