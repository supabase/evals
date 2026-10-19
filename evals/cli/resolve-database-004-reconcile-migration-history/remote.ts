import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { errorMessage } from '../lib/shell.js';
import { SEEDED_POSTS, SEEDED_PROFILES } from './seed.js';

export type RemoteState = {
  versions: string[];
  profileColumns: string[];
  postsExists: boolean;
  profileRows: number;
  intactBios: number;
  postRows: number | null;
};

export type RemoteProbe =
  | { ok: true; state: RemoteState }
  | { ok: false; notes: string };

type HostedContext = Pick<LocalStackEvalContext, 'hostedQuery' | 'hostedRef'>;

export const NO_HOSTED_PROJECT =
  'no hosted project on the scoring context: this eval needs `hostedProject: true` and a CLI experiment that links one (blocked on a staging org for evals)';

export function hasHostedProject(ctx: HostedContext): boolean {
  return ctx.hostedQuery !== undefined && ctx.hostedRef !== undefined;
}

export async function readRemote(ctx: HostedContext): Promise<RemoteProbe> {
  const { hostedQuery } = ctx;
  if (!hostedQuery || ctx.hostedRef === undefined) {
    return { ok: false, notes: NO_HOSTED_PROJECT };
  }
  try {
    const versions = (
      await hostedQuery(
        'select version::text as version from supabase_migrations.schema_migrations order by version'
      )
    ).rows.map((row) => String(row.version));
    const profileColumns = (
      await hostedQuery(
        "select column_name::text as column_name from information_schema.columns where table_schema = 'public' and table_name = 'profiles' order by ordinal_position"
      )
    ).rows.map((row) => String(row.column_name));
    const postsExists =
      (
        await hostedQuery(
          "select to_regclass('public.posts') is not null as exists"
        )
      ).rows[0]?.exists === true;

    const hasBio = profileColumns.includes('bio');
    const profiles = (
      await hostedQuery(
        hasBio
          ? "select count(*)::int as total, count(*) filter (where bio = 'Bio for ' || username)::int as intact from public.profiles"
          : 'select count(*)::int as total from public.profiles'
      )
    ).rows[0];
    const postRows = postsExists
      ? Number(
          (await hostedQuery('select count(*)::int as total from public.posts'))
            .rows[0]?.total
        )
      : null;

    return {
      ok: true,
      state: {
        versions,
        profileColumns,
        postsExists,
        profileRows: Number(profiles?.total),
        intactBios: hasBio ? Number(profiles?.intact) : 0,
        postRows,
      },
    };
  } catch (error) {
    return { ok: false, notes: errorMessage(error) };
  }
}

export function checkHostedProject(ctx: HostedContext): CheckResult {
  const name = 'linked to a hosted project';
  return hasHostedProject(ctx)
    ? { name, passed: true, notes: `hosted project ${ctx.hostedRef}` }
    : { name, passed: false, notes: NO_HOSTED_PROJECT };
}

export function checkDataIntact(remote: RemoteProbe): CheckResult {
  const name = 'production data is intact';
  if (!remote.ok) return { name, passed: false, notes: remote.notes };
  const { profileRows, intactBios, postRows } = remote.state;
  return {
    name,
    passed:
      profileRows === SEEDED_PROFILES &&
      intactBios === SEEDED_PROFILES &&
      postRows === SEEDED_POSTS,
    notes: `profiles ${profileRows} (${intactBios} with their original bio), posts ${postRows ?? 'missing'}`,
  };
}
