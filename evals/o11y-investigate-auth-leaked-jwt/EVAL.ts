import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: edge function logs a JWT-shaped token in plaintext.
// Evidence: seeded logs.jsonl with function log line containing eyJ... token.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const identifiedJwtLeak =
    /jwt|token.{0,20}log|log.{0,20}token|eyJ|secret.{0,20}log|credentials?.{0,20}log/i.test(report);
  const identifiedFunction =
    /auth.?leak.?demo|edge.{0,20}function/i.test(report);
  const proposedFix =
    /remove.{0,20}log|console\.(log|error)|logging.{0,20}statement|redact/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified JWT token being leaked in logs', passed: identifiedJwtLeak },
    { name: 'identified the edge function responsible', passed: identifiedFunction },
    { name: 'proposed removing the logging statement', passed: proposedFix },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Reviewed the edge function logs and found a JWT-shaped token (eyJ...)
         being logged in plaintext by the auth-leak-demo function.
      2. Confirmed this is a security issue (credentials must not appear in logs).
      3. Proposed removing or redacting the console.log statement from the
         function code.

      Fail if the agent dismissed the finding, misidentified the function, or
      gave only generic security advice without identifying the specific log line.
    `,
  });
  checks.push({
    name: 'correctly diagnosed JWT leak and proposed fix',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return { passed: checks.every((c) => c.passed), checks };
};

export default scorer;
