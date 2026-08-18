/**
 * local-docs.ts — minimal local docs loop for `search_docs` evals.
 *
 *   pnpm docs:local up   --docs <path-to-supabase-monorepo-checkout>
 *   pnpm docs:local seed             # full embed via the docs app's own pipeline (~$0.12 OpenAI; asks first)
 *   pnpm docs:local api  [--port N]  # serve the content GraphQL API (foreground; keep it running)
 *   pnpm docs:local down
 *
 * Then point evals at it:
 *   pnpm eval -- --content-api http://127.0.0.1:3001/docs/api/graphql
 *
 * Design:
 * - The docs checkout is YOURS (`--docs`), cloned wherever you like — no
 *   submodule, no patches. Edit pages there, re-seed, re-run.
 * - The supabase stack runs from a generated workdir (.local-docs/) with its
 *   own project id and a port block off both the evals local-stack range
 *   (54321+) and the docs monorepo default, so it collides with neither.
 *   Files are COPIED, not symlinked (Windows-safe); `up` regenerates them.
 * - Minimal on purpose: full seed only. The upstream pipeline's incremental
 *   mode has known bugs we found while building the previous iteration
 *   (guide checksums never set -> guides always re-embed; a skipped source's
 *   still-valid rows get purged). Incremental lands here once those fixes
 *   land upstream in supabase/supabase.
 * - Some sources need production creds (e.g. DOCS_GITHUB_APP_* for
 *   lint-warnings); without them the upstream pipeline fails its run. Pass
 *   them through the environment if you have them.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..', '..');
const OVERLAY = join(ROOT, '.local-docs');
const PROJECT_ID = 'evals-local-docs';
const DB_CONTAINER = `supabase_db_${PROJECT_ID}`;
// stack ports: whatever block the checkout's config declares -> 443xx (off
// the evals local-stack range 54321-9, and below the macOS ephemeral range
// 49152+, where transient outbound sockets flakily steal listen ports)
const PORT_PREFIX_TO = '443';
const STACK_EXCLUDES =
  'realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor';

const onWindows = process.platform === 'win32';

type DocsOptions = { docs?: string; port?: string; yes?: boolean };

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/**
 * Run a command, streaming output; fails loudly on nonzero exit.
 *
 * `quiet` buffers instead of streaming, because the supabase CLI reports the
 * stack's ANON_KEY, PUBLISHABLE_KEY, SERVICE_ROLE_KEY, SECRET_KEY, and
 * JWT_SECRET on every start, plus an update-notifier nag. That buries our own
 * one-line status, and the keys are not something to leave on a screen
 * recording.
 *
 * On failure it replays stderr only. Measured against `supabase start`: the key
 * report goes to stdout (3 key lines there, 0 on stderr), while stderr carries
 * the diagnostics you actually want (workdir, config warnings, per-service
 * status). Dropping stdout is a stream boundary rather than a pattern match, so
 * there is no redaction regex to keep in step with the CLI's output shapes.
 */
function run(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    shim?: boolean;
    quiet?: boolean;
  } = {}
) {
  const res = spawnSync(cmd, args, {
    stdio: opts.quiet ? 'pipe' : 'inherit',
    encoding: opts.quiet ? 'utf8' : undefined,
    cwd: opts.cwd ?? ROOT,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    // .cmd shims (corepack, .bin/tsx) need a shell on Windows
    shell: opts.shim ? onWindows : false,
  });
  if (res.status !== 0) {
    if (opts.quiet && res.stderr) process.stderr.write(res.stderr);
    fail(`${cmd} ${args.join(' ')} failed (exit ${res.status})`);
  }
}

/**
 * Capture stdout. stderr is swallowed rather than inherited: the supabase CLI
 * writes its workdir line, deprecation warnings, stopped-service list, and
 * update-notifier nag there on every invocation, and this runs inside helpers
 * whose own output is one line. On failure execFileSync throws with the output
 * attached, so nothing is lost when it matters.
 */
