import type { CheckResult, ToolScorer } from "@supabase-evals/core";

const TARGET_USER = "00000000-0000-0000-0000-000000000001";

const scorer: ToolScorer = async (ctx) => {
  const q = (sql: string) =>
    ctx.query(sql);
  const checks: CheckResult[] = [];

  try {
    const { rows: indexes } = await q(`
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'events';
    `);
    const hasCoveringIndex = indexes.some((row) => {
      const def = row.indexdef;
      return typeof def === "string" && /ON\s+(?:public\.)?events\s+.*\(\s*user_id\s*,\s*created_at/i.test(def);
    });
    checks.push({
      type: "deterministic",
      name: "created index covering user_id and created_at",
      passed: hasCoveringIndex,
    });

    const { rows: planRows } = await q(`
EXPLAIN SELECT id, kind, payload, created_at
FROM events
WHERE user_id = '${TARGET_USER}'
ORDER BY created_at DESC
LIMIT 50;
    `);
    const plan = planRows.map((row) => Object.values(row).join(" ")).join("\n");
    checks.push({
      type: "deterministic",
      name: "query plan uses an index",
      passed: /(Index Scan|Index Only Scan|Bitmap Index Scan)/i.test(plan),
    });
    checks.push({
      type: "deterministic",
      name: "query plan avoids sequential scan on events",
      passed: !/Seq Scan on events/i.test(plan),
    });

    const { rows: inserted } = await q(`
INSERT INTO events (user_id, kind, payload)
VALUES ('${TARGET_USER}', 'insert_probe', '{"ok": true}'::jsonb)
RETURNING id;
    `);
    checks.push({ type: "deterministic", name: "inserts still work", passed: inserted.length === 1 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      type: "deterministic",
      name: "scorer evaluated performance fix",
      passed: false,
      notes: msg,
    });
    return {
      passed: false,
      checks,
    };
  }

  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
};

export default scorer;
