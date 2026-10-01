import { serializeTranscript, type TranscriptPart } from '@supabase-evals/core';

/** Judge input pairing the harness's own ground truth with the full transcript. */
export function formatGroundTruthJudgeInput(
  groundTruth: readonly string[],
  transcript: TranscriptPart[]
): string {
  return [
    'Ground truth observed by the harness after the run:',
    ...groundTruth,
    '',
    'Transcript:',
    serializeTranscript(transcript, { includeToolCallInputs: true }),
  ].join('\n');
}

/** Whether `text` contains `n` as a whole number, not as part of a longer one. */
export function mentionsNumber(text: string, n: number): boolean {
  return new RegExp(`(?<!\\d)${n}(?!\\d)`).test(text);
}
