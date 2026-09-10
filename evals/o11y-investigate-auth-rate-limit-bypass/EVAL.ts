import {
  judge,
  serializeTranscript,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: burst of failed auth attempts seeded in auth.audit_log_entries.
// This is an investigate eval — agent diagnoses the attack pattern and proposes
// rate-limiting / captcha configuration.

const scorer: LocalStackScorer = async (ctx) => {
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });
  const report = ctx.agentReport ?? '';

  const inspectedLogs =
    /audit_log|auth.log|sign.{0,5}in|failed.{0,20}attempt|invalid.{0,20}creden/i.test(transcript);
  const identifiedBurst =
    /burst|repeated|brute.?force|high.{0,20}rate|same.{0,20}ip/i.test(report);

  const checks: CheckResult[] = [
    { name: 'inspected auth audit logs', passed: inspectedLogs },
    { name: 'identified repeated failed attempts / brute force', passed: identifiedBurst },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Queried auth.audit_log_entries and identified the burst of failed login
         attempts from the same IP range.
      2. Proposed concrete configuration changes — such as enabling CAPTCHA,
         lowering rate limits, or enabling IP-based throttling in GoTrue config.

      Fail if the agent did not inspect the auth logs, misidentified the issue,
      or gave only vague recommendations without specifics.
    `,
  });
  checks.push({
    name: 'correctly diagnosed rate-limit bypass and proposed config fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
