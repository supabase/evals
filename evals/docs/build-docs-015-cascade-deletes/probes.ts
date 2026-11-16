import { randomUUID } from 'node:crypto';
import type { CheckResult } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// The scorer's only dependencies on the stack: superuser SQL, split in two.
// `Query` reads, and `ctx.query` can only read, since it wraps the statement
// in a json_agg subquery. `Run` writes, through psql. Typed narrowly so the
// same probes can run against an in-memory Postgres when checking them.
export type Query = (
  sql: string
) => Promise<{ rows: Record<string, unknown>[] }>;
export type Run = (sql: string) => Promise<{ ok: boolean; message: string }>;

// Every row the scorer writes carries this run's marker, so nothing it reads
// can come from a seed, another run, or a literal the agent wrote.
// Team "a" is the one that closes; team "b" is the bystander.
export type World = { marker: string };

export type Setup = { world: World } | { failure: string };

// Built after the agent's migrations are applied. One statement, so a failure
// leaves nothing half-made. Per team: a member who stays, a member who
// leaves, one project, one task, a comment by each member, one invoice.
export async function setupWorld(run: Run): Promise<Setup> {
  const marker = `cd${randomUUID().slice(0, 8)}`;
  const team = (t: string) => stripIndent`
    t_${t} AS (
      INSERT INTO public.teams (name) VALUES ('${marker}-${t}') RETURNING id
    ),
    m_${t} AS (
      INSERT INTO public.members (team_id, name)
      SELECT id, '${marker}-${t}-' || who FROM t_${t}, (VALUES ('stays'), ('leaves')) v(who)
      RETURNING id, name
    ),
    p_${t} AS (
      INSERT INTO public.projects (team_id, name)
      SELECT id, '${marker}-${t}-project' FROM t_${t} RETURNING id
    ),
    k_${t} AS (
      INSERT INTO public.tasks (project_id, title)
      SELECT id, '${marker}-${t}-task' FROM p_${t} RETURNING id
    ),
    c_${t} AS (
      INSERT INTO public.comments (task_id, author_id, body)
      SELECT k_${t}.id, m_${t}.id, replace(m_${t}.name, '-${t}-', '-${t}-by-')
      FROM k_${t}, m_${t}
      RETURNING id
    ),
    i_${t} AS (
      INSERT INTO public.invoices (team_id, team_name, amount_cents)
      SELECT id, '${marker}-${t}', 4200 FROM t_${t} RETURNING id
    )`;
  const built = await run(
    `WITH ${team('a')}, ${team('b')} SELECT (SELECT count(*) FROM c_a) + (SELECT count(*) FROM c_b) AS comments;`
  );
  return built.ok
    ? { world: { marker } }
    : { failure: `could not build the two teams: ${built.message}` };
}

export async function checkLeaverCommentsKept(
  query: Query,
  run: Run,
  world: World
): Promise<CheckResult> {
  const name = 'deleting a member who left keeps the comments they wrote';
  const { marker } = world;
  const deleted = await run(
    `DELETE FROM public.members WHERE name = '${marker}-a-leaves';`
  );
  if (!deleted.ok) {
    return {
      name,
      passed: false,
      notes: `the member could not be deleted: ${deleted.message}`,
    };
  }
  const left = await count(
    query,
    `SELECT count(*) FROM public.members WHERE name = '${marker}-a-leaves'`
  );
  const kept = await count(
    query,
    `SELECT count(*) FROM public.comments WHERE body = '${marker}-a-by-leaves'`
  );
  return {
    name,
    passed: left === 0 && kept === 1,
    notes:
      left !== 0
        ? 'the delete ran but the member is still there'
        : kept === 1
          ? 'member gone, comment kept'
          : 'the comment was deleted with its author',
  };
}

export type TeamDelete = { ok: true } | { ok: false; error: string };

export async function deleteClosedTeam(
  run: Run,
  world: World
): Promise<TeamDelete> {
  const deleted = await run(
    `DELETE FROM public.teams WHERE name = '${world.marker}-a';`
  );
  return deleted.ok ? { ok: true } : { ok: false, error: deleted.message };
}

export function checkTeamDeleteSucceeds(result: TeamDelete): CheckResult {
  return {
    name: 'deleting a team succeeds',
    passed: result.ok,
    notes: result.ok ? 'deleted' : result.error,
  };
}

const notRun = (name: string, result: TeamDelete): CheckResult | undefined =>
  result.ok
    ? undefined
    : {
        name,
        passed: false,
        notes: `not run: the team delete failed (${result.error})`,
      };

export async function checkClosedTeamRowsGone(
  query: Query,
  world: World,
  result: TeamDelete
): Promise<CheckResult> {
  const name =
    "the closed team's members, projects, tasks and comments are gone";
  const blocked = notRun(name, result);
  if (blocked) return blocked;
  const like = `'${world.marker}-a-%'`;
  const left = {
    members: await count(
      query,
      `SELECT count(*) FROM public.members WHERE name LIKE ${like}`
    ),
    projects: await count(
      query,
      `SELECT count(*) FROM public.projects WHERE name LIKE ${like}`
    ),
    tasks: await count(
      query,
      `SELECT count(*) FROM public.tasks WHERE title LIKE ${like}`
    ),
    comments: await count(
      query,
      `SELECT count(*) FROM public.comments WHERE body LIKE ${like}`
    ),
  };
  const remaining = Object.entries(left).filter(([, n]) => n > 0);
  return {
    name,
    passed: remaining.length === 0,
    notes:
      remaining.length === 0
        ? 'none left'
        : `still there: ${remaining.map(([t, n]) => `${n} ${t}`).join(', ')}`,
  };
}

export async function checkInvoicesKept(
  query: Query,
  world: World,
  result: TeamDelete
): Promise<CheckResult> {
  const name = "the closed team's invoices are kept";
  const blocked = notRun(name, result);
  if (blocked) return blocked;
  const kept = await count(
    query,
    `SELECT count(*) FROM public.invoices WHERE team_name = '${world.marker}-a'`
  );
  return {
    name,
    passed: kept === 1,
    notes: kept === 1 ? 'kept' : 'the invoice was deleted with the team',
  };
}

// Exact counts, so a delete that reached too far fails even if it only took
// one row.
const BYSTANDER: [string, string, string, number][] = [
  ['teams', 'name', "= '{m}-b'", 1],
  ['members', 'name', "LIKE '{m}-b-%'", 2],
  ['projects', 'name', "LIKE '{m}-b-%'", 1],
  ['tasks', 'title', "LIKE '{m}-b-%'", 1],
  ['comments', 'body', "LIKE '{m}-b-%'", 2],
  ['invoices', 'team_name', "= '{m}-b'", 1],
];

export async function checkOtherTeamUntouched(
  query: Query,
  world: World,
  result: TeamDelete
): Promise<CheckResult> {
  const name = "the other team's rows are all still there";
  const blocked = notRun(name, result);
  if (blocked) return blocked;
  const short: string[] = [];
  for (const [table, column, predicate, expected] of BYSTANDER) {
    const n = await count(
      query,
      `SELECT count(*) FROM public.${table} WHERE ${column} ${predicate.replace('{m}', world.marker)}`
    );
    if (n !== expected) short.push(`${table} ${n}/${expected}`);
  }
  return {
    name,
    passed: short.length === 0,
    notes: short.length === 0 ? 'all there' : `missing: ${short.join(', ')}`,
  };
}

async function count(query: Query, sql: string): Promise<number> {
  const { rows } = await query(sql.replace('count(*)', 'count(*)::int AS n'));
  return Number(rows[0]?.n ?? 0);
}
