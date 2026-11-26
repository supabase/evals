import { randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  SupabaseClient,
} from '@supabase-evals/core';
import { execSql } from '../lib/exec-sql.js';

export const CHECK = {
  stored:
    'an article added with its embedding comes back when searching for that embedding',
  order: 'the closest article comes first, then the next closest',
  count: 'the search returns as many articles as it was asked for, and no more',
  existing:
    'the articles that were already in the project are found by their own text',
} as const;

// app/embed.mjs, kept in step with it. The seed's articles are searched with
// what the app itself would send for their text.
const DIMENSIONS = 8;
export function embed(text: string): number[] {
  const out = new Array<number>(DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 0;
    for (const ch of word) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
    out[hash % DIMENSIONS] += 1;
  }
  const length = Math.hypot(...out) || 1;
  return out.map((value) => value / length);
}

// The seed's articles, by title. The scorer looks the ids up by title, so a
// reordered table does not matter.
const SEEDED: { title: string; body: string }[] = [
  {
    title: 'Resetting your password',
    body: 'To reset your password open Settings and choose Reset password. We email you a link that works for one hour.',
  },
  {
    title: 'Updating your billing address',
    body: 'Open Billing in Settings and edit the address on your invoices. New invoices use it straight away.',
  },
  {
    title: 'Cancelling a subscription',
    body: 'You can cancel a subscription from Billing at any time. It stays active until the end of the period you paid for.',
  },
  {
    title: 'Exporting your data',
    body: 'Choose Export in Settings to download your orders and customers as a spreadsheet. Large exports are emailed to you.',
  },
  {
    title: 'Inviting teammates',
    body: 'Owners can invite teammates by email from the Team page. Each teammate picks their own password.',
  },
  {
    title: 'Two step sign in',
    body: 'Turn on two step sign in under Security to ask for a code from your phone every time you sign in.',
  },
];

type Row = { id: number; title: string };
export type Found = { ok: true; rows: Row[] } | { ok: false; message: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Calls the function the way the help center does: over the API with the
// public key, by name, with these two arguments. The API reloads its view of
// the database a moment after a function appears, so a not-found answer is
// asked again for a few seconds before it counts.
export async function search(
  client: SupabaseClient,
  vector: number[],
  count: number,
  attempts = 8
): Promise<Found> {
  let last = 'no answer';
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { data, error } = await client.rpc('match_articles', {
      query_embedding: vector,
      match_count: count,
    });
    if (!error) {
      const rows = Array.isArray(data)
        ? data.map((row: { id?: unknown; title?: unknown }) => ({
            id: Number(row.id),
            title: String(row.title ?? ''),
          }))
        : [];
      return { ok: true, rows };
    }
    last = `${error.code ?? '?'} ${error.message}`.trim();
    if (error.code !== 'PGRST202') break;
    if (attempt < attempts - 1) await sleep(1_000);
  }
  return { ok: false, message: last.slice(0, 300) };
}

export type Existing = { found: Found[]; ids: (number | undefined)[] };

// Before anything of the scorer's goes into the table, so a row it adds cannot
// stand between an article and its own text.
export async function searchSeeded(
  ctx: LocalStackEvalContext,
  client: SupabaseClient
): Promise<Existing> {
  const { rows } = await ctx.query('SELECT id, title FROM public.articles;');
  const ids = SEEDED.map((article) => {
    const row = rows.find((candidate) => candidate.title === article.title);
    return row === undefined ? undefined : Number(row.id);
  });
  const found: Found[] = [];
  for (const article of SEEDED) {
    // Once the wait for the API to see the function has run out, the rest do
    // not wait again.
    const missing = found.some(
      (result) => !result.ok && result.message.startsWith('PGRST202')
    );
    found.push(await search(client, embed(article.body), 3, missing ? 1 : 8));
  }
  return { found, ids };
}

export type Marked =
  | {
      ok: true;
      ids: { near: number; mid: number; far: number };
      query: number[];
    }
  | { ok: false; message: string };

