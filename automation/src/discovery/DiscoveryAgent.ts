import Anthropic from '@anthropic-ai/sdk';
import type { Policy } from '../config.ts';
import type { EvidenceRecorder, StepType } from '../evidence/EvidenceRecorder.ts';
import type { ControlLease } from '../hitl/ControlLease.ts';
import { raiseInterventionAndAwaitHandBack } from '../hitl/escalation.ts';
import type { InterventionResolution, InterventionStore } from '../hitl/interventions.ts';
import type { Action, ActResult, SurfaceDriver, TargetDescriptor } from '../surface/SurfaceDriver.ts';
import { buildSystemPrompt } from './prompt.ts';
import { DISCOVERY_TOOLS, dispatchTool, renderObservationForModel, type ToolDispatch } from './tools.ts';

const MAX_RESPONSE_TOKENS = 1024;
const INITIAL_USER_MESSAGE = 'Begin. Call "perceive" first to see the current state of the page.';
const NO_TOOL_CALL_REMINDER =
  'You must call exactly one of the available tools on every turn: perceive, click, fill, select, navigate, extract, done, or stuck.';

export type DiscoveryStopReason = 'done' | 'stuck' | 'max_steps' | 'timeout';

/**
 * One action the model successfully executed, grounded in the node it actually hit —
 * `ActResult.target` already carries everything needed, so this is pure accumulation.
 */
export interface GroundedAction {
  readonly step: number;
  readonly action: Action;
  readonly target?: TargetDescriptor;
  /** Present only for `extract`: the output name the model chose via its "as" argument. */
  readonly extractedAs?: string;
}

export interface DiscoveryOutcome {
  readonly stopReason: DiscoveryStopReason;
  readonly summary?: string;
  readonly stuckReason?: string;
  readonly steps: number;
  readonly groundedActions: readonly GroundedAction[];
  readonly outputs: Readonly<Record<string, string>>;
  /** Present only when `stopReason === 'stuck'` and the resulting intervention has been resolved one way or the other. */
  readonly interventionId?: string;
  readonly escalationResolution?: InterventionResolution;
}

export interface DiscoveryHitlContext {
  readonly lease: ControlLease;
  readonly interventions: InterventionStore;
}

export interface DiscoveryOptions {
  readonly goal: string;
  readonly driver: SurfaceDriver;
  readonly recorder: EvidenceRecorder;
  readonly policy: Policy;
  readonly anthropicApiKey: string;
  readonly model: string;
  /** `stuck` routes into the same intervention path a guardrail block uses during replay. */
  readonly hitl: DiscoveryHitlContext;
}

/**
 * The observe -> decide -> act loop. Stops on `done`, `stuck`, the step budget
 * (`policy.limits.maxStepsPerRun`), or the wall-clock budget
 * (`policy.limits.maxRunDurationMs`) — whichever comes first. Every turn is written to
 * evidence via `recorder.recordStep`, the same call the snapshot CLI already uses.
 *
 * Hand-rolled rather than built on the SDK's `beta.messages.toolRunner`: the runner's
 * own docs recommend the manual loop precisely for "custom logging" and "conditional
 * execution" needs, which is exactly what per-turn evidence recording and the
 * done/stuck/timeout stopping conditions are. The loop below is a plain `while`
 * spanning create -> dispatch -> append, which is not complex enough to justify
 * fighting a helper designed for a simpler case.
 */
