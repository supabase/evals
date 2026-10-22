import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  describeFailure,
  errorMessage,
  shellQuote,
  truncate,
} from '../lib/shell.js';
import type { StackProbe } from '../lib/stack.js';
import { PROBE_TITLE_PREFIX, PROBE_USERS } from './fixtures.js';

type ExecContext = Pick<LocalStackEvalContext, 'exec'>;

export type ReadOutcome = { titles: string[] } | { denied: string };
export type WriteOutcome = { rows: number } | { denied: string };
export type AccessProbe =
  | {
      ok: true;
      reads: { owner: ReadOutcome; other: ReadOutcome; anon: ReadOutcome };
      writes: {
        otherUpdate: WriteOutcome;
        otherDelete: WriteOutcome;
        otherInsertAsOwner: WriteOutcome;
        ownerUpdate: WriteOutcome;
        ownerInsert: WriteOutcome;
      };
    }
  | { ok: false; notes: string };

export const READ_CHECK_NAME = 'each user can see only their own notes';
export const WRITE_CHECK_NAME = "only a note's owner can change it";

const READ_NAMES = ['owner', 'other', 'anon'] as const;
const WRITE_NAMES = [
  'otherUpdate',
  'otherDelete',
  'otherInsertAsOwner',
  'ownerUpdate',
  'ownerInsert',
] as const;
type ReadName = (typeof READ_NAMES)[number];
type WriteName = (typeof WRITE_NAMES)[number];

const OWNER_TITLES = [
  `${PROBE_TITLE_PREFIX}owner-1`,
  `${PROBE_TITLE_PREFIX}owner-2`,
];
const OTHER_TITLES = [`${PROBE_TITLE_PREFIX}other-1`];
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const ROW_COUNT_RE = /^\d+$/;

/** A `psql` command against `dbUrl` that stops at the first error, with `script` piped to stdin when given. */
export function psqlCommand(
  dbUrl: string,
  args: readonly string[],
  script?: string
): string {
  const psql = `psql ${shellQuote(dbUrl)} -X -A -t -q -v ON_ERROR_STOP=1 ${args.join(' ')}`;
  if (script === undefined) return psql;
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `printf %s ${shellQuote(encoded)} | base64 -d | ${psql}`;
}

/** The SQL of the access probe: one rolled-back transaction that reads and writes the notes as the owner, another user and anon. */
export function buildAccessProbeSql(): string {
  const { owner, other } = PROBE_USERS;
  const [ownerOne, ownerTwo] = OWNER_TITLES;
  const [otherOne] = OTHER_TITLES;
  const step = (
    who: string,
    key: string,
    statement: string,
    outcome: string
  ) => `select eval_probe.act('${who}');
do $$ declare n bigint; t text; begin
  ${statement} insert into eval_probe.results values ('${key}', ${outcome});
exception when others then insert into eval_probe.results values ('${key}', 'denied:' || sqlstate);
end $$;
reset role;
`;
  const read = (name: ReadName, who: string) =>
    step(
      who,
      `read.${name}`,
      `select coalesce(string_agg(title, ',' order by title), '') into t from public.notes where title like '${PROBE_TITLE_PREFIX}%';`,
      `'titles:' || t`
    );
  const write = (name: WriteName, who: string, statement: string) =>
    step(
      who,
      `write.${name}`,
      `${statement} get diagnostics n = row_count;`,
      `'rows:' || n`
    );
  const edit = (title: string) =>
    `update public.notes set body = '${PROBE_TITLE_PREFIX}edited' where title = '${title}';`;
  const insert = (title: string) =>
    `insert into public.notes (owner_id, title) values ('${owner.id}', '${title}');`;

  return `begin;
create schema eval_probe;
create table eval_probe.results (k text primary key, v text not null);
grant usage on schema eval_probe to authenticated, anon;
grant insert on eval_probe.results to authenticated, anon;
create function eval_probe.act(who text) returns void language plpgsql as $$
begin
  if who = 'anon' then
    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', who, true);
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
  end if;
end $$;
insert into auth.users (id, email, aud, role) values
  ('${owner.id}', '${owner.email}', 'authenticated', 'authenticated'),
  ('${other.id}', '${other.email}', 'authenticated', 'authenticated');
insert into public.notes (owner_id, title) values
  ('${owner.id}', '${ownerOne}'),
  ('${owner.id}', '${ownerTwo}'),
  ('${other.id}', '${otherOne}');
${read('owner', owner.id)}
${read('other', other.id)}
${read('anon', 'anon')}
${write('otherUpdate', other.id, edit(ownerOne))}
${write('otherDelete', other.id, `delete from public.notes where title = '${ownerTwo}';`)}
${write('otherInsertAsOwner', other.id, insert(`${PROBE_TITLE_PREFIX}forged`))}
${write('ownerUpdate', owner.id, edit(ownerOne))}
${write('ownerInsert', owner.id, insert(`${PROBE_TITLE_PREFIX}owner-3`))}
select k || '|' || v from eval_probe.results order by k;
rollback;
`;
}

