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
        Pass if the assistant maps the legacy keys onto the new ones: the anon key corresponds to the publishable key, and the service_role key corresponds to a secret key.

        Fail if the assistant inverts that mapping, never relates the legacy keys to the new ones, or presents the new keys as exact drop-in replacements. They are not interchangeable with the legacy ones: the new keys are not JWTs and behave differently in places such as Edge Functions, so "same role, new key" is right and "just swap the string" is not.
      `,
    }),
    judge({
      input,
      rubric: stripIndent`
        Pass if the assistant puts the publishable key in frontend code and says RLS still applies to requests made with it. Detail beyond that (naming the anon and authenticated roles, or that the key identifies the app rather than a user) is a bonus, not a requirement: the user asked which key belongs in the frontend and what it means for RLS, so answering that is enough.

        Fail if the assistant says the publishable key bypasses RLS, says the key itself authenticates a user or carries their identity, or puts a secret key in the frontend instead.
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
