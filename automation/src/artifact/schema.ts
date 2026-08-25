import { z } from 'zod';

/** Bumped whenever a shape change would break an already-saved artifact; `store.ts` rejects anything else. */
export const CURRENT_SCHEMA_VERSION = '1.0.0';

const sensitivityClassSchema = z.enum(['low', 'quasi-identifier', 'sensitive']);
const nameMatchSchema = z.enum(['exact', 'contains']);
const effectSchema = z.enum(['safe', 'irreversible']);
const outcomeTypeSchema = z.enum(['business_outcome', 'recoverable']);
const inputTypeSchema = z.enum(['string', 'number', 'boolean']);
const outputTypeSchema = z.enum(['string', 'number', 'boolean', 'currency']);

const targetScopeSchema = z.object({ role: z.string(), name: z.string() });

const targetFallbackSchema = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('label'), value: z.string() }),
  z.object({ strategy: z.literal('text'), value: z.string() }),
  z.object({ strategy: z.literal('placeholder'), value: z.string() }),
  z.object({ strategy: z.literal('css'), value: z.string() }),
]);

/**
 * Structurally mirrors `TargetDescriptor` from `surface/SurfaceDriver.ts` — the artifact
 * must not encode Playwright, but it still needs the same semantic shape that driver
 * resolves against. `nameMatch`/`ordinal`/`fallbacks` default so a hand-authored
 * checkpoint or outcome-recovery target can stay as terse as the plan's illustrative
 * JSON (`{ role, name }`), while a fully-populated grounded step target round-trips
 * unchanged.
 */
const targetDescriptorSchema = z.object({
  role: z.string(),
  name: z.string(),
  nameMatch: nameMatchSchema.default('exact'),
  within: targetScopeSchema.optional(),
  ordinal: z.number().int().nonnegative().default(0),
  fallbacks: z.array(targetFallbackSchema).default([]),
});

/** `{ $input: "memberId" }` is resolved against run params by `artifact/binding.ts`, never inlined here. */
const boundValueSchema = z.union([z.string(), z.object({ $input: z.string() })]);

const waitSchema = z.object({
  until: z.enum(['target-visible']),
  timeoutMs: z.number().int().positive(),
});

const stepIdSchema = z.string().min(1);

const stepCommonSchema = {
  id: stepIdSchema,
  effect: effectSchema,
  wait: waitSchema.optional(),
};

const clickStepSchema = z.object({
  ...stepCommonSchema,
  action: z.literal('click'),
  target: targetDescriptorSchema,
});

const fillStepSchema = z.object({
  ...stepCommonSchema,
  action: z.literal('fill'),
  target: targetDescriptorSchema,
  value: boundValueSchema,
});

const selectStepSchema = z.object({
  ...stepCommonSchema,
  action: z.literal('select'),
  target: targetDescriptorSchema,
  value: boundValueSchema,
});

const extractStepSchema = z.object({
  ...stepCommonSchema,
  action: z.literal('extract'),
  target: targetDescriptorSchema,
  into: z.string().min(1),
});

/** Present for capabilities that navigate mid-flow; the capability's own `target.entryUrl` covers the initial load. */
const navigateStepSchema = z.object({
  ...stepCommonSchema,
  action: z.literal('navigate'),
  url: z.string().min(1),
});

const stepSchema = z.discriminatedUnion('action', [
  clickStepSchema,
  fillStepSchema,
  selectStepSchema,
  extractStepSchema,
  navigateStepSchema,
]);

const checkpointSchema = z.object({
  assert: z.enum(['visible']),
  target: targetDescriptorSchema,
});

const outcomeWhenSchema = z.object({
  role: z.string(),
  /**
   * Contains-match against the observed node's text, deliberately not exact: the plan's
   * own examples state the match text without the trailing id/period Part A actually
   * renders (e.g. "No member found for ID" vs "No member found for ID 99999."), and
   * contains-match is robust to that kind of trailing variance.
   */
  textMatches: z.string().min(1),
});

const outcomeRecoverySchema = z.object({
  action: z.literal('click'),
  target: targetDescriptorSchema,
  thenRestartFromStep: stepIdSchema,
  maxAttempts: z.number().int().positive(),
});

const outcomeSchema = z
  .object({
    id: z.string().min(1),
    type: outcomeTypeSchema,
    terminal: z.boolean().optional(),
    when: outcomeWhenSchema,
    recovery: outcomeRecoverySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'recoverable' && value.recovery === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['recovery'],
        message: 'a "recoverable" outcome must declare a recovery policy',
      });
    }
    if (value.type === 'business_outcome' && value.recovery !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['recovery'],
        message: 'a "business_outcome" is terminal and must not declare a recovery policy',
      });
    }
  });

const inputDefSchema = z.object({
  name: z.string().min(1),
  type: inputTypeSchema,
  required: z.boolean(),
  example: z.string().optional(),
  sensitivity: sensitivityClassSchema,
});

const outputDefSchema = z.object({
  name: z.string().min(1),
  type: outputTypeSchema,
  sensitivity: sensitivityClassSchema,
});

const targetAppSchema = z.object({
  app: z.string().min(1),
  /** `"base"` today, meaning "no tenant-specific override" — the seam described for a future per-tenant override file. */
  tenant: z.string().min(1),
  entryUrl: z.string().refine(isHttpUrl, 'must be an http(s) URL'),
});

const surfaceSchema = z.object({
  /** Only the web/accessibility-tree driver exists; extend when a legacy-web or desktop driver lands. */
  kind: z.enum(['web']),
  perception: z.enum(['accessibility-tree']),
});

const provenanceSchema = z.object({
  discoveredAt: z.string().min(1),
  model: z.string().min(1),
  discoveryRunId: z.string().min(1),
  evidencePath: z.string().min(1),
});

const approvalSchema = z.object({
  /**
   * `"draft"`: discovered but not signed off, so unattended replay is refused.
   * `"approved"`: reviewed by a human, so unattended replay is permitted. Discovery only
   * ever emits `"draft"` — promotion is the `approve` command's job, never the model's.
   */
  state: z.enum(['draft', 'approved']),
});

export const artifactSchema = z.object({
  schemaVersion: z.string().min(1),
  id: z.string().min(1),
  version: z.number().int().positive(),
  title: z.string().min(1),
  target: targetAppSchema,
  surface: surfaceSchema,
  inputs: z.array(inputDefSchema),
  outputs: z.array(outputDefSchema),
  steps: z.array(stepSchema).min(1),
  checkpoint: checkpointSchema,
  outcomes: z.array(outcomeSchema),
  provenance: provenanceSchema,
  approval: approvalSchema,
});

export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactStep = Artifact['steps'][number];
export type ArtifactTargetDescriptor = z.infer<typeof targetDescriptorSchema>;
export type ArtifactValue = z.infer<typeof boundValueSchema>;
export type ArtifactOutcome = Artifact['outcomes'][number];
export type ArtifactCheckpoint = Artifact['checkpoint'];

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
