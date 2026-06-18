import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
} from "@supabase-evals/core";

// The orphan version recorded on the remote but missing from local files —
// the thing that makes `db push` fail until it is reconciled.
const ORPHAN_VERSION = "20240115000000";
// The pending local migration the agent must get applied to the hosted project.
const PENDING_VERSION = "20240220000000";
const SEEDED_PROFILE_COUNT = 25;

/**
 * Verifies recovery from a remote migration-history mismatch (AI-823): the
 * agent reconciles the hosted history so `supabase db push` can apply a pending
 * migration, without resetting production data.
 *
 * Ground truth is read from the hosted project directly via the management API
 * (`/database/query`) — never the CLI under test — plus the local migration
 * files in the agent's workspace. We assert the END STATE rather than which
 * commands were used: both valid recovery paths (`db pull` the orphan down, or
 * `migration repair --status reverted` it) land the same reconciled history.
 *
 * NOTE (backend): this scorer reads the remote over the management API, which
 * works regardless of how `db push` reached it. The open backend question
 * (AI-843) is only how the *agent's* CLI writes to the remote over the Postgres
 * wire — see the two alternatives in the PR description.
 */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    if (!ctx.hostedMgmt || !ctx.hostedRef) {
      return {
        passed: false,
        checks: [
          {
            name: "linked to a hosted project",
            passed: false,
            notes:
              "no hosted platform on the scoring context — the eval needs `hostedProject: true`",
          },
        ],
      };
    }

    const checks: CheckResult[] = [
      await checkAvatarApplied(ctx),
      await checkPendingMigrationRecorded(ctx),
      await checkHistoryReconciled(ctx),
      await checkProductionDataIntact(ctx),
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        { name: "scorer evaluated migration-history recovery", passed: false, notes: msg },
      ],
    };
  }
};

export default scorer;

// The pending migration's schema change actually landed on the hosted DB: the
// avatar_url column now exists on public.profiles.
async function checkAvatarApplied(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = "the avatar_url column is applied on the hosted profiles table";
  const rows = await remoteQuery(
    ctx,
    `select 1 from information_schema.columns
       where table_schema = 'public'
         and table_name = 'profiles'
         and column_name = 'avatar_url'`,
  );
  return {
    name,
    passed: rows.length > 0,
    notes: rows.length > 0 ? undefined : "avatar_url not found on public.profiles",
  };
}

// The pending migration is recorded in the remote history — i.e. it was pushed,
// not just applied as ad-hoc SQL.
async function checkPendingMigrationRecorded(
  ctx: LocalStackEvalContext,
): Promise<CheckResult> {
  const name = `migration ${PENDING_VERSION} is recorded in the remote history`;
  const versions = await remoteHistoryVersions(ctx);
  const present = versions.includes(PENDING_VERSION);
  return {
    name,
    passed: present,
    notes: present ? undefined : `remote history versions: ${JSON.stringify(versions)}`,
  };
}

// History is reconciled: every version the remote considers applied has a
// matching local migration file. This is exactly the condition that lets
// `db push` proceed without the "history does not match local files" error.
// The orphan (20240115000000) must therefore either have been pulled down into
// a local file or repaired out of the remote history.
async function checkHistoryReconciled(
  ctx: LocalStackEvalContext,
): Promise<CheckResult> {
  const name = "remote migration history matches local migration files";
  const remoteVersions = await remoteHistoryVersions(ctx);
  const localVersions = await localMigrationVersions(ctx);
  const orphans = remoteVersions.filter((v) => !localVersions.includes(v));
  const orphanResolved = !remoteVersions.includes(ORPHAN_VERSION) ||
    localVersions.includes(ORPHAN_VERSION);
  const passed = orphans.length === 0 && orphanResolved;
  return {
    name,
    passed,
    notes: passed
      ? undefined
      : `remote-only versions still unreconciled: ${JSON.stringify(orphans)} ` +
        `(remote: ${JSON.stringify(remoteVersions)}, local: ${JSON.stringify(localVersions)})`,
  };
}

// Production data survived: the seeded profiles are all still present and their
// bio values intact — the remote was reconciled, not reset/wiped.
async function checkProductionDataIntact(
  ctx: LocalStackEvalContext,
): Promise<CheckResult> {
  const name = "production profile data is intact (not reset)";
  const rows = await remoteQuery(
    ctx,
    `select count(*)::int as total, count(bio)::int as with_bio from public.profiles`,
  );
  const total = Number(rows[0]?.total ?? -1);
  const withBio = Number(rows[0]?.with_bio ?? -1);
  const passed = total === SEEDED_PROFILE_COUNT && withBio === SEEDED_PROFILE_COUNT;
  return {
    name,
    passed,
    notes: passed
      ? undefined
      : `expected ${SEEDED_PROFILE_COUNT} profiles all with bio, got total=${total} with_bio=${withBio}`,
  };
}

// --- helpers ---------------------------------------------------------------

async function remoteQuery(
  ctx: LocalStackEvalContext,
  query: string,
): Promise<Record<string, unknown>[]> {
  const res = await ctx.hostedMgmt!.POST("/v1/projects/{ref}/database/query", {
    params: { path: { ref: ctx.hostedRef! } },
    body: { query },
  });
  if (res.error || !res.data) {
    throw new Error(`remote query failed: ${JSON.stringify(res.error)}`);
  }
  return res.data as unknown as Record<string, unknown>[];
}

async function remoteHistoryVersions(ctx: LocalStackEvalContext): Promise<string[]> {
  const rows = await remoteQuery(
    ctx,
    `select version from supabase_migrations.schema_migrations order by version`,
  );
  return rows.map((r) => String(r.version));
}

// Versions present as files in the agent's local supabase/migrations directory,
// derived from the leading timestamp of each filename.
async function localMigrationVersions(ctx: LocalStackEvalContext): Promise<string[]> {
  const result = await ctx.exec(
    `ls supabase/migrations 2>/dev/null | sed -n 's/^\\([0-9]\\{14\\}\\).*/\\1/p' | sort -u`,
  );
  return result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}
