import {
  judge,
  serializeTranscript,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkOrdersInPublication(ctx),
      await checkCourierFeedStillPublished(ctx),
      await checkPublicationStillPublishesInserts(ctx),
      await checkOrdersRlsIntact(ctx),
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
          name: "scorer evaluated realtime publication fix",
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

export default scorer;

async function checkOrdersInPublication(ctx: ToolEvalContext): Promise<CheckResult> {
  // Realtime Postgres Changes only delivers events for tables in this publication.
  const { rows } = await ctx.query(stripIndent`
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'orders';
  `);

  return {
    name: "orders table added to supabase_realtime publication",
    passed: rows.length > 0,
  };
}

async function checkCourierFeedStillPublished(ctx: ToolEvalContext): Promise<CheckResult> {
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
    name: "courier_locations still in supabase_realtime publication",
    passed: rows.length > 0,
  };
}

async function checkPublicationStillPublishesInserts(
  ctx: ToolEvalContext,
): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT pubinsert FROM pg_publication WHERE pubname = 'supabase_realtime';`,
  );

  return {
    name: "publication still publishes INSERT events",
    passed: rows[0]?.pubinsert === true,
  };
}

async function checkOrdersRlsIntact(ctx: ToolEvalContext): Promise<CheckResult> {
  // Guard against debugging by weakening security: RLS stays enabled and
  // staff can still read orders through it.
  const { rows: rls } = await ctx.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'orders';`,
  );
  if (rls[0]?.relrowsecurity !== true) {
    return { name: "RLS still enabled on orders", passed: false };
  }

  try {
    const { rows } = await ctx.query(stripIndent`
      BEGIN;
      SET LOCAL ROLE authenticated;
      SET LOCAL request.jwt.claim.role = 'authenticated';
      SELECT count(*)::int AS count FROM orders;
      COMMIT;
    `);

    return {
      name: "RLS still enabled on orders",
      passed: rows[0]?.count === 2,
      notes: `authenticated sees ${rows[0]?.count} orders`,
    };
  } catch (error) {
    try {
      await ctx.query("ROLLBACK;");
    } catch {
      // Clear aborted scorer transactions.
    }
    const msg = error instanceof Error ? error.message : String(error);
    return { name: "RLS still enabled on orders", passed: false, notes: msg };
  }
}

async function checkPublicationDiagnosis(ctx: ToolEvalContext): Promise<CheckResult> {
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
    name: "diagnosed missing publication membership",
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
