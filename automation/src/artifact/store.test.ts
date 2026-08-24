import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from './schema.ts';
import {
  ArtifactValidationError,
  artifactFilePath,
  loadArtifact,
  saveArtifact,
  UnknownSchemaVersionError,
} from './store.ts';

function minimalArtifact(): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'member.savings-balance.read',
    version: 1,
    title: 'Read member savings balance',
    target: { app: 'core-banking-console', tenant: 'base', entryUrl: 'http://localhost:5173/' },
    surface: { kind: 'web', perception: 'accessibility-tree' },
    inputs: [
      { name: 'memberId', type: 'string', required: true, example: '12345', sensitivity: 'quasi-identifier' },
    ],
    outputs: [{ name: 'savingsBalance', type: 'currency', sensitivity: 'sensitive' }],
    steps: [
      {
        id: 's1',
        action: 'fill',
        effect: 'safe',
        target: { role: 'textbox', name: 'Member ID' },
        value: { $input: 'memberId' },
      },
    ],
    checkpoint: { assert: 'visible', target: { role: 'heading', name: 'Member', nameMatch: 'contains' } },
    outcomes: [],
    provenance: {
      discoveredAt: '2026-08-23T23:17:31.123Z',
      model: 'claude-sonnet-5',
      discoveryRunId: '20260823T231731Z-abwo2d',
      evidencePath: 'evidence/20260823T231731Z-abwo2d/',
    },
    approval: { state: 'draft' },
  };
}

describe('artifact store', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(path.join(tmpdir(), 'artifact-store-test-'));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('names the file <id>.v<version>.json', () => {
    expect(artifactFilePath('member.savings-balance.read', 1, rootDir)).toBe(
      path.join(rootDir, 'member.savings-balance.read.v1.json'),
    );
  });

  it('round-trips save/load, preserving the artifact including schema-filled defaults', () => {
    const savedPath = saveArtifact(minimalArtifact(), rootDir);
    const loaded = loadArtifact(savedPath);

    expect(savedPath).toBe(artifactFilePath('member.savings-balance.read', 1, rootDir));
    expect(loaded.id).toBe('member.savings-balance.read');
    expect(loaded.steps[0]).toMatchObject({
      target: { role: 'textbox', name: 'Member ID', nameMatch: 'exact', ordinal: 0, fallbacks: [] },
    });
  });

  it('creates the root directory on save if it does not exist yet', () => {
    const nested = path.join(rootDir, 'nested', 'artifacts');
    const savedPath = saveArtifact(minimalArtifact(), nested);

    expect(() => loadArtifact(savedPath)).not.toThrow();
  });

  it('rejects saving a malformed artifact, naming the offending field, before anything is written', () => {
    const malformed = { ...minimalArtifact() };
    delete malformed['checkpoint'];

    expect(() => saveArtifact(malformed, rootDir)).toThrow(ArtifactValidationError);
    expect(() => saveArtifact(malformed, rootDir)).toThrow(/checkpoint/);
  });

  it('rejects loading a malformed file, naming the offending field', () => {
    const filePath = path.join(rootDir, 'broken.v1.json');
    const malformed = { ...minimalArtifact() };
    delete malformed['checkpoint'];
    writeFileSync(filePath, JSON.stringify(malformed), 'utf8');

    expect(() => loadArtifact(filePath)).toThrow(ArtifactValidationError);
    expect(() => loadArtifact(filePath)).toThrow(/checkpoint/);
  });

  it('rejects loading a file with an unrecognized schemaVersion, naming the version', () => {
    const filePath = path.join(rootDir, 'future.v1.json');
    writeFileSync(filePath, JSON.stringify({ ...minimalArtifact(), schemaVersion: '2.0.0' }), 'utf8');

    expect(() => loadArtifact(filePath)).toThrow(UnknownSchemaVersionError);
    expect(() => loadArtifact(filePath)).toThrow(/2\.0\.0/);
  });

  it('rejects loading a file that is not valid JSON', () => {
    const filePath = path.join(rootDir, 'not-json.v1.json');
    writeFileSync(filePath, '{ not valid json', 'utf8');

    expect(() => loadArtifact(filePath)).toThrow(ArtifactValidationError);
  });
});
