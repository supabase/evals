import {
  judge,
  type CheckResult,
  type CommandResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from "@supabase-evals/core";
import { stripIndent } from "common-tags";

const QUEUE = "tasks";
const FUNCTION = "process-tasks";
const JOB = "enqueue-tasks";
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkCronJobScheduled(ctx),
      await checkCronCommandEnqueues(ctx),
      await checkFunctionDrains(ctx),
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

/** Run arbitrary SQL against the local stack as postgres. base64 sidesteps shell quoting. */
async function execSql(ctx: LocalStackEvalContext, sql: string): Promise<CommandResult> {
  const encoded = Buffer.from(sql, "utf-8").toString("base64");
  return ctx.exec(`echo ${encoded} | base64 -d | psql "${DB_URL}" -v ON_ERROR_STOP=1 -tA`);
}

async function checkCronJobScheduled(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = `pg_cron job '${JOB}' scheduled to run every minute`;
  const { rows } = await ctx.query(
    `select schedule, active from cron.job where jobname = '${JOB}'`,
  );
  if (rows.length === 0) {
    return { name, passed: false, notes: "job not found in cron.job" };
  }
  const schedule = String(rows[0]?.schedule ?? "");
  const active = rows[0]?.active === true;
  // pg_cron accepts both the 5-field crontab form and an interval string.
  const everyMinute = /^\s*\*(\/1)?(\s+\*){4}\s*$/.test(schedule) || /minute|second/i.test(schedule);
  return {
    name,
    passed: active && everyMinute,
    notes: `schedule='${schedule}', active=${active}`,
  };
}

async function checkCronCommandEnqueues(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = `cron command enqueues to the '${QUEUE}' queue`;
  const { rows } = await ctx.query(`select command from cron.job where jobname = '${JOB}'`);
  if (rows.length === 0) {
    return { name, passed: false, notes: "job not found, so its command can't run" };
  }
  const command = String(rows[0]?.command ?? "");

  // The queue may not exist yet — the agent's command might create it.
  const before = (await queueDepth(ctx)) ?? 0;
  const run = await execSql(ctx, command);
  if (!run.ok) {
    return { name, passed: false, notes: `running the cron command failed: ${run.stderr.trim()}` };
  }
  const after = await queueDepth(ctx);
  if (after === null) {
    return {
      name,
      passed: false,
      notes: `queue '${QUEUE}' does not exist after running the command — was it created?`,
    };
  }
  return {
    name,
    passed: after > before,
    notes: `queue depth ${before} -> ${after}`,
  };
}

/** Rows currently in the queue, or null if the queue table doesn't exist. */
async function queueDepth(ctx: LocalStackEvalContext): Promise<number | null> {
  // Querying a missing pgmq.q_<queue> throws "relation does not exist", which
  // is how we detect the agent never created the queue.
  const result = await ctx
    .query(`select count(*)::int as n from pgmq.q_${QUEUE}`)
    .catch(() => null);
  if (!result) return null;
  return Number(result.rows[0]?.n ?? 0);
}

async function checkFunctionDrains(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = `${FUNCTION} function drains the queue`;

  // Seed a message so there's something to drain regardless of cron timing.
  const send = await execSql(ctx, `select pgmq.send('${QUEUE}', '{"job":"process"}'::jsonb)`);
  if (!send.ok) {
    return {
      name,
      passed: false,
      notes: `couldn't enqueue a test message — is the '${QUEUE}' queue created? ${send.stderr.trim()}`,
    };
  }

  const status = await readStatus(ctx);
  const apiUrl = typeof status.API_URL === "string" ? status.API_URL : undefined;
  const serviceKey = typeof status.SERVICE_ROLE_KEY === "string" ? status.SERVICE_ROLE_KEY : undefined;
  const anonKey = typeof status.ANON_KEY === "string" ? status.ANON_KEY : serviceKey;
  if (!apiUrl || !serviceKey) {
    return { name, passed: false, notes: "missing API_URL/SERVICE_ROLE_KEY from `supabase status`" };
  }

  // Invoke as the service role, the way an internal worker would.
  const res = await fetch(`${apiUrl}/functions/v1/${FUNCTION}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: anonKey ?? serviceKey,
      "content-type": "application/json",
    },
    body: "{}",
  });
  const body = await res.text();
  if (!res.ok) {
    return { name, passed: false, notes: `HTTP ${res.status}: ${body.slice(0, 200)}` };
  }

  const verdict = await judge({
    input: `HTTP ${res.status} response body: ${body}`,
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
  return { name, passed: verdict.passed, judgeNotes: verdict.notes };
}

/** Parse `supabase status -o json` for the stack's URL and keys. */
async function readStatus(ctx: LocalStackEvalContext): Promise<Record<string, unknown>> {
  const res = await ctx.exec("supabase status -o json");
  const start = res.stdout.indexOf("{");
  const end = res.stdout.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error(`could not read \`supabase status\`: ${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout.slice(start, end + 1));
}
