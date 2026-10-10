import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: authenticated reads on posts are slow because the RLS policy calls
// public.get_current_user_id(), a VOLATILE wrapper function. Postgres cannot
// hoist a VOLATILE call into an initplan, so it re-evaluates the function for
// every row scanned. The smoking gun is in pg_stat_statements: low blks_read
// (data is cached) but high mean_exec_time (~650ms). The agent must trace the
// slow stats to the policy, identify the VOLATILE function as the cause, and
// propose making the function STABLE or wrapping the call in (SELECT ...).

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const namedPostsTable = /\bposts\b/i.test(report);
  const inspectedStats = /pg_stat_statements|query performance|query insights/i.test(transcript);
  const identifiedCause =
    /volatile|initplan|per.?row|re.?evaluat/i.test(report) ||
    /get_current_user_id|rls.*slow|slow.*rls|policy.*slow|slow.*policy/i.test(report);
  const proposedFix =
    /\bstable\b/i.test(report) ||
    /\(select\s+.*\)|sub.?select.*policy|wrap.*policy|policy.*wrap/i.test(report) ||
    /change.*volatile|volatile.*change|volatile.*stable/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified posts as the affected table', passed: namedPostsTable },
    { name: 'inspected query statistics', passed: inspectedStats },
    { name: 'identified per-row VOLATILE function evaluation as the cause', passed: identifiedCause },
    { name: 'proposed making the function STABLE or wrapping in (SELECT ...)', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Notices from query statistics that the posts SELECT is slow despite
         low I/O (data is in memory), indicating per-row CPU overhead rather
         than disk reads.
      2. Examines the RLS policy on the posts table and identifies
         public.get_current_user_id() as the function being called in the
         USING clause.
      3. Identifies that the function is VOLATILE, causing Postgres to
         re-evaluate it for every row scanned rather than once per query
         (the initplan / per-row evaluation problem).
      4. Proposes a concrete fix: either change the function from VOLATILE
         to STABLE, or rewrite the policy USING clause to wrap the call in
         a sub-SELECT — e.g. USING (user_id = (SELECT public.get_current_user_id())).

      Fail if the agent blames I/O or missing indexes without investigating
      the RLS policy, or gives vague advice without identifying the VOLATILE
      function and explaining why it causes per-row re-evaluation.
    `,
  });

  checks.push({
    name: 'correctly diagnosed VOLATILE initplan cause and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return {
    passed: namedPostsTable && inspectedStats && identifiedCause && proposedFix && verdict.passed,
    checks,
  };
};

export default scorer;