function capture(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd: ROOT,
    maxBuffer: 1 << 24,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

function docsPath(docs: string | undefined): string {
  const marker = join(OVERLAY, 'docs-path.txt');
  let p =
    docs ??
    (existsSync(marker) ? readFileSync(marker, 'utf8').trim() : undefined);
  if (!p)
    fail(
      'no docs checkout configured — pass --docs <path-to-supabase-monorepo> (git clone https://github.com/supabase/supabase)'
    );
  p = isAbsolute(p) ? p : resolve(process.cwd(), p);
  if (!existsSync(join(p, 'apps', 'docs')))
    fail(`not a supabase monorepo checkout (apps/docs missing): ${p}`);
  return p;
}

/** Parse `supabase status -o env` output (KEY="value" lines). */
function stackEnv(): Record<string, string> {
  const out = capture('supabase', [
    'status',
    '--workdir',
    OVERLAY,
    '-o',
    'env',
  ]);
  const env: Record<string, string> = {};
  for (const m of out.matchAll(/^([A-Z_]+)="(.*)"$/gm)) env[m[1]] = m[2];
  if (!env.API_URL)
    fail('could not read the local stack env — is it up? (pnpm docs:local up)');
  return env;
}

function cmdUp(opts: DocsOptions) {
  const docs = docsPath(opts.docs);
  const src = join(docs, 'supabase');
  existsSync(join(src, 'config.toml')) ||
    fail(`no supabase/config.toml in the docs checkout: ${docs}`);

  // regenerate the overlay workdir: rewritten config + copied stack files
  rmSync(OVERLAY, { recursive: true, force: true });
  mkdirSync(join(OVERLAY, 'supabase'), { recursive: true });
  const config = readFileSync(join(src, 'config.toml'), 'utf8')
    .replace(/^project_id = ".*"$/m, `project_id = "${PROJECT_ID}"`)
    .replace(
      /^port = \d{3}(\d{2})$/gm,
      (_, tail) => `port = ${PORT_PREFIX_TO}${tail}`
    );
  writeFileSync(join(OVERLAY, 'supabase', 'config.toml'), config);
  for (const f of ['migrations', 'seed.sql', 'functions', 'buckets']) {
    const from = join(src, f);
    if (existsSync(from))
      cpSync(from, join(OVERLAY, 'supabase', f), {
        recursive: true,
        dereference: true,
      });
  }
  writeFileSync(join(OVERLAY, 'docs-path.txt'), `${docs}\n`);

  console.log(`starting the docs stack (project ${PROJECT_ID})...`);
  run('supabase', ['start', '--workdir', OVERLAY, '-x', STACK_EXCLUDES], {
    quiet: true,
  });
  // Upstream page migrations grant service_role no CRUD on the content
  // tables; the embedder authenticates as service_role and needs it.
  run(
    'docker',
    [
      'exec',
      DB_CONTAINER,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-q',
      '-c',
      'GRANT ALL ON public.page, public.page_section TO service_role; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role; GRANT SELECT ON public.page, public.page_section TO anon, authenticated;',
    ],
    { quiet: true }
  );
  console.log(
    `docs stack up on ${stackEnv().API_URL}; next: pnpm docs:local seed`
  );
}

async function cmdSeed(opts: DocsOptions) {
  const docs = docsPath(opts.docs);
  if (!process.env.OPENAI_API_KEY)
    fail('OPENAI_API_KEY not set — add it to .env at the repo root');
  const docsApp = join(docs, 'apps', 'docs');
  if (!existsSync(join(docsApp, 'node_modules'))) {
    fail(
      `docs app dependencies not installed — run:\n  corepack pnpm --dir ${docs} install --filter ./apps/docs...`
    );
  }
  const env = stackEnv();
  if (!opts.yes && !process.env.LOCAL_DOCS_YES) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await rl.question(
      "Full docs embed: ~1.2M tokens ≈ $0.12 OpenAI. Type 'seed' to proceed: "
    );
    rl.close();
    if (answer !== 'seed') fail('cancelled.');
  }
  run('corepack', ['pnpm', 'run', 'embeddings:refresh'], {
    cwd: docsApp,
    shim: true,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: env.API_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: env.PUBLISHABLE_KEY ?? env.ANON_KEY,
      SUPABASE_SECRET_KEY: env.SECRET_KEY ?? env.SERVICE_ROLE_KEY,
      // generate-embeddings.ts hard-requires these two before doing any work.
      // It builds its own client from NEXT_PUBLIC_SUPABASE_URL +
      // SUPABASE_SECRET_KEY, but sources/partner-integrations.ts reads the MISC
      // pair to pull partner data from the hosted "misc" project. Pointed at the
      // local stack they clear the gate; the partner source then finds no such
      // tables, which is the right trade for a local docs index.
      NEXT_PUBLIC_MISC_URL: env.API_URL,
      NEXT_PUBLIC_MISC_ANON_KEY: env.PUBLISHABLE_KEY ?? env.ANON_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      NODE_ENV: 'development',
    },
  });
  console.log(
    'seeded. next: pnpm docs:local api   (keep it running in a separate terminal)'
  );
}

