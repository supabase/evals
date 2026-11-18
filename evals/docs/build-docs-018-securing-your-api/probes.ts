import { randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  SupabaseClient,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import { execSql } from '../lib/exec-sql.js';
import { CLOSE_STALE, NOTES, REPLIES, SEARCH } from './catalog.js';
import { NAMES } from './names.js';

const PASSWORD = 'secret123';

export type World = {
  run: string;
  anon: SupabaseClient;
  owner: SupabaseClient;
  stranger: SupabaseClient;
  ownerId: string;
  strangerId: string;
  ownerTicket: number;
  strangerTicket: number;
  // Rows the scorer put in the agent's tables, so an empty answer is a table
  // refusing and never a table with nothing in it.
  markers: { ok: true; values: Markers } | { ok: false; why: string };
};

type Markers = {
  ownerReply: string;
  strangerReply: string;
  ownerNote: string;
  strangerNote: string;
};

export type Setup = { world: World } | { failure: string };

type ApiError = { code?: string; message?: string } | null;

// Signs up two customers and gives each a ticket, plus a help article only this
// run knows about. Everything is written after the agent's work, scoped to the
// run, so a literal in the agent's code cannot satisfy a control.
export async function setupWorld(ctx: LocalStackEvalContext): Promise<Setup> {
  const run = randomUUID().slice(0, 8);
  const anon = await ctx.getClient();
  const owner = await ctx.getClient();
  const stranger = await ctx.getClient();

  const { data: a, error: aError } = await owner.auth.signUp({
    email: `owner-${run}@example.com`,
    password: PASSWORD,
  });
  const { data: b, error: bError } = await stranger.auth.signUp({
    email: `stranger-${run}@example.com`,
    password: PASSWORD,
  });
  if (
    aError ||
    bError ||
    !a.user?.id ||
    !a.session ||
    !b.user?.id ||
    !b.session
  ) {
    return {
      failure: `could not sign two customers up: ${aError?.message ?? bError?.message ?? 'no session'}`,
    };
  }

  const seeded = await execSql(
    ctx,
    stripIndent`
      WITH a AS (
        INSERT INTO public.tickets (customer_id, subject)
        VALUES ('${a.user.id}', 'owner-${run}') RETURNING id
      ), b AS (
        INSERT INTO public.tickets (customer_id, subject)
        VALUES ('${b.user.id}', 'stranger-${run}') RETURNING id
      ), h AS (
        INSERT INTO public.help_articles (title, body)
        VALUES ('help-${run}', 'how to ${run}') RETURNING id
      )
      SELECT (SELECT id FROM a) || ' ' || (SELECT id FROM b) || ' ' || (SELECT id FROM h);
    `,
    { tuplesOnly: true }
  );
  const ids = parseIds(seeded.stdout);
  if (!seeded.ok || ids.length < 3) {
    return { failure: `could not seed two tickets: ${seeded.message}` };
  }

  const world: World = {
    run,
    anon,
    owner,
    stranger,
    ownerId: a.user.id,
    strangerId: b.user.id,
    ownerTicket: ids[0],
    strangerTicket: ids[1],
    markers: { ok: false, why: 'the agent built neither table' },
  };
  return { world };
}

// Separate from setupWorld so a table the agent shaped differently costs the
// checks that read it and nothing else.
export async function seedMarkers(
  ctx: LocalStackEvalContext,
  world: World
): Promise<void> {
  const values: Markers = {
    ownerReply: `reply-owner-${world.run}`,
    strangerReply: `reply-stranger-${world.run}`,
    ownerNote: `note-owner-${world.run}`,
    strangerNote: `note-stranger-${world.run}`,
  };
  const seeded = await execSql(
    ctx,
    stripIndent`
      INSERT INTO public.${REPLIES} (ticket_id, body) VALUES
        (${world.ownerTicket}, '${values.ownerReply}'),
        (${world.strangerTicket}, '${values.strangerReply}');
      INSERT INTO public.${NOTES} (ticket_id, body) VALUES
        (${world.ownerTicket}, '${values.ownerNote}'),
        (${world.strangerTicket}, '${values.strangerNote}');
    `
  );
  world.markers = seeded.ok
    ? { ok: true, values }
    : {
        ok: false,
        why: `could not insert a reply and a note as the superuser: ${seeded.message}`,
      };
}

function notRun(name: string, why: string): CheckResult {
  return { name, passed: false, notes: `not run: ${why}` };
}

function parseIds(output: string): number[] {
  return output
    .split(/\s+/)
    .map((token) => Number(token))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function bodiesOf(data: unknown): string[] {
  return Array.isArray(data)
    ? data.map((row) => String((row as { body?: unknown }).body ?? ''))
    : [];
}

// A refusal arrives as 42501, either "permission denied" or a row policy. Any
// other error is something the probe caused, not a refusal, and is reported as
// not measured so a wide-open table cannot score as closed on a malformed
// request.
function unmeasured(error: ApiError): boolean {
  return error !== null && error.code !== '42501';
}

const describe = (error: ApiError) =>
  error ? `${error.code ?? '?'} ${error.message ?? ''}`.trim() : 'no error';

// Positive control for the intended exposure. It needs the grant and a policy,
// so it reds an agent that closed the table too far (#645) as well as one that
// opened it to everybody. The owner's own row has to come back before the
// absence for anyone else means anything.
export async function checkRepliesReadableByTheirCustomerOnly(
  world: World
): Promise<CheckResult> {
  const name = NAMES.replies;
  if (!world.markers.ok) return notRun(name, world.markers.why);
  const { ownerReply, strangerReply } = world.markers.values;

  const [owner, stranger, anon] = await Promise.all(
    [world.owner, world.stranger, world.anon].map((client) =>
      client.from(REPLIES).select('body')
    )
  );

  const ownerBodies = bodiesOf(owner.data);
  if (!ownerBodies.includes(ownerReply)) {
    return {
      name,
      passed: false,
      notes: `the customer could not read the reply on their own ticket: ${owner.error ? describe(owner.error) : `got ${JSON.stringify(owner.data)}`}`,
    };
  }
  if (ownerBodies.includes(strangerReply)) {
    return {
      name,
      passed: false,
      notes: "a customer read a reply on someone else's ticket",
    };
  }
  if (bodiesOf(stranger.data).includes(ownerReply)) {
    return {
      name,
      passed: false,
      notes: "another customer read a reply on someone else's ticket",
    };
  }
  if (
    bodiesOf(anon.data).some(
      (body) => body === ownerReply || body === strangerReply
    )
  ) {
    return { name, passed: false, notes: 'a signed-out visitor read a reply' };
  }
  const odd = [stranger.error, anon.error].find(unmeasured);
  return odd
    ? { name, passed: false, notes: `could not measure: ${describe(odd)}` }
    : { name, passed: true, notes: 'only the ticket owner read their reply' };
}

// The check the page's own wording does not reach. A policy copied from the
// replies onto the notes reads fine and hands staff-only text to the customer it
// is about, so the owner is probed beside the stranger and the visitor.
export async function checkNotesReadableByNoClient(
  world: World
): Promise<CheckResult> {
  const name = NAMES.notes;
  if (!world.markers.ok) return notRun(name, world.markers.why);
  const { ownerNote, strangerNote } = world.markers.values;

  const actors: [string, SupabaseClient][] = [
    ['the ticket owner', world.owner],
    ['another customer', world.stranger],
    ['a signed-out visitor', world.anon],
  ];
  const results = await Promise.all(
    actors.map(async ([who, client]) => ({
      who,
      ...(await client.from(NOTES).select('body')),
    }))
  );

  const leaks = results.filter((result) =>
    bodiesOf(result.data).some(
      (body) => body === ownerNote || body === strangerNote
    )
  );
  if (leaks.length > 0) {
    return {
      name,
      passed: false,
      notes: `${leaks.map((leak) => leak.who).join(', ')} read an internal note`,
    };
  }
  const odd = results.find((result) => unmeasured(result.error));
  return odd
    ? {
        name,
        passed: false,
        notes: `could not measure for ${odd.who}: ${describe(odd.error)}`,
      }
    : {
        name,
        passed: true,
        notes: 'nobody read a note the scorer had put there',
      };
}

// Sends a whole contract row, so only access control can refuse it. A request
// that fails on a not-null column would read as a refusal and score a wide-open
// table as closed (#264), so absence is confirmed as the superuser and any
// error but 42501 is treated as not measured.
//
// A customer posting a reply is not asked about: the prompt does not rule it
// out, so the check does not either.
export async function checkNoClientWritesNotes(
  ctx: LocalStackEvalContext,
  world: World
): Promise<CheckResult> {
  const name = NAMES.writes;
  const attempts: {
    label: string;
    table: string;
    body: string;
    client: SupabaseClient;
  }[] = [
    {
      label: 'the ticket owner wrote a note',
      table: NOTES,
      body: `w-owner-note-${world.run}`,
      client: world.owner,
    },
    {
      label: 'another customer wrote a note',
      table: NOTES,
      body: `w-stranger-note-${world.run}`,
      client: world.stranger,
    },
    {
      label: 'a signed-out visitor wrote a note',
      table: NOTES,
      body: `w-anon-note-${world.run}`,
      client: world.anon,
    },
    {
      label: 'a signed-out visitor wrote a reply',
      table: REPLIES,
      body: `w-anon-reply-${world.run}`,
      client: world.anon,
    },
  ];

  const errors: ApiError[] = [];
  for (const attempt of attempts) {
    const { error } = await attempt.client
      .from(attempt.table)
      .insert({ ticket_id: world.ownerTicket, body: attempt.body });
    errors.push(error);
  }

  const { rows } = await ctx.query(`
    SELECT body FROM public.${NOTES} WHERE body LIKE 'w-%-${world.run}'
    UNION ALL
    SELECT body FROM public.${REPLIES} WHERE body LIKE 'w-%-${world.run}'
  `);
  const written = new Set(rows.map((row) => String(row.body)));
  const leaked = attempts.filter((attempt) => written.has(attempt.body));
  if (leaked.length > 0) {
    return {
      name,
      passed: false,
      notes: leaked.map((attempt) => attempt.label).join('; '),
    };
  }
  const odd = errors.find(unmeasured);
  return odd
    ? {
        name,
        passed: false,
        notes: `could not measure, the insert failed for a reason that is not a refusal: ${describe(odd)}`,
      }
    : {
        name,
        passed: true,
        notes: 'no row landed and every refusal was 42501',
      };
}

// Positive control for over-revocation. It passes for an agent that built
// nothing, because the function is the seed's. It only bites after a blanket
// revoke, which is what the page's default-privileges block invites.
export async function checkVisitorCanSearchHelp(
  world: World
): Promise<CheckResult> {
  const name = NAMES.search;
  const { data, error } = await world.anon.rpc(SEARCH, {
    q: `help-${world.run}`,
  });
  const titles = Array.isArray(data)
    ? data.map((row) => String((row as { title?: unknown }).title ?? ''))
    : [];
  const found = titles.includes(`help-${world.run}`);
  return {
    name,
    passed: found,
    notes: found
      ? 'the run-scoped article came back'
      : `${error ? describe(error) : `got ${JSON.stringify(data)}`}`,
  };
}

// Calls the function as each client that must not reach it, with a stale ticket
// for each on hand, then confirms as the superuser that none was closed. Any
// call that comes back without an error reached the function, closed or not.
// Runs before the server key's own call so a stale ticket that call would have
// closed is not mistaken for one a client closed.
export async function checkNoClientRunsTheNightlyJob(
  ctx: LocalStackEvalContext,
  world: World
): Promise<CheckResult> {
  const name = NAMES.clientJob;
  const seeded = await seedStale(ctx, world, 'client');
  if ('failure' in seeded) return notRun(name, seeded.failure);

  const actors: [string, SupabaseClient][] = [
    ['the ticket owner', world.owner],
    ['another customer', world.stranger],
    ['a signed-out visitor', world.anon],
  ];
  const calls = await Promise.all(
    actors.map(async ([who, client]) => ({
      who,
      ...(await client.rpc(CLOSE_STALE)),
    }))
  );

  const { rows } = await ctx.query(
    `SELECT id, status FROM public.tickets WHERE id IN (${seeded.ids.join(', ')})`
  );
  const closed = rows.filter((row) => row.status === 'closed');
  const reached = calls.filter((call) => call.error === null);
  if (closed.length > 0 || reached.length > 0) {
    return {
      name,
      passed: false,
      notes:
        reached.length > 0
          ? `${reached.map((call) => call.who).join(', ')} called it and got an answer${closed.length > 0 ? `; ${closed.length} stale tickets were closed` : ''}`
          : `${closed.length} stale tickets were closed`,
    };
  }
  const missing = calls.find(
    (call) => call.error?.code === 'PGRST202' || call.error?.code === '42883'
  );
  return missing
    ? {
        name,
        passed: false,
        notes: `could not measure for ${missing.who}: ${describe(missing.error)}`,
      }
    : {
        name,
        passed: true,
        notes: `every call was refused (${calls.map((call) => call.error?.code).join(', ')}) and no stale ticket was closed`,
      };
}

async function seedStale(
  ctx: LocalStackEvalContext,
  world: World,
  tag: string
): Promise<{ ids: number[] } | { failure: string }> {
  const seeded = await execSql(
    ctx,
    stripIndent`
      WITH a AS (
        INSERT INTO public.tickets (customer_id, subject, updated_at)
        VALUES ('${world.ownerId}', 'stale-${tag}-owner-${world.run}', now() - interval '60 days') RETURNING id
      ), b AS (
        INSERT INTO public.tickets (customer_id, subject, updated_at)
        VALUES ('${world.strangerId}', 'stale-${tag}-stranger-${world.run}', now() - interval '60 days') RETURNING id
      )
      SELECT (SELECT id FROM a) || ' ' || (SELECT id FROM b);
    `,
    { tuplesOnly: true }
  );
  const ids = parseIds(seeded.stdout);
  return seeded.ok && ids.length === 2
    ? { ids }
    : { failure: `could not seed stale tickets: ${seeded.message}` };
}

// The server key's side. These run as the service role inside the database, not
// over HTTP: the Data API switches to that role to serve a server-key request,
// so the privilege question is the same, and the probe does not depend on how
// the stack's gateway maps a secret key. Both checks fail for an agent that
// closed its own back end out (#196, #237, #645).
export async function checkServerKeyReachesRepliesAndNotes(
  ctx: LocalStackEvalContext,
  world: World
): Promise<CheckResult> {
  const name = NAMES.serverTables;
  const reply = `svc-reply-${world.run}`;
  const note = `svc-note-${world.run}`;
  const result = await execSql(
    ctx,
    stripIndent`
      begin;
      set local role service_role;
      insert into public.${REPLIES} (ticket_id, body) values (${world.ownerTicket}, '${reply}');
      insert into public.${NOTES} (ticket_id, body) values (${world.ownerTicket}, '${note}');
      select body from public.${REPLIES} where body = '${reply}';
      select body from public.${NOTES} where body = '${note}';
      commit;
    `,
    { tuplesOnly: true }
  );
  const ok =
    result.ok && result.stdout.includes(reply) && result.stdout.includes(note);
  return {
    name,
    passed: ok,
    notes: ok
      ? 'wrote and read one reply and one note as the service role'
      : result.ok
        ? 'both inserts ran but the rows did not read back'
        : result.message,
  };
}

// A fresh ticket, idle for 60 days, has to be closed. One touched today has to
// stay open, so a function that closes everything cannot pass.
export async function checkServerKeyRunsTheNightlyJob(
  ctx: LocalStackEvalContext,
  world: World
): Promise<CheckResult> {
  const name = NAMES.serverJob;
  const seeded = await seedStale(ctx, world, 'job');
  if ('failure' in seeded) return notRun(name, seeded.failure);
  const [stale] = seeded.ids;

  const called = await execSql(
    ctx,
    stripIndent`
      begin;
      set local role service_role;
      select public.${CLOSE_STALE}();
      commit;
    `,
    { tuplesOnly: true }
  );
  if (!called.ok) return { name, passed: false, notes: called.message };

  const count = Number(
    called.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .pop()
  );
  const { rows } = await ctx.query(
    `SELECT id, status FROM public.tickets WHERE id IN (${stale}, ${world.ownerTicket})`
  );
  const status = (id: number) =>
    rows.find((row) => Number(row.id) === id)?.status;

  const problems = [
    status(stale) === 'closed'
      ? undefined
      : 'a ticket idle for 60 days stayed open',
    status(world.ownerTicket) === 'open'
      ? undefined
      : 'a ticket touched today was closed',
    Number.isFinite(count) && count >= 1
      ? undefined
      : `it returned ${JSON.stringify(called.stdout.trim())} instead of a count`,
  ].filter((problem): problem is string => problem !== undefined);

  return {
    name,
    passed: problems.length === 0,
    notes: problems.length === 0 ? `closed ${count}` : problems.join('; '),
  };
}
