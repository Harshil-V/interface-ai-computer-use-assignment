import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  maskValue,
  redactText,
  type RedactionRule,
  type SensitivityClass,
} from '../guardrails/redaction.ts';
import type {
  ActFailure,
  Action,
  ActionKind,
  Observation,
  ObservationNode,
  ScreenshotStore,
} from '../surface/SurfaceDriver.ts';

const SCREENSHOTS_DIR = 'screenshots';
const SNAPSHOTS_DIR = 'snapshots';
const RUN_LOG_FILENAME = 'run.json';
const SEQUENCE_DIGITS = 3;
const JSON_INDENT = 2;
const RUN_ID_SUFFIX_LENGTH = 6;

/**
 * Values typed into a back-office banking screen are never assumed to be public, and
 * values read off one are assumed to be the regulated data itself. Callers that know
 * better classify explicitly on the action.
 */
const DEFAULT_INPUT_SENSITIVITY: SensitivityClass = 'quasi-identifier';
const DEFAULT_EXTRACT_SENSITIVITY: SensitivityClass = 'sensitive';

export type RunMode = 'snapshot' | 'discovery' | 'replay';

export type StepType = 'navigate' | 'perceive' | 'act' | 'note' | 'intervention';

export interface StepRecord {
  readonly type: StepType;
  /** Why the step happened — the part a reader cannot reconstruct from the screenshots. */
  readonly reason: string;
  readonly action?: Action;
  readonly outcome?: 'ok' | 'failed';
  readonly failure?: ActFailure;
  readonly extracted?: string;
  readonly extractSensitivity?: SensitivityClass;
  readonly url?: string;
  readonly screenshotPath?: string;
  readonly snapshotPath?: string;
  /** Free-text note an operator submitted with a hand-back; run through the high-risk redaction sweep before persisting. */
  readonly operatorNote?: string;
}

export interface RunOutcome {
  readonly status: 'completed' | 'failed';
  readonly detail?: string;
}

export interface EvidenceRecorderOptions {
  readonly rootDir: string;
  readonly mode: RunMode;
  readonly goal: string;
  readonly runId?: string;
}

interface PersistedStep {
  readonly index: number;
  readonly at: string;
  readonly type: StepType;
  readonly reason: string;
  readonly action?: Record<string, unknown>;
  readonly outcome?: 'ok' | 'failed';
  readonly failure?: ActFailure;
  readonly extracted?: string;
  readonly url?: string;
  readonly screenshot?: string;
  readonly snapshot?: string;
  readonly operatorNote?: string;
}

/**
 * Owns the `evidence/<runId>/` folder. Everything written here passes through
 * redaction first; the in-process caller keeps the unmasked values.
 *
 * Discovery and replay runs write the same shape, so one reader serves both.
 */
export class EvidenceRecorder implements ScreenshotStore {
  readonly runId: string;
  readonly runDir: string;

  private readonly mode: RunMode;
  private readonly goal: string;
  private readonly startedAt = new Date().toISOString();
  private readonly steps: PersistedStep[] = [];
  private readonly rules: RedactionRule[] = [];
  /** Numbered per artifact kind so a screenshot and the snapshot taken with it share an index. */
  private readonly sequences = new Map<string, number>();

  private constructor(options: EvidenceRecorderOptions, runId: string, runDir: string) {
    this.runId = runId;
    this.runDir = runDir;
    this.mode = options.mode;
    this.goal = options.goal;
  }

  static async create(options: EvidenceRecorderOptions): Promise<EvidenceRecorder> {
    const runId = options.runId ?? generateRunId();
    const runDir = path.join(options.rootDir, runId);

    await mkdir(path.join(runDir, SCREENSHOTS_DIR), { recursive: true });
    await mkdir(path.join(runDir, SNAPSHOTS_DIR), { recursive: true });

    return new EvidenceRecorder(options, runId, runDir);
  }

  /** Registers a value that must never be persisted verbatim, wherever it appears. */
  classify(value: string, sensitivity: SensitivityClass): void {
    if (value !== '') {
      this.rules.push({ value, sensitivity });
    }
  }

