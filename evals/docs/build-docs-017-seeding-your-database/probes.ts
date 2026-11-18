import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

// Query reads, Run writes and never throws. Plain functions so the probes also
// run on PGlite.
export type Query = (
  sql: string
) => Promise<{ rows: Record<string, unknown>[] }>;
export type Run = (
  sql: string
) => Promise<{ ok: boolean; stdout: string; message: string }>;
export type Reset = { ok: boolean; message: string };

export const CHECK = {
  reset: 'resetting the local database succeeds',
  rows: 'after a reset, every row on the sample data list is there',
  inserts:
    'after a reset, new studios, instructors, classes and bookings can be added',
  noSeed: 'a reset without the sample data step leaves none of it behind',
} as const;

// supabase/sample/README.md, joined by name so any ids pass.
const SAMPLE: [label: string, exists: string][] = [
  ...[
    ['Harbour Yoga', 'Wellington'],
    ['Northside Pilates', 'Auckland'],
  ].map(([name, city]): [string, string] => [
    `studio ${name}`,
    `select 1 from public.studios where name = '${name}' and city = '${city}'`,
  ]),
  ...[
    ['Maya Okafor', 'Harbour Yoga'],
    ['Tomas Reyes', 'Harbour Yoga'],
    ['Ana Lindqvist', 'Northside Pilates'],
  ].map(([name, studio]): [string, string] => [
    `instructor ${name} at ${studio}`,
    `select 1 from public.instructors i join public.studios s on s.id = i.studio_id
     where i.name = '${name}' and s.name = '${studio}'`,
  ]),
  ...[
    ['Sunrise Flow', 'Maya Okafor'],
    ['Yin Restore', 'Maya Okafor'],
    ['Power Vinyasa', 'Tomas Reyes'],
    ['Reformer Basics', 'Ana Lindqvist'],
  ].map(([title, instructor]): [string, string] => [
    `class ${title} by ${instructor}`,
    `select 1 from public.classes c join public.instructors i on i.id = c.instructor_id
     where c.title = '${title}' and i.name = '${instructor}'`,
  ]),
  ...[
    ['kiri@example.com', 'Sunrise Flow'],
    ['kiri@example.com', 'Reformer Basics'],
    ['sam@example.com', 'Sunrise Flow'],
    ['jo@example.com', 'Power Vinyasa'],
    ['lee@example.com', 'Yin Restore'],
  ].map(([guest, title]): [string, string] => [
    `booking ${guest} for ${title}`,
    `select 1 from public.bookings b join public.classes c on c.id = b.class_id
     where b.guest_email = '${guest}' and c.title = '${title}'`,
  ]),
];

/** Runs the CLI's own reset inside the sandbox. Never throws. */
export async function resetDatabase(
  ctx: Pick<LocalStackEvalContext, 'exec'>,
  { withSampleData }: { withSampleData: boolean }
): Promise<Reset> {
  const command = `supabase db reset${withSampleData ? '' : ' --no-seed'} 2>&1`;
  try {
    const result = await ctx.exec(command, { timeoutMs: 300_000 });
    return result.exitCode === 0
      ? { ok: true, message: '' }
      : { ok: false, message: resetError(result.stdout ?? '') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: message.slice(0, 300) };
  }
}

export function checkResetSucceeds(reset: Reset): CheckResult {
  return {
    name: CHECK.reset,
    passed: reset.ok,
    notes: reset.ok ? 'supabase db reset exited 0' : reset.message,
  };
}

/** The labels of every sample row that is (or isn't) in the database. */
async function sampleRows(query: Query, present: boolean): Promise<string[]> {
  const values = SAMPLE.map(
    ([label, exists]) => `('${label}', exists (${exists}))`
  ).join(',\n');
  const { rows } = await query(
    `select label from (values ${values}) t(label, present) where present = ${present}`
  );
  return rows.map((row) => String(row.label));
}

export async function checkSampleRows(
  query: Query,
  reset: Reset
): Promise<CheckResult> {
  if (!reset.ok) return blocked(CHECK.rows, reset);
  const missing = await sampleRows(query, false);
  return {
    name: CHECK.rows,
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? `all ${SAMPLE.length} rows present`
        : `missing ${missing.length} of ${SAMPLE.length}: ${missing.join('; ')}`,
  };
}

// One new row per table, chained so each insert has a parent, then rolled
// back. A collision on any table's key stops the script and names it.
export async function checkNewRows(
  run: Run,
  reset: Reset
): Promise<CheckResult> {
  if (!reset.ok) return blocked(CHECK.inserts, reset);
  const marker = `sd${randomUUID().slice(0, 8)}`;
  const result = await run(stripIndent`
    begin;
    insert into public.studios (name, city) values ('${marker} studio', 'Nelson');
    insert into public.instructors (studio_id, name)
      select id, '${marker} instructor' from public.studios where name = '${marker} studio';
    insert into public.classes (instructor_id, title, starts_at)
      select id, '${marker} class', now() from public.instructors where name = '${marker} instructor';
    insert into public.bookings (class_id, guest_email)
      select id, '${marker}@example.com' from public.classes where title = '${marker} class';
    select count(*) from public.bookings where guest_email = '${marker}@example.com';
    rollback;
  `);
  const added = result.ok && result.stdout.trim() === '1';
  return {
    name: CHECK.inserts,
    passed: added,
    notes: added
      ? 'a new studio, instructor, class and booking all inserted'
      : result.ok
        ? `the chain inserted ${result.stdout.trim() || 'nothing'} bookings, expected 1`
        : result.message,
  };
}

// Runs last: it wipes what the other probes read. Absence alone passes an
// agent that built nothing, so this only means something next to CHECK.rows.
export async function checkNoSampleDataWithoutSeed(
  query: Query,
  reset: Reset
): Promise<CheckResult> {
  if (!reset.ok) return blocked(CHECK.noSeed, reset);
  const present = await sampleRows(query, true);
  return {
    name: CHECK.noSeed,
    passed: present.length === 0,
    notes:
      present.length === 0
        ? 'supabase db reset --no-seed left no sample rows'
        : `still there without the seed step: ${present.join('; ')}`,
  };
}

// The CLI prints the failure last, as `failed to send batch: ERROR: ...`,
// after progress lines, so lead with the ERROR line and its statement.
function resetError(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const at = lines.findIndex((line) => line.includes('ERROR'));
  const message = at === -1 ? lines.at(-1) : lines.slice(at, at + 2).join(' ');
  return (message ?? 'no output').slice(0, 300);
}

function blocked(name: string, reset: Reset): CheckResult {
  return {
    name,
    passed: false,
    notes: `not run: reset failed: ${reset.message}`,
  };
}