// Three articles, all in the half of the space no seeded article reaches, so
// the closest three to the query are these three whatever the seed holds:
// the first is the query itself, the others are progressively further away.
export async function addMarked(ctx: LocalStackEvalContext): Promise<Marked> {
  const marker = `pv${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const vectors = {
    near: [-1, 0, 0, 0, 0, 0, 0, 0],
    mid: [-0.95, 0.3122498999, 0, 0, 0, 0, 0, 0],
    far: [-0.8, 0.6, 0, 0, 0, 0, 0, 0],
  };
  const added = await execSql(
    ctx,
    (Object.entries(vectors) as [keyof typeof vectors, number[]][])
      .map(
        ([role, vector]) =>
          `INSERT INTO public.articles (title, body, embedding) VALUES ('${marker} ${role}', '${marker} ${role}', '[${vector.join(',')}]') RETURNING '${role}', id;`
      )
      .join('\n'),
    { tuplesOnly: true }
  );
  if (!added.ok) return { ok: false, message: added.message };
  const ids: Record<string, number> = {};
  for (const line of added.stdout.split('\n')) {
    const [role, id] = line.trim().split('|');
    if (role && id) ids[role] = Number(id);
  }
  if (!ids.near || !ids.mid || !ids.far) {
    return {
      ok: false,
      message: `could not read back the ids: ${added.stdout.trim()}`,
    };
  }
  return {
    ok: true,
    ids: ids as { near: number; mid: number; far: number },
    query: vectors.near,
  };
}

const notRun = (name: string, why: string): CheckResult => ({
  name,
  passed: false,
  notes: `not run: ${why}`,
});

// The control for the two after it. It needs the extension, a column that holds
// the app's numbers, a function the public key can call, and rows that can be
// searched.
export async function checkStored(
  marked: Marked,
  found: Found | undefined
): Promise<CheckResult> {
  const name = CHECK.stored;
  if (!marked.ok) {
    return {
      name,
      passed: false,
      notes: `adding an article with its embedding failed: ${marked.message}`,
    };
  }
  if (found === undefined || !found.ok) {
    return {
      name,
      passed: false,
      notes: `the search failed: ${found?.message ?? 'not called'}`,
    };
  }
  const present = found.rows.some((row) => row.id === marked.ids.near);
  return {
    name,
    passed: present,
    notes: present
      ? `found among ${found.rows.length} rows`
      : `the article did not come back (${found.rows.length} rows)`,
  };
}

export function checkOrder(
  marked: Marked,
  found: Found | undefined
): CheckResult {
  const name = CHECK.order;
  if (!marked.ok || found === undefined || !found.ok) {
    return notRun(name, 'the stored article was not found to begin with');
  }
  const ids = found.rows.map((row) => row.id);
  const [near, mid, far] = [
    marked.ids.near,
    marked.ids.mid,
    marked.ids.far,
  ].map((id) => ids.indexOf(id));
  if (near < 0 || mid < 0 || far < 0) {
    return {
      name,
      passed: false,
      notes: 'not all three articles came back, so there is no order to read',
    };
  }
  const right = near < mid && mid < far;
  return {
    name,
    passed: right,
    notes: right
      ? 'closest at 1, next at 2, furthest at 3'
      : `the closest article was at ${near + 1}, the next at ${mid + 1} and the furthest at ${far + 1}`,
  };
}

export function checkCount(
  marked: Marked,
  found: Found | undefined
): CheckResult {
  const name = CHECK.count;
  if (!marked.ok) return notRun(name, 'the stored article was not found');
  if (found === undefined || !found.ok) {
    return {
      name,
      passed: false,
      notes: `the search failed: ${found?.message ?? 'not called'}`,
    };
  }
  const right = found.rows.length === 2;
  return {
    name,
    passed: right,
    notes: `asked for 2, got ${found.rows.length}`,
  };
}

export function checkExisting(existing: Existing): CheckResult {
  const name = CHECK.existing;
  const failed: string[] = [];
  SEEDED.forEach((article, index) => {
    const id = existing.ids[index];
    const result = existing.found[index];
    if (id === undefined) {
      failed.push(`${article.title}: the article is gone`);
    } else if (!result.ok) {
      failed.push(`${article.title}: ${result.message}`);
    } else if (result.rows[0]?.id !== id) {
      failed.push(`${article.title}: not first`);
    }
  });
  return failed.length === 0
    ? {
        name,
        passed: true,
        notes: `all ${SEEDED.length} came back first for their own text`,
      }
    : { name, passed: false, notes: failed.slice(0, 3).join('; ') };
}