function parseRead(value: string): ReadOutcome | undefined {
  if (value.startsWith('titles:')) {
    const titles = value
      .slice('titles:'.length)
      .split(',')
      .filter((title) => title !== '');
    return { titles };
  }
  const denied = value.startsWith('denied:') ? value.slice(7) : undefined;
  return denied !== undefined && SQLSTATE_RE.test(denied)
    ? { denied }
    : undefined;
}

function parseWrite(value: string): WriteOutcome | undefined {
  if (value.startsWith('rows:')) {
    const rows = value.slice('rows:'.length);
    return ROW_COUNT_RE.test(rows) ? { rows: Number(rows) } : undefined;
  }
  const denied = value.startsWith('denied:') ? value.slice(7) : undefined;
  return denied !== undefined && SQLSTATE_RE.test(denied)
    ? { denied }
    : undefined;
}

const includes = <T extends string>(
  names: readonly T[],
  name: string
): name is T => (names as readonly string[]).includes(name);

/** Reads the `key|value` rows the access probe prints; anything it does not recognise, or any missing row, makes the probe fail. */
export function parseAccessProbeOutput(stdout: string): AccessProbe {
  const reads: Partial<Record<ReadName, ReadOutcome>> = {};
  const writes: Partial<Record<WriteName, WriteOutcome>> = {};
  let rowCount = 0;
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const bar = line.indexOf('|');
    if (bar === -1) {
      return {
        ok: false,
        notes: `unrecognised access probe output: ${truncate(line, 120)}`,
      };
    }
    const key = line.slice(0, bar);
    const value = line.slice(bar + 1);
    const dot = key.indexOf('.');
    const kind = key.slice(0, dot);
    const name = key.slice(dot + 1);
    const bad = (reason: string) => ({
      ok: false as const,
      notes: `${reason} ${key}: ${truncate(value, 120)}`,
    });
    if (kind === 'read' && includes(READ_NAMES, name)) {
      if (reads[name] !== undefined) return bad('duplicate row for');
      const outcome = parseRead(value);
      if (outcome === undefined) return bad('unrecognised value for');
      reads[name] = outcome;
    } else if (kind === 'write' && includes(WRITE_NAMES, name)) {
      if (writes[name] !== undefined) return bad('duplicate row for');
      const outcome = parseWrite(value);
      if (outcome === undefined) return bad('unrecognised value for');
      writes[name] = outcome;
    } else {
      return {
        ok: false,
        notes: `unexpected row key ${truncate(key, 120)} in the access probe output`,
      };
    }
    rowCount++;
  }
  if (rowCount === 0) {
    return { ok: false, notes: 'the access probe printed no rows' };
  }
  const missing = [
    ...READ_NAMES.filter((name) => reads[name] === undefined).map(
      (name) => `read.${name}`
    ),
    ...WRITE_NAMES.filter((name) => writes[name] === undefined).map(
      (name) => `write.${name}`
    ),
  ];
  if (missing.length > 0) {
    return {
      ok: false,
      notes: `the access probe printed no row for ${missing.join(', ')}`,
    };
  }
  return {
    ok: true,
    reads: reads as Record<ReadName, ReadOutcome>,
    writes: writes as Record<WriteName, WriteOutcome>,
  };
}

