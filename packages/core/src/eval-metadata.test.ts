import { describe, expect, it } from 'vitest';
import { evalMetadataSchema, rawEvalResultSchema } from './eval-metadata.js';

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
