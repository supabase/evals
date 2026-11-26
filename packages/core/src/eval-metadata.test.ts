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

describe('customMetadata frontmatter', () => {
  const base = {
    stage: 'build',
    product: ['database'],
    topic: ['sql'],
    interface: 'cli',
  };

  it('passes the object through unchanged', () => {
    const customMetadata = { area: 'local-stacks', nested: { a: 1 } };
    expect(
      evalFrontmatterSchema.parse({ ...base, customMetadata }).customMetadata
    ).toEqual(customMetadata);
  });

  it('stays undefined when absent', () => {
    expect(evalFrontmatterSchema.parse(base).customMetadata).toBeUndefined();
  });

  it('rejects a non-object', () => {
    for (const customMetadata of ['local-stacks', ['a'], 3, null]) {
      expect(
        evalFrontmatterSchema.safeParse({ ...base, customMetadata }).success
      ).toBe(false);
    }
  });

  it('is kept in result files', () => {
    const parsed = rawEvalResultSchema.parse({
      experiment: 'e',
      eval: 'x',
      interface: 'cli',
      customMetadata: { area: 'local-stacks' },
    });
    expect(parsed.customMetadata).toEqual({ area: 'local-stacks' });
  });
});
