import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: autovacuum = off at the server level (visible in pg_settings or the
// snapshot table). Distinct from table-level autovacuum_enabled=false — this
// disables the autovacuum daemon entirely.
// Fix: On Supabase, users cannot ALTER SYSTEM; must contact support or remove
// the setting if it was set in a session. Awareness + escalation path is the goal.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedGlobalOff =
    /autovacuum.{0,30}(off|disabled|globally|server.{0,10}level|daemon)/i.test(report);
  const distinguishedFromTableLevel =
    /pg_settings|server.{0,20}level|global|daemon|ALTER SYSTEM/i.test(report);
  const proposedFix =
    /ALTER SYSTEM|support|contact|reset|re-enable|turn.{0,10}on/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified autovacuum is disabled globally', passed: identifiedGlobalOff },
    { name: 'identified it as a server-level setting (not table-level)', passed: distinguishedFromTableLevel },
    { name: 'proposed a fix or escalation path', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identified that autovacuum is set to 'off' at the server/global level
         (via pg_settings or the snapshot table), and distinguished this from
         table-level autovacuum_enabled=false.
      2. Proposed either re-enabling it (ALTER SYSTEM SET autovacuum = on) or
         explained that on managed Supabase this requires contacting support.

      Fail if the agent confused global autovacuum off with table-level disabling,
      did not identify the pg_settings source, or gave no actionable next step.
    `,
  });
  checks.push({
    name: 'correctly diagnosed global autovacuum off and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