  recordStep(step: StepRecord): void {
    this.steps.push({
      index: this.steps.length + 1,
      at: new Date().toISOString(),
      type: step.type,
      reason: step.reason,
      ...(step.action === undefined ? {} : { action: this.persistableAction(step.action) }),
      ...(step.outcome === undefined ? {} : { outcome: step.outcome }),
      ...(step.failure === undefined ? {} : { failure: step.failure }),
      ...(step.extracted === undefined
        ? {}
        : {
            extracted: maskValue(
              step.extracted,
              step.extractSensitivity ?? DEFAULT_EXTRACT_SENSITIVITY,
            ),
          }),
      ...(step.url === undefined ? {} : { url: step.url }),
      ...(step.screenshotPath === undefined
        ? {}
        : { screenshot: this.relative(step.screenshotPath) }),
      ...(step.snapshotPath === undefined ? {} : { snapshot: this.relative(step.snapshotPath) }),
      ...(step.operatorNote === undefined ? {} : { operatorNote: redactText(step.operatorNote) }),
    });
  }

  async writeScreenshot(png: Uint8Array, label: string): Promise<string> {
    const filePath = path.join(
      this.runDir,
      SCREENSHOTS_DIR,
      `${this.nextPrefix(SCREENSHOTS_DIR)}-${label}.png`,
    );
    await writeFile(filePath, png);
    return filePath;
  }

  /** Persists an observation with every accessible name and text run through redaction. */
  async writeObservation(observation: Observation, label: string): Promise<string> {
    const filePath = path.join(
      this.runDir,
      SNAPSHOTS_DIR,
      `${this.nextPrefix(SNAPSHOTS_DIR)}-${label}.json`,
    );
    const redacted = {
      ...observation,
      // Paths are stored relative to the run folder so committed evidence does not carry
      // the recording machine's directory layout and stays readable after a move.
      screenshotPath:
        observation.screenshotPath === null ? null : this.relative(observation.screenshotPath),
      nodes: observation.nodes.map((node) => this.redactNode(node)),
    };
    await writeFile(filePath, `${JSON.stringify(redacted, null, JSON_INDENT)}\n`, 'utf8');
    return filePath;
  }

  /** Persists an arbitrary JSON document — e.g. a hand-back before/after diff — alongside the numbered snapshots. */
  async writeJson(data: unknown, label: string): Promise<string> {
    const filePath = path.join(
      this.runDir,
      SNAPSHOTS_DIR,
      `${this.nextPrefix(SNAPSHOTS_DIR)}-${label}.json`,
    );
    await writeFile(filePath, `${JSON.stringify(data, null, JSON_INDENT)}\n`, 'utf8');
    return filePath;
  }

  async finish(outcome: RunOutcome): Promise<string> {
    const filePath = path.join(this.runDir, RUN_LOG_FILENAME);
    const runLog = {
      runId: this.runId,
      mode: this.mode,
      goal: this.goal,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      redaction: {
        appliedTo: ['step values', 'extracted values', 'persisted accessibility snapshots'],
        classifiedValueCount: this.rules.length,
      },
      steps: this.steps,
      outcome,
    };

    await writeFile(filePath, `${JSON.stringify(runLog, null, JSON_INDENT)}\n`, 'utf8');
    return filePath;
  }

  private persistableAction(action: Action): Record<string, unknown> {
    const base: Record<string, unknown> = { kind: action.kind satisfies ActionKind };

    if (action.kind === 'navigate') {
      return { ...base, url: action.url };
    }

    base['ref'] = action.ref;
    if (action.kind === 'fill' || action.kind === 'select') {
      base['value'] = maskValue(action.value, action.sensitivity ?? DEFAULT_INPUT_SENSITIVITY);
    }
    return base;
  }

  private redactNode(node: ObservationNode): ObservationNode {
    return {
      ...node,
      name: redactText(node.name, this.rules),
      ...(node.text === undefined ? {} : { text: redactText(node.text, this.rules) }),
      children: node.children.map((child) => this.redactNode(child)),
    };
  }

  private nextPrefix(kind: string): string {
    const next = (this.sequences.get(kind) ?? 0) + 1;
    this.sequences.set(kind, next);
    return String(next).padStart(SEQUENCE_DIGITS, '0');
  }

  private relative(absolutePath: string): string {
    return path.relative(this.runDir, absolutePath);
  }
}

/** Sortable by name, so `ls evidence/` reads chronologically. */
function generateRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const suffix = Math.random().toString(36).slice(2, 2 + RUN_ID_SUFFIX_LENGTH);
  return `${timestamp}-${suffix}`;
}
