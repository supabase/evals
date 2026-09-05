import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Fault: /rest/v1/reports drives DB CPU because it runs a JOIN between reports
// and the 200k-row events table with no index on events.user_id. The agent must
// cross-reference API logs (which endpoint is slow?) with pg_stat_statements
// (which query is expensive?) to attribute the load correctly.

const scorer: ToolScorer = async (ctx) => {
  const report = ctx.agentReport ?? '';
  const transcript = serializeTranscript(ctx.transcript, { includeToolCallInputs: true });

  const namedReports =
    /\breports\b/i.test(report) &&
    (/\/rest\/v1\/reports/i.test(report) || /reports.*endpoint|endpoint.*reports/i.test(report));
  const inspectedLogs = /\/rest\/v1\//i.test(transcript);
  const inspectedStats = /pg_stat_statements|query performance|query insights/i.test(transcript);
  const identifiedJoin =
    /\bjoin\b/i.test(report) &&
    /\bevents\b/i.test(report);

  const checks: CheckResult[] = [
    { name: 'identified /rest/v1/reports as the load source', passed: namedReports },
    { name: 'inspected API logs across endpoints', passed: inspectedLogs },
    { name: 'inspected query statistics', passed: inspectedStats },
    { name: 'identified the expensive join involving events', passed: identifiedJoin },
  ];

  const verdict = await judge({
    input: transcript,
    rubric: stripIndent`
      Pass if the agent:
      1. Reviews API logs and identifies that /rest/v1/reports requests are
         consistently slow (3–4s) while /rest/v1/users and /rest/v1/events
         are fast.
      2. Cross-references those slow requests with query statistics to find
         the expensive JOIN between reports and events.
      3. Correctly attributes the elevated DB CPU to the reports endpoint.
      4. Proposes a concrete fix — such as adding an index on events.user_id,
         rewriting the query, or removing the join.

      Fail if the agent blames the wrong endpoint, only looks at one data
      source (logs only or stats only), or gives vague advice without naming
      the reports table and the expensive join.
    `,
  });

  checks.push({
    name: 'correctly attributed load to reports endpoint and identified cause',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  });

  return {
    passed: namedReports && inspectedStats && identifiedJoin && verdict.passed,
    checks,
  };
};

export default scorer;