export async function runDiscovery(options: DiscoveryOptions): Promise<DiscoveryOutcome> {
  const client = new Anthropic({ apiKey: options.anthropicApiKey });
  const system = buildSystemPrompt(options.goal);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: INITIAL_USER_MESSAGE }];
  const groundedActions: GroundedAction[] = [];
  const outputs: Record<string, string> = {};
  const startedAt = Date.now();
  const { maxStepsPerRun, maxRunDurationMs } = options.policy.limits;

  for (let step = 1; step <= maxStepsPerRun; step += 1) {
    if (Date.now() - startedAt >= maxRunDurationMs) {
      return { stopReason: 'timeout', steps: step - 1, groundedActions, outputs };
    }

    const response = await client.messages.create({
      model: options.model,
      max_tokens: MAX_RESPONSE_TOKENS,
      system,
      tools: DISCOVERY_TOOLS,
      messages,
    });
    messages.push({ role: 'assistant', content: response.content });

    const toolUseBlocks = response.content.filter(isToolUseBlock);
    const rationale = textOf(response.content);

    if (toolUseBlocks.length === 0) {
      options.recorder.recordStep({
        type: 'note',
        reason: rationale === '' ? '(model returned neither text nor a tool call)' : rationale,
        outcome: 'failed',
      });
      messages.push({ role: 'user', content: NO_TOOL_CALL_REMINDER });
      continue;
    }

    const ctx: StepContext = {
      driver: options.driver,
      recorder: options.recorder,
      runId: options.recorder.runId,
      goal: options.goal,
      hitl: options.hitl,
      step,
      rationale,
      groundedActions,
      outputs,
    };
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    let stop: DiscoveryStop | undefined;

    for (const block of toolUseBlocks) {
      const handled = await handleToolUseBlock(block, ctx);
      toolResults.push(handled.resultBlock);
      stop ??= handled.stop;
    }
    messages.push({ role: 'user', content: toolResults });

    if (stop !== undefined) {
      return {
        stopReason: stop.reason,
        steps: step,
        groundedActions,
        outputs,
        ...(stop.summary === undefined ? {} : { summary: stop.summary }),
        ...(stop.stuckReason === undefined ? {} : { stuckReason: stop.stuckReason }),
        ...(stop.interventionId === undefined ? {} : { interventionId: stop.interventionId }),
        ...(stop.escalationResolution === undefined ? {} : { escalationResolution: stop.escalationResolution }),
      };
    }
  }

  return { stopReason: 'max_steps', steps: maxStepsPerRun, groundedActions, outputs };
}

interface StepContext {
  readonly driver: SurfaceDriver;
  readonly recorder: EvidenceRecorder;
  readonly runId: string;
  readonly goal: string;
  readonly hitl: DiscoveryHitlContext;
  readonly step: number;
  readonly rationale: string;
  /** Mutated in place: the grounded log and outputs accumulate across the whole run. */
  readonly groundedActions: GroundedAction[];
  readonly outputs: Record<string, string>;
}

interface DiscoveryStop {
  readonly reason: 'done' | 'stuck';
  readonly summary?: string;
  readonly stuckReason?: string;
  readonly interventionId?: string;
  readonly escalationResolution?: InterventionResolution;
}

async function handleToolUseBlock(
  block: Anthropic.ToolUseBlock,
  ctx: StepContext,
): Promise<{ resultBlock: Anthropic.ToolResultBlockParam; stop?: DiscoveryStop }> {
  let dispatch: ToolDispatch;
  try {
    dispatch = await dispatchTool({ name: block.name, input: block.input }, ctx.driver);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    ctx.recorder.recordStep({ type: 'note', reason: `${ctx.rationale} (rejected: ${message})`, outcome: 'failed' });
    return { resultBlock: toolResult(block.id, message, true) };
  }

  switch (dispatch.kind) {
    case 'perceive':
      return { resultBlock: await handlePerceive(dispatch, block.id, ctx) };
    case 'done':
      ctx.recorder.recordStep({ type: 'note', reason: ctx.rationale, outcome: 'ok' });
      return {
        resultBlock: toolResult(block.id, 'Goal acknowledged as complete.'),
        stop: { reason: 'done', summary: dispatch.summary },
      };
    case 'stuck':
      return {
        resultBlock: toolResult(block.id, 'Stuck condition acknowledged; escalated to a human operator.'),
        stop: await handleStuck(dispatch, ctx),
      };
    case 'action':
      return { resultBlock: handleAction(dispatch, block.id, ctx) };
  }
}

