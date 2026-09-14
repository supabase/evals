import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkOrdersInPublication(ctx),
      await checkCourierFeedStillPublished(ctx),
      await checkPublicationStillPublishesInserts(ctx),
      await checkOrdersRlsEnabled(ctx),
      await checkStaffCanReadOrders(ctx),
      await checkPublicationDiagnosis(ctx),
    ];

    return {
      passed: checks.every((check) => check.passed),
      checks,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [
        {
          name: 'scorer evaluated realtime publication fix',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

async function checkOrdersInPublication(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  // Realtime Postgres Changes only delivers events for tables in this publication.
  const { rows } = await ctx.query(stripIndent`
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'orders';
  `);

  return {
    name: 'orders table added to supabase_realtime publication',
    passed: rows.length > 0,
  };
}

async function checkCourierFeedStillPublished(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  // The working courier feed must survive the fix (e.g. a publication
  // recreated with only orders would silently break it).
  const { rows } = await ctx.query(stripIndent`
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'courier_locations';
  `);

  return {
    name: 'courier_locations still in supabase_realtime publication',
    passed: rows.length > 0,
  };
}

async function checkPublicationStillPublishesInserts(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT pubinsert FROM pg_publication WHERE pubname = 'supabase_realtime';`
  );

  return {
    name: 'publication still publishes INSERT events',
    passed: rows[0]?.pubinsert === true,
  };
}

async function checkOrdersRlsEnabled(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  // Guard against debugging by weakening security: RLS must stay enabled.
  const { rows } = await ctx.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'orders';`
  );

  return {
    name: 'RLS still enabled on orders',
    passed: rows[0]?.relrowsecurity === true,
  };
}

async function checkStaffCanReadOrders(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  // The "staff can read orders" policy must survive the fix: an authenticated
  // user should still see every order through PostgREST.
  const name = 'staff can still read orders through RLS';

  try {
    const client = ctx.getClient();
    const { error: signUpError } = await client.auth.signUp({
      email: 'dispatch-staff@example.com',
      password: 'secret123',
    });
    if (signUpError) {
      return { name, passed: false, notes: signUpError.message };
    }

    const { rows: privileged } = await ctx.query(
      `SELECT count(*)::int AS count FROM orders;`
    );

    if (privileged.length === 0 || privileged[0].count === undefined) {
      return {
        name,
        passed: false,
        notes: 'failed to count orders with privileged SQL',
      };
    }

    const expected = privileged[0].count;

    const { count: authenticatedCount, error: readError } = await client
      .from('orders')
      .select('*', { count: 'exact', head: true });
    if (readError) {
      return { name, passed: false, notes: readError.message };
    }

    return {
      name,
      passed: authenticatedCount === expected,
      notes: `authenticated sees ${authenticatedCount} of ${expected} orders`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

async function checkPublicationDiagnosis(
  ctx: ToolEvalContext
): Promise<CheckResult> {
  const verdict = await judge({
    input: serializeTranscript(ctx.transcript, {
      includeToolCallInputs: true,
    }),
    rubric: stripIndent`
      Pass if the assistant diagnoses the silent Realtime subscription as the orders table missing from the supabase_realtime publication and fixes exactly that.

      A passing answer should:
      - Identify that the channel reaches SUBSCRIBED but Postgres Changes never delivers INSERT events for orders because orders is not in the supabase_realtime publication.
      - Add the orders table to the existing publication, e.g. ALTER PUBLICATION supabase_realtime ADD TABLE orders (or the dashboard equivalent).
      - Leave the rest of the project working: the courier_locations feed, the existing policies, and RLS on orders.

      Fail if the assistant blames RLS, grants, the client subscription code, or networking as the root cause, recreates the publication FOR ALL TABLES or drops tables that were already in it, disables RLS or weakens policies as part of the fix, recommends read replicas, or only suggests client-side changes without fixing the publication.
    `,
  });

  return {
    name: 'diagnosed missing publication membership',
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
