import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: GET /rest/v1/orders is slow because the orders table has no index on
// user_id. The agent must correlate API request logs with pg_stat_statements to
// identify the sequential scan and propose adding an index.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const namedOrdersTable = /\borders\b/i.test(report);
  const inspectedLogs = /\/rest\/v1\/orders|orders endpoint|api log/i.test(transcript);
  const inspectedStats = /pg_stat_statements|query performance|query insights/i.test(transcript);
  const proposedIndex =
    /\bcreate index\b|\badd.*index\b|\bindex on\b/i.test(report) ||
    /\buser_id\b.*\bindex\b|\bindex\b.*\buser_id\b/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified orders as the slow endpoint target', passed: namedOrdersTable },
    { name: 'inspected API logs', passed: inspectedLogs },
    { name: 'inspected query statistics', passed: inspectedStats },
    { name: 'proposed adding an index', passed: proposedIndex },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Identifies that GET /rest/v1/orders requests are consistently slow (2–3s).
      2. Correlates the API logs with query statistics to find the underlying
         SELECT on the orders table.
      3. Identifies that the query does a sequential scan (high blks_read, no
         index on user_id or similar filter column).
      4. Proposes a concrete fix — at minimum, creating an index on the filter
         column (user_id or equivalent).

      Fail if the agent only looks at logs without checking query statistics,
      blames the wrong table, or gives vague advice without a concrete index
      recommendation.
    `,
  });

  checks.push({
    name: 'correctly traced slow endpoint to seq scan and proposed index',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return {
    passed: namedOrdersTable && inspectedStats && proposedIndex && verdict.passed,
    checks,
  };
};

export default scorer;
