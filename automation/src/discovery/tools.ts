import type Anthropic from '@anthropic-ai/sdk';
import type { Action, ActResult, Observation, SurfaceDriver } from '../surface/SurfaceDriver.ts';

/**
 * The tool surface offered to the model. Every action tool accepts only a `ref` —
 * there is no selector, XPath, or locator parameter anywhere in these schemas, which
 * is what makes "the model never authors locators" a structural property rather than
 * a prompt request.
 */
export const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'perceive',
    description:
      'Return the current accessibility snapshot of the page: every interactive or status-bearing element, each carrying a system-assigned "ref". Call this whenever you need to see the current state before deciding what to do next.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'click',
    description: 'Click the element identified by "ref" (from the most recent perceive result).',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'The ref to click, e.g. "n3".' } },
      required: ['ref'],
    },
  },
  {
    name: 'fill',
    description: 'Type "value" into the textbox identified by "ref".',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The ref of the textbox.' },
        value: { type: 'string', description: 'The text to type.' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'select',
    description: 'Choose "value" as the selected option in the control identified by "ref".',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The ref of the control.' },
        value: { type: 'string', description: 'The option value to select.' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the page to "url". Only URLs on the allowed origin will succeed.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'The absolute URL to navigate to.' } },
      required: ['url'],
    },
  },
  {
    name: 'extract',
    description:
      'Read the value or text of the element identified by "ref" and record it under the output name "as".',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The ref of the element to read.' },
        as: { type: 'string', description: 'The output name to record the value under, e.g. "savingsBalance".' },
      },
      required: ['ref', 'as'],
    },
  },
  {
    name: 'done',
    description:
      'Declare that the goal has been met. Call this exactly once, with a short summary of what was accomplished.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'A short summary of what was accomplished.' } },
      required: ['summary'],
    },
  },
  {
    name: 'stuck',
    description:
      'Declare a genuine dead end: the goal cannot be met from the current state. Call this instead of guessing randomly or repeating a failed action.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why the goal cannot be met.' } },
      required: ['reason'],
    },
  },
];

export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

/**
 * What dispatching one tool call produced. `action` covers the five tools that
 * operate the driver; `extractInto` is present only for `extract`, since the output
 * name is not part of the `Action`/`ActResult` contract those tools already share.
 */
export type ToolDispatch =
  | { readonly kind: 'perceive'; readonly observation: Observation }
  | { readonly kind: 'action'; readonly action: Action; readonly result: ActResult; readonly extractInto?: string }
  | { readonly kind: 'done'; readonly summary: string }
  | { readonly kind: 'stuck'; readonly reason: string };

/** Thrown for a call the model made up, or one missing a required field. Caught by the loop, never fatal. */
export class InvalidToolCallError extends Error {
  override readonly name = 'InvalidToolCallError';
}

/** Renders an observation the same way it will be persisted, so the model sees exactly the refs on disk. */
export function renderObservationForModel(observation: Observation): string {
  return JSON.stringify({
    url: observation.url,
    title: observation.title,
    truncated: observation.truncated,
    nodes: observation.nodes,
  });
}

/**
 * Dispatches one model tool call to the {@link SurfaceDriver}. `done`/`stuck` are
 * loop-control signals and never reach the driver at all.
 */
export async function dispatchTool(call: ToolCall, driver: SurfaceDriver): Promise<ToolDispatch> {
  switch (call.name) {
    case 'perceive':
      return { kind: 'perceive', observation: await driver.perceive() };
    case 'click':
      return await dispatchAction({ kind: 'click', ref: requireString(call, 'ref') }, driver);
    case 'fill':
      return await dispatchAction(
        { kind: 'fill', ref: requireString(call, 'ref'), value: requireString(call, 'value') },
        driver,
      );
    case 'select':
      return await dispatchAction(
        { kind: 'select', ref: requireString(call, 'ref'), value: requireString(call, 'value') },
        driver,
      );
    case 'navigate':
      return await dispatchAction({ kind: 'navigate', url: requireString(call, 'url') }, driver);
    case 'extract':
      return await dispatchExtract(call, driver);
    case 'done':
      return { kind: 'done', summary: requireString(call, 'summary') };
    case 'stuck':
      return { kind: 'stuck', reason: requireString(call, 'reason') };
    default:
      throw new InvalidToolCallError(`Unknown tool "${call.name}".`);
  }
}

async function dispatchAction(action: Action, driver: SurfaceDriver): Promise<ToolDispatch> {
  return { kind: 'action', action, result: await driver.act(action) };
}

async function dispatchExtract(call: ToolCall, driver: SurfaceDriver): Promise<ToolDispatch> {
  const extractInto = requireString(call, 'as');
  const action: Action = { kind: 'extract', ref: requireString(call, 'ref') };
  return { kind: 'action', action, result: await driver.act(action), extractInto };
}

function requireString(call: ToolCall, key: string): string {
  const value = (call.input as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new InvalidToolCallError(`Tool "${call.name}" requires a non-empty string "${key}".`);
  }
  return value;
}
