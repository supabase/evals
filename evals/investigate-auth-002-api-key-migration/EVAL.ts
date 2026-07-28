import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const scorer: ToolScorer = async (ctx) => {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript),
    rubric: stripIndent`
      Pass if the assistant explains the legacy anon/service_role keys against the new publishable/secret keys, says which key belongs in frontend code, and says what each means for RLS.

      A passing answer should:
      - Describe the legacy and new keys as role equivalents: the anon key corresponds to the publishable key, and the service_role key corresponds to a secret key.
      - Explain that the publishable key belongs in frontend code. It identifies the app rather than a user: requests carrying no user access token run as the anon role, and requests carrying one run as the authenticated role. RLS applies either way.
      - Explain that a secret key is server-only, maps to service_role, bypasses RLS, and must never ship to the client.

      Fail if the assistant recommends putting a secret key or the legacy service_role key in frontend code, says RLS applies to the secret key, claims the publishable key bypasses RLS, says the publishable key itself authenticates a user or carries their identity, or inverts the legacy-to-new key mapping.
    `,
  });

  const checks: CheckResult[] = [
    {
      name: 'explained publishable vs secret API keys',
      passed: verdict.passed,
      judgeNotes: verdict.notes,
    },
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
};

export default scorer;
