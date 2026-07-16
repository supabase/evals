import type { CheckResult, SupabaseClient, ToolScorer } from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const PASSWORD = "secret123";
const ACME = "11111111-1111-1111-1111-111111111111";
const GLOBEX = "22222222-2222-2222-2222-222222222222";

const scorer: ToolScorer = async (ctx) => {
  try {
    const userA = await signUpUser(ctx.client, "profiles-a@example.com");
    if ("failure" in userA) return { passed: false, checks: [userA.failure] };
    const userB = await signUpUser(ctx.getClient(), "profiles-b@example.com");
    if ("failure" in userB) return { passed: false, checks: [userB.failure] };
    const userC = await signUpUser(ctx.getClient(), "profiles-c@example.com");
    if ("failure" in userC) return { passed: false, checks: [userC.failure] };
    const userD = await signUpUser(ctx.getClient(), "profiles-d@example.com");
    if ("failure" in userD) return { passed: false, checks: [userD.failure] };

    const clientA = userA.client;
    const clientB = userB.client;
    const clientC = userC.client;
    const clientD = userD.client;

    // A and B are coworkers at Acme, C is an unapproved Acme hire, D works at Globex.
    await ctx.query(stripIndent`
      INSERT INTO profiles (user_id, company_id, display_name, is_approved) VALUES
        ('${userA.id}', '${ACME}', 'Alice', true),
        ('${userB.id}', '${ACME}', 'Bob', true),
        ('${userC.id}', '${ACME}', 'Cara', false),
        ('${userD.id}', '${GLOBEX}', 'Dana', true);
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
    const bReadsCoworkerA = await clientB.from("profiles").select("id").eq("user_id", userA.id);
    const aReadsCoworkerB = await clientA.from("profiles").select("id").eq("user_id", userB.id);
    const dReadsOtherCompanyA = await clientD.from("profiles").select("id").eq("user_id", userA.id);
    const aReadsOtherCompanyD = await clientA.from("profiles").select("id").eq("user_id", userD.id);
    const dUpdatesA = await clientD
      .from("profiles")
      .update({ display_name: "hijacked" })
      .eq("user_id", userA.id)
      .select("id");
    const dDeletesA = await clientD.from("profiles").delete().eq("user_id", userA.id).select("id");

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
        name: "same-company coworker B can select A's approved profile",
        passed: !bReadsCoworkerA.error && bReadsCoworkerA.data?.length === 1,
        notes: bReadsCoworkerA.error?.message,
      },
      {
        name: "same-company coworker A can select B's approved profile",
        passed: !aReadsCoworkerB.error && aReadsCoworkerB.data?.length === 1,
        notes: aReadsCoworkerB.error?.message,
      },
      {
        name: "different-company user D cannot select A's approved profile",
        passed: Boolean(dReadsOtherCompanyA.error) || dReadsOtherCompanyA.data?.length === 0,
      },
      {
        name: "different-company user A cannot select D's approved profile",
        passed: Boolean(aReadsOtherCompanyD.error) || aReadsOtherCompanyD.data?.length === 0,
      },
      {
        name: "different-company user D cannot update A's profile",
        passed: Boolean(dUpdatesA.error) || !dUpdatesA.data || dUpdatesA.data.length === 0,
      },
      {
        name: "different-company user D cannot delete A's profile",
        passed: Boolean(dDeletesA.error) || !dDeletesA.data || dDeletesA.data.length === 0,
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
