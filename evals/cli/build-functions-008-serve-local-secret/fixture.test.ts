import { describe, expect, it } from 'vitest';
import { DIGEST_SECRET, WRONG_SECRET } from './fixture.js';

const PREFIX = 'dgs_';
const SEEDED_SHAPE = /^dgs_[0-9a-f]{32}$/;

describe('the seeded secret', () => {
  it('has the dgs_ prefix and 32 hex characters', () => {
    expect(DIGEST_SECRET).toMatch(SEEDED_SHAPE);
  });
});

describe('WRONG_SECRET', () => {
  it('is not the seeded secret', () => {
    expect(WRONG_SECRET).not.toBe(DIGEST_SECRET);
  });

  it('has the length of the seeded secret', () => {
    expect(WRONG_SECRET).toHaveLength(DIGEST_SECRET.length);
  });

  it('keeps the dgs_ prefix', () => {
    expect(WRONG_SECRET.startsWith(PREFIX)).toBe(true);
  });

  it('has the shape of the seeded secret', () => {
    expect(WRONG_SECRET).toMatch(SEEDED_SHAPE);
  });

  it('differs from the seeded secret in exactly one position', () => {
    const differing = [...DIGEST_SECRET].filter(
      (character, index) => WRONG_SECRET[index] !== character
    );

    expect(differing).toHaveLength(1);
  });
});
