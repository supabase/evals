import {
  type CheckResult,
  type CommandResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from "@supabase-evals/core";

const QUEUE = "tasks";
const FUNCTION = "process-tasks";
const JOB = "enqueue-tasks";
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const scorer: LocalStackScorer = async (ctx) => {
  try {
    const checks: CheckResult[] = [
      await checkCronJobScheduled(ctx),
      await checkCronCommandEnqueues(ctx),
      ...(await checkDrainAuthorization(ctx)),
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

/** Checks the enqueue-tasks cron job exists and is scheduled to run every minute. */
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
  const normalizedSchedule = schedule.trim().replace(/\s+/g, " ");
  const everyMinute =
    normalizedSchedule === "* * * * *" || normalizedSchedule === "*/1 * * * *";
  return {
    name,
    passed: active && everyMinute,
    notes: `schedule='${schedule}', active=${active}`,
  };
}

/** Runs the scheduled job's command and checks it enqueues a message to the tasks queue. */
async function checkCronCommandEnqueues(ctx: LocalStackEvalContext): Promise<CheckResult> {
  const name = `cron command enqueues to the '${QUEUE}' queue`;
  const { rows } = await ctx.query(`select command from cron.job where jobname = '${JOB}'`);
  if (rows.length === 0) {
    return { name, passed: false, notes: "job not found, so its command can't run" };
  }
  const command = String(rows[0]?.command ?? "");

  // The queue may not exist yet, since the agent's command may be what creates it.
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
      notes: `queue '${QUEUE}' does not exist after running the command. Was it created?`,
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

type DrainAttempt = { msgId: number; removed: boolean; status: number; body: string };

/**
 * Seeds one tracked message, invokes process-tasks with the given caller
 * credentials, and reports whether that message actually left the queue.
 * pgmq.read only hides a row for its visibility timeout, so the id is gone
 * only if the function popped or deleted it.
 */
async function invokeAndCheckRemoval(
  ctx: LocalStackEvalContext,
  apiUrl: string,
  bearer: string,
  apikey: string,
): Promise<DrainAttempt> {
  const { rows } = await ctx.query(
    `select pgmq.send('${QUEUE}', '{"job":"process"}'::jsonb) as msg_id`,
  );
  const msgId = Number(rows[0]?.msg_id);

  const res = await fetch(`${apiUrl}/functions/v1/${FUNCTION}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, apikey, "content-type": "application/json" },
    body: "{}",
  });
  const body = await res.text();

  const { rows: after } = await ctx.query(
    `select count(*)::int as n from pgmq.q_${QUEUE} where msg_id = ${msgId}`,
  );
  return { msgId, removed: Number(after[0]?.n ?? 0) === 0, status: res.status, body };
}

/**
 * Checks the internal-only contract: a service-role caller drains the queue,
 * but a public (anon) caller does not. One CheckResult for each.
 */
async function checkDrainAuthorization(ctx: LocalStackEvalContext): Promise<CheckResult[]> {
  const serviceName = `${FUNCTION} drains the queue for an internal (service role) caller`;
  const anonName = `${FUNCTION} does not drain for a public (anon) caller`;

  const status = await readStatus(ctx);
  const apiUrl = typeof status.API_URL === "string" ? status.API_URL : undefined;
  const serviceKey = typeof status.SERVICE_ROLE_KEY === "string" ? status.SERVICE_ROLE_KEY : undefined;
  const anonKey = typeof status.ANON_KEY === "string" ? status.ANON_KEY : undefined;
  if (!apiUrl || !serviceKey || !anonKey) {
    const notes = "missing API_URL/SERVICE_ROLE_KEY/ANON_KEY from `supabase status`";
    return [
      { name: serviceName, passed: false, notes },
      { name: anonName, passed: false, notes },
    ];
  }

  let service: DrainAttempt;
  try {
    service = await invokeAndCheckRemoval(ctx, apiUrl, serviceKey, anonKey);
  } catch (error) {
    const notes = `couldn't run the service-role drain. Is the '${QUEUE}' queue created? ${
      error instanceof Error ? error.message : String(error)
    }`;
    return [
      { name: serviceName, passed: false, notes },
      { name: anonName, passed: false, notes },
    ];
  }
  const serviceCheck: CheckResult = {
    name: serviceName,
    passed: service.removed,
    notes: service.removed
      ? `service-role invoke removed message ${service.msgId}`
      : `service-role invoke returned ${service.status}, message ${service.msgId} still queued: ${service.body.slice(0, 160)}`,
  };

  let anon: DrainAttempt;
  try {
    anon = await invokeAndCheckRemoval(ctx, apiUrl, anonKey, anonKey);
  } catch (error) {
    return [
      serviceCheck,
      { name: anonName, passed: false, notes: error instanceof Error ? error.message : String(error) },
    ];
  }
  const anonCheck: CheckResult = {
    name: anonName,
    passed: !anon.removed,
    notes: anon.removed
      ? `anon invoke drained message ${anon.msgId}, so the function is not internal-only`
      : `anon invoke left message ${anon.msgId} in the queue (status ${anon.status})`,
  };

  return [serviceCheck, anonCheck];
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
