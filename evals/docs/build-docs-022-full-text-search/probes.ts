import { randomUUID } from 'node:crypto';
import type { CheckResult } from '@supabase-evals/core';

// Plain functions so the probes also run on PGlite. Run executes as the
// superuser, returns psql's `-A -t` rows (`a|b`, one per line), and never
// throws.
export type Run = (
  sql: string
) => Promise<{ ok: boolean; stdout: string; message: string }>;

export const CHECK = {
  callable: 'the search runs the way the help center calls it',
  matches: 'the articles that mention the word come back, and no others',
  noText: 'an article with a title and no text is found by its title',
  order:
    'a title match comes before an article that only mentions the word in its text',
  typed: 'several words typed the way a visitor types them find the article',
} as const;

// The marker is a made-up word, so no seeded article and no other run
// contains it. Every article the probes add carries it.
export type World = {
  marker: string;
  ids: { heavy: number; hit: number; bare: number; other: number };
};
export type Setup = { world: World } | { failure: string };

const newMarker = () => `kc${randomUUID().slice(0, 8)}`;

// Four articles, inserted one at a time with the body-heavy one first, so an
// answer in insertion order is the wrong order:
//   heavy  the word is in the text eight times and not in the title
//   hit    the word is in the title once, with a short text
//   bare   the word is in the title and there is no text
//   other  does not mention the word at all
export async function setupWorld(run: Run): Promise<Setup> {
  const marker = newMarker();
  const mentions = Array(8).fill(marker).join(' tips, ');
  const built = await run(`
    insert into public.articles (title, body)
      values ('Getting started', 'Before you begin: ${mentions}.')
      returning 'heavy', id;
    insert into public.articles (title, body)
      values ('All about ${marker}', 'A short overview of how it works.')
      returning 'hit', id;
    insert into public.articles (title, body)
      values ('Cancel your ${marker} subscription', null)
      returning 'bare', id;
    insert into public.articles (title, body)
      values ('Update your billing address', 'Open settings and edit the address.')
      returning 'other', id;
  `);
  if (!built.ok) {
    return { failure: `could not add the probe articles: ${built.message}` };
  }
  const ids: Record<string, number> = {};
  for (const line of built.stdout.split('\n')) {
    const [role, id] = line.trim().split('|');
    if (role && id) ids[role] = Number(id);
  }
  if (!ids.heavy || !ids.hit || !ids.bare || !ids.other) {
    return {
      failure: `could not read back the probe articles: ${built.stdout.trim()}`,
    };
  }
  return {
    world: { marker, ids: ids as World['ids'] },
  };
}

export type Search =
  | { ok: true; ids: number[] }
  | { ok: false; message: string };

/** Calls the function the way PostgREST does: by name, with `term`. Rows come back in the order the function gave them. */
export async function search(run: Run, term: string): Promise<Search> {
  const literal = term.replaceAll("'", "''");
  const result = await run(
    `select r.id from public.search_articles(term => '${literal}') with ordinality as r order by r.ordinality;`
  );
  if (!result.ok) return { ok: false, message: result.message };
  const ids = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number);
  return { ok: true, ids };
}

export const searchTerms = (world: World) => ({
  single: world.marker,
  typed: `  Cancel  ${world.marker} subscription? `,
});

const notRun = (name: string, message: string): CheckResult => ({
  name,
  passed: false,
  notes: `not run: ${message}`,
});

// The positive control for everything below: the call works and says
// something. An agent that built nothing fails here, and the checks after it
// fail with a `not run` note rather than passing.
export function checkCallable(found: Search): CheckResult {
  return {
    name: CHECK.callable,
    passed: found.ok,
    notes: found.ok ? `returned ${found.ids.length} rows` : found.message,
  };
}

export function checkMatches(world: World, found: Search): CheckResult {
  const name = CHECK.matches;
  if (!found.ok) return notRun(name, found.message);
  const { heavy, hit, bare } = world.ids;
  const missing = [
    ['the title match', hit],
    ['the text-only match', heavy],
  ].filter(([, id]) => !found.ids.includes(id as number));
  // Seeded articles and the unrelated one don't mention the word. Anything
  // outside the three that do means the search returns articles it shouldn't.
  const extra = found.ids.filter(
    (id) => id !== heavy && id !== hit && id !== bare
  );
  const problems = [
    missing.length > 0
      ? `missing: ${missing.map(([label]) => label).join(', ')}`
      : '',
    extra.length > 0
      ? `${extra.length} article(s) that don't mention it came back`
      : '',
  ].filter(Boolean);
  return {
    name,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? 'both matches, nothing else'
        : problems.join('; '),
  };
}

export function checkNoText(world: World, found: Search): CheckResult {
  const name = CHECK.noText;
  if (!found.ok) return notRun(name, found.message);
  const present = found.ids.includes(world.ids.bare);
  return {
    name,
    passed: present,
    notes: present
      ? 'found'
      : 'an article whose text is empty did not come back for a word in its title',
  };
}

export function checkOrder(world: World, found: Search): CheckResult {
  const name = CHECK.order;
  if (!found.ok) return notRun(name, found.message);
  const { ids } = found;
  const hit = ids.indexOf(world.ids.hit);
  const heavy = ids.indexOf(world.ids.heavy);
  if (hit < 0 || heavy < 0) {
    return {
      name,
      passed: false,
      notes: 'not both articles came back, so there is no order to read',
    };
  }
  return {
    name,
    passed: hit < heavy,
    notes:
      hit < heavy
        ? `title match at ${hit + 1}, text-only match at ${heavy + 1}`
        : `the text-only article came first (${heavy + 1}) and the title match second (${hit + 1})`,
  };
}

export function checkTyped(world: World, found: Search): CheckResult {
  const name = CHECK.typed;
  if (!found.ok) {
    return { name, passed: false, notes: found.message };
  }
  const present = found.ids.includes(world.ids.bare);
  return {
    name,
    passed: present,
    notes: present
      ? `found among ${found.ids.length} rows`
      : `the article did not come back (${found.ids.length} rows)`,
  };
}
