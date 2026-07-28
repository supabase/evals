import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const scorer: ToolScorer = async (ctx) => {
  const input = serializeTranscript(ctx.transcript);

  const [mapping, frontendKey, serverKey] = await Promise.all([
    judge({
      input,
      rubric: stripIndent`
        Pass if the assistant maps the legacy keys onto the new ones as role equivalents: the anon key corresponds to the publishable key, and the service_role key corresponds to a secret key.

        Fail if the assistant inverts that mapping, or presents the new keys as exact drop-in renames of the legacy ones rather than role equivalents.
      `,
    }),
    judge({
      input,
      rubric: stripIndent`
        Pass if the assistant puts the publishable key in frontend code and describes it as identifying the app rather than a user: requests carrying no user access token run as the anon role, requests carrying one run as the authenticated role, and RLS applies either way.

        Fail if the assistant says the publishable key bypasses RLS, or says the key itself authenticates a user or carries their identity.
      `,
    }),
    judge({
      input,
      rubric: stripIndent`
        Pass if the assistant keeps a secret key server-only, maps it to service_role, and says it bypasses RLS and must never ship to the client.

        Fail if the assistant recommends putting a secret key or the legacy service_role key in frontend code, or says RLS applies to the secret key.
      `,
    }),
  ]);

  const checks: CheckResult[] = [
    {
      name: 'mapped legacy anon/service_role onto publishable/secret',
      passed: mapping.passed,
      judgeNotes: mapping.notes,
    },
    {
      name: 'placed the publishable key in the frontend with RLS still applying',
      passed: frontendKey.passed,
      judgeNotes: frontendKey.notes,
    },
    {
      name: 'kept the secret key server-only and RLS-bypassing',
      passed: serverKey.passed,
      judgeNotes: serverKey.notes,
    },
  ];

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
};

export default scorer;
