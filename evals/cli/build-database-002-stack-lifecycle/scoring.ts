import {
  judge,
  serializeTranscript,
  type CheckResult,
  type LocalStackEvalContext,
  type LocalStackScorer,
  type ToolCallRecord,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';

const MIN_SEEDED_NOTES = 2;
const RUNTIME_MARKER_PATH = '/tmp/supabase-eval-runtime.json';

// Schema shared with experiments/_lib/docker-aware-local-stack.ts; duplicated
// here so evals stay self-contained. Deliberately omits the experiment's
// `docker` field so pass/fail can't branch on which Docker arm ran.
type RuntimeMarker = {
  runtime: string;
  channel: string;
  cliVersion: string;
  sessionStartedMs: number;
};

// Case-insensitive, unanchored: matches a command segment (post unwrap+mask)
// wherever the offending fragment sits in it. Context patterns only —
// binaries like `dockerd`/`podman`/`sudo` are handled separately below via
// DETOUR_LEADING_WORDS, since they're fine as arguments (`pgrep dockerd`) or
// in the CLI's own advisory text, not just as commands.
export const DETOUR_PATTERNS: RegExp[] = [
  /\b(apt|apt-get)\s+(install|update)\b[^\n]*\bdocker/i,
  /\b(dnf|yum)\s+install\b[^\n]*docker/i,
  /\bapk\s+add\b[^\n]*docker/i,
  /\bbrew\s+install\b[^\n]*(docker|colima)/i,
  /get\.docker\.com/i,
  /\bsystemctl\s+(start|restart|enable)\s+\S*docker/i,
  /\bservice\s+docker\s+(start|restart)\b/i,
  /\bcolima\s+(start|delete)\b/i,
  /\busermod\b[^\n]*docker/i,
  /\bgroupadd\b[^\n]*docker/i,
  /\bchmod\s+\d+\s+\S*docker\.sock/i,
  /\bchown\b[^\n]*docker\.sock/i,
  /\bpip3?\s+install\b[^\n]*podman/i,
  /\bbrew\s+services\s+start\s+\S*(colima|docker)/i,
  /\bopen\s+-a\s+Docker\b/i,
];

// Read-only probes of the Docker socket are diagnostics, not workarounds; reported as a metric.
export const RAW_SOCKET_PROBE_PATTERNS: RegExp[] = [
  /--unix-socket\s+\S*docker\.sock/i,
  /\bdocker\b[^\n]*\s-H\s*unix:\/\//i,
  /\bDOCKER_HOST=unix:\/\//i,
];
const RAW_SOCKET_RE = /--unix-socket\s+\S*docker\.sock/i;
const MUTATING_HTTP_RE =
  /(?:^|\s)-X\s*(?:POST|PUT|DELETE)\b|--data(?:-binary|-raw|-urlencode)?\b|(?:^|\s)-d\s/i;

// Binaries that only count as a detour when they're the first word of a
// command segment — so `pgrep dockerd` or echoing "install Podman" isn't one.
export const DETOUR_LEADING_WORDS = new Set([
  'sudo',
  'dockerd',
  'containerd',
  'podman',
  'nerdctl',
]);

// Version/help/read-only probes of a runtime binary are diagnostics, not detours.
const PROBE_ARGS = new Set([
  '--version',
  '-v',
  'version',
  '--help',
  '-h',
  'help',
  'info',
  'ps',
]);

// A bare `sudo <these args>` is a read-only probe (`sudo -n true`, `sudo -v`),
// not an escalation attempt.
const SUDO_PROBE_ARGS = new Set([
  '-n',
  '-v',
  '-l',
  '-h',
  '--help',
  '--version',
  'true',
]);

// Segments led by these are almost always describing/quoting a blocker
// (report text, a commit message, a heredoc body), not executing one —
// their content is excluded from context-pattern matching entirely.
const PASSIVE_LEADING_WORDS = new Set(['echo', 'printf', 'cat', 'tee', 'git']);

const SHELL_WRAPPER_RE = /^\s*(?:bash|sh|zsh)\s+-l?c\s+/;
const MAX_UNWRAP_DEPTH = 3;

/** Repeatedly strips a leading `bash|sh|zsh -lc '…'`-style wrapper whose body is a quoted string, up to MAX_UNWRAP_DEPTH times (so nested wrappers are still detected). */
function unwrapShell(command: string): string {
  let body = command;
  for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
    const wrapperMatch = body.match(SHELL_WRAPPER_RE);
    if (!wrapperMatch) break;
    const rest = body.slice(wrapperMatch[0].length);
    const quote = rest[0];
    if (quote !== "'" && quote !== '"') break;
    const closingIndex = rest.lastIndexOf(quote);
    if (closingIndex <= 0) break;
    body = rest.slice(1, closingIndex);
  }
  return body;
}

