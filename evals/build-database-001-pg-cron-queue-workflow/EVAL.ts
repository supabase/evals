import {
  judge,
  unwrapEdgeFunctionResponse,
  type CheckResult,
  type ToolEvalContext,
  type ToolScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const QUEUE = "tasks";
const FUNCTION = "process-tasks";
const JOB = "enqueue-tasks";

const scorer: ToolScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkCronJobScheduled(ctx),
      await checkCronCommandRunsAndEnqueues(ctx),
      await checkFunctionRequiresAuth(ctx),
      {
        name: "function dequeues and returns messages",
        ...(await checkFunctionDequeues(ctx).catch((err): Omit<CheckResult, "name"> => ({
          passed: false,
          notes: err instanceof Error ? err.message : String(err),
        }))),
      },
    ];

    return {
      passed: checks.every((c) => c.passed),
      checks,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      checks: [{ name: "scorer completed without errors", passed: false, notes: msg }],
    };
  }
};

export default scorer;

async function checkCronJobScheduled(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT 1 FROM cron.job WHERE jobname = '${JOB}'`,
  );
  return {
    name: `pg_cron job '${JOB}' scheduled`,
    passed: rows.length > 0,
  };
}

async function checkCronCommandRunsAndEnqueues(ctx: ToolEvalContext): Promise<CheckResult> {
  const { rows } = await ctx.query(
    `SELECT command FROM cron.job WHERE jobname = '${JOB}'`,
  );
  if (rows.length === 0) {
    return { name: `cron command enqueues to '${QUEUE}' queue`, passed: false, notes: "job not found" };
  }
  const command = String(rows[0]?.command ?? "");
  try {
    await ctx.query(command);
  } catch (err) {
    return {
      name: `cron command enqueues to '${QUEUE}' queue`,
      passed: false,
      notes: err instanceof Error ? err.message : String(err),
    };
  }
  const { rows: msgs } = await ctx.query(
    `SELECT count(*)::int AS n FROM pgmq.q_${QUEUE}`,
  );
  return {
    name: `cron command enqueues to '${QUEUE}' queue`,
    passed: Number(msgs[0]?.n ?? 0) > 0,
  };
}

async function checkFunctionRequiresAuth(ctx: ToolEvalContext): Promise<CheckResult> {
  const result = await ctx.invokeFunction({ name: FUNCTION, method: "POST" });
  const passed = result.type === "response" && result.status === 401;
  return {
    name: "function requires authentication",
    passed,
    notes: passed
      ? undefined
      : `expected 401, got ${result.type === "response" ? result.status : result.error}`,
  };
}

async function checkFunctionDequeues(ctx: ToolEvalContext): Promise<CheckResult> {
  await ctx.query(`SELECT pgmq.send('${QUEUE}', '{"job":"process"}'::jsonb)`);

  const response = unwrapEdgeFunctionResponse(
    await ctx.invokeFunction({
      name: FUNCTION,
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.serviceRoleKey}` },
    }),
  );

  if (response.status < 200 || response.status >= 300) {
    return {
      name: "function dequeues and returns messages",
      passed: false,
      notes: `HTTP ${response.status}: ${response.body.slice(0, 200)}`,
    };
  }

  const verdict = await judge({
    input: `HTTP ${response.status} response body: ${response.body}`,
    rubric: stripIndent`
      Pass if the response body shows the function successfully drained or
      processed at least one queued message. Valid responses include a JSON
      array of dequeued message objects, or a status object with a count,
      processed count, or similar field showing at least one message was
      handled.
      Fail if the response is empty, only says the queue was empty, reports a
      zero count, or contains no evidence that a queued message was handled.
    `,
  });
  return {
    name: "function dequeues and returns messages",
    passed: verdict.passed,
    judgeNotes: verdict.notes,
  };
}
