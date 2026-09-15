import {
  type CheckResult,
  type CommandResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

// Dual-auth Edge Function benchmark: the prompt is a requirements-only ticket
// that never names @supabase/server, yet the "uses @supabase/server" check is
// GATING — a correct-but-hand-rolled solution fails. This measures whether
// agents *discover* the package the SDK team wants them to reach for, on top
// of getting the user-JWT vs service-key security boundary right. Its sibling
// build-functions-006 (suite: regression) names the package in the prompt and
// guards the "can use it when pointed at it" property instead.
const FUNCTION = 'user-stats';
const DEFAULT_DB_URL =
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

interface InvokeResult {
  status: number;
  ok: boolean;
  body: string;
}

const scorer: LocalStackScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    // A unique suffix keeps the seeded metric names distinct so substring
    // matching on the function's JSON response is unambiguous, and keeps the
    // signup emails collision-free across attempts.
    const suffix = Date.now().toString(36);
    const aMetric = `steps_a_${suffix}`;
    const bMetric = `steps_b_${suffix}`;

    const status = await readStatus(ctx);
    const apiUrl = str(status.API_URL);
    // @supabase/server validates against the *new* API keys only (it rejects the
    // legacy service_role/anon JWTs), so this eval drives it with the new keys:
    // sb_secret_… for the service path, sb_publishable_… for the user/negative
    // paths. This is why the eval pins a CLI new enough to expose them and to
    // inject SUPABASE_SECRET_KEYS/PUBLISHABLE_KEYS/JWKS into the edge runtime.
    const secretKey = str(status.SECRET_KEY);
    const publishableKey = str(status.PUBLISHABLE_KEY);
    const dbUrl = str(status.DB_URL) ?? DEFAULT_DB_URL;
    if (!apiUrl || !secretKey || !publishableKey) {
      return fail(
        'read stack config from `supabase status`',
        `missing API_URL/SECRET_KEY/PUBLISHABLE_KEY — new API keys are required for @supabase/server; is the stack running on a new-enough CLI? got keys: ${Object.keys(status).join(', ')}`
      );
    }

    // Two independent users via the publishable-key client (getClient is async
    // and returns a fresh client each call on the local stack).
    const clientA = await ctx.getClient();
    const clientB = await ctx.getClient();
    const { data: authA, error: errA } = await clientA.auth.signUp({
      email: `dual-a-${suffix}@example.com`,
      password: 'secret123',
    });
    const { data: authB, error: errB } = await clientB.auth.signUp({
      email: `dual-b-${suffix}@example.com`,
      password: 'secret123',
    });
    if (
      errA ||
      errB ||
      !authA.user?.id ||
      !authA.session?.access_token ||
      !authB.user?.id ||
      !authB.session?.access_token
    ) {
      return fail(
        'created two authenticated users',
        errA?.message ?? errB?.message ?? 'missing user id or session'
      );
    }
    const aId = authA.user.id;
    const bId = authB.user.id;
    const aToken = authA.session.access_token;

    // Seed one row per user. INSERT must go through raw psql: the local-stack
    // ctx.query wraps SQL as a SELECT subquery and rejects non-SELECT.
    const seed = await execSql(
      ctx,
      dbUrl,
      `insert into public.user_stats (user_id, metric, value) values ` +
        `('${aId}', '${aMetric}', 111), ('${bId}', '${bMetric}', 222);`
    );
    if (!seed.ok) {
      return fail(
        'seeded user_stats rows',
        seed.stderr.trim() || seed.stdout.trim()
      );
    }

    const { rows: seedRows } = await ctx.query(
      `select count(*)::int as n from public.user_stats where metric in ('${aMetric}', '${bMetric}')`
    );
    checks.push({
      name: 'seed rows present',
      passed: Number(seedRows[0]?.n ?? 0) === 2,
      notes: `found ${seedRows[0]?.n ?? 0}/2 seeded rows`,
    });

    const invoke = (
      headers: Record<string, string>,
      body: Record<string, unknown>
    ): Promise<InvokeResult> => invokeFn(apiUrl, headers, body);

    // 1. No credentials at all → must be rejected, and must not leak any rows.
    const noCred = await invoke({}, {});
    checks.push({
      name: 'rejects request with no credentials',
      passed: !noCred.ok && !leaks(noCred.body, aMetric, bMetric),
      notes: `status ${noCred.status}: ${preview(noCred.body)}`,
    });

    // 2. User path: A's JWT → only A's rows (RLS in force). Real clients also
    // send an apikey to route through the gateway.
    const aOwn = await invoke(
      { authorization: `Bearer ${aToken}`, apikey: publishableKey },
      {}
    );
    checks.push({
      name: 'user with JWT reads only their own rows',
      passed:
        aOwn.ok && aOwn.body.includes(aMetric) && !aOwn.body.includes(bMetric),
      notes: `status ${aOwn.status}: ${preview(aOwn.body)}`,
    });

    // 3. User path cannot escalate: A asks for B via body → still only A's rows.
    const aEscalate = await invoke(
      { authorization: `Bearer ${aToken}`, apikey: publishableKey },
      { user_id: bId }
    );
    checks.push({
      name: "user cannot read another user's rows by passing user_id",
      passed:
        aEscalate.ok &&
        aEscalate.body.includes(aMetric) &&
        !aEscalate.body.includes(bMetric),
      notes: `status ${aEscalate.status}: ${preview(aEscalate.body)}`,
    });

    // 4. Service path: service-role secret key in apikey + target user_id in
    // body → returns that user's rows, bypassing RLS.
    const service = await invoke({ apikey: secretKey }, { user_id: bId });
    checks.push({
      name: "service key bypasses RLS to read the target user's rows",
      passed: service.ok && service.body.includes(bMetric),
      notes: `status ${service.status}: ${preview(service.body)}`,
    });

    // 5. Non-service key must NOT be granted service access: a bare client key
    // with no user JWT must not return another user's rows.
    const anonService = await invoke(
      { apikey: publishableKey },
      { user_id: bId }
    );
    checks.push({
      name: 'non-service key is not granted service access',
      passed: !anonService.body.includes(bMetric),
      notes: `status ${anonService.status}: ${preview(anonService.body)}`,
    });

    // 6. Unverified token: a forged, unsigned (alg:none) JWT claiming to be user
    // B must never return B's rows. Once the function turns off the platform's
    // JWT verification (which it must, for the service path), verifying the user
    // token becomes the function's own job — an implementation that decodes the
    // JWT without checking its signature would trust the forged `sub`.
    const forged = await invoke(
      {
        authorization: `Bearer ${forgeUnsignedToken(bId)}`,
        apikey: publishableKey,
      },
      {}
    );
    checks.push({
      name: 'rejects an unverified (forged) user token',
      passed: !leaks(forged.body, aMetric, bMetric),
      notes: `status ${forged.status}: ${preview(forged.body)}`,
    });

    // 7. Service access requires the actual service key, not merely some
    // credential in the apikey slot: user A's own JWT placed in `apikey` (with
    // no service key and no user JWT on the Authorization header) must not be
    // mistaken for the service key and granted RLS-bypassing access to user B.
    const apikeyEscalate = await invoke({ apikey: aToken }, { user_id: bId });
    checks.push({
      name: 'a user token in the apikey slot is not treated as the service key',
      passed: !apikeyEscalate.body.includes(bMetric),
      notes: `status ${apikeyEscalate.status}: ${preview(apikeyEscalate.body)}`,
    });

    // 8. GATING: the function must actually be built with @supabase/server,
    // even though the prompt never names it — a hand-rolled solution fails
    // this eval even if it behaves correctly.
    checks.push(await serverUsageCheck(ctx));

    return { passed: checks.every((c) => c.passed), checks };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    checks.push({
      name: 'scorer completed without errors',
      passed: false,
      notes: msg,
    });
    return { passed: false, checks };
  }
};

