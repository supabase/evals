import { describe, expect, it } from 'vitest';
import {
  evalFrontmatterSchema,
  evalMetadataSchema,
  rawEvalResultSchema,
} from './eval-metadata.js';

it('preserves the requested MCP revision and resolved commit in results', () => {
  const repoSources = {
    'supabase/mcp': {
      revision: 'feature/experiment',
      commitSha: 'a'.repeat(40),
    },
  };
  const parsed = rawEvalResultSchema.parse({
    experiment: 'test-experiment',
    eval: 'test-eval',
    interface: 'mcp',
    repoSources,
  });
  expect(parsed.repoSources).toEqual(repoSources);
});

describe('cliVersion schema', () => {
  const BETA_VERSION = '2.118.0-beta.60';

  it('round-trips a resolved beta version through the frontmatter metadata schema', () => {
    const parsed = evalMetadataSchema.parse({
      stage: 'build',
      product: ['database'],
      topic: ['sql'],
      interface: 'cli',
      cliVersion: BETA_VERSION,
    });

    expect(parsed.cliVersion).toBe(BETA_VERSION);
  });

  it('round-trips a resolved beta version through the result schema', () => {
    const parsed = rawEvalResultSchema.parse({
      experiment: 'test-experiment',
      eval: 'test-eval',
      interface: 'cli',
      cliVersion: BETA_VERSION,
    });

    expect(parsed.cliVersion).toBe(BETA_VERSION);
  });

  it('still rejects a non-version string', () => {
    expect(() =>
      evalMetadataSchema.parse({
        stage: 'build',
        product: ['database'],
        topic: ['sql'],
        interface: 'cli',
        cliVersion: 'stable',
      })
    ).toThrow();
  });
});

describe('local setup', () => {
  const base = {
    stage: 'build',
    product: ['database'],
    topic: ['sql'],
    interface: 'cli',
  };

  it('allows a preinstalled CLI with or without a running stack', () => {
    expect(
      evalFrontmatterSchema.safeParse({ ...base, preinstallCli: true }).success
    ).toBe(true);
    expect(
      evalFrontmatterSchema.safeParse({
        ...base,
        preinstallCli: true,
        startLocalStack: true,
      }).success
    ).toBe(true);
  });

  it('accepts quoted booleans and a stopped stack without the CLI', () => {
    expect(
      evalFrontmatterSchema.parse({
        ...base,
        preinstallCli: 'true',
        startLocalStack: 'true',
      }).startLocalStack
    ).toBe(true);
    expect(
      evalFrontmatterSchema.parse({ ...base, startLocalStack: 'false' })
        .startLocalStack
    ).toBe(false);
  });

  it('rejects starting the stack without preinstalling the CLI', () => {
    expect(
      evalFrontmatterSchema.safeParse({ ...base, startLocalStack: true })
        .success
    ).toBe(false);
  });
});