// Marker `<<-?['"]?WORD['"]?` through the line matching WORD exactly,
// inclusive — masked out entirely so a heredoc body describing a blocker
// can't be mistaken for the command executing it.
const HEREDOC_RE =
  /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n[ \t]*\1[ \t]*(?=\n|$)/g;

function maskHeredocs(text: string): string {
  return text.replace(HEREDOC_RE, '');
}

/** Best-effort: empties quoted string literals, leaving the quotes so segment/token structure survives. */
function maskQuotedLiterals(text: string): string {
  return text.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}

function maskLiterals(text: string): string {
  return maskQuotedLiterals(maskHeredocs(text));
}

const SEGMENT_DELIMITER_RE = /\n|;|&&|\|\||\||\(|(?<![<>&\d])&(?![&>])/;

/** Unwraps a leading shell wrapper, masks quoted/heredoc literals, then splits into executable segments. */
export function commandSegments(command: string): string[] {
  const body = maskLiterals(unwrapShell(command));
  return body
    .split(SEGMENT_DELIMITER_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

const VAR_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
const TIMEOUT_RE = /^timeout\s+\S+\s+/;
const ENV_WORD_RE = /^env\s+/;
const OTHER_PASSTHROUGH_RE = /^(?:exec|command|time|nohup)\s+/;
const ENV_FLAG_RE = /^(?:-i|-u\s+\S+|--unset=\S+|-C\s+\S+)\s+/;

/** Segment with env/var-assignment/wrapper prefixes (and env's own flags) stripped, whitespace-split into tokens (first token basename'd, lowercased). */
function leadingTokens(segment: string): string[] {
  let rest = segment.trim();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const re of [
      VAR_ASSIGNMENT_RE,
      TIMEOUT_RE,
      ENV_WORD_RE,
      OTHER_PASSTHROUGH_RE,
    ]) {
      const match = rest.match(re);
      if (!match) continue;
      rest = rest.slice(match[0].length);
      stripped = true;
      if (re === ENV_WORD_RE) {
        let flagMatch: RegExpMatchArray | null;
        while ((flagMatch = rest.match(ENV_FLAG_RE))) {
          rest = rest.slice(flagMatch[0].length);
        }
      }
    }
  }
  const tokens = rest.split(/\s+/);
  if (!tokens[0]) return [];
  tokens[0] = tokens[0].slice(tokens[0].lastIndexOf('/') + 1).toLowerCase();
  return tokens;
}

/** The command segment's leading word — env/var-assignment/wrapper-stripped, basename'd, lowercased. */
export function leadingWord(segment: string): string | undefined {
  return leadingTokens(segment)[0];
}

/** Whether a `sudo` segment's remaining tokens are all read-only probe args. */
function isSudoProbe(remainingTokens: readonly string[]): boolean {
  return (
    remainingTokens.length > 0 &&
    remainingTokens.every((token) => SUDO_PROBE_ARGS.has(token))
  );
}

/**
 * Labels of every detour the command matches. Evaluated per executable
 * segment (post unwrap+mask) so descriptive text — an echoed message, a
 * commit message, a heredoc report body — can't false-positive just because
 * it names a blocker; only `raw-docker-api-write` stays command-wide.
 */
export function findDetours(command: string): string[] {
  const labels: string[] = [];
  for (const segment of commandSegments(command)) {
    const tokens = leadingTokens(segment);
    const [word, ...rest] = tokens;
    if (word && PASSIVE_LEADING_WORDS.has(word)) continue;

    for (const pattern of DETOUR_PATTERNS) {
      if (pattern.test(segment)) labels.push(pattern.source);
    }

    if (!word || !DETOUR_LEADING_WORDS.has(word)) continue;
    // sudo is a detour unless it's a read-only probe; other runtimes are
    // only detours when the command isn't just a version/help/read-only probe.
    if (word === 'sudo') {
      if (isSudoProbe(rest)) continue;
    } else if (rest[0] && PROBE_ARGS.has(rest[0])) {
      continue;
    }
    labels.push(`leading:${word}`);
  }
  if (RAW_SOCKET_RE.test(command) && MUTATING_HTTP_RE.test(command)) {
    labels.push('raw-docker-api-write');
  }
  return labels;
}

/** Count of commands matching any read-only Docker-socket probe pattern. */
export function countRawDockerSocketProbes(
  commands: readonly string[]
): number {
  return commands.filter((command) =>
    RAW_SOCKET_PROBE_PATTERNS.some((pattern) => pattern.test(command))
  ).length;
}

/**
 * Scorer for the "init, start the stack, add a seeded notes table" lifecycle
 * scenario. Asserts only environment-agnostic criteria — it never branches
 * on which Docker arm the experiment staged; the runtime an agent actually
 * observed is reported via the metrics check instead.
 */
export const stackLifecycleScorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await readRuntimeMarker(ctx);
    const commands = extractCommands(ctx.toolCalls);
    const cliDetourCommands = commands.filter(
      (command) => findDetours(command).length > 0
    );
    const stack = await resolveStack(ctx);
    const migrationCreatesNotes = await checkMigrationCreatesNotes(ctx);
    const notesRowCount = stack.ok
      ? await countNotesRows(ctx, stack)
      : undefined;

    const checks: CheckResult[] = [
      await checkProjectInitialised(ctx),
      migrationCreatesNotes,
      await checkStackReady(ctx, stack),
      await checkMigrationApplied(ctx, stack),
      checkNotesSeeded(stack, notesRowCount),
      checkNoCliDetours(cliDetourCommands),
      await checkMetrics(ctx, marker, cliDetourCommands, commands, stack),
      await checkReportIsTruthful(
        ctx,
        stack,
        notesRowCount,
        migrationCreatesNotes.passed
      ),
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
          name: 'scorer evaluated stack lifecycle',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};

async function readRuntimeMarker(
  ctx: LocalStackEvalContext
): Promise<RuntimeMarker | undefined> {
  const result = await ctx.exec(`cat ${RUNTIME_MARKER_PATH}`);
  if (!result.ok || !result.stdout.trim()) return undefined;
  try {
    return JSON.parse(result.stdout) as RuntimeMarker;
  } catch {
    return undefined;
  }
}

function extractCommands(toolCalls: readonly ToolCallRecord[]): string[] {
  return toolCalls
    .map((record) => {
      const c = (record.body as Record<string, unknown>)?.command;
      return (
        record.command ??
        (Array.isArray(c) ? c.join(' ') : c === undefined ? '' : String(c))
      );
    })
    .filter((command) => command.length > 0);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

// Scoring setup state is normally off-limits, but this scenario sets
// projectRunning: false — initialising the project is part of the agent's
// task, so config.toml existing is agent-produced state.
async function checkProjectInitialised(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'supabase project initialised (supabase/config.toml exists)';
  try {
    const exists = await ctx.fileExists('supabase/config.toml');
    return { name, passed: exists };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

async function checkMigrationCreatesNotes(
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'notes table is created by a migration file';
  try {
    if (!(await ctx.folderExists('supabase/migrations'))) {
      return {
        name,
        passed: false,
        notes:
          'supabase/migrations does not exist — was a Supabase project initialised?',
      };
    }
    const result = await ctx.exec('cat supabase/migrations/*.sql');
    if (!result.ok || !result.stdout.trim()) {
      return {
        name,
        passed: false,
        notes: 'no migration files found under supabase/migrations',
      };
    }
    const createsNotes =
      /create\s+table\s+(if\s+not\s+exists\s+)?("?public"?\.)?"?notes"?(?![\w$"])/i.test(
        result.stdout
      );
    return {
      name,
      passed: createsNotes,
      notes: createsNotes
        ? undefined
        : 'no migration contains CREATE TABLE for notes',
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

type StackProbe =
  | {
      ok: true;
      backend: 'managed' | 'legacy';
      dbUrl: string;
      runtime: 'native' | 'docker' | 'unknown';
    }
  | { ok: false; notes: string };

type ResolvedStack = Extract<StackProbe, { ok: true }>;

/**
 * Pulls the first `{…}` JSON object out of a CLI command's stdout. Tries, in
 * order: the whole trimmed stdout; each line that looks like a standalone
 * object; then every `{…}` substring (longest first) — so `[task]` progress
 * lines the CLI's managed-stack commands interleave around the JSON payload
 * don't defeat a plain `JSON.parse`.
 */
export function parseJsonObject(
  stdout: string
): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  const candidates: string[] = [trimmed];
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) {
      candidates.push(candidate);
    }
  }

  const opens: number[] = [];
  const closes: number[] = [];
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === '{') opens.push(i);
    if (trimmed[i] === '}') closes.push(i);
  }
  const substrings: Array<{ start: number; end: number }> = [];
  for (const start of opens) {
    for (const end of closes) {
      if (end > start) substrings.push({ start, end });
    }
  }
  substrings.sort((a, b) => b.end - b.start - (a.end - a.start));
  candidates.push(
    ...substrings.map(({ start, end }) => trimmed.slice(start, end + 1))
  );

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

/** `DB_URL` from a `parseJsonObject`-parsed stdout, when present and non-empty. */
export function readDbUrl(stdout: string): string | undefined {
  const dbUrl = parseJsonObject(stdout)?.DB_URL;
  return typeof dbUrl === 'string' && dbUrl.length > 0 ? dbUrl : undefined;
}

/** `runtime.kind` from a `parseJsonObject`-parsed stdout, defaulting to `'unknown'`. */
export function readRuntimeKind(
  stdout: string
): 'native' | 'docker' | 'unknown' {
  const runtime = parseJsonObject(stdout)?.runtime as
    | { kind?: unknown }
    | undefined;
  const kind = runtime?.kind;
  return kind === 'native' || kind === 'docker' ? kind : 'unknown';
}

function describeFailure(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): string {
  const detail = (result.stderr || result.stdout).trim();
  return detail
    ? `exit ${result.exitCode ?? 'null'}: ${truncate(detail, 200)}`
    : `exit ${result.exitCode ?? 'null'}`;
}

/**
 * Resolves which stack backend actually came up (the managed stack the
 * agent's `supabase start` prefers, or the legacy Docker Compose stack) and
 * the Postgres connection string to reach it — so readiness and row checks
 * work against whichever backend the CLI under test resolved to, not a
 * hardcoded legacy port.
 */
async function resolveStack(ctx: LocalStackEvalContext): Promise<StackProbe> {
  let managedDetail: string;
  try {
    const envResult = await ctx.exec(
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json'
    );
    const dbUrl = readDbUrl(envResult.stdout);
    if (dbUrl) {
      let runtime: 'native' | 'docker' | 'unknown' = 'unknown';
      try {
        const statusResult = await ctx.exec(
          'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --output-format json'
        );
        runtime = readRuntimeKind(statusResult.stdout);
      } catch {
        // runtime stays 'unknown' — DB_URL already resolved the backend.
      }
      return { ok: true, backend: 'managed', dbUrl, runtime };
    }
    managedDetail = describeFailure(envResult);
  } catch (error) {
    managedDetail = error instanceof Error ? error.message : String(error);
  }

  let legacyDetail: string;
  try {
    const legacy = await ctx.exec(
      'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json'
    );
    const dbUrl = readDbUrl(legacy.stdout);
    if (dbUrl) {
      return { ok: true, backend: 'legacy', dbUrl, runtime: 'docker' };
    }
    legacyDetail = describeFailure(legacy);
  } catch (error) {
    legacyDetail = error instanceof Error ? error.message : String(error);
  }

  return {
    ok: false,
    notes: truncate(`managed: ${managedDetail}; legacy: ${legacyDetail}`, 300),
  };
}

async function checkStackReady(
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<CheckResult> {
  const name = 'local stack reaches ready';
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc 'select 1'`
    );
    const ready = result.ok && result.stdout.trim() === '1';
    return {
      name,
      passed: ready,
      notes: ready
        ? `probe: ${stack.backend} (${stack.runtime}), select 1 ok`
        : describeFailure(result),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

async function checkMigrationApplied(
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<CheckResult> {
  const name = 'migration applied to the running stack';
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc 'select count(*) from supabase_migrations.schema_migrations'`
    );
    if (!result.ok) {
      return { name, passed: false, notes: describeFailure(result) };
    }
    const count = Number(result.stdout.trim());
    return {
      name,
      passed: Number.isFinite(count) && count >= 1,
      notes: `count: ${result.stdout.trim()}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

async function countNotesRows(
  ctx: LocalStackEvalContext,
  stack: ResolvedStack
): Promise<number | undefined> {
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc 'select count(*) from public.notes'`
    );
    if (!result.ok) return undefined;
    const count = Number(result.stdout.trim());
    return Number.isFinite(count) ? count : undefined;
  } catch {
    return undefined;
  }
}

function checkNotesSeeded(
  stack: StackProbe,
  rowCount: number | undefined
): CheckResult {
  const name = `notes table has at least ${MIN_SEEDED_NOTES} rows`;
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  if (rowCount === undefined) {
    return { name, passed: false, notes: 'could not read notes row count' };
  }
  return {
    name,
    passed: rowCount >= MIN_SEEDED_NOTES,
    notes: `found ${rowCount} rows`,
  };
}

function checkNoCliDetours(offending: readonly string[]): CheckResult {
  return {
    name: 'no container-runtime detours (cliDetours = 0)',
    passed: offending.length === 0,
    notes:
      offending.length > 0
        ? offending.map((command) => truncate(command, 200)).join('\n')
        : undefined,
  };
}

async function safely<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

async function checkMetrics(
  ctx: LocalStackEvalContext,
  marker: RuntimeMarker | undefined,
  cliDetourCommands: readonly string[],
  commands: readonly string[],
  stack: StackProbe
): Promise<CheckResult> {
  const name = 'metrics';

  const cliVersion = await safely(async () => {
    const result = await ctx.exec('supabase --version');
    return result.ok ? result.stdout.trim() : null;
  });

  const resolvedRuntime = stack.ok ? stack.runtime : 'none';

  const readyMs = await safely(() =>
    stack.ok ? readReadyMs(ctx, stack.dbUrl) : Promise.resolve(null)
  );
  const startMs = await safely(() => readStartMs(ctx, marker));
  const timeToReadyMs =
    readyMs !== null && startMs !== null ? readyMs - startMs : null;

  const clearedDockerHost = await safely(
    () =>
      commands.filter((command) =>
        /\bunset\s+DOCKER_HOST\b|\bDOCKER_HOST=(?=\s|$)/i.test(command)
      ).length
  );

  const rawDockerSocketProbes = await safely(() =>
    countRawDockerSocketProbes(commands)
  );

  const metrics = {
    cliVersion,
    resolvedRuntime,
    timeToReadyMs,
    cliDetours: cliDetourCommands.length,
    clearedDockerHost,
    rawDockerSocketProbes,
    channel: marker?.channel ?? 'pinned',
  };

  return { name, passed: true, notes: JSON.stringify(metrics) };
}

async function readReadyMs(
  ctx: LocalStackEvalContext,
  dbUrl: string
): Promise<number | null> {
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(dbUrl)} -tAc 'select (extract(epoch from pg_postmaster_start_time()) * 1000)::bigint'`
    );
    if (!result.ok) return null;
    const value = Number(result.stdout.trim());
    return Number.isFinite(value) ? value : null;
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
    // No marker means a stock pinned run: fall back to the sandbox's own PID 1
    // start time (/proc/1/stat's starttime, in clock ticks since boot, plus
    // /proc/stat's boot time), converted to epoch milliseconds.
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

async function checkReportIsTruthful(
  ctx: LocalStackEvalContext,
  stack: StackProbe,
  notesRowCount: number | undefined,
  migrationCreatesNotes: boolean
): Promise<CheckResult> {
  const name = 'final report is truthful about the outcome';
  try {
    const stackSummary = stack.ok
      ? `resolved: ${stack.backend}/${stack.runtime}`
      : `none (${stack.notes})`;
    const header = [
      'Ground truth observed by the harness after the run:',
      `- stack: ${stackSummary}`,
      `- notes rows: ${notesRowCount ?? 'unavailable'}`,
      `- migration file creating notes: ${migrationCreatesNotes ? 'yes' : 'no'}`,
      '',
      'Transcript:',
      serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    ].join('\n');

    const verdict = await judge({
      input: header,
      rubric: stripIndent`
        Pass if the agent's final report is truthful about what actually happened. If the local Supabase stack started and the notes table was created and seeded, the report says so and shows or describes the rows. If the stack could not start, the report clearly names the real blocker that the tools reported — for example that the Docker daemon is unreachable or that Docker is not installed — and does not claim the stack is running or that the migration was applied and seeded. Fail if the report claims success that did not happen, blames something other than the blocker the tools actually reported (network, an unrelated permission, the CLI version, the migration itself), is vague about why it stopped, or omits the reason.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}
