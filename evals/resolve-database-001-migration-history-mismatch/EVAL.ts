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
 * The exact local migration sequence a correct reconciliation must produce, in
 * order: the original `create_profiles`, the recovered orphan `add_profile_bio`
 * in its original slot, then the pending `add_avatar_url`. We pin the precise
 * set and order — not merely that timestamps ascend — because the orphan must be
 * recovered into its correct position (20240115, between create and avatar) so
 * local history fully describes the remote schema with no drift; discarding it
 * (repair --status reverted) or pulling it in under a fresh timestamp does not
 * qualify.
 */
const EXPECTED_MIGRATIONS = [
  { version: "20240101000000", name: "create_profiles" },
  { version: ORPHAN_VERSION, name: "add_profile_bio" },
  { version: PENDING_VERSION, name: "add_avatar_url" },
] as const;

/**
 * Verifies recovery from a remote migration-history mismatch (AI-823): the
 * agent reconciles the hosted history so `supabase db push` can apply a pending
 * migration, without resetting production data.
 *
 * Ground truth is read from the hosted project's database directly via
 * `ctx.hostedQuery` (in-process against the same PGlite, never the CLI under
 * test) plus the local migration files in the agent's workspace. We assert the
 * END STATE rather than the exact commands used, but the end state is pinned:
 * the local history must be exactly `EXPECTED_MIGRATIONS` (the orphan recovered
 * into its slot), and every one of those versions applied on the remote.
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

// The local migrations must be exactly the expected sequence, in order — not
// merely a chronologically-ascending set. We know the canonical result: the
// orphan recovered into its slot, giving create_profiles -> add_profile_bio ->
// add_avatar_url. This catches the orphan being discarded, pulled in under a
// fresh timestamp, reordered, renamed, duplicated, or left un-applied — states
// that may pass the looser checks but are wrong or un-pushable.
async function checkMigrationOrder(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = "local migrations are the expected files in the expected order";
  const files = await localMigrationFiles(ctx);
  const actual = files.map((f) => f.version);
  const expected = EXPECTED_MIGRATIONS.map((m) => m.version);

  // Exact version sequence, in order (length + position). This alone enforces
  // presence of all three, the orphan in its 20240115 slot, no extras, no
  // duplicates, and correct ordering.
  if (actual.length !== expected.length || expected.some((v, i) => v !== actual[i])) {
    return {
      name,
      passed: false,
      notes:
        `expected [${EXPECTED_MIGRATIONS.map((m) => `${m.version}_${m.name}`).join(", ")}], ` +
        `got [${files.map((f) => f.file).join(", ") || "(none)"}]`,
    };
  }

  // The two seeded files must not be renamed/replaced; the recovered orphan may
  // carry any descriptive name (its slot is already enforced by the version
  // match above).
  const renamed = EXPECTED_MIGRATIONS.filter(
    (m) =>
      m.version !== ORPHAN_VERSION &&
      !files.some((f) => f.version === m.version && f.name === m.name),
  );
  if (renamed.length > 0) {
    return {
      name,
      passed: false,
      notes: `seeded migration(s) renamed: expected ${renamed.map((m) => `${m.version}_${m.name}`).join(", ")}`,
    };
  }

  // Each expected migration must be recorded as applied on the remote, so the
  // recovered orphan isn't just a local file sitting un-pushed.
  const applied = new Set(await remoteHistoryVersions(ctx));
  const notApplied = expected.filter((v) => !applied.has(v));
  if (notApplied.length > 0) {
    return {
      name,
      passed: false,
      notes: `expected migration(s) not applied on the remote: ${JSON.stringify(notApplied)}`,
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
