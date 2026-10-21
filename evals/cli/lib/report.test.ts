// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import { serializeTranscript, type TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import {
  formatGroundTruthJudgeInput,
  maskAccessTokens,
  mentionsNumber,
} from './report.js';

describe('formatGroundTruthJudgeInput', () => {
  it('matches the stack-lifecycle truthful-judge input', () => {
    const transcript: TranscriptPart[] = [
      {
        type: 'tool_call',
        name: 'bash',
        input: { command: 'supabase start' },
        output: 'Started supabase local development setup.',
      },
      { type: 'message', role: 'assistant', content: 'Started the stack.' },
    ];
    const groundTruth = [
      '- stack: resolved: managed/native',
      '- notes rows: 3',
      '- migration file creating notes: yes',
    ];
    const expected = [
      'Ground truth observed by the harness after the run:',
      '- stack: resolved: managed/native',
      '- notes rows: 3',
      '- migration file creating notes: yes',
      '',
      'Transcript:',
      serializeTranscript(transcript, { includeToolCallInputs: true }),
    ].join('\n');
    expect(formatGroundTruthJudgeInput(groundTruth, transcript)).toBe(expected);
    expect(expected).toContain('supabase start');
  });

  describe('tool call outputs', () => {
    const transcript: TranscriptPart[] = [
      {
        type: 'tool_call',
        name: 'bash',
        input: { command: 'supabase gen types --local' },
        output: 'supabase start is not running.',
      },
    ];

    it('leaves outputs out by default', () => {
      const input = formatGroundTruthJudgeInput(['- fact'], transcript);

      expect(input).toContain('supabase gen types --local');
      expect(input).not.toContain('supabase start is not running.');
    });

    it('leaves outputs out when includeToolCallOutputs is false', () => {
      expect(
        formatGroundTruthJudgeInput(['- fact'], transcript, {
          includeToolCallOutputs: false,
        })
      ).toBe(formatGroundTruthJudgeInput(['- fact'], transcript));
    });

    it('adds outputs after the inputs when includeToolCallOutputs is true', () => {
      const input = formatGroundTruthJudgeInput(['- fact'], transcript, {
        includeToolCallOutputs: true,
      });

      expect(input).toBe(
        [
          'Ground truth observed by the harness after the run:',
          '- fact',
          '',
          'Transcript:',
          serializeTranscript(transcript, {
            includeToolCallInputs: true,
            includeToolCallOutputs: true,
          }),
        ].join('\n')
      );
      expect(input).toContain('supabase gen types --local');
      expect(input).toContain('supabase start is not running.');
    });
  });
});

describe('mentionsNumber', () => {
  it.each<[text: string, expected: boolean]>([
    ['API on port 54321.', true],
    ['http://127.0.0.1:54321/rest', true],
    ['54321', true],
    ['port 543210', false],
    ['port 154321', false],
    ['no ports here', false],
  ])('finds 54321 in %j: %j', (text, expected) => {
    expect(mentionsNumber(text, 54321)).toBe(expected);
  });
});

describe('maskAccessTokens', () => {
  const MASK = '[redacted access token]';
  const TOKEN = `sbp_${'e'.repeat(40)}`;

  it('masks a token typed into a command', () => {
    expect(maskAccessTokens(`supabase login --token ${TOKEN}`)).toBe(
      `supabase login --token ${MASK}`
    );
  });

  it('masks a token printed after an environment variable name', () => {
    expect(maskAccessTokens(`SUPABASE_ACCESS_TOKEN=${TOKEN}\nHOME=/root`)).toBe(
      `SUPABASE_ACCESS_TOKEN=${MASK}\nHOME=/root`
    );
  });

  it.each([
    ['sbp_', `sbp_${'a'.repeat(40)}`],
    ['sbp_oauth_', `sbp_oauth_${'b'.repeat(40)}`],
    ['sbp_v0_', `sbp_v0_${'0123456789abcdef'.repeat(3).slice(0, 40)}`],
  ])('masks a token with the %s prefix', (_, token) => {
    const masked = maskAccessTokens(`token: ${token}.`);

    expect(masked).toBe(`token: ${MASK}.`);
    expect(masked).not.toContain(token);
  });

  it('masks every token in the text', () => {
    const masked = maskAccessTokens(
      `${TOKEN} and ${TOKEN.replace('e', 'f')} in "${TOKEN}"`
    );

    expect(masked).toBe(`${MASK} and ${MASK} in "${MASK}"`);
  });

  it.each([
    ['too short', `sbp_${'e'.repeat(39)}`],
    ['not hexadecimal', `sbp_${'g'.repeat(40)}`],
    ['a different prefix', `sbx_${'e'.repeat(40)}`],
  ])('leaves a string alone when it is %s', (_, text) => {
    expect(maskAccessTokens(text)).toBe(text);
  });

  it('leaves text without a token untouched', () => {
    const text =
      'supabase config push --project-ref abcdefghijklmnopqrst --yes';

    expect(maskAccessTokens(text)).toBe(text);
  });
});
