import {
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

// Legacy → new API key migration (regression): the seeded app authenticates
// with the local stack's legacy demo JWTs (anon + service_role) and works
// out of the box; the task is to move it to the new sb_publishable_… /
// sb_secret_… keys without breaking it. Scored on behavior (both scripts
// still print the right data — the stats script's RLS-bypassing count only
// works with a genuine secret key), on the legacy JWTs being gone, and on
// the key boundary staying intact (the public script must not end up holding
// the secret key).

const APP_DIR = 'app';

// Header+payload prefix shared by both legacy local demo JWTs
// ({"iss":"supabase-demo",…} signed with the default local JWT secret) —
// matching on it catches either key regardless of the signature bytes.
const LEGACY_JWT_MARKER = 'eyJpc3MiOiJzdXBhYmFzZS1kZW1vIi';

const scorer: LocalStackScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    const status = await readStatus(ctx);
    const publishableKey = str(status.PUBLISHABLE_KEY);
    const secretKey = str(status.SECRET_KEY);
    if (!publishableKey || !secretKey) {
      return fail(
        'read stack config from `supabase status`',
        `missing PUBLISHABLE_KEY/SECRET_KEY — is the stack running on a new-enough CLI? got keys: ${Object.keys(status).join(', ')}`
      );
    }

    // Be generous about a missing install step; the eval is about the keys,
    // not npm. A no-op when the agent already installed dependencies.
    await ctx.exec(
      `cd ${APP_DIR} && [ -d node_modules ] || npm install --no-audit --no-fund --silent || true`,
      { timeoutMs: 180_000 }
    );

    // Ground truth from the seeded database.
    const { rows: publishedRows } = await ctx.query(
      `select title from public.posts where published order by title asc`
    );
    const expectedTitles = publishedRows.map((row) => row.title);
    const { rows: draftRows } = await ctx.query(
      `select count(*)::int as n from public.posts where not published`
    );
    const expectedDrafts = Number(draftRows[0]?.n ?? -1);

    // 1. The public script still lists published posts (client-key path).
    const posts = await ctx.exec(`cd ${APP_DIR} && npm run -s posts`, {
      timeoutMs: 60_000,
    });
    const postTitles = parseJson(posts.stdout, '[', ']');
    checks.push({
      name: 'posts script still lists published posts',
      passed:
        JSON.stringify(postTitles ?? null) === JSON.stringify(expectedTitles),
      notes: postTitles
        ? `got ${JSON.stringify(postTitles)}`
        : `no JSON output — ${preview(posts.stderr || posts.stdout)}`,
    });

    // 2. The internal script still counts drafts. Drafts are invisible to the
    // publishable key (RLS), so a correct count proves a working secret key.
    const stats = await ctx.exec(`cd ${APP_DIR} && npm run -s stats`, {
      timeoutMs: 60_000,
    });
    const statsOut = parseJson(stats.stdout, '{', '}') as
      | { drafts?: unknown }
      | undefined;
    checks.push({
      name: 'stats script still counts drafts (secret key bypasses RLS)',
      passed: statsOut?.drafts === expectedDrafts,
      notes: statsOut
        ? `got ${JSON.stringify(statsOut)}, expected ${expectedDrafts} drafts`
        : `no JSON output — ${preview(stats.stderr || stats.stdout)}`,
    });

    // 3. The legacy JWTs are gone from the app (env files included).
    const legacyScan = await ctx.exec(
      `grep -rl --exclude-dir=node_modules '${LEGACY_JWT_MARKER}' ${APP_DIR} || true`
    );
    checks.push({
      name: 'legacy anon/service_role JWTs removed from the app',
      passed: legacyScan.stdout.trim() === '',
      notes:
        legacyScan.stdout.trim().replace(/\s+/g, ', ') ||
        'no legacy JWTs found',
    });

    // 4. Key boundary intact: the public script must not hold the secret key,
    // neither as a literal nor via an env var that resolves to it.
    checks.push(await publicScriptKeyCheck(ctx));

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

/**
 * The public (posts) script must not use the secret key: no sb_secret_
 * literal in its source, and no reference to an env var whose value in .env
 * is a secret key.
 */
async function publicScriptKeyCheck(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const NAME = 'public script does not hold the secret key';
  const entry = await resolveScriptEntry(ctx, 'posts');
  const source = await ctx
    .readFile(`${APP_DIR}/${entry}`)
    .catch(() => undefined);
  if (source === undefined) {
    return {
      name: NAME,
      passed: false,
      notes: `could not read ${APP_DIR}/${entry} to inspect`,
    };
  }
  if (source.includes('sb_secret_')) {
    return {
      name: NAME,
      passed: false,
      notes: `${entry} contains an sb_secret_ literal`,
    };
  }
  const env = await ctx.readFile(`${APP_DIR}/.env`).catch(() => '');
  const secretVars = parseEnv(env)
    .filter(([, value]) => value.startsWith('sb_secret_'))
    .map(([key]) => key);
  const leaked = secretVars.filter((name) => source.includes(name));
  return {
    name: NAME,
    passed: leaked.length === 0,
    notes: leaked.length
      ? `${entry} references secret-key env var(s): ${leaked.join(', ')}`
      : `${entry} holds no secret-key reference`,
  };
}

/** File the given npm script runs, e.g. `posts` → `posts.mjs`. */
async function resolveScriptEntry(
  ctx: LocalStackEvalContext,
  script: string
): Promise<string> {
  const fallback = `${script}.mjs`;
  try {
    const pkg = JSON.parse(await ctx.readFile(`${APP_DIR}/package.json`)) as {
      scripts?: Record<string, string>;
    };
    const command = pkg.scripts?.[script] ?? '';
    return command.match(/[\w./-]+\.(?:mjs|cjs|js|ts)/)?.[0] ?? fallback;
  } catch {
    return fallback;
  }
}

function parseEnv(content: string): Array<[string, string]> {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .flatMap((line) => {
      const eq = line.indexOf('=');
      if (eq === -1) return [];
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      return [[line.slice(0, eq).trim(), value] as [string, string]];
    });
}

function parseJson(
  stdout: string,
  open: string,
  close: string
): unknown | undefined {
  const start = stdout.indexOf(open);
  const end = stdout.lastIndexOf(close);
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return undefined;
  }
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
