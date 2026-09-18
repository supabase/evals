import type {
  CheckResult,
  CommandResult,
  LocalStackEvalContext,
  LocalStackScorer,
  ToolCallRecord,
} from '@supabase-evals/core';

/**
 * The worktree → table mapping the prompt asks for. Each table must exist in
 * exactly one stack: its home worktree's.
 */
export const WORKTREE_TABLES: ReadonlyArray<{
  worktree: string;
  table: string;
}> = [
  { worktree: 'feature-a', table: 'widgets' },
  { worktree: 'feature-b', table: 'gadgets' },
  { worktree: 'feature-c', table: 'gizmos' },
];

const MIN_SEEDED_ROWS = 1;

// Written by experiments/_lib/docker-aware-local-stack.ts; absent on the
// stock pinned runtime. Only the fields this scorer reads are typed here.
const RUNTIME_MARKER_PATH = '/tmp/supabase-eval-runtime.json';
type RuntimeMarker = {
  channel?: string;
  cliVersion?: string;
  sessionStartedMs?: number;
};

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in scoring.test.ts)
// ---------------------------------------------------------------------------

export type WorktreeEntry = {
  path: string;
  /** Full symbolic ref (`refs/heads/x`), absent when detached or bare. */
  branch?: string;
  detached: boolean;
  bare: boolean;
};

/** Parse `git worktree list --porcelain` into one entry per worktree. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const rawLine of porcelain.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('worktree ')) {
      current = {
        path: line.slice('worktree '.length),
        detached: false,
        bare: false,
      };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    }
  }
  return entries;
}

/**
 * Match the expected worktree names against a repo's worktree list by path
 * basename, and require each to be on its own branch. Returns the matched
 * entries plus a list of human-readable problems (empty when everything
 * lines up).
 */
