import { describe, expect, it } from 'vitest';
import {
  evalFrontmatterSchema,
  evalMetadataSchema,
  rawEvalResultSchema,
} from './eval-metadata.js';

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

describe('sdk schema', () => {
  const base = {
    stage: 'build',
    product: ['database'],
    topic: ['sdk'],
    interface: 'cli',
  };

  it('is optional and stays absent when omitted', () => {
    expect(evalFrontmatterSchema.parse(base).sdk).toBeUndefined();
  });

  it('normalizes the token and folds language aliases', () => {
    expect(evalFrontmatterSchema.parse({ ...base, sdk: 'py' }).sdk).toBe('py');
    expect(evalFrontmatterSchema.parse({ ...base, sdk: ' JS ' }).sdk).toBe(
      'js'
    );
    expect(
      evalFrontmatterSchema.parse({ ...base, sdk: 'JavaScript' }).sdk
    ).toBe('js');
    expect(evalFrontmatterSchema.parse({ ...base, sdk: 'Python' }).sdk).toBe(
      'py'
    );
    expect(evalFrontmatterSchema.parse({ ...base, sdk: 'dart' }).sdk).toBe(
      'flutter'
    );
  });

  it('rejects an unknown sdk', () => {
    expect(() => evalFrontmatterSchema.parse({ ...base, sdk: 'go' })).toThrow();
  });

  it('round-trips through the result schema', () => {
    const parsed = rawEvalResultSchema.parse({
      experiment: 'test-experiment',
      eval: 'test-eval',
      interface: 'cli',
      sdk: 'py',
    });
    expect(parsed.sdk).toBe('py');
  });
});