/** Runs the access probe against the stack's database; never throws. */
export async function readNotesAccess(
  ctx: ExecContext,
  stack: StackProbe
): Promise<AccessProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      psqlCommand(stack.dbUrl, ['-f -'], buildAccessProbeSql())
    );
    if (!result.ok) return { ok: false, notes: describeFailure(result) };
    return parseAccessProbeOutput(result.stdout);
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

function readProblems(
  who: string,
  outcome: ReadOutcome,
  own: readonly string[]
): string[] {
  if ('denied' in outcome) {
    return [
      `${who} read was denied (${outcome.denied}), so the probe never reached the notes`,
    ];
  }
  const missing = own.filter((title) => !outcome.titles.includes(title));
  const extra = outcome.titles.filter((title) => !own.includes(title));
  return [
    ...(missing.length > 0
      ? [`${who} cannot see their own notes (missing ${missing.join(', ')})`]
      : []),
    ...(extra.length > 0
      ? [
          who === 'owner'
            ? `owner also sees the other user's notes (${extra.join(', ')})`
            : `other user sees the owner's notes (${extra.join(', ')})`,
        ]
      : []),
  ];
}

export function checkReadIsolation(probe: AccessProbe): CheckResult {
  const name = READ_CHECK_NAME;
  if (!probe.ok) {
    return {
      name,
      passed: false,
      notes: `could not probe the notes: ${probe.notes}`,
    };
  }
  const { owner, other, anon } = probe.reads;
  const problems = [
    ...readProblems('owner', owner, OWNER_TITLES),
    ...readProblems('other user', other, OTHER_TITLES),
    ...('titles' in anon && anon.titles.length > 0
      ? [`anon sees notes (${anon.titles.join(', ')})`]
      : []),
  ];
  return problems.length > 0
    ? { name, passed: false, notes: problems.join('; ') }
    : {
        name,
        passed: true,
        notes:
          'the owner and the other user each see only their own notes, and anon sees none',
      };
}

function writeProblems(
  label: string,
  outcome: WriteOutcome,
  mustTouchRows: boolean
): string[] {
  if (mustTouchRows) {
    if ('denied' in outcome) {
      return [
        `${label} was denied (${outcome.denied}), so the owner lost access`,
      ];
    }
    return outcome.rows >= 1
      ? []
      : [`${label} touched no rows, so the owner lost access`];
  }
  return 'rows' in outcome && outcome.rows > 0
    ? [`${label} touched ${outcome.rows} of the owner's notes`]
    : [];
}

export function checkWriteIsolation(probe: AccessProbe): CheckResult {
  const name = WRITE_CHECK_NAME;
  if (!probe.ok) {
    return {
      name,
      passed: false,
      notes: `could not probe the notes: ${probe.notes}`,
    };
  }
  const { writes } = probe;
  const problems = [
    ...writeProblems("other user's update", writes.otherUpdate, false),
    ...writeProblems("other user's delete", writes.otherDelete, false),
    ...writeProblems(
      "other user's insert as the owner",
      writes.otherInsertAsOwner,
      false
    ),
    ...writeProblems("owner's update", writes.ownerUpdate, true),
    ...writeProblems("owner's insert", writes.ownerInsert, true),
  ];
  return problems.length > 0
    ? { name, passed: false, notes: problems.join('; ') }
    : {
        name,
        passed: true,
        notes:
          "the other user cannot change or add the owner's notes, and the owner still can",
      };
}
