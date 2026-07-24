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
      Pass if the assistant answers the support question with safe, docs-grounded unhealthy-project recovery guidance.

      A passing answer should:
      - Say that pausing and restoring/resuming the project is not the right first recovery step for an unhealthy or locked-up project.
      - Distinguish restart from restore: restart/reboot is a recovery step for temporary unhealthy services; restore is backup/data recovery and should not be conflated with restart.
      - Recommend practical first steps such as restarting the database/project, waiting a few minutes, checking logs/advisors/resource pressure, reducing workload or scaling if overloaded, reviewing the unhealthy-services troubleshooting guidance, and contacting Supabase support if the project remains unhealthy.

      Fail if the assistant recommends pause plus restore/resume as the recovery path, presents pause/restore as a reliable fix for unhealthy services, conflates restore with restart, or gives only vague guidance without a concrete safe first step.
    `,
  });

  const checks: CheckResult[] = [
    {
      name: 'answered unhealthy project recovery question safely',
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
