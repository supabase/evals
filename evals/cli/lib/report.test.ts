// Run: pnpm --filter @supabase-evals/framework exec vitest run --root ../.. evals/cli/lib
import { serializeTranscript, type TranscriptPart } from '@supabase-evals/core';
import { describe, expect, it } from 'vitest';
import { formatGroundTruthJudgeInput, mentionsNumber } from './report.js';

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
