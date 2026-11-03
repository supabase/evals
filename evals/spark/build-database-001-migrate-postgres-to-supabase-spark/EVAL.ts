import { stripIndent } from 'common-tags';
import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
} from '@supabase-evals/core';

const TABLES = [
  { name: 'teams', expectedRows: 5 },
  { name: 'members', expectedRows: 10 },
  { name: 'tasks', expectedRows: 13 },
];

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [];
    for (const check of [
      checkTablesExist,
      checkRowCounts,
      checkForeignKeys,
      checkIndex,
      checkSequencesSynced,
    ]) {
      try {
        checks.push(await check(ctx));
      } catch (error) {
        checks.push({
          name: check.name,
          passed: false,
          notes: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: 'scorer completed without errors', passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

async function checkTablesExist(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'all 3 tables exist (teams, members, tasks)';
  const missing: string[] = [];
  for (const table of ['teams', 'members', 'tasks']) {
    try {
      await ctx.query(`select * from ${table} limit 0`);
    } catch {
      missing.push(table);
    }
  }
  return {
    name,
    passed: missing.length === 0,
    notes: missing.length ? `missing: ${missing.join(', ')}` : undefined,
  };
}

async function checkRowCounts(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'row counts match (teams=5, members=10, tasks=13)';
  const problems: string[] = [];
  for (const { name: table, expectedRows } of TABLES) {
    const { rows } = await ctx.query(`select count(*)::int as n from ${table}`);
    const actual = Number(rows[0]?.n ?? 0);
    if (actual !== expectedRows) {
      problems.push(`${table}: expected ${expectedRows}, got ${actual}`);
    }
  }
  return {
    name,
    passed: problems.length === 0,
    notes: problems.length === 0 ? undefined : problems.join('; '),
  };
}

async function checkForeignKeys(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const trials = [
    {
      table: 'members',
      sql: "insert into members(team_id, email, full_name) values (-1, 'fk-probe@example.com', 'FK probe') returning id",
    },
    {
      table: 'tasks',
      sql: "insert into tasks(team_id, title) values (-1, 'FK probe') returning id",
    },
    {
      table: 'tasks',
      sql: "insert into tasks(team_id, assigned_to, title) values (1, -1, 'FK probe') returning id",
    },
  ];
  const failures: string[] = [];
  for (const trial of trials) {
    try {
      const { rows } = await ctx.query(trial.sql);
      const id = Number(rows[0]?.id);
      if (Number.isInteger(id) && id > 0)
        await ctx.query(`delete from ${trial.table} where id = ${id}`);
      failures.push(`${trial.table} accepted an invalid foreign key`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/foreign key/i.test(message)) failures.push(message);
    }
  }
  return {
    name: 'foreign keys reject all three invalid references',
    passed: failures.length === 0,
    notes: failures.join('; ') || undefined,
  };
}

async function checkIndex(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = 'tasks_team_status_idx index survived the restore';
  const { rows } = await ctx.query(stripIndent`
    select indexname
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'tasks'
      and indexname = 'tasks_team_status_idx'
  `);
  return {
    name,
    passed: rows.length > 0,
    notes: rows.length > 0 ? undefined : 'index not found in pg_indexes',
  };
}

async function checkSequencesSynced(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const trials = [
    {
      table: 'teams',
      sql: "insert into teams(name) values ('Sequence probe') returning id",
    },
    {
      table: 'members',
      sql: "insert into members(team_id, email, full_name) values (1, 'sequence-probe@example.com', 'Sequence probe') returning id",
    },
    {
      table: 'tasks',
      sql: "insert into tasks(team_id, title) values (1, 'Sequence probe') returning id",
    },
  ];
  const failures: string[] = [];
  for (const trial of trials) {
    try {
      const before = await ctx.query(
        `select max(id) as max_id from ${trial.table}`
      );
      const result = await ctx.query(trial.sql);
      const id = Number(result.rows[0]?.id);
      if (Number.isInteger(id) && id > 0)
        await ctx.query(`delete from ${trial.table} where id = ${id}`);
      if (!Number.isInteger(id) || id <= Number(before.rows[0]?.max_id ?? 0))
        failures.push(`${trial.table}: generated id did not advance`);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    name: 'next inserts advance past restored IDs without conflicts',
    passed: failures.length === 0,
    notes: failures.join('; ') || undefined,
  };
}
