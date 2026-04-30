import type { Scorer } from "../../apps/framework/harness/types.js";

const TARGET_USER = "00000000-0000-0000-0000-000000000001";

const scorer: Scorer = async (ctx) => {
  const q = (sql: string) =>
    ctx.mgmt.call("database.query", { query: sql }) as Promise<{ rows: any[] }>;
  const checks: Array<{ name: string; ok: boolean }> = [];

  try {
    const { rows: indexes } = await q(`
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'events';
    `);
    const hasCoveringIndex = indexes.some((row) =>
      /ON\s+(?:public\.)?events\s+.*\(\s*user_id\s*,\s*created_at/i.test(row.indexdef)
    );
    checks.push({
      name: "created index covering user_id and created_at",
      ok: hasCoveringIndex,
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
      name: "query plan uses an index",
      ok: /(Index Scan|Index Only Scan|Bitmap Index Scan)/i.test(plan),
    });
    checks.push({
      name: "query plan avoids sequential scan on events",
      ok: !/Seq Scan on events/i.test(plan),
    });

    const { rows: inserted } = await q(`
INSERT INTO events (user_id, kind, payload)
VALUES ('${TARGET_USER}', 'insert_probe', '{"ok": true}'::jsonb)
RETURNING id;
    `);
    checks.push({ name: "inserts still work", ok: inserted.length === 1 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      score: checks.filter((c) => c.ok).length / 4,
      notes: [
        ...checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`),
        `FAIL scorer could not evaluate performance fix: ${msg}`,
      ].join("\n"),
    };
  }

  return {
    passed: checks.every((c) => c.ok),
    score: checks.filter((c) => c.ok).length / checks.length,
    notes: checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("\n"),
  };
};

export default scorer;
