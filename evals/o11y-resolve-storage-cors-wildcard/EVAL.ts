import {
  judge,
  serializeTranscript,
  type CheckResult,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: storage CORS set to allowedOrigins: ["*"].
// BLOCKED: CORS config is a platform/infrastructure setting, not SQL-verifiable.
// Eval relies entirely on judge scoring of the agent's diagnostic report.

const scorer: LocalStackScorer = async (ctx) => {
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent identified that the storage CORS configuration uses a
      wildcard origin ("*") which is insecure, and proposed restricting it to a
      specific origin (e.g. "https://example.com" or the project's production
      domain) via config.toml [storage.cors] or equivalent Supabase dashboard
      setting.

      Fail if the agent:
      - Did not identify the wildcard CORS as the issue
      - Only described the risk without proposing a specific configuration change
      - Proposed keeping the wildcard but adding other mitigations
    `,
  });

  const checks: CheckResult[] = [
    {
      name: 'correctly identified and proposed fix for wildcard CORS',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    },
  ];

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
