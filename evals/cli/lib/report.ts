import { serializeTranscript, type TranscriptPart } from '@supabase-evals/core';

/** Judge input pairing the harness's own ground truth with the full transcript; tool call outputs are included only on request. */
export function formatGroundTruthJudgeInput(
  groundTruth: readonly string[],
  transcript: TranscriptPart[],
  options: { includeToolCallOutputs?: boolean } = {}
): string {
  return [
    'Ground truth observed by the harness after the run:',
    ...groundTruth,
    '',
    'Transcript:',
    serializeTranscript(transcript, {
      includeToolCallInputs: true,
      ...options,
    }),
  ].join('\n');
}

/** Whether `text` contains `n` as a whole number, not as part of a longer one. */
export function mentionsNumber(text: string, n: number): boolean {
  return new RegExp(`(?<!\\d)${n}(?!\\d)`).test(text);
}

const ACCESS_TOKEN_REGEX = /sbp_(oauth_|v0_)?[a-f0-9]{40}/g;

/** Replaces every Supabase access token in text sent to a judge. */
export function maskAccessTokens(text: string): string {
  return text.replace(ACCESS_TOKEN_REGEX, '[redacted access token]');
}
