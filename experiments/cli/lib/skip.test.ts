import type { EvalMetadata } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { skipUnlessCli, skipUnlessDockerless } from './skip.js';

const baseMetadata: EvalMetadata = {
  stage: 'build',
  product: ['database'],
  topic: ['sdk'],
  interface: 'cli',
};

describe('skipUnlessCli', () => {
  it('runs a cli eval that is not hosted-linked', () => {
    expect(skipUnlessCli({ id: 'e', metadata: baseMetadata })).toBe(false);
  });

  it('skips a non-cli eval', () => {
    expect(
      skipUnlessCli({
        id: 'e',
        metadata: { ...baseMetadata, interface: 'mcp' },
      })
    ).toBe(true);
  });

  it('skips a hosted-linked eval', () => {
    expect(
      skipUnlessCli({
        id: 'e',
        metadata: { ...baseMetadata, hostedProject: true },
      })
    ).toBe(true);
  });

  it('runs a cli eval with hostedProject explicitly false', () => {
    expect(
      skipUnlessCli({
        id: 'e',
        metadata: { ...baseMetadata, hostedProject: false },
      })
    ).toBe(false);
  });
});

describe('skipUnlessDockerless', () => {
  const dockerlessMetadata: EvalMetadata = {
    ...baseMetadata,
    needsDocker: false,
    projectRunning: false,
  };

  it('runs a cli eval that needs no Docker and has no pre-started stack', () => {
    expect(
      skipUnlessDockerless({ id: 'e', metadata: dockerlessMetadata })
    ).toBe(false);
  });

  it('skips a non-cli eval', () => {
    expect(
      skipUnlessDockerless({
        id: 'e',
        metadata: { ...dockerlessMetadata, interface: 'mcp' },
      })
    ).toBe(true);
  });

  it('skips a hosted-linked eval', () => {
    expect(
      skipUnlessDockerless({
        id: 'e',
        metadata: { ...dockerlessMetadata, hostedProject: true },
      })
    ).toBe(true);
  });

  it('skips an eval that needs Docker', () => {
    expect(
      skipUnlessDockerless({
        id: 'e',
        metadata: { ...dockerlessMetadata, needsDocker: true },
      })
    ).toBe(true);
  });

  it('skips an eval whose needsDocker is unset (defaults to true)', () => {
    expect(
      skipUnlessDockerless({
        id: 'e',
        metadata: { ...baseMetadata, projectRunning: false },
      })
    ).toBe(true);
  });

  it('skips an eval whose stack is already running', () => {
    expect(
      skipUnlessDockerless({
        id: 'e',
        metadata: { ...dockerlessMetadata, projectRunning: true },
      })
    ).toBe(true);
  });

  it('skips an eval whose projectRunning is unset (defaults to true)', () => {
    expect(
      skipUnlessDockerless({
        id: 'e',
        metadata: { ...baseMetadata, needsDocker: false },
      })
    ).toBe(true);
  });
});
