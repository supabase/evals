import {
  type CheckResult,
  type ToolCallRecord,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const TARGET_USER = '00000000-0000-0000-0000-000000000001';

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      ...performanceWorkflowChecks(ctx.toolCalls),
      ...(await Promise.all(
        [
          checkCreatedRecentEventsIndex,
          checkQueryPlanUsesIndex,
          checkInsertsStillWork,
        ].map(async (check) => {
          try {
            return await check(ctx);
          } catch (error) {
            return {
              name: check.name,
              passed: false,
              notes: error instanceof Error ? error.message : String(error),
            };
          }
        })
      )),
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
          name: 'scorer evaluated CPU spike fix',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

export function performanceWorkflowChecks(
  calls: ToolCallRecord[]
): CheckResult[] {
  const queries: string[] = [];
  for (const call of calls) {
    if (
      call.tool.kind === 'mcp' &&
      call.tool.server === 'supabase-mcp' &&
      call.tool.toolName === 'execute_sql' &&
      !call.error &&
      typeof call.body.query === 'string'
    )
      queries.push(call.body.query);
  }
  return [
    {
      name: 'inspected pg_stat_statements for query performance',
      passed: queries.some((query) =>
        /\b(?:from|join)\s+(?:public\.)?pg_stat_statements\b/i.test(query)
      ),
    },
    {
      name: 'ran EXPLAIN on the expensive query',
      passed: queries.some(
        (query) =>
          /^\s*explain\b/i.test(query) &&
          /\bevents\b/i.test(query) &&
          /\buser_id\b/i.test(query)
      ),
    },
  ];
}

async function checkCreatedRecentEventsIndex(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'events';
  `);

  const hasCoveringIndex = rows.some((row) => {
    const def = row.indexdef;
    return (
      typeof def === 'string' &&
      /ON\s+(?:public\.)?events\s+.*\(\s*user_id\s*,\s*created_at/i.test(def)
    );
  });

  return {
    name: 'created index covering user_id and created_at',
    passed: hasCoveringIndex,
  };
}

async function checkQueryPlanUsesIndex(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    EXPLAIN SELECT id, kind, payload, created_at
    FROM events
    WHERE user_id = '${TARGET_USER}'
    ORDER BY created_at DESC
    LIMIT 50;
  `);
  const plan = rows.map((row) => Object.values(row).join(' ')).join('\n');

  return {
    name: 'query plan uses an index and avoids sequential scan',
    passed:
      /(Index Scan|Index Only Scan|Bitmap Index Scan|SEARCH \S+ USING (?:COVERING )?INDEX)/i.test(
        plan
      ) && !/(Seq Scan on events|\bSCAN (?:TABLE )?events\b)/i.test(plan),
    notes: plan,
  };
}

async function checkInsertsStillWork(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(stripIndent`
    INSERT INTO events (user_id, kind, payload)
    VALUES ('${TARGET_USER}', 'insert_probe', '{"ok": true}'::jsonb)
    RETURNING id;
  `);

  return {
    name: 'inserts still work',
    passed: rows.length === 1,
  };
}
