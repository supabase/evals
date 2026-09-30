import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: checkout function dereferences an unset env var (SECRET_KEY!),
// throwing on every invocation. Evidence: seeded logs showing 500 errors.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identified500 =
    /checkout.{0,30}(500|error|fail)|500.{0,30}checkout/i.test(report);
  const identifiedCause =
    /env.{0,20}(var|variable|key)|secret.?key|unset|undefined|null.{0,10}deref|bang|!/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified checkout function returning 500', passed: identified500 },
    { name: 'identified missing env var as root cause', passed: identifiedCause },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that the checkout edge function is returning 500 on every call.
      2. Identified the root cause as a missing environment variable (SECRET_KEY
         accessed with ! which throws when undefined).
      3. Proposed guarding the env var with a null check or default, or setting
         the environment variable in the project settings.

      Fail if the agent misidentified the cause or did not propose a specific fix.
    `,
  });
  checks.push({
    name: 'correctly diagnosed 500 error and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