function cmdApi(opts: DocsOptions) {
  const docs = docsPath(opts.docs);
  const docsApp = join(docs, 'apps', 'docs');
  const port = opts.port ?? '3001';
  const env = stackEnv();
  const tsx = join(
    docsApp,
    'node_modules',
    '.bin',
    onWindows ? 'tsx.cmd' : 'tsx'
  );
  if (!existsSync(tsx))
    fail(
      `tsx not installed in the docs app — run:\n  corepack pnpm --dir ${docs} install --filter ./apps/docs...`
    );
  const stub = join(__dirname, 'docs', 'sentry-stub-register.mjs');
  console.log(
    `serving on http://127.0.0.1:${port}/docs/api/graphql — point evals at it with --content-api`
  );
  // Runs with the DOCS app's tsx + tsconfig so the route's TS and its
  // `react-server` condition resolve; the Sentry stub no-ops the route's
  // telemetry (the real package crashes outside Next's instrumentation).
  run(
    tsx,
    [
      '--conditions=react-server',
      '--tsconfig',
      'tsconfig.json',
      join(__dirname, 'docs', 'content-api-server.ts'),
    ],
    {
      cwd: docsApp,
      shim: true,
      env: {
        NODE_ENV: 'development',
        PORT: port,
        DOCS_ROUTE_PATH: join(docsApp, 'app', 'api', 'graphql', 'route.ts'),
        NEXT_PUBLIC_SUPABASE_URL: env.API_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: env.PUBLISHABLE_KEY ?? env.ANON_KEY,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        NODE_OPTIONS: `--import ${stub}${process.env.NODE_OPTIONS ? ` ${process.env.NODE_OPTIONS}` : ''}`,
      },
    }
  );
}

export async function main(argv: string[]) {
  const usage =
    'usage: pnpm docs:local <up|seed|api|down> [--docs <path>] [--port N] [--yes]';
  const parsed = (() => {
    try {
      return parseArgs({
        args: argv,
        options: {
          docs: { type: 'string' },
          port: { type: 'string' },
          yes: { type: 'boolean' },
        },
        allowPositionals: true,
      });
    } catch (err) {
      fail(`${err instanceof Error ? err.message : String(err)}\n${usage}`);
    }
  })();
  const { values } = parsed;
  switch (parsed.positionals[0]) {
    case 'up':
      cmdUp(values);
      break;
    case 'seed':
      await cmdSeed(values);
      break;
    case 'api':
      cmdApi(values);
      break;
    case 'down':
      run('supabase', ['stop', '--workdir', OVERLAY], { quiet: true });
      console.log(
        `docs stack stopped (project ${PROJECT_ID}); the seeded index stays in its docker volume`
      );
      break;
    default:
      fail(usage);
  }
}

await main(process.argv.slice(2));
