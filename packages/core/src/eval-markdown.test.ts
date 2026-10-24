import { describe, expect, it } from 'vitest';
import { parseEvalMarkdown } from './eval-markdown.js';

describe('parseEvalMarkdown', () => {
  const frontmatter = (extra: string) =>
    [
      '---',
      'stage: build',
      'product: database',
      'topic: sdk',
      'interface: cli',
      extra,
      '---',
      '',
      'Do the thing.',
    ]
      .filter(Boolean)
      .join('\n');

  it('reads sdk from the frontmatter', () => {
    expect(parseEvalMarkdown(frontmatter('sdk: python')).metadata.sdk).toBe(
      'py'
    );
  });

  it('leaves sdk undefined when the frontmatter omits it', () => {
    expect(parseEvalMarkdown(frontmatter('')).metadata.sdk).toBeUndefined();
  });

  it('names the sdk field in the error for an unknown value', () => {
    expect(() =>
      parseEvalMarkdown(frontmatter('sdk: go'), 'x/PROMPT.md')
    ).toThrow(/x\/PROMPT\.md has invalid eval metadata: sdk:/);
  });
});
