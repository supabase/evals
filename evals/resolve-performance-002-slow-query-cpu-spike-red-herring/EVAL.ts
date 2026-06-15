import {
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const TARGET_USER = "00000000-0000-0000-0000-000000000001";

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      checkQueriedPgStatStatements(ctx),
      checkRankedByTotalExecTime(ctx),
      checkRanExplain(ctx),
      await checkCreatedRecentEventsIndex(ctx),
      await checkQueryPlanUsesIndex(ctx),
      await checkInsertsStillWork(ctx),
    ];

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: "scorer evaluated CPU spike fix",
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

/** Checks that the agent inspected query statistics rather than guessing the fix. */
function checkQueriedPgStatStatements(ctx: ToolEvalContext): CheckResult {
  const sql = executedSql(ctx);

  return {
    name: "inspected pg_stat_statements for query performance",
    passed: /\bpg_stat_statements\b/i.test(sql),
  };
}

/**
 * The crux of this scenario: the slow-query logs and the mean/max columns point
 * at the rare audit_log report (the decoy). The CPU hog only surfaces when
 * ranking by cumulative execution time, so a correct diagnosis sorts the query
 * stats by total_exec_time rather than per-call latency.
 */
function checkRankedByTotalExecTime(ctx: ToolEvalContext): CheckResult {
  const sql = executedSql(ctx);

  return {
    name: "ranked query stats by total (cumulative) execution time",
    passed: /\btotal_exec_time\b/i.test(sql),
  };
}

/** Checks that the agent used EXPLAIN on the expensive events query (the hog). */
function checkRanExplain(ctx: ToolEvalContext): CheckResult {
  const sql = executedSql(ctx);

  return {
    name: "ran EXPLAIN on the expensive query",
    passed:
      /\bexplain\b/i.test(sql) &&
      /\bevents\b/i.test(sql) &&
      /\buser_id\b/i.test(sql),
  };
}

/** Checks for the index shape needed by the recent events lookup (the CPU hog). */
async function checkCreatedRecentEventsIndex(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'events';
  `);

  const hasCoveringIndex = rows.some((row) => {
    const def = row.indexdef;
    return (
      typeof def === "string" &&
      /ON\s+(?:public\.)?events\s+.*\(\s*user_id\s*,\s*created_at/i.test(def)
    );
  });

  return {
    name: "created index covering user_id and created_at on events",
    passed: hasCoveringIndex,
  };
}

/**
 * Decisive correctness check: verifies Postgres plans the high-frequency hog
 * lookup with an index and no sequential scan. An agent that only fixed the
 * audit_log decoy leaves this query on a seq scan and fails here.
 */
async function checkQueryPlanUsesIndex(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    EXPLAIN SELECT id, kind, payload, created_at
    FROM events
    WHERE user_id = '${TARGET_USER}'
    ORDER BY created_at DESC
    LIMIT 50;
  `);
  const plan = rows.map((row) => Object.values(row).join(" ")).join("\n");

  return {
    name: "hog query plan uses an index and avoids sequential scan",
    passed:
      /(Index Scan|Index Only Scan|Bitmap Index Scan)/i.test(plan) &&
      !/Seq Scan on events/i.test(plan),
    notes: plan,
  };
}

/** Confirms the schema change did not break normal inserts into events. */
async function checkInsertsStillWork(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    INSERT INTO events (user_id, kind, payload)
    VALUES ('${TARGET_USER}', 'insert_probe', '{"ok": true}'::jsonb)
    RETURNING id;
  `);

  return {
    name: "inserts still work",
    passed: rows.length === 1,
  };
}

/** Collects SQL-like text from tool calls and transcript entries for workflow checks. */
function executedSql(ctx: ToolEvalContext): string {
  const toolCallSql = ctx.toolCalls
    .flatMap((call) => Object.values(call.body))
    .filter((value): value is string => typeof value === "string")
    .join("\n");

  return [
    toolCallSql,
    serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
  ].join("\n");
}
