import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackScorer,
} from "@supabase-evals/core";

// The pending local migration the agent must get applied to the hosted project.
const PENDING_VERSION = "20240220000000";
const SEEDED_PROFILE_COUNT = 25;

// The two seeded migrations that bookend a correct reconciliation. The agent
// must keep them, unrenamed, as the first and last migration.
const FIRST_MIGRATION = { version: "20240101000000", name: "create_profiles" } as const;
const LAST_MIGRATION = { version: PENDING_VERSION, name: "add_avatar_url" } as const;

/**
 * Verifies recovery from a remote migration-history mismatch (AI-823): the
 * agent reconciles the hosted history so `supabase db push` can apply a pending
 * migration, without resetting production data.
 *
 * Ground truth is read from the hosted project's database directly via
 * `ctx.hostedQuery` (in-process against the same PGlite, never the CLI under
 * test) plus the local migration files in the agent's workspace. We assert the
 * END STATE rather than the exact commands used. Two recovered shapes are valid
 * — both keep all three migrations, ordered create_profiles → bio reconciliation
 * → add_avatar_url, with strictly ascending timestamps:
 *   A. orphan recovered into its slot: bio at 20240115.
 *   B. `db pull` style: bio captured under any timestamp, as long as it lands
 *      before the avatar.
 * `checkMigrationOrder` accepts either: create_profiles first, add_avatar_url
 * last, exactly one migration strictly between, all applied on the remote.
 */
const scorer: LocalStackScorer = async (ctx) => {
  try {
    if (!ctx.hostedQuery || !ctx.hostedRef) {
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
      await checkMigrationOrder(ctx),
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
  const passed = orphans.length === 0;
  return {
    name,
    passed,
    notes: passed
      ? undefined
      : `remote-only versions still unreconciled: ${JSON.stringify(orphans)} ` +
        `(remote: ${JSON.stringify(remoteVersions)}, local: ${JSON.stringify(localVersions)})`,
  };
}

// The local migrations must be a valid reconciled sequence — the right files in
// the right order with sequential timestamps — not merely a chronologically
// ascending set. Both accepted solutions share one shape: exactly three files,
// the two seeded bookends unchanged, and a single bio reconciliation strictly
// between them (the orphan recovered in its 20240115 slot, or a db-pull capture
// at any earlier-than-avatar timestamp). Requiring add_avatar_url to be last is
// what enforces "bio before avatar". This rejects discarding the orphan
// (2 files), a bio pulled in after the avatar, reordering, renaming a seeded
// file, duplicate timestamps, or a reconciliation left un-applied — states that
// can slip past the looser checks but are wrong or un-pushable.
async function checkMigrationOrder(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = "local migrations are a valid reconciled sequence";
  const files = await localMigrationFiles(ctx); // ascending by filename (version)
  const versions = files.map((f) => f.version);
  const shown = files.map((f) => f.file).join(", ") || "(none)";
  const expectedShape =
    `${FIRST_MIGRATION.version}_${FIRST_MIGRATION.name} → <bio reconciliation> → ` +
    `${LAST_MIGRATION.version}_${LAST_MIGRATION.name}, strictly ascending`;

  const first = files[0];
  const last = files[files.length - 1];
  const strictlyAscending = versions.every((v, i) => i === 0 || v > versions[i - 1]);
  const validShape =
    files.length === 3 &&
    strictlyAscending &&
    first.version === FIRST_MIGRATION.version &&
    first.name === FIRST_MIGRATION.name &&
    last.version === LAST_MIGRATION.version &&
    last.name === LAST_MIGRATION.name;
  if (!validShape) {
    return { name, passed: false, notes: `expected ${expectedShape}; got [${shown}]` };
  }

  // The bio reconciliation (and every migration) must actually be applied on the
  // remote — not left as a local-only file that was never pushed.
  const applied = new Set(await remoteHistoryVersions(ctx));
  const notApplied = versions.filter((v) => !applied.has(v));
  if (notApplied.length > 0) {
    return {
      name,
      passed: false,
      notes: `migration(s) not applied on the remote: ${JSON.stringify(notApplied)}`,
    };
  }

  return { name, passed: true };
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
  const { rows } = await ctx.hostedQuery!(query);
  return rows;
}

async function remoteHistoryVersions(ctx: LocalStackEvalContext): Promise<string[]> {
  const rows = await remoteQuery(
    ctx,
    `select version from supabase_migrations.schema_migrations order by version`,
  );
  return rows.map((r) => String(r.version));
}

// Unique versions present as files in the agent's local supabase/migrations
// directory, derived from the leading timestamp of each filename.
async function localMigrationVersions(ctx: LocalStackEvalContext): Promise<string[]> {
  const result = await ctx.exec(
    `ls supabase/migrations 2>/dev/null | sed -n 's/^\\([0-9]\\{14\\}\\).*/\\1/p' | sort -u`,
  );
  return result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

// Local migration files parsed into { version, name }, in filename order
// (lexical sort on the 14-digit prefix == chronological). Keeps duplicates and
// preserves order so `checkMigrationOrder` can assert the exact sequence.
async function localMigrationFiles(
  ctx: LocalStackEvalContext,
): Promise<Array<{ version: string; name: string; file: string }>> {
  const result = await ctx.exec(`ls supabase/migrations 2>/dev/null | sort`);
  return result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((file) => {
      const m = file.match(/^(\d{14})_(.+)\.sql$/);
      return m ? { version: m[1], name: m[2], file } : { version: "", name: "", file };
    })
    .filter((f) => f.version !== "");
}
