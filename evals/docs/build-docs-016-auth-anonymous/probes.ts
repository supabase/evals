import { randomUUID } from 'node:crypto';
import type {
  CheckResult,
  LocalStackEvalContext,
  SupabaseClient,
} from '@supabase-evals/core';

export const CHECK = {
  session: 'a visitor can start a session without an account',
  guestReads: 'a guest can read the reviews',
  guestCart: 'a guest can add a plant to their cart',
  memberReview: 'a customer with an account can post a review',
  guestReview: 'a guest cannot post a review',
} as const;

const PASSWORD = 'secret123';
const RLS_REFUSAL = '42501';

export type Run = (sql: string) => Promise<{ ok: boolean; message: string }>;

export type Guest = { client: SupabaseClient; id: string };

export type World = {
  guestClient: SupabaseClient;
  memberClient: SupabaseClient;
  guestId: string;
  memberId: string;
  plantId: number;
  marker: string;
};

export type Setup = { world: World } | { failure: string };

export async function startGuest(
  ctx: LocalStackEvalContext
): Promise<{ guest: Guest } | { failure: string }> {
  const client = await ctx.getClient();
  const { data, error } = await client.auth.signInAnonymously();
  if (error || !data.user || !data.session) {
    return {
      failure: `a visitor could not start a session: ${error?.message ?? 'no session'}`,
    };
  }
  if (data.user.is_anonymous !== true) {
    return { failure: 'the visitor session is not marked as a guest' };
  }
  return { guest: { client, id: data.user.id } };
}

export function checkSessionStarts(
  started: { guest: Guest } | { failure: string }
): CheckResult {
  return 'guest' in started
    ? { name: CHECK.session, passed: true, notes: 'signed in as a guest' }
    : { name: CHECK.session, passed: false, notes: started.failure };
}

export async function setupWorld(
  ctx: LocalStackEvalContext,
  run: Run,
  guest: Guest
): Promise<Setup> {
  const marker = `sprout-${randomUUID().slice(0, 8)}`;

  const memberClient = await ctx.getClient();
  const { data: member, error: memberError } = await memberClient.auth.signUp({
    email: `${marker}@example.test`,
    password: PASSWORD,
  });
  if (memberError || !member.user || !member.session) {
    return {
      failure: `a customer could not sign up: ${memberError?.message ?? 'no session'}`,
    };
  }

  const planted = await run(
    `INSERT INTO plants (name, price_cents) VALUES ('${marker}', 1200);`
  );
  if (!planted.ok) {
    return { failure: `could not add a plant: ${planted.message}` };
  }
  const { rows } = await ctx.query(
    `SELECT id FROM plants WHERE name = '${marker}';`
  );
  const plantId = Number(rows[0]?.id);
  if (!Number.isFinite(plantId)) {
    return { failure: 'the plant the scorer added is missing' };
  }

  const reviewed = await run(
    `INSERT INTO reviews (user_id, plant_id, body) VALUES ('${member.user.id}', ${plantId}, '${marker}-existing');`
  );
  if (!reviewed.ok) {
    return { failure: `could not add a review: ${reviewed.message}` };
  }

  return {
    world: {
      guestClient: guest.client,
      memberClient,
      guestId: guest.id,
      memberId: member.user.id,
      plantId,
      marker,
    },
  };
}

export async function checkGuestReads(world: World): Promise<CheckResult> {
  const { data, error } = await world.guestClient
    .from('reviews')
    .select('body')
    .eq('plant_id', world.plantId);
  const found = (data ?? []).some(
    (row) => row.body === `${world.marker}-existing`
  );
  return {
    name: CHECK.guestReads,
    passed: found,
    notes: found
      ? 'read the review the scorer added'
      : `did not get the review back${error ? `: ${error.message}` : ''}`,
  };
}

export async function checkGuestCart(
  ctx: LocalStackEvalContext,
  world: World
): Promise<CheckResult> {
  const { error } = await world.guestClient
    .from('cart_items')
    .insert({ plant_id: world.plantId, note: `${world.marker}-cart` });
  const count = await countRows(
    ctx,
    `SELECT count(*)::int AS count FROM cart_items WHERE note = '${world.marker}-cart' AND user_id = '${world.guestId}';`
  );
  return {
    name: CHECK.guestCart,
    passed: count === 1,
    notes:
      count === 1
        ? 'the cart row is there under the guest'
        : `the cart row is missing${error ? `: ${error.message}` : ''}`,
  };
}

export async function checkMemberReview(
  ctx: LocalStackEvalContext,
  world: World
): Promise<CheckResult> {
  const { error } = await world.memberClient.from('reviews').insert({
    plant_id: world.plantId,
    body: `${world.marker}-member`,
  });
  const count = await countRows(
    ctx,
    `SELECT count(*)::int AS count FROM reviews WHERE body = '${world.marker}-member' AND user_id = '${world.memberId}';`
  );
  return {
    name: CHECK.memberReview,
    passed: count === 1,
    notes:
      count === 1
        ? 'the review is there under the customer'
        : `the review is missing${error ? `: ${error.message}` : ''}`,
  };
}

export async function checkGuestCannotReview(
  ctx: LocalStackEvalContext,
  world: World
): Promise<CheckResult> {
  const { error } = await world.guestClient.from('reviews').insert({
    plant_id: world.plantId,
    body: `${world.marker}-guest`,
  });
  const count = await countRows(
    ctx,
    `SELECT count(*)::int AS count FROM reviews WHERE body = '${world.marker}-guest';`
  );
  if (count > 0) {
    return {
      name: CHECK.guestReview,
      passed: false,
      notes: 'the guest got a review into the table',
    };
  }
  if (error?.code !== RLS_REFUSAL) {
    return {
      name: CHECK.guestReview,
      passed: false,
      notes:
        `no row was written, but the refusal was not an access refusal: ${error?.code ?? 'no error'} ${error?.message ?? ''}`.trim(),
    };
  }
  return {
    name: CHECK.guestReview,
    passed: true,
    notes: 'refused with an access error and no row was written',
  };
}

async function countRows(
  ctx: LocalStackEvalContext,
  sql: string
): Promise<number> {
  const { rows } = await ctx.query(sql);
  return Number(rows[0]?.count ?? 0);
}
