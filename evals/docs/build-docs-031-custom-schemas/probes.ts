import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';
import { messageOf, restartStack } from '../lib/local-stack.js';

export const CHECK = {
  starts: 'the local stack starts with the project settings',
  visitor: 'a visitor reads the published articles and not the drafts',
  server: 'the server key adds a published article',
  later:
    'a table added to help_center later is readable through the API without more setup',
  staff: 'the staff records cannot be read through the API',
} as const;

type Stack = { apiUrl: string; anon: string; secret: string };
type Reply = { status: number; code: string; message: string; rows: unknown[] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What the page's cURL tab sends: the table as the route, and the schema in a
// profile header (Accept-Profile to read, Content-Profile to write).
async function call(
  stack: Stack,
  key: string,
  path: string,
  schema: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Reply> {
  const writing = init.method !== undefined && init.method !== 'GET';
  const response = await fetch(`${stack.apiUrl}/rest/v1/${path}`, {
    method: init.method ?? 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      [writing ? 'Content-Profile' : 'Accept-Profile']: schema,
      ...(writing ? { Prefer: 'return=minimal' } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const error = (response.ok ? {} : (parsed ?? {})) as {
    code?: string;
    message?: string;
  };
  return {
    status: response.status,
    code: error.code ?? '',
    message: error.message ?? (response.ok ? '' : text.slice(0, 160)),
    rows: Array.isArray(parsed) ? parsed : [],
  };
}

// The stack has just restarted, and the API reloads its view of the database a
// moment after a table appears. Ask again for a few seconds when the answer is
// that the API is not ready, never when it is a refusal.
async function ready(
  stack: Stack,
  key: string,
  path: string,
  schema: string,
  init?: { method?: string; body?: unknown },
  waitFor: string[] = []
): Promise<Reply> {
  let last: Reply = { status: 0, code: '', message: 'no answer', rows: [] };
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      last = await call(stack, key, path, schema, init);
    } catch (error) {
      last = { status: 0, code: '', message: messageOf(error), rows: [] };
    }
    const settled =
      last.status !== 0 &&
      last.code !== 'PGRST002' &&
      !waitFor.includes(last.code);
    if (settled) return last;
    await sleep(1_500);
  }
  return last;
}

const describe = (reply: Reply) =>
  `${reply.code || reply.status} ${reply.message}`.trim();

export type Probe = {
  marker: string;
  stack?: Stack;
  failure?: string;
  visitor?: Reply;
  server?: Reply;
  serverRow?: boolean;
  later?: Reply;
  staff?: Reply;
};

// Auth-free: every call is the publishable key or the secret key, as a visitor
// and the server would send them. Written after the stack restarts, with rows
// that carry a marker, so nothing the agent wrote can have matched them.
export async function probeApi(ctx: LocalStackEvalContext): Promise<Probe> {
  const marker = `cs${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const probe: Probe = { marker };
  try {
    const status = await ctx.stackStatus();
    const stack: Stack = {
      apiUrl: status.apiUrl,
      anon: status.publishableKey,
      secret: status.secretKey,
    };
    probe.stack = stack;

    const seeded = await execSql(
      ctx,
      `INSERT INTO help_center.articles (title, body, published) VALUES
         ('${marker} shown', 'visible to visitors', true),
         ('${marker} draft', 'not for visitors', false);`
    );
    if (!seeded.ok) {
      probe.failure = `could not add the scorer's articles: ${seeded.message}`;
      return probe;
    }

    probe.visitor = await ready(
      stack,
      stack.anon,
      'articles?select=title,published',
      'help_center'
    );
    probe.server = await ready(stack, stack.secret, 'articles', 'help_center', {
      method: 'POST',
      body: {
        title: `${marker} from the server`,
        body: 'added by the job',
        published: true,
      },
    });
    const { rows } = await ctx.query(
      `SELECT 1 AS found FROM help_center.articles WHERE title = '${marker} from the server'`
    );
    probe.serverRow = rows.length > 0;

    // A table the project adds after the agent is done, as the admin account
    // does with its own migrations. Only a standing arrangement for tables
    // made later can have covered it.
    const table = `${marker}_notes`;
    const made = await execSql(
      ctx,
      `CREATE TABLE help_center.${table} (id integer PRIMARY KEY, note text);
       INSERT INTO help_center.${table} VALUES (1, '${marker} note');`
    );
    probe.later = made.ok
      ? await ready(stack, stack.anon, table, 'help_center', undefined, [
          'PGRST205',
        ])
      : { status: 0, code: '', message: made.message, rows: [] };
    if (made.ok) {
      await execSql(ctx, `DROP TABLE IF EXISTS help_center.${table};`);
    }

    probe.staff = await ready(stack, stack.anon, 'salaries', 'staff');
    return probe;
  } catch (error) {
    probe.failure = messageOf(error);
    return probe;
  }
}

export async function checkStackStarts(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const restarted = await restartStack(ctx);
  return {
    name: CHECK.starts,
    passed: restarted.ok,
    notes: restarted.ok
      ? 'stopped and started again on the project settings'
      : restarted.message,
  };
}

const notRun = (name: string, why: string): CheckResult => ({
  name,
  passed: false,
  notes: `not run: ${why}`,
});

// The control for the other three. It needs the schema exposed to the API, the
// grants for the visitor's role, and the seed's policy left standing.
export function checkVisitor(probe: Probe): CheckResult {
  const name = CHECK.visitor;
  if (probe.failure) return notRun(name, probe.failure);
  const reply = probe.visitor;
  if (!reply || reply.status !== 200) {
    return {
      name,
      passed: false,
      notes: `the API answered ${reply ? describe(reply) : 'nothing'}`,
    };
  }
  const titles = reply.rows.map((row) =>
    String((row as { title?: unknown }).title ?? '')
  );
  const shown = titles.includes(`${probe.marker} shown`);
  const draft = titles.includes(`${probe.marker} draft`);
  const problems = [
    shown ? '' : 'the published article did not come back',
    draft ? 'a draft came back' : '',
  ].filter(Boolean);
  return {
    name,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? `${titles.length} rows, the published one and no draft`
        : problems.join('; '),
  };
}

// Confirmed as the superuser, not read back with the server key: a server that
// only adds articles has no need to read them, so a least-privilege grant is
// correct work.
export function checkServer(probe: Probe): CheckResult {
  const name = CHECK.server;
  if (probe.failure) return notRun(name, probe.failure);
  const reply = probe.server;
  if (!reply || reply.status < 200 || reply.status >= 300) {
    return {
      name,
      passed: false,
      notes: `the API answered ${reply ? describe(reply) : 'nothing'}`,
    };
  }
  return {
    name,
    passed: probe.serverRow === true,
    notes: probe.serverRow
      ? 'the article is in the table'
      : 'the API said yes but the article is not in the table',
  };
}

export function checkLater(probe: Probe): CheckResult {
  const name = CHECK.later;
  if (probe.failure) return notRun(name, probe.failure);
  const reply = probe.later;
  if (!reply || reply.status !== 200) {
    return {
      name,
      passed: false,
      notes: `the API answered ${reply ? describe(reply) : 'nothing'}`,
    };
  }
  const found = reply.rows.some((row) =>
    JSON.stringify(row).includes(`${probe.marker} note`)
  );
  return {
    name,
    passed: found,
    notes: found
      ? 'a visitor read a table added after the setup'
      : 'the table came back without its row',
  };
}

// Absence is only evidence once the visitor's own read works, so a closed API
// cannot pass it. Any refusal passes, whether the schema is not exposed or
// exposed and closed: either way the records are not readable.
export function checkStaff(probe: Probe): CheckResult {
  const name = CHECK.staff;
  if (probe.failure) return notRun(name, probe.failure);
  if (probe.visitor?.status !== 200) {
    return notRun(
      name,
      "the visitor's own read does not work, so a refusal here proves nothing"
    );
  }
  const reply = probe.staff;
  if (!reply) return notRun(name, 'the API gave no answer');
  if (reply.status === 200 && reply.rows.length > 0) {
    return {
      name,
      passed: false,
      notes: `the API returned ${reply.rows.length} staff rows to a visitor`,
    };
  }
  return {
    name,
    passed: reply.status !== 200 || reply.rows.length === 0,
    notes:
      reply.status === 200
        ? 'the schema is reachable but showed nothing'
        : `refused: ${describe(reply)}`,
  };
}
