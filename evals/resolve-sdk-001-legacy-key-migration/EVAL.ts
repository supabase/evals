import {
  type CheckResult,
  type CommandResult,
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
    const install = await ctx.exec(
      `cd ${APP_DIR} && [ -d node_modules ] || npm install --no-audit --no-fund --silent`,
      { timeoutMs: 180_000 }
    );
    if (!install.ok) {
      return fail(
        'installed app dependencies',
        install.stderr.trim() || install.stdout.trim()
      );
    }

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

    // 5. Prove both scripts actually depend on the keys, not just that their
    // output happens to match: corrupt the live key value on disk and
    // confirm the same script now breaks. Without this, a stub that already
    // knows the expected titles/count — with no real Supabase call at all —
    // would pass checks 1-4 for free.
    checks.push(
      await keyDependencyCheck(ctx, 'posts', publishableKey, 'publishable key')
    );
    checks.push(
      await keyDependencyCheck(ctx, 'stats', secretKey, 'secret key')
    );

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

/**
 * Corrupts the on-disk copy of `keyValue` (in `.env`, or in the script's
 * source if it's hardcoded there instead) and re-runs the given npm script,
 * expecting it to break — proving the script reads the key at call time
 * rather than being hardcoded or key-agnostic. Restores the original
 * content afterward either way.
 */
async function keyDependencyCheck(
  ctx: LocalStackEvalContext,
  script: 'posts' | 'stats',
  keyValue: string,
  label: string
): Promise<CheckResult> {
  const NAME = `${script} script actually depends on its ${label}`;
  const envPath = `${APP_DIR}/.env`;
  const entry = await resolveScriptEntry(ctx, script);
  const entryPath = `${APP_DIR}/${entry}`;

  const env = await ctx.readFile(envPath).catch(() => undefined);
  const targetPath = env?.includes(keyValue)
    ? envPath
    : await ctx
        .readFile(entryPath)
        .then((source) => (source.includes(keyValue) ? entryPath : undefined))
        .catch(() => undefined);
  if (targetPath === undefined) {
    return {
      name: NAME,
      passed: false,
      notes: `could not find the live ${label} on disk (checked ${envPath} and ${entryPath}) to corrupt`,
    };
  }

  const original = await ctx.readFile(targetPath);
  const corrupted = original.replaceAll(
    keyValue,
    `${keyValue}-corrupted-by-eval`
  );
  await writeFile(ctx, targetPath, corrupted);
  const run = await ctx
    .exec(`cd ${APP_DIR} && npm run -s ${script}`, { timeoutMs: 60_000 })
    .finally(() => writeFile(ctx, targetPath, original));

  const stillLooksValid =
    script === 'posts'
      ? parseJson(run.stdout, '[', ']') !== undefined
      : (parseJson(run.stdout, '{', '}') as { drafts?: unknown } | undefined)
          ?.drafts !== undefined;
  return {
    name: NAME,
    passed: !run.ok || !stillLooksValid,
    notes:
      !run.ok || !stillLooksValid
        ? `broke as expected with a corrupted ${label}`
        : `still produced ${preview(run.stdout)} with a corrupted ${label} — looks hardcoded or key-agnostic`,
  };
}

function writeFile(
  ctx: LocalStackEvalContext,
  path: string,
  content: string
): Promise<CommandResult> {
  const encoded = Buffer.from(content, 'utf-8').toString('base64');
  return ctx.exec(`echo ${encoded} | base64 -d > ${path}`);
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
