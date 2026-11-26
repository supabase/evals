import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { messageOf, readStack, type Step } from '../lib/local-stack.js';

export const TICKETS = 'tickets';
export const REPORTS = 'reports';

const MB = 1_000_000;

export const CHECK = {
  starts: 'the local stack starts with the project settings',
  applied: 'the agent applied the bucket settings it wrote',
  accepted: 'files under 5 MB are accepted in both places',
  tickets: 'a file over 5 MB is refused in tickets',
  reports: 'a file over 5 MB is refused in reports',
} as const;

// 3 MB and 8 MB sit well either side of 5 MB, so 5 MB read as 5,000,000 or
// 5,242,880 bytes gives the same verdicts.
const SMALL = 3 * MB;
const BIG = 8 * MB;

type Place = {
  bucket: string;
  type: string;
  /** What the bucket row says its own limit is, for the notes. */
  limit?: string;
  /** Whether the file under the limit went in. The control for the refusal. */
  accepted?: boolean;
  acceptedNote?: string;
  /** Whether the file over the limit was stored. */
  overStored?: boolean;
  overNote?: string;
};

export type Probe =
  | { ok: false; reason: string }
  | { ok: true; places: Record<string, Place> };

const short = (text: string) => text.replace(/\s+/g, ' ').slice(0, 200);

export type Applied = { ok: boolean; changed: string[]; message: string };

// A limit declared in config.toml only reaches a bucket that already exists
// once the CLI seeds it, and the page says nothing about that. The scorer seeds
// so one missed step costs one check rather than the refusal checks, and the
// rows that changed are the proof the agent hadn't. It also means a limit set
// some other way for a bucket that config.toml declares is overwritten.
export async function applyBucketSettings(
  ctx: LocalStackEvalContext,
  started: Step
): Promise<Applied> {
  if (!started.ok) return { ok: false, changed: [], message: started.message };
  try {
    const before = await limits(ctx);
    const seeded = await ctx.exec('supabase seed buckets --local 2>&1', {
      timeoutMs: 180_000,
    });
    if (seeded.exitCode !== 0) {
      return {
        ok: false,
        changed: [],
        message: short(seeded.stdout ?? 'seed buckets failed'),
      };
    }
    const after = await limits(ctx);
    const changed = Object.keys(after).filter((id) => before[id] !== after[id]);
    return { ok: true, changed, message: '' };
  } catch (error) {
    return { ok: false, changed: [], message: messageOf(error) };
  }
}

async function limits(
  ctx: LocalStackEvalContext
): Promise<Record<string, string>> {
  const { rows } = await ctx.query(
    'select id, file_size_limit from storage.buckets;'
  );
  return Object.fromEntries(
    rows.map((row) => [String(row.id), String(row.file_size_limit)])
  );
}

/**
 * One round of uploads as the server key, which bypasses policies, so what is
 * measured is the project's size limits. Refusals are read from storage.objects
 * as the superuser, never inferred from the response. Every path carries a
 * per-run marker.
 */
export async function probeUploads(
  ctx: LocalStackEvalContext,
  started: Step
): Promise<Probe> {
  if (!started.ok) return { ok: false, reason: started.message };
  try {
    const stack = await readStack(ctx);
    const marker = `fl${randomUUID().slice(0, 8)}`;
    const places: Record<string, Place> = {
      [TICKETS]: { bucket: TICKETS, type: 'image/png' },
      [REPORTS]: { bucket: REPORTS, type: 'application/pdf' },
    };
    for (const place of Object.values(places)) {
      place.limit = await bucketLimit(ctx, place.bucket);
      const small = await upload(stack, place, `${marker}/under.bin`, SMALL);
      place.accepted = await stored(ctx, place.bucket, `${marker}/under.bin`);
      place.acceptedNote = place.accepted ? undefined : small;
      if (!place.accepted) continue;
      const big = await upload(stack, place, `${marker}/over.bin`, BIG);
      place.overStored = await stored(ctx, place.bucket, `${marker}/over.bin`);
      place.overNote = place.overStored ? undefined : big;
    }
    return { ok: true, places };
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
}

async function upload(
  stack: { apiUrl: string; adminKey: string },
  place: Place,
  path: string,
  size: number
): Promise<string> {
  // A secret key in the new format is not a JWT, so it only goes in `apikey`.
  const headers: Record<string, string> = {
    apikey: stack.adminKey,
    'Content-Type': place.type,
  };
  if (stack.adminKey.split('.').length === 3) {
    headers.Authorization = `Bearer ${stack.adminKey}`;
  }
  try {
    const response = await fetch(
      `${stack.apiUrl}/storage/v1/object/${place.bucket}/${path}`,
      { method: 'POST', headers, body: Buffer.alloc(size, 'a') }
    );
    return `${response.status} ${short(await response.text())}`;
  } catch (error) {
    return messageOf(error);
  }
}

async function stored(
  ctx: LocalStackEvalContext,
  bucket: string,
  path: string
): Promise<boolean> {
  const { rows } = await ctx.query(
    `select count(*)::int as n from storage.objects where bucket_id = '${bucket}' and name = '${path}';`
  );
  return Number(rows[0]?.n) > 0;
}

async function bucketLimit(
  ctx: LocalStackEvalContext,
  bucket: string
): Promise<string> {
  const { rows } = await ctx.query(
    `select file_size_limit from storage.buckets where id = '${bucket}';`
  );
  if (rows.length === 0) return 'no such bucket';
  const bytes = rows[0]?.file_size_limit;
  return bytes === null || bytes === undefined
    ? 'no limit of its own'
    : `${bytes} bytes`;
}

function blocked(name: string, probe: { reason: string }): CheckResult {
  return { name, passed: false, notes: `not run: ${probe.reason}` };
}

export function checkSettingsApplied(applied: Applied): CheckResult {
  return {
    name: CHECK.applied,
    passed: applied.ok && applied.changed.length === 0,
    notes: !applied.ok
      ? `could not check: ${applied.message}`
      : applied.changed.length === 0
        ? 'config.toml and the buckets agreed'
        : `config.toml declared limits the buckets did not have yet: ${applied.changed.join(', ')}; the scorer seeded them so the uploads could be measured`,
  };
}

export function checkStackStarts(started: Step): CheckResult {
  return {
    name: CHECK.starts,
    passed: started.ok,
    notes: started.ok ? 'supabase start exited 0' : started.message,
  };
}

// The control for the two refusal checks: a project that refuses everything
// would pass them both.
export function checkAcceptedUnderTheLimit(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.accepted, probe);
  const failed = Object.values(probe.places).filter((p) => !p.accepted);
  return {
    name: CHECK.accepted,
    passed: failed.length === 0,
    notes:
      failed.length === 0
        ? 'a 3 MB file was stored in tickets and in reports'
        : failed
            .map(
              (p) =>
                `${p.bucket} took no 3 MB file (${p.limit}): ${p.acceptedNote}`
            )
            .join('; '),
  };
}

export function checkRefused(probe: Probe, bucket: string): CheckResult {
  const name = bucket === TICKETS ? CHECK.tickets : CHECK.reports;
  if (!probe.ok) return blocked(name, probe);
  const place = probe.places[bucket];
  if (!place.accepted) {
    return {
      name,
      passed: false,
      notes: `not run: ${bucket} took no 3 MB file (see "${CHECK.accepted}")`,
    };
  }
  return {
    name,
    passed: !place.overStored,
    notes: place.overStored
      ? `an 8 MB file was stored in ${bucket}; its own limit is ${place.limit}`
      : `refused: ${place.overNote}`,
  };
}
