import { stripIndent } from 'common-tags';
import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
} from '@supabase-evals/core';

const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const TABLES = [
  { name: 'teams', expectedRows: 5 },
  { name: 'members', expectedRows: 10 },
  { name: 'tasks', expectedRows: 13 },
] as const;

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkTablesExist(ctx),
      await checkRowCounts(ctx),
      await checkForeignKeys(ctx),
      await checkIndex(ctx),
      await checkSequencesSynced(ctx),
    ];

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

/** Checks all 3 source tables were created in the public schema. */
async function checkTablesExist(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'all 3 tables exist (teams, members, tasks)';
  const { rows } = await ctx.query(stripIndent`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name in ('teams', 'members', 'tasks')
  `);
  const found = rows.map((r) => String(r.table_name));
  const missing = ['teams', 'members', 'tasks'].filter(
    (t) => !found.includes(t)
  );
  return {
    name,
    passed: missing.length === 0,
    notes: missing.length === 0 ? undefined : `missing: ${missing.join(', ')}`,
  };
}

/** Checks row counts match the source data (teams=5, members=10, tasks=13). */
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

/** Checks the 3 FK constraints (members→teams, tasks→teams, tasks→members) survived the restore. */
async function checkForeignKeys(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'foreign key constraints survived the restore';
  const { rows } = await ctx.query(stripIndent`
    select tc.table_name, tc.constraint_name
    from information_schema.table_constraints tc
    where tc.constraint_type = 'FOREIGN KEY'
      and tc.table_schema = 'public'
      and tc.table_name in ('members', 'tasks')
  `);
  // members.team_id → teams, tasks.team_id → teams, tasks.assigned_to → members
  const found = rows.length;
  return {
    name,
    passed: found >= 3,
    notes:
      found >= 3
        ? undefined
        : `found ${found} FK constraint(s), expected at least 3`,
  };
}

/** Checks tasks_team_status_idx survived the restore. */
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

/** Checks each bigserial sequence was advanced past the max existing ID so the next insert won't conflict. */
async function checkSequencesSynced(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name =
    "sequences synced (next insert won't conflict with existing IDs)";
  // pg_sequences.last_value reads without advancing the sequence.
  // After a correct setval(), last_value should be >= the max existing id.
  const { rows } = await ctx.query(stripIndent`
    select
      s.sequencename,
      s.last_value,
      t.max_id
    from pg_sequences s
    join lateral (
      select max_id from (values
        ('teams_id_seq',   (select coalesce(max(id), 0) from teams)),
        ('members_id_seq', (select coalesce(max(id), 0) from members)),
        ('tasks_id_seq',   (select coalesce(max(id), 0) from tasks))
      ) v(seq_name, max_id)
      where v.seq_name = s.sequencename
    ) t on true
    where s.schemaname = 'public'
      and s.sequencename in ('teams_id_seq', 'members_id_seq', 'tasks_id_seq')
  `);

  if (rows.length < 3) {
    return {
      name,
      passed: false,
      notes: `could not find all 3 sequences in pg_sequences (found ${rows.length})`,
    };
  }

  const behind = rows.filter((r) => Number(r.last_value) < Number(r.max_id));
  if (behind.length > 0) {
    const details = behind
      .map(
        (r) =>
          `${r.sequencename}: last_value=${r.last_value}, max_id=${r.max_id}`
      )
      .join('; ');
    return { name, passed: false, notes: details };
  }

  return { name, passed: true };
}