async function handlePerceive(
  dispatch: Extract<ToolDispatch, { kind: 'perceive' }>,
  toolUseId: string,
  ctx: StepContext,
): Promise<Anthropic.ToolResultBlockParam> {
  const snapshotPath = await ctx.recorder.writeObservation(dispatch.observation, `step-${ctx.step}-perceive`);
  ctx.recorder.recordStep({
    type: 'perceive',
    reason: ctx.rationale,
    outcome: 'ok',
    url: dispatch.observation.url,
    snapshotPath,
    ...(dispatch.observation.screenshotPath === null ? {} : { screenshotPath: dispatch.observation.screenshotPath }),
  });
  return toolResult(toolUseId, renderObservationForModel(dispatch.observation));
}

/**
 * Routes a model-declared dead end into the same intervention path a replay
 * guardrail block uses. `stuck` is already a terminal signal from the model, so —
 * unlike replay's "resume and continue from the next step" — this run always ends
 * here regardless of what the operator decides; the resolution is recorded so the
 * caller can report `escalated`/`resumed` vs `escalated`/`abandoned` accurately.
 * Continuing the LLM loop after a human intervenes on a `stuck` run is out of scope
 * by design: only the abandon path is exercised by this project's required demo,
 * and a stuck-then-resumed discovery run has no well-defined "next turn" to hand
 * the model without materially more design than this milestone calls for.
 */
async function handleStuck(
  dispatch: Extract<ToolDispatch, { kind: 'stuck' }>,
  ctx: StepContext,
): Promise<DiscoveryStop> {
  ctx.recorder.recordStep({ type: 'note', reason: ctx.rationale, outcome: 'failed' });

  const escalation = await raiseInterventionAndAwaitHandBack(
    {
      runId: ctx.runId,
      capabilityId: '(discovery)',
      goal: ctx.goal,
      stepId: `turn-${ctx.step}`,
      trigger: 'stuck',
      stopReason: dispatch.reason,
    },
    { driver: ctx.driver, recorder: ctx.recorder, lease: ctx.hitl.lease, interventions: ctx.hitl.interventions },
  );

  return {
    reason: 'stuck',
    stuckReason: dispatch.reason,
    interventionId: escalation.interventionId,
    escalationResolution: escalation.resolution,
  };
}

function handleAction(
  dispatch: Extract<ToolDispatch, { kind: 'action' }>,
  toolUseId: string,
  ctx: StepContext,
): Anthropic.ToolResultBlockParam {
  const { action, result, extractInto } = dispatch;
  recordActionStep(action, result, ctx);

  if (result.ok) {
    ctx.groundedActions.push({
      step: ctx.step,
      action,
      ...(result.target === undefined ? {} : { target: result.target }),
      ...(extractInto === undefined ? {} : { extractedAs: extractInto }),
    });
    if (extractInto !== undefined && result.extracted !== undefined) {
      ctx.outputs[extractInto] = result.extracted;
    }
    return toolResult(toolUseId, describeSuccess(result));
  }

  return toolResult(toolUseId, result.failure?.message ?? `${action.kind} failed.`, true);
}

function recordActionStep(action: Action, result: ActResult, ctx: StepContext): void {
  const type: StepType = action.kind === 'navigate' ? 'navigate' : 'act';
  ctx.recorder.recordStep({
    type,
    reason: ctx.rationale,
    action,
    outcome: result.ok ? 'ok' : 'failed',
    ...(result.failure === undefined ? {} : { failure: result.failure }),
    ...(result.extracted === undefined ? {} : { extracted: result.extracted }),
  });
}

function describeSuccess(result: ActResult): string {
  return result.extracted === undefined ? `${result.kind} succeeded.` : `Extracted: ${result.extracted}`;
}

function toolResult(toolUseId: string, content: string, isError = false): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) };
}

function isToolUseBlock(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === 'tool_use';
}

function textOf(blocks: readonly Anthropic.ContentBlock[]): string {
  return blocks
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}
