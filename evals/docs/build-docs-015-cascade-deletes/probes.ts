import { randomUUID } from 'node:crypto';
import type { CheckResult } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Query reads, Run writes and never throws. Plain functions so the probes also
// run on PGlite.
export type Query = (
  sql: string
) => Promise<{ rows: Record<string, unknown>[] }>;
export type Run = (sql: string) => Promise<{ ok: boolean; message: string }>;

export const CHECK = {
  leaver: 'deleting a member who left keeps the comments they wrote',
  teamDelete: 'deleting a team succeeds',
  rowsGone: "the closed team's members, projects, tasks and comments are gone",
  invoices: "the closed team's invoices are kept",
  otherTeam: "the other team's rows are all still there",
} as const;

// Every name starts with a per-run marker. Team a closes, team b is left alone.
export type World = { marker: string };

export type Setup = { world: World } | { failure: string };

// Per team: two members (one leaves later), a project, a task, a comment from
// each member, and an invoice.
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
  const name = CHECK.leaver;
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
  const n = await counts(query, {
    members: `name = '${marker}-a-leaves'`,
    comments: `body = '${marker}-a-by-leaves'`,
  });
  return {
    name,
    passed: n.members === 0 && n.comments === 1,
    notes:
      n.members !== 0
        ? 'the delete ran but the member is still there'
        : n.comments === 1
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
    name: CHECK.teamDelete,
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
  const name = CHECK.rowsGone;
  const blocked = notRun(name, result);
  if (blocked) return blocked;
  const like = `LIKE '${world.marker}-a-%'`;
  const left = await counts(query, {
    members: `name ${like}`,
    projects: `name ${like}`,
    tasks: `title ${like}`,
    comments: `body ${like}`,
  });
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
  const name = CHECK.invoices;
  const blocked = notRun(name, result);
  if (blocked) return blocked;
  const { invoices } = await counts(query, {
    invoices: `team_name = '${world.marker}-a'`,
  });
  return {
    name,
    passed: invoices === 1,
    notes: invoices === 1 ? 'kept' : 'the invoice was deleted with the team',
  };
}

// Exact counts, so deleting even one extra row fails.
const BYSTANDER = {
  teams: 1,
  members: 2,
  projects: 1,
  tasks: 1,
  comments: 2,
  invoices: 1,
};

export async function checkOtherTeamUntouched(
  query: Query,
  world: World,
  result: TeamDelete
): Promise<CheckResult> {
  const name = CHECK.otherTeam;
  const blocked = notRun(name, result);
  if (blocked) return blocked;
  const team = `= '${world.marker}-b'`;
  const like = `LIKE '${world.marker}-b-%'`;
  const found = await counts(query, {
    teams: `name ${team}`,
    members: `name ${like}`,
    projects: `name ${like}`,
    tasks: `title ${like}`,
    comments: `body ${like}`,
    invoices: `team_name ${team}`,
  });
  const short = Object.entries(BYSTANDER)
    .filter(([table, expected]) => found[table] !== expected)
    .map(([table, expected]) => `${table} ${found[table]}/${expected}`);
  return {
    name,
    passed: short.length === 0,
    notes: short.length === 0 ? 'all there' : `missing: ${short.join(', ')}`,
  };
}

// One query for every count, keyed by table.
async function counts(
  query: Query,
  where: Record<string, string>
): Promise<Record<string, number>> {
  const columns = Object.entries(where).map(
    ([table, predicate]) =>
      `(SELECT count(*)::int FROM public.${table} WHERE ${predicate}) AS ${table}`
  );
  const { rows } = await query(`SELECT ${columns.join(', ')}`);
  return Object.fromEntries(
    Object.keys(where).map((table) => [table, Number(rows[0]?.[table] ?? 0)])
  );
}
