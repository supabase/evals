import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: A custom chaos_admin role has BYPASSRLS and is used by a function
// callable by authenticated users, allowing them to bypass row-level security.
// BLOCKED: supabase_auth_admin is a superuser-reserved role; eval uses
// a custom chaos_admin role with BYPASSRLS as a stand-in.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedBypassrls =
    /bypassrls|bypass.{0,10}rls|security.{0,10}definer|row.{0,10}level.{0,10}security.{0,20}bypass/i.test(report);
  const identifiedRisk =
    /escalat|privilege|anon|authenticated.{0,20}(bypass|admin|access)|function.{0,20}security.{0,20}definer|get_all_orders/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified BYPASSRLS configuration', passed: identifiedBypassrls },
    { name: 'identified privilege escalation risk', passed: identifiedRisk },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent identified that a role with BYPASSRLS privilege is used
      by a SECURITY DEFINER function callable by authenticated/anon users, and
      explained that this allows bypassing RLS on all tables. The fix should
      involve revoking BYPASSRLS from the role, revoking EXECUTE on the function
      from public roles, or both.

      Fail if the agent misidentified the issue or gave only generic RLS advice.
    `,
  });
  checks.push({
    name: 'correctly diagnosed BYPASSRLS privilege escalation',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
