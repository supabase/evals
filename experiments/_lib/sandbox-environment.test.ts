// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. experiments/_lib evals/build-database-002-stack-lifecycle
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readSandboxEnvironment,
  requiresDockerlessSandbox,
} from './sandbox-environment.js';

let evalDir: string;

afterEach(() => {
  if (evalDir) rmSync(evalDir, { recursive: true, force: true });
});

function makeEvalDir(): string {
  evalDir = mkdtempSync(join(tmpdir(), 'sandbox-environment-test-'));
  return evalDir;
}

function writeEnvironmentFile(dir: string, contents: string): void {
  writeFileSync(join(dir, 'sandbox-environment.json'), contents);
}

describe('readSandboxEnvironment', () => {
  it('returns "available" when sandbox-environment.json is missing', () => {
    const dir = makeEvalDir();
    expect(readSandboxEnvironment(dir)).toBe('available');
  });

  it('returns "available" with no local/ directory required', () => {
    const dir = makeEvalDir();
    writeEnvironmentFile(dir, '{"docker":"available"}');
    expect(readSandboxEnvironment(dir)).toBe('available');
  });

  it('returns "no-daemon" when local/ exists', () => {
    const dir = makeEvalDir();
    writeEnvironmentFile(dir, '{"docker":"no-daemon"}');
    mkdirSync(join(dir, 'local'));
    expect(readSandboxEnvironment(dir)).toBe('no-daemon');
  });

  it('returns "absent" when local/ exists', () => {
    const dir = makeEvalDir();
    writeEnvironmentFile(dir, '{"docker":"absent"}');
    mkdirSync(join(dir, 'local'));
    expect(readSandboxEnvironment(dir)).toBe('absent');
  });

  it('throws mentioning local/ when a non-available state has no local/ directory', () => {
    const dir = makeEvalDir();
    writeEnvironmentFile(dir, '{"docker":"no-daemon"}');
    expect(() => readSandboxEnvironment(dir)).toThrow(/local\//);
    expect(() => readSandboxEnvironment(dir)).toThrow(dir);
  });

  it('throws mentioning the file path when the docker value is invalid', () => {
    const dir = makeEvalDir();
    writeEnvironmentFile(dir, '{"docker":"broken"}');
    expect(() => readSandboxEnvironment(dir)).toThrow(
      join(dir, 'sandbox-environment.json')
    );
    expect(() => readSandboxEnvironment(dir)).toThrow(
      /"docker" must be one of/
    );
  });

  it('throws mentioning the file path when the docker key is missing', () => {
    const dir = makeEvalDir();
    writeEnvironmentFile(dir, '{}');
    expect(() => readSandboxEnvironment(dir)).toThrow(
      join(dir, 'sandbox-environment.json')
    );
  });

  it('throws "<path>: invalid JSON — …" when the file is not valid JSON', () => {
    const dir = makeEvalDir();
    writeEnvironmentFile(dir, '{not valid json');
    const path = join(dir, 'sandbox-environment.json');
    expect(() => readSandboxEnvironment(dir)).toThrow(
      `${path}: invalid JSON —`
    );
  });
});

describe('requiresDockerlessSandbox', () => {
  it('is false for build-database-002-stack-lifecycle (no sandbox-environment.json)', () => {
    expect(
      requiresDockerlessSandbox('build-database-002-stack-lifecycle')
    ).toBe(false);
  });

  it('is true for build-database-003-docker-less-stack-lifecycle (docker: no-daemon)', () => {
    expect(
      requiresDockerlessSandbox(
        'build-database-003-docker-less-stack-lifecycle'
      )
    ).toBe(true);
  });

  it('is true for build-database-004-docker-absent-stack-lifecycle (docker: absent)', () => {
    expect(
      requiresDockerlessSandbox(
        'build-database-004-docker-absent-stack-lifecycle'
      )
    ).toBe(true);
  });

  it('is false for a non-existent eval id (no file means "available")', () => {
    expect(requiresDockerlessSandbox('does-not-exist-eval-id')).toBe(false);
  });
});
