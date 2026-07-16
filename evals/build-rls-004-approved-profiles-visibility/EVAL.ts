import type { CheckResult, SupabaseClient, ToolScorer } from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const PASSWORD = "secret123";

const scorer: ToolScorer = async (ctx) => {
  try {
    const userA = await signUpUser(ctx.client, "profiles-a@example.com");
    if ("failure" in userA) return { passed: false, checks: [userA.failure] };
    const userB = await signUpUser(ctx.getClient(), "profiles-b@example.com");
    if ("failure" in userB) return { passed: false, checks: [userB.failure] };
    const userC = await signUpUser(ctx.getClient(), "profiles-c@example.com");
    if ("failure" in userC) return { passed: false, checks: [userC.failure] };

    const clientA = userA.client;
    const clientB = userB.client;
    const clientC = userC.client;

    await ctx.query(stripIndent`
      INSERT INTO profiles (user_id, display_name, is_approved) VALUES
        ('${userA.id}', 'Alice', true),
        ('${userB.id}', 'Bob', true),
        ('${userC.id}', 'Cara', false);
    `);

    const { rows: rls } = await ctx.query(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'profiles';`,
    );

    const aOwnSelect = await clientA.from("profiles").select("id").eq("user_id", userA.id);
    const aOwnUpdate = await clientA
      .from("profiles")
      .update({ bio: "hello" })
      .eq("user_id", userA.id)
      .select("bio");
    const cOwnSelect = await clientC.from("profiles").select("id").eq("user_id", userC.id);
    const cOwnUpdate = await clientC
      .from("profiles")
      .update({ bio: "not approved yet" })
      .eq("user_id", userC.id)
      .select("bio");
    const bReadsA = await clientB.from("profiles").select("id").eq("user_id", userA.id);
    const aReadsB = await clientA.from("profiles").select("id").eq("user_id", userB.id);
    const bUpdatesA = await clientB
      .from("profiles")
      .update({ display_name: "hijacked" })
      .eq("user_id", userA.id)
      .select("id");
    const bDeletesA = await clientB.from("profiles").delete().eq("user_id", userA.id).select("id");

    const checks: CheckResult[] = [
      { name: "RLS enabled on profiles", passed: rls[0]?.relrowsecurity === true },
      {
        name: "user A can select own profile",
        passed: !aOwnSelect.error && aOwnSelect.data?.length === 1,
        notes: aOwnSelect.error?.message,
      },
      {
        name: "user A can update own profile",
        passed: !aOwnUpdate.error && aOwnUpdate.data?.[0]?.bio === "hello",
        notes: aOwnUpdate.error?.message,
      },
      {
        name: "unapproved user C can still select own profile",
        passed: !cOwnSelect.error && cOwnSelect.data?.length === 1,
        notes: cOwnSelect.error?.message,
      },
      {
        name: "unapproved user C can still update own profile",
        passed: !cOwnUpdate.error && cOwnUpdate.data?.[0]?.bio === "not approved yet",
        notes: cOwnUpdate.error?.message,
      },
      {
        name: "unrelated user B cannot select user A's approved profile",
        passed: Boolean(bReadsA.error) || bReadsA.data?.length === 0,
      },
      {
        name: "unrelated user A cannot select user B's approved profile",
        passed: Boolean(aReadsB.error) || aReadsB.data?.length === 0,
      },
      {
        name: "user B cannot update user A's profile",
        passed: Boolean(bUpdatesA.error) || !bUpdatesA.data || bUpdatesA.data.length === 0,
      },
      {
        name: "user B cannot delete user A's profile",
        passed: Boolean(bDeletesA.error) || !bDeletesA.data || bDeletesA.data.length === 0,
      },
    ];

    return { passed: checks.every((check) => check.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: "scorer evaluated profiles RLS behavior", passed: false, notes: msg }],
    };
  }
};

export default scorer;

/** Signs up a fresh auth user on the given client so tests can exercise per-user RLS. */
async function signUpUser(
  client: SupabaseClient,
  email: string,
): Promise<{ client: SupabaseClient; id: string } | { failure: CheckResult }> {
  const { data, error } = await client.auth.signUp({ email, password: PASSWORD });
  if (error || !data.user?.id || !data.session) {
    return {
      failure: {
        name: `created auth session for ${email}`,
        passed: false,
        notes: error?.message ?? "missing session",
      },
    };
  }
  return { client, id: data.user.id };
}
