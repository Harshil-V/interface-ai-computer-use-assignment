import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { artifactSchema, CURRENT_SCHEMA_VERSION, type Artifact } from './schema.ts';

/** `automation/src/artifact` -> repo root, sibling to `evidence/`. */
export const ARTIFACTS_ROOT_DIR = path.resolve(import.meta.dirname, '..', '..', '..', 'artifacts');

const JSON_INDENT = 2;

/** A saved or loaded artifact failed schema validation. Named after the field that failed, not just "invalid". */
export class ArtifactValidationError extends Error {
  override readonly name = 'ArtifactValidationError';
}

/** The file on disk declares a `schemaVersion` this loader was not built to understand. */
export class UnknownSchemaVersionError extends Error {
  override readonly name = 'UnknownSchemaVersionError';
}

export function artifactFileName(id: string, version: number): string {
  return `${id}.v${version}.json`;
}

export function artifactFilePath(id: string, version: number, rootDir: string = ARTIFACTS_ROOT_DIR): string {
  return path.join(rootDir, artifactFileName(id, version));
}

/**
 * Validates before writing — the schema is the single source of truth on both sides of
 * the store, so a malformed artifact can never reach disk. Takes `unknown` rather than
 * `Artifact` so this guarantee holds even for a caller that only believes its object is
 * well-typed.
 */
export function saveArtifact(artifact: unknown, rootDir: string = ARTIFACTS_ROOT_DIR): string {
  const validated = parseArtifact(artifact, 'artifact passed to saveArtifact');
  const filePath = artifactFilePath(validated.id, validated.version, rootDir);
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(validated, null, JSON_INDENT)}\n`, 'utf8');
  return filePath;
}

export function loadArtifact(filePath: string): Artifact {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (cause) {
    throw new ArtifactValidationError(`Cannot read artifact at ${filePath}: ${messageOf(cause)}`);
  }

  const schemaVersion = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new UnknownSchemaVersionError(
      `Artifact at ${filePath} declares schemaVersion ${JSON.stringify(schemaVersion)}; ` +
        `this loader only understands "${CURRENT_SCHEMA_VERSION}".`,
    );
  }

  return parseArtifact(raw, filePath);
}

function parseArtifact(raw: unknown, source: string): Artifact {
  const result = artifactSchema.safeParse(raw);
  if (!result.success) {
    throw new ArtifactValidationError(formatIssues(`Invalid artifact in ${source}`, result.error));
  }
  return result.data;
}

function formatIssues(heading: string, error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const location = issue.path.length === 0 ? '(root)' : issue.path.join('.');
    return `  - ${location}: ${issue.message}`;
  });
  return `${heading}:\n${lines.join('\n')}`;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