export function matchWorktrees(
  entries: readonly WorktreeEntry[],
  names: readonly string[]
): {
  matched: Record<string, WorktreeEntry | undefined>;
  problems: string[];
} {
  const matched: Record<string, WorktreeEntry | undefined> = {};
  const problems: string[] = [];
  for (const name of names) {
    const entry = entries.find((e) => basename(e.path) === name);
    matched[name] = entry;
    if (!entry) {
      problems.push(`no worktree named ${name}`);
    } else if (entry.bare) {
      problems.push(`${name} is a bare worktree`);
    } else if (entry.detached || !entry.branch) {
      problems.push(`${name} is not checked out on a branch`);
    }
  }
  const branches = names
    .map((name) => matched[name]?.branch)
    .filter((b): b is string => typeof b === 'string');
  const duplicates = branches.filter((b, i) => branches.indexOf(b) !== i);
  for (const dup of new Set(duplicates)) {
    problems.push(`more than one worktree is on ${dup}`);
  }
  return { matched, problems };
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/**
 * Pull the first `{ … }` JSON object out of command output. The CLI prints
 * `[task] …` progress lines around its JSON in `--output-format json` mode,
 * so a plain `JSON.parse(stdout)` is not enough.
 */
export function parseJsonObject(
  stdout: string
): Record<string, unknown> | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `host:port` of a Postgres connection URL — the part that tells two stacks
 * apart. Credentials and database name are ignored on purpose.
 */
export function endpointKey(dbUrl: string): string | undefined {
  try {
    const url = new URL(dbUrl);
    if (!url.hostname) return undefined;
    return `${url.hostname}:${url.port || '5432'}`;
  } catch {
    return undefined;
  }
}

/** Whether the SQL contains a `create table` for `public.<table>` (or bare `<table>`). */
export function migrationCreatesTable(sql: string, table: string): boolean {
  const pattern = new RegExp(
    `create\\s+table\\s+(if\\s+not\\s+exists\\s+)?("?public"?\\.)?"?${table}"?\\b`,
    'i'
  );
  return pattern.test(sql);
}

/** Count `supabase start` / `supabase stack start` invocations across the agent's commands. */
export function countSupabaseStarts(commands: readonly string[]): number {
  let count = 0;
  for (const command of commands) {
    const matches = command.match(/\bsupabase\s+(?:stack\s+)?start\b/g);
    count += matches?.length ?? 0;
  }
  return count;
}

export function extractCommands(
  toolCalls: readonly ToolCallRecord[]
): string[] {
  return toolCalls
    .map(
      (record) => record.command ?? String((record.body as any)?.command ?? '')
    )
    .filter((command) => command.length > 0);
}

/**
 * Directory that owns a `.git` entry reported by `find` (`./repo/.git` →
 * `./repo`, `./.git` → `.`). Works for both `.git` directories (the main
 * worktree) and `.git` files (linked worktrees), since either one lets
 * `git worktree list` enumerate every worktree of the repo.
 */
export function repoDirFromGitEntry(gitEntry: string): string {
  const trimmed = gitEntry.trim().replace(/\/+$/, '');
  if (trimmed === '.git') return '.';
  const parent = trimmed.replace(/\/\.git$/, '');
  return parent.length > 0 ? parent : '.';
}

// ---------------------------------------------------------------------------
// Sandbox-side helpers
// ---------------------------------------------------------------------------

type StackHandle = {
  worktree: string;
  dir: string;
  /** Which CLI backend answered: the managed stack or the legacy Docker path. */
  backend: 'managed' | 'legacy';
  dbUrl: string;
  runtime: 'native' | 'docker' | 'unknown';
};

type StackResolution =
  | { ok: true; stack: StackHandle }
  | { ok: false; worktree: string; dir: string; notes: string };

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Run `command` with `dir` as the working directory. */
function inDir(dir: string, command: string): string {
  return `cd ${shellQuote(dir)} && ${command}`;
}

/**
 * Locate a worktree directory by name, up to three levels below the workspace
 * (the agent may have created the repo at the root or in a subfolder).
 */
async function findWorktreeDir(
  ctx: LocalStackEvalContext,
  name: string
): Promise<string | undefined> {
  const result = await ctx.exec(
    `find . -mindepth 1 -maxdepth 3 -type d -name ${shellQuote(name)} -not -path '*/node_modules/*' -not -path '*/.git/*' | head -n 1`
  );
  const relative = result.stdout.trim();
  if (!result.ok || !relative) return undefined;
  const absolute = await ctx.exec(`readlink -f ${shellQuote(relative)}`);
  return absolute.ok ? absolute.stdout.trim() || undefined : undefined;
}

/**
 * Locate a git repository within the workspace (the main worktree's `.git`
 * directory or a linked worktree's `.git` file). Either lets
 * `git worktree list` report every worktree of that repo by absolute path,
 * wherever the agent put them — including outside the workspace.
 */
async function findRepoDir(
  ctx: LocalStackEvalContext
): Promise<string | undefined> {
  const result = await ctx.exec(
    "find . -mindepth 1 -maxdepth 4 \\( -type d -o -type f \\) -name .git -not -path '*/node_modules/*' -not -path '*/.agents/*' -not -path '*/.claude/*' -not -path '*/.codex/*' | head -n 1"
  );
  const hit = result.stdout.trim();
  if (!result.ok || !hit) return undefined;
  const absolute = await ctx.exec(
    `readlink -f ${shellQuote(repoDirFromGitEntry(hit))}`
  );
  return absolute.ok ? absolute.stdout.trim() || undefined : undefined;
}

/**
 * Resolve the stack serving a worktree, whichever CLI backend the agent used.
 *
 * The managed stack (`SUPABASE_EXPERIMENTAL_STACK=1`) is asked first because
 * it rejects the legacy `-o json` flag outright, and the legacy backend is
 * asked second because it has no idea managed stacks exist. Both are forced
 * via the env var so the answer does not depend on how (or whether) the agent
 * enabled the flag in config.toml or its own shell.
 */
async function resolveStack(
  ctx: LocalStackEvalContext,
  worktree: string,
  dir: string
): Promise<StackResolution> {
  const notes: string[] = [];

  const managedEnv = await ctx.exec(
    inDir(
      dir,
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json 2>/dev/null'
    )
  );
  const managed = parseJsonObject(managedEnv.stdout);
  const managedDbUrl = readString(managed, 'DB_URL');
  if (managedEnv.ok && managedDbUrl) {
    const status = await ctx.exec(
      inDir(
        dir,
        'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --output-format json 2>/dev/null'
      )
    );
    const runtime = parseJsonObject(status.stdout)?.runtime as
      | { kind?: unknown }
      | undefined;
    const kind = runtime?.kind;
    return {
      ok: true,
      stack: {
        worktree,
        dir,
        backend: 'managed',
        dbUrl: managedDbUrl,
        runtime: kind === 'native' || kind === 'docker' ? kind : 'unknown',
      },
    };
  }
  notes.push(
    `managed: ${summarize(managedEnv, managed?.error ?? managed?.message)}`
  );

  const legacy = await ctx.exec(
    inDir(
      dir,
      'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json 2>/dev/null'
    )
  );
  const legacyDbUrl = readString(parseJsonObject(legacy.stdout), 'DB_URL');
  if (legacy.ok && legacyDbUrl) {
    return {
      ok: true,
      stack: {
        worktree,
        dir,
        backend: 'legacy',
        dbUrl: legacyDbUrl,
        runtime: 'docker',
      },
    };
  }
  notes.push(`legacy: ${summarize(legacy)}`);

  return { ok: false, worktree, dir, notes: notes.join('; ') };
}

function summarize(result: CommandResult, detail?: unknown): string {
  if (detail !== undefined) return truncate(JSON.stringify(detail), 200);
  const text = (result.stderr || result.stdout).trim();
  return text ? truncate(text, 200) : `exit ${result.exitCode}`;
}

function readString(
  obj: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = obj?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Run a SELECT against one stack via psql, returning JSON rows. */
async function queryStack(
  ctx: LocalStackEvalContext,
  stack: StackHandle,
  sql: string
): Promise<Record<string, unknown>[]> {
  const wrapped = `select coalesce(json_agg(t), '[]'::json) from (${sql.replace(/;\s*$/, '')}) t;`;
  // base64 transport sidesteps shell quoting entirely.
  const encoded = Buffer.from(wrapped, 'utf-8').toString('base64');
  const result = await ctx.exec(
    `echo ${encoded} | base64 -d | psql ${shellQuote(stack.dbUrl)} -v ON_ERROR_STOP=1 -tA`,
    { timeoutMs: 30_000 }
  );
  if (!result.ok) {
    throw new Error(
      `query against ${stack.worktree} failed: ${truncate(result.stderr || result.stdout, 300)}`
    );
  }
  const text = result.stdout.trim();
  return text ? (JSON.parse(text) as Record<string, unknown>[]) : [];
}

async function tableExists(
  ctx: LocalStackEvalContext,
  stack: StackHandle,
  table: string
): Promise<boolean> {
  const rows = await queryStack(
    ctx,
    stack,
    `select to_regclass('public.${table}') is not null as present`
  );
  return rows[0]?.present === true;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

/**
 * Scorer for the "one local stack per git worktree" scenario. Grades only the
 * end state: real worktrees, one live stack each, and per-table schema/data
 * isolation. It never asserts which CLI backend or runtime was used; those
 * are reported through the always-passing metrics check.
 */
export const worktreeStacksScorer: LocalStackScorer = async (ctx) => {
  try {
    const names = WORKTREE_TABLES.map((entry) => entry.worktree);
    const worktrees = await checkWorktrees(ctx, names);
    const stacks = await resolveStacks(ctx, worktrees.dirs);

    const checks: CheckResult[] = [
      worktrees.check,
      checkDistinctStacks(stacks),
      ...(await Promise.all(
        WORKTREE_TABLES.map((entry) => checkSchemaIsolation(ctx, stacks, entry))
      )),
      ...(await Promise.all(
        WORKTREE_TABLES.map((entry) => checkSeeded(ctx, stacks, entry))
      )),
      ...(await Promise.all(
        WORKTREE_TABLES.map((entry) =>
          checkMigration(ctx, worktrees.dirs, entry)
        )
      )),
      await checkMetrics(ctx, stacks),
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
          name: 'scorer evaluated worktree stacks',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

async function checkWorktrees(
  ctx: LocalStackEvalContext,
  names: readonly string[]
): Promise<{ check: CheckResult; dirs: Record<string, string | undefined> }> {
  const name = `git worktrees ${names.join(', ')} exist on distinct branches`;
  const dirs: Record<string, string | undefined> = {};
  try {
    // Ask git, not the filesystem: agents have put worktrees outside the
    // workspace (`/tmp/feature-a`), and `git worktree list` reports them by
    // absolute path wherever they are. The name lookup is only a fallback so
    // three unrelated repos still get a precise note instead of "not found".
    const repoDir = await findRepoDir(ctx);
    if (!repoDir) {
      for (const worktree of names) {
        dirs[worktree] = await findWorktreeDir(ctx, worktree);
      }
    }
    const anchor = repoDir ?? Object.values(dirs).find(Boolean);
    if (!anchor) {
      return {
        check: {
          name,
          passed: false,
          notes: `no git repository and none of ${names.join(', ')} exist in the workspace`,
        },
        dirs,
      };
    }
    const list = await ctx.exec(
      inDir(anchor, 'git worktree list --porcelain 2>&1')
    );
    if (!list.ok) {
      return {
        check: {
          name,
          passed: false,
          notes: `git worktree list failed in ${anchor}: ${truncate(list.stderr || list.stdout, 200)}`,
        },
        dirs,
      };
    }
    const { matched, problems } = matchWorktrees(
      parseWorktreeList(list.stdout),
      names
    );
    // git's own path for each worktree drives every later check; anything
    // git doesn't know about falls back to a same-named folder, if any, so
    // the migration check can still point at what the agent produced.
    for (const worktree of names) {
      const entry = matched[worktree];
      dirs[worktree] =
        entry?.path ?? dirs[worktree] ?? (await findWorktreeDir(ctx, worktree));
    }
    return {
      check: {
        name,
        passed: problems.length === 0,
        notes:
          problems.length > 0
            ? problems.join('; ')
            : names.map((n) => `${n} → ${matched[n]?.branch}`).join(', '),
      },
      dirs,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { check: { name, passed: false, notes: msg }, dirs };
  }
}

async function resolveStacks(
  ctx: LocalStackEvalContext,
  dirs: Record<string, string | undefined>
): Promise<Record<string, StackResolution>> {
  const out: Record<string, StackResolution> = {};
  for (const { worktree } of WORKTREE_TABLES) {
    const dir = dirs[worktree];
    out[worktree] = dir
      ? await resolveStack(ctx, worktree, dir)
      : { ok: false, worktree, dir: '', notes: 'worktree directory not found' };
  }
  return out;
}

function checkDistinctStacks(
  stacks: Record<string, StackResolution>
): CheckResult {
  const name =
    'each worktree has its own running stack (three distinct database endpoints)';
  const resolutions = Object.values(stacks);
  const failures = resolutions.filter((r) => !r.ok);
  if (failures.length > 0) {
    return {
      name,
      passed: false,
      notes: failures
        .map((r) => (r.ok ? '' : `${r.worktree}: ${r.notes}`))
        .join('\n'),
    };
  }
  const live = resolutions.filter((r) => r.ok).map((r) => r.stack);
  const keys = live.map((stack) => endpointKey(stack.dbUrl) ?? stack.dbUrl);
  const distinct = new Set(keys).size === live.length;
  return {
    name,
    passed: distinct,
    notes: live
      .map(
        (stack, i) =>
          `${stack.worktree}: ${keys[i]} (${stack.backend}/${stack.runtime})`
      )
      .join(', '),
  };
}

async function checkSchemaIsolation(
  ctx: LocalStackEvalContext,
  stacks: Record<string, StackResolution>,
  entry: { worktree: string; table: string }
): Promise<CheckResult> {
  const name = `${entry.table} exists only in ${entry.worktree}'s stack`;
  try {
    const presence: string[] = [];
    let passed = true;
    for (const { worktree } of WORKTREE_TABLES) {
      const resolution = stacks[worktree];
      if (!resolution?.ok) {
        presence.push(`${worktree}: no stack`);
        passed = false;
        continue;
      }
      const present = await tableExists(ctx, resolution.stack, entry.table);
      const expected = worktree === entry.worktree;
      if (present !== expected) passed = false;
      presence.push(`${worktree}: ${present ? 'present' : 'absent'}`);
    }
    return { name, passed, notes: presence.join(', ') };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

async function checkSeeded(
  ctx: LocalStackEvalContext,
  stacks: Record<string, StackResolution>,
  entry: { worktree: string; table: string }
): Promise<CheckResult> {
  const name = `${entry.table} has at least ${MIN_SEEDED_ROWS} row in ${entry.worktree}'s stack`;
  try {
    const resolution = stacks[entry.worktree];
    if (!resolution?.ok) {
      return { name, passed: false, notes: `${entry.worktree}: no stack` };
    }
    const rows = await queryStack(
      ctx,
      resolution.stack,
      `select count(*)::int as n from public.${entry.table}`
    );
    const count = Number(rows[0]?.n ?? 0);
    return {
      name,
      passed: count >= MIN_SEEDED_ROWS,
      notes: `found ${count} rows`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

async function checkMigration(
  ctx: LocalStackEvalContext,
  dirs: Record<string, string | undefined>,
  entry: { worktree: string; table: string }
): Promise<CheckResult> {
  const name = `${entry.table} is created by a migration file in ${entry.worktree}`;
  try {
    const dir = dirs[entry.worktree];
    if (!dir) {
      return { name, passed: false, notes: 'worktree directory not found' };
    }
    const result = await ctx.exec(
      inDir(dir, 'cat supabase/migrations/*.sql 2>/dev/null')
    );
    if (!result.ok || !result.stdout.trim()) {
      return {
        name,
        passed: false,
        notes: `no migration files found under ${entry.worktree}/supabase/migrations`,
      };
    }
    const creates = migrationCreatesTable(result.stdout, entry.table);
    return {
      name,
      passed: creates,
      notes: creates
        ? undefined
        : `no migration in ${entry.worktree} contains CREATE TABLE for ${entry.table}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

/**
 * Observational metrics, never a gate. Fleet wall-clock is measured across
 * all three stacks together (latest Postgres start minus session start), as
 * the ticket asks: parallel startup time is part of what's being validated.
 */
async function checkMetrics(
  ctx: LocalStackEvalContext,
  stacks: Record<string, StackResolution>
): Promise<CheckResult> {
  const name = 'metrics';
  try {
    const marker = await readRuntimeMarker(ctx);
    const commands = extractCommands(ctx.toolCalls);
    const cliVersionResult = await ctx.exec('supabase --version');
    const cliVersion = cliVersionResult.ok
      ? cliVersionResult.stdout.trim()
      : null;

    const perWorktree: Record<string, unknown> = {};
    let latestReadyMs: number | null = null;
    for (const { worktree } of WORKTREE_TABLES) {
      const resolution = stacks[worktree];
      if (!resolution?.ok) {
        perWorktree[worktree] = { backend: null, runtime: 'none' };
        continue;
      }
      const readyMs = await readReadyMs(ctx, resolution.stack);
      perWorktree[worktree] = {
        backend: resolution.stack.backend,
        runtime: resolution.stack.runtime,
        endpoint: endpointKey(resolution.stack.dbUrl) ?? null,
        readyMs,
      };
      if (
        readyMs !== null &&
        (latestReadyMs === null || readyMs > latestReadyMs)
      ) {
        latestReadyMs = readyMs;
      }
    }

    const startMs = await readStartMs(ctx, marker);
    const fleetWallClockMs =
      latestReadyMs !== null && startMs !== null
        ? latestReadyMs - startMs
        : null;

    const metrics = {
      cliVersion,
      channel: marker?.channel ?? 'pinned',
      stacksRunning: Object.values(stacks).filter((r) => r.ok).length,
      fleetWallClockMs,
      supabaseStartInvocations: countSupabaseStarts(commands),
      worktrees: perWorktree,
    };
    return { name, passed: true, notes: JSON.stringify(metrics) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: true, notes: JSON.stringify({ error: msg }) };
  }
}

async function readRuntimeMarker(
  ctx: LocalStackEvalContext
): Promise<RuntimeMarker | undefined> {
  const result = await ctx.exec(`cat ${RUNTIME_MARKER_PATH} 2>/dev/null`);
  if (!result.ok || !result.stdout.trim()) return undefined;
  return parseJsonObject(result.stdout) as RuntimeMarker | undefined;
}

async function readReadyMs(
  ctx: LocalStackEvalContext,
  stack: StackHandle
): Promise<number | null> {
  try {
    const rows = await queryStack(
      ctx,
      stack,
      'select (extract(epoch from pg_postmaster_start_time()) * 1000)::bigint as ms'
    );
    const ms = rows[0]?.ms;
    return ms === undefined || ms === null ? null : Number(ms);
  } catch {
    return null;
  }
}

async function readStartMs(
  ctx: LocalStackEvalContext,
  marker: RuntimeMarker | undefined
): Promise<number | null> {
  if (marker?.sessionStartedMs !== undefined) return marker.sessionStartedMs;
  try {
    // No marker means a stock pinned run: fall back to the sandbox's PID 1
    // start time (/proc/1/stat starttime in clock ticks since boot, plus
    // /proc/stat btime), converted to epoch milliseconds.
    const result = await ctx.exec(
      "echo $(( ($(awk '{print $22}' /proc/1/stat) / $(getconf CLK_TCK) + $(awk '/^btime/ {print $2}' /proc/stat)) * 1000 ))"
    );
    if (!result.ok) return null;
    const value = Number(result.stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
