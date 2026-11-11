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

describe('area and journeyPhase frontmatter', () => {
  const base = {
    stage: 'build',
    product: ['database'],
    topic: ['sql'],
    interface: 'cli',
  };

  it('parses and normalizes area and journeyPhase', () => {
    const parsed = evalFrontmatterSchema.parse({
      ...base,
      area: 'Local Stacks',
      journeyPhase: 'Design',
    });

    expect(parsed).toMatchObject({
      area: 'local-stacks',
      journeyPhase: 'design',
    });
  });

  it('rejects an unknown journeyPhase', () => {
    expect(() =>
      evalFrontmatterSchema.parse({ ...base, journeyPhase: 'build' })
    ).toThrow();
  });

  it('leaves both undefined when omitted', () => {
    const parsed = evalFrontmatterSchema.parse(base);

    expect(parsed.area).toBeUndefined();
    expect(parsed.journeyPhase).toBeUndefined();
  });
});
