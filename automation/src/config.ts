import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ACTION_KINDS } from './surface/SurfaceDriver.ts';

const PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..');

export const EXAMPLE_POLICY_PATH = path.join(PACKAGE_ROOT, 'config', 'policy.example.json');
/** Overrides the example when present, so a local policy is picked up without a flag. */
export const LOCAL_POLICY_PATH = path.join(PACKAGE_ROOT, 'config', 'policy.json');
export const DEFAULT_EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence');
const DOTENV_PATH = path.join(PACKAGE_ROOT, '.env');

const TRUE_LITERALS: readonly string[] = ['true', '1', 'yes'];
const FALSE_LITERALS: readonly string[] = ['false', '0', 'no'];

/** Configuration failures are unrecoverable by design: stop before touching a surface. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

const actionKindSchema = z.enum(ACTION_KINDS);

const originSchema = z
  .string()
  .refine(isBareHttpOrigin, 'must be a bare http(s) origin such as http://localhost:5173')
  .transform((value) => new URL(value).origin);

const regexSchema = z.string().refine(isValidRegExp, 'must be a valid regular expression');

const positiveIntSchema = z.number().int().positive();

const riskClassificationSchema = z
  .object({
    defaultRisk: z.enum(['safe', 'risky']),
    safeActionTypes: z.array(actionKindSchema),
    riskyActionTypes: z.array(actionKindSchema),
    riskyTargetNamePatterns: z.array(regexSchema),
  })
  .superRefine((value, ctx) => {
    const conflicting = value.safeActionTypes.filter((kind) =>
      value.riskyActionTypes.includes(kind),
    );
    if (conflicting.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `action types classified as both safe and risky: ${conflicting.join(', ')}`,
      });
    }
  });

const policySchema = z.object({
  allowedOrigins: z.array(originSchema).min(1),
  allowedRoutePatterns: z.array(regexSchema).min(1),
  allowedActionTypes: z.array(actionKindSchema).min(1),
  riskClassification: riskClassificationSchema,
  limits: z.object({
    maxStepsPerRun: positiveIntSchema,
    actionTimeoutMs: positiveIntSchema,
    navigationTimeoutMs: positiveIntSchema,
    maxObservationNodes: positiveIntSchema,
    maxTextLength: positiveIntSchema,
  }),
});

export type Policy = z.infer<typeof policySchema>;

export interface EnvironmentConfig {
  /** Reserved for the discovery agent; unused by the perception layer. */
  readonly anthropicApiKey: string | null;
  readonly headless: boolean;
  readonly policyPath: string | null;
  readonly evidenceDir: string | null;
}

export interface AutomationConfig {
  readonly policy: Policy;
  readonly policyPath: string;
  readonly evidenceDir: string;
  readonly headless: boolean;
  readonly anthropicApiKey: string | null;
}

export interface LoadConfigOptions {
  readonly policyPath?: string | undefined;
  readonly evidenceDir?: string | undefined;
  readonly headless?: boolean | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export function parsePolicy(raw: unknown, source: string): Policy {
  const result = policySchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(formatIssues(`Invalid automation policy in ${source}`, result.error));
  }
  return result.data;
}

export function parseEnvironment(source: NodeJS.ProcessEnv): EnvironmentConfig {
  return {
    anthropicApiKey: readOptional(source.ANTHROPIC_API_KEY),
    headless: readBoolean(source.AUTOMATION_HEADLESS, 'AUTOMATION_HEADLESS', false),
    policyPath: readOptional(source.AUTOMATION_POLICY_PATH),
    evidenceDir: readOptional(source.AUTOMATION_EVIDENCE_DIR),
  };
}

/**
 * Resolves env plus policy into one typed object. Any problem throws {@link ConfigError}
 * with the offending source and field named, rather than degrading to a default.
 */
export function loadConfig(options: LoadConfigOptions = {}): AutomationConfig {
  loadDotEnvFile();

  const environment = parseEnvironment(options.env ?? process.env);
  const policyPath = path.resolve(
    options.policyPath ?? environment.policyPath ?? defaultPolicyPath(),
  );

  return {
    policy: parsePolicy(readJsonFile(policyPath), policyPath),
    policyPath,
    evidenceDir: path.resolve(options.evidenceDir ?? environment.evidenceDir ?? DEFAULT_EVIDENCE_DIR),
    headless: options.headless ?? environment.headless,
    anthropicApiKey: environment.anthropicApiKey,
  };
}

function defaultPolicyPath(): string {
  return existsSync(LOCAL_POLICY_PATH) ? LOCAL_POLICY_PATH : EXAMPLE_POLICY_PATH;
}

function loadDotEnvFile(): void {
  if (existsSync(DOTENV_PATH)) {
    process.loadEnvFile(DOTENV_PATH);
  }
}

function readJsonFile(filePath: string): unknown {
  let contents: string;
  try {
    contents = readFileSync(filePath, 'utf8');
  } catch (cause) {
    throw new ConfigError(`Cannot read policy file at ${filePath}.`, { cause });
  }

  try {
    return JSON.parse(contents);
  } catch (cause) {
    throw new ConfigError(`Policy file at ${filePath} is not valid JSON.`, { cause });
  }
}

function readOptional(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function readBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  const literal = readOptional(value)?.toLowerCase();
  if (literal === null || literal === undefined) {
    return fallback;
  }
  if (TRUE_LITERALS.includes(literal)) {
    return true;
  }
  if (FALSE_LITERALS.includes(literal)) {
    return false;
  }
  throw new ConfigError(
    `${name} must be one of ${[...TRUE_LITERALS, ...FALSE_LITERALS].join(', ')}, received "${value}".`,
  );
}

function formatIssues(heading: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const location = issue.path.length === 0 ? '(root)' : issue.path.join('.');
    return `  - ${location}: ${issue.message}`;
  });
  return `${heading}:\n${lines.join('\n')}`;
}

function isBareHttpOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const isHttp = url.protocol === 'http:' || url.protocol === 'https:';
  return isHttp && url.pathname === '/' && url.search === '' && url.hash === '';
}

function isValidRegExp(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}
