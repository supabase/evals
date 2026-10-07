import { describe, expect, it } from 'vitest';
import { describeFailure, summarizeHelpOutput } from './shell.js';

describe('summarizeHelpOutput', () => {
  it('replaces a help payload and keeps surrounding text', () => {
    expect(
      summarizeHelpOutput('usage: {"_tag":"Help","flags":[{"a":1}]} done')
    ).toBe('usage: <help output> done');
  });

  it('replaces a truncated payload through the end', () => {
    expect(summarizeHelpOutput('{"_tag":"Help","flags":[{"a"')).toBe(
      '<help output>'
    );
  });

  it('leaves other text alone', () => {
    expect(summarizeHelpOutput('{"DB_URL":"x"}')).toBe('{"DB_URL":"x"}');
  });
});

describe('describeFailure', () => {
  it('shortens a help payload before truncating', () => {
    expect(
      describeFailure({
        exitCode: 1,
        stdout: `{"_tag":"Help","text":"${'x'.repeat(500)}"}`,
        stderr: '',
      })
    ).toBe('exit 1: <help output>');
  });
});