export default scorer;

function leaks(body: string, aMetric: string, bMetric: string): boolean {
  return body.includes(aMetric) || body.includes(bMetric);
}

/**
 * Build an unsigned (`alg: none`) JWT that claims to be the given user. Any
 * correct verifier rejects it (no signature); a decode-only implementation
 * would trust the `sub` claim and leak that user's rows.
 */
function forgeUnsignedToken(userId: string): string {
  const enc = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = enc({ alg: 'none', typ: 'JWT' });
  const payload = enc({
    sub: userId,
    role: 'authenticated',
    aud: 'authenticated',
    iat: now,
    exp: now + 3600,
  });
  return `${header}.${payload}.`;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function preview(body: string): string {
  return body.replace(/\s+/g, ' ').slice(0, 160);
}

function fail(
  name: string,
  notes: string
): { passed: false; checks: CheckResult[] } {
  return { passed: false, checks: [{ name, passed: false, notes }] };
}

async function invokeFn(
  apiUrl: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<InvokeResult> {
  const res = await fetch(`${apiUrl}/functions/v1/${FUNCTION}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, ok: res.ok, body: await res.text() };
}

/** Run arbitrary SQL as the postgres superuser via base64 -> psql. */
async function execSql(
  ctx: LocalStackEvalContext,
  dbUrl: string,
  sql: string
): Promise<CommandResult> {
  const encoded = Buffer.from(sql, 'utf-8').toString('base64');
  return ctx.exec(
    `echo ${encoded} | base64 -d | psql "${dbUrl}" -v ON_ERROR_STOP=1 -tA`
  );
}

/** Parse `supabase status -o json` for the stack's URL and keys. */
async function readStatus(
  ctx: LocalStackEvalContext
): Promise<Record<string, unknown>> {
  const res = await ctx.exec('supabase status -o json');
  const start = res.stdout.indexOf('{');
  const end = res.stdout.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(
      `could not read \`supabase status\`: ${res.stderr || res.stdout}`
    );
  }
  return JSON.parse(res.stdout.slice(start, end + 1));
}

/**
 * GATING: the deployed function must genuinely be built with @supabase/server.
 * We look for a real import of / call into the package, not a mention in a
 * comment (a raw-supabase-js solution may name it in passing).
 */
async function serverUsageCheck(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const NAME = 'implementation uses @supabase/server';
  const candidates = [
    `supabase/functions/${FUNCTION}/index.ts`,
    `supabase/functions/${FUNCTION}/index.tsx`,
  ];
  for (const path of candidates) {
    if (await ctx.fileExists(path)) {
      const src = await ctx.readFile(path).catch(() => '');
      const uses =
        /\bwithSupabase\s*\(/.test(src) ||
        /(?:from|import)\s*\(?\s*['"](?:npm:|jsr:)?@supabase\/server['"]/.test(
          src
        );
      return {
        name: NAME,
        passed: uses,
        notes: uses
          ? 'imports @supabase/server / withSupabase'
          : 'hand-rolled (raw supabase-js or other) — this eval requires @supabase/server',
      };
    }
  }
  return {
    name: NAME,
    passed: false,
    notes: 'could not locate function source to inspect',
  };
}
