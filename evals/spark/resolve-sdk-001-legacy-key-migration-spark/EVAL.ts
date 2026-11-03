import { isRecord } from '@supabase-evals/core/json';
import {
  type CheckResult,
  type CommandResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
} from '@supabase-evals/core';

// Check key replacement, script behavior and the frontend/backend key boundary.

const APP_DIR = 'app';

// Header+payload prefix shared by both legacy local demo JWTs
// ({"iss":"supabase-demo",…} signed with the default local JWT secret) —
// matching on it catches either key regardless of the signature bytes.
const LEGACY_JWT_MARKER = 'eyJpc3MiOiJzdXBhYmFzZS1kZW1vIi';

const scorer: LocalStackScorer = async (ctx) => {
  const checks: CheckResult[] = [];
  try {
    const status = await ctx.stackStatus();
    const apiUrl = str(status.apiUrl);
    const publishableKey = str(status.publishableKey);
    const secretKey = str(status.secretKey);
    if (!apiUrl || !publishableKey || !secretKey) {
      return fail(
        'read stack config from `supabase status`',
        `missing API_URL/PUBLISHABLE_KEY/SECRET_KEY. is the stack running on a new-enough CLI? got keys: ${Object.keys(status).join(', ')}`
      );
    }

    // Install dependencies if the agent omitted the install step.
    const install = await ctx.exec(
      `cd ${APP_DIR} && npm install --no-audit --no-fund --silent`,
      { timeoutMs: 180_000 }
    );
    if (!install.ok) {
      return fail(
        'installed app dependencies',
        install.stderr.trim() || install.stdout.trim()
      );
    }

    const { rows: publishedRows } = await ctx.query(
      `select title from public.posts where published order by title asc`
    );
    const expectedTitles = publishedRows.map((row) => row.title);
    const { rows: draftRows } = await ctx.query(
      `select count(*)::int as n from public.posts where not published`
    );
    const expectedDrafts = Number(draftRows[0]?.n ?? -1);

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
        : `no JSON output. ${preview(posts.stderr || posts.stdout)}`,
    });

    const stats = await ctx.exec(`cd ${APP_DIR} && npm run -s stats`, {
      timeoutMs: 60_000,
    });
    const statsOut = parseStats(stats.stdout);
    checks.push({
      name: 'stats script still counts drafts using the new key',
      passed: statsOut?.drafts === expectedDrafts,
      notes: statsOut
        ? `got ${JSON.stringify(statsOut)}, expected ${expectedDrafts} drafts`
        : `no JSON output. ${preview(stats.stderr || stats.stdout)}`,
    });

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

    checks.push(await publicScriptKeyCheck(ctx));

    // Corrupt the URL on disk to reject hardcoded output.
    checks.push(
      await networkDependencyCheck(ctx, 'posts', apiUrl, (run) => {
        const titles = parseJson(run.stdout, '[', ']');
        return (
          JSON.stringify(titles ?? null) === JSON.stringify(expectedTitles)
        );
      })
    );
    checks.push(
      await networkDependencyCheck(ctx, 'stats', apiUrl, (run) => {
        const out = parseStats(run.stdout);
        return out?.drafts === expectedDrafts;
      })
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

// Temporarily replace the project URL in all app files.
// A real request must fail or stop returning the expected data.
async function networkDependencyCheck(
  ctx: LocalStackEvalContext,
  script: 'posts' | 'stats',
  url: string,
  stillMatchesExpected: (run: CommandResult) => boolean
): Promise<CheckResult> {
  const NAME = `${script} script actually calls the project (not a stub)`;
  const targets = await findFilesContaining(ctx, url);
  if (targets.length === 0) {
    return {
      name: NAME,
      passed: false,
      notes: `could not find the live project URL on disk under ${APP_DIR} to corrupt`,
    };
  }

  const originals = new Map<string, string>(
    await Promise.all(
      targets.map(
        async (path): Promise<[string, string]> => [
          path,
          await ctx.readFile(path),
        ]
      )
    )
  );
  const restoreAll = () =>
    Promise.all(
      targets.map((path) => writeFile(ctx, path, originals.get(path)!))
    );

  const corruptions = await Promise.all(
    targets.map((path) =>
      writeFile(ctx, path, originals.get(path)!.replaceAll(url, BROKEN_URL))
    )
  );
  const failedWrite = corruptions.find((result) => !result.ok);
  if (failedWrite) {
    await restoreAll();
    return {
      name: NAME,
      passed: false,
      notes: `could not corrupt the project URL for this check: ${failedWrite.stderr.trim() || failedWrite.stdout.trim()}`,
    };
  }

  const run = await ctx
    .exec(`cd ${APP_DIR} && npm run -s ${script}`, { timeoutMs: 60_000 })
    .finally(restoreAll);

  const stillCorrect = run.ok && stillMatchesExpected(run);
  return {
    name: NAME,
    passed: !stillCorrect,
    notes: stillCorrect
      ? `still produced ${preview(run.stdout)} against an unreachable project URL. looks hardcoded or not actually calling Supabase`
      : 'broke as expected against an unreachable project URL',
  };
}

const BROKEN_URL = 'http://127.0.0.1:1';

async function findFilesContaining(
  ctx: LocalStackEvalContext,
  value: string
): Promise<string[]> {
  const scan = await ctx.exec(
    `grep -rlF --exclude-dir=node_modules -- '${value}' ${APP_DIR} || true`
  );
  return scan.stdout.trim().split('\n').filter(Boolean);
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
    const pkg: unknown = JSON.parse(
      await ctx.readFile(`${APP_DIR}/package.json`)
    );
    const scripts = isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts : {};
    const command = typeof scripts[script] === 'string' ? scripts[script] : '';
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
    .flatMap((line): Array<[string, string]> => {
      const eq = line.indexOf('=');
      if (eq === -1) return [];
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      return [[line.slice(0, eq).trim(), value]];
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

function parseStats(stdout: string) {
  const value = parseJson(stdout, '{', '}');
  return isRecord(value) ? value : undefined;
}
