import { randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  LocalStackStatus,
  SupabaseClient,
} from '@supabase-evals/core';

const PASSWORD = 'secret123';
const ROSTER = 'roster';

export type Fixtures = {
  clientA: SupabaseClient;
  anonClient: SupabaseClient;
  emailA: string;
  emailB: string;
};

export async function setupFixtures(
  ctx: LocalStackEvalContext
): Promise<{ fixtures: Fixtures } | { failure: CheckResult }> {
  const run = randomUUID().slice(0, 8);
  const emailA = `roster-a-${run}@example.com`;
  const emailB = `roster-b-${run}@example.com`;
  const clientA = await ctx.getClient();
  const clientB = await ctx.getClient();
  const anonClient = await ctx.getClient();

  for (const [client, email] of [
    [clientA, emailA],
    [clientB, emailB],
  ] as const) {
    const { data, error } = await client.auth.signUp({
      email,
      password: PASSWORD,
    });
    if (error || !data.user) {
      return {
        failure: {
          name: 'scorer seeded two signed-up users',
          passed: false,
          notes: `${email}: ${error?.message ?? 'no user returned'}`,
        },
      };
    }
    // Give the row a display name too, so a roster that inner-joins profiles
    // is not failed for a fixture the probe left half-built. The address is
    // written when the agent added a column for it, matching what their own
    // sign-up flow would store.
    const row = { id: data.user.id, display_name: `Roster ${run}` };
    let { error: profileError } = await client
      .from('profiles')
      .insert({ ...row, email });
    if (profileError) {
      ({ error: profileError } = await client.from('profiles').insert(row));
    }
    if (profileError && profileError.code !== '23505') {
      return {
        failure: {
          name: 'scorer seeded two signed-up users',
          passed: false,
          notes: `profile row for ${email}: ${profileError.message}`,
        },
      };
    }
  }

  return { fixtures: { clientA, anonClient, emailA, emailB } };
}

/**
 * The positive control. `no secret key in the client bundle` is satisfied by a
 * solution that never built the roster, so a green there only means something
 * paired with proof the roster works.
 */
export async function checkRoster(
  status: LocalStackStatus,
  fixtures: Fixtures
): Promise<CheckResult> {
  const name = 'roster returns every signed-up email';
  let body: string;
  let httpStatus: number;

  try {
    const res = await fetch(`${status.apiUrl}/functions/v1/${ROSTER}`, {
      headers: {
        apikey: status.publishableKey,
        authorization: `Bearer ${status.publishableKey}`,
      },
    });
    httpStatus = res.status;
    body = await res.text();
  } catch (error) {
    return {
      name,
      passed: false,
      notes: `GET /functions/v1/${ROSTER} did not respond: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const missing = [fixtures.emailA, fixtures.emailB].filter(
    (email) => !body.includes(email)
  );

  return {
    name,
    passed: httpStatus === 200 && missing.length === 0,
    notes:
      httpStatus === 200 && missing.length === 0
        ? undefined
        : `HTTP ${httpStatus}, missing ${missing.length}/2 seeded emails. Body: ${body.trim().slice(0, 600)}`,
  };
}

/**
 * Copying the address into a table with a permissive read policy leaves RLS
 * enabled and every check on the page's own advice green, while handing the
 * address to whoever holds the publishable key.
 */
export async function checkEmailsHiddenFromClients(
  ctx: LocalStackEvalContext,
  fixtures: Fixtures
): Promise<CheckResult> {
  const name = "no client role can read another user's email";

  let relations: string[];
  try {
    const { rows } = await ctx.query(`
      select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_depend d on d.objid = c.oid and d.deptype = 'e'
      where n.nspname = 'public'
        and c.relkind in ('r', 'p', 'v', 'm')
        and d.objid is null
      order by c.relname
    `);
    relations = rows.map((row) => String(row.relname));
  } catch (error) {
    return {
      name,
      passed: false,
      notes: `could not list the exposed schema: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  // Ranges over whatever the agent left in `public`, so a table the seed never
  // mentioned is measured too.
  const leaks: string[] = [];
  for (const relation of relations) {
    for (const [role, client] of [
      ['authenticated', fixtures.clientA],
      ['anon', fixtures.anonClient],
    ] as const) {
      const { data } = await client.from(relation).select('*');
      if (data && JSON.stringify(data).includes(fixtures.emailB)) {
        leaks.push(`${role} reads it from ${relation}`);
      }
    }
  }

  return {
    name,
    // Passes when the address is unreachable, including the case where the
    // agent never copied it out of auth.users at all.
    passed: leaks.length === 0,
    notes: leaks.length ? leaks.join('; ') : undefined,
  };
}
