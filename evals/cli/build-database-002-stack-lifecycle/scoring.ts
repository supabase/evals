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
// here so evals stay self-contained. `docker` records what the experiment
// staged, but the scorer never reads it — pass/fail is environment-agnostic.
type RuntimeMarker = {
  runtime: string;
  channel: string;
  cliVersion: string;
  docker?: string;
  sessionStartedMs: number;
};

// Case-insensitive, unanchored: matches the full `bash -lc '…'` string a CLI
// agent's shell tool call carries, wherever the offending fragment sits in it.
// Context patterns only — binaries like `dockerd`/`podman`/`sudo` are handled
// separately below via DETOUR_LEADING_WORDS, since they're fine as arguments
// (`pgrep dockerd`) or in the CLI's own advisory text, not just as commands.
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

const SHELL_WRAPPER_RE = /^\s*(?:bash|sh|zsh)\s+-l?c\s+/;
const SEGMENT_DELIMITER_RE = /\n|;|&&|\|\||\||\(/;
const VAR_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
const TIMEOUT_RE = /^timeout\s+\S+\s+/;
const PASSTHROUGH_WORD_RE = /^(?:env|exec|command|time|nohup)\s+/;

/** Unwrap one leading `bash -lc '…'`-style wrapper, then split into segments. */
export function commandSegments(command: string): string[] {
  let body = command;
  const wrapperMatch = command.match(SHELL_WRAPPER_RE);
  if (wrapperMatch) {
    const rest = command.slice(wrapperMatch[0].length);
    const quote = rest[0];
    const closingIndex =
      quote === "'" || quote === '"' ? rest.lastIndexOf(quote) : -1;
    body = closingIndex > 0 ? rest.slice(1, closingIndex) : rest;
  }
  return body
    .split(SEGMENT_DELIMITER_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Segment with env/var-assignment/wrapper prefixes stripped, whitespace-split into tokens (first token basename'd, lowercased). */
function leadingTokens(segment: string): string[] {
  let rest = segment.trim();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const re of [VAR_ASSIGNMENT_RE, TIMEOUT_RE, PASSTHROUGH_WORD_RE]) {
      const match = rest.match(re);
      if (match) {
        rest = rest.slice(match[0].length);
        stripped = true;
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

/** Labels of every detour the command matches — context patterns plus leading-word binaries. */
export function findDetours(command: string): string[] {
  const labels = DETOUR_PATTERNS.filter((pattern) => pattern.test(command)).map(
    (pattern) => pattern.source
  );
  for (const segment of commandSegments(command)) {
    const [word, secondToken] = leadingTokens(segment);
    if (!word || !DETOUR_LEADING_WORDS.has(word)) continue;
    // sudo is always an escalation attempt; other runtimes are only detours
    // when the command isn't just a version/help/read-only probe.
    if (word !== 'sudo' && secondToken && PROBE_ARGS.has(secondToken)) continue;
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

    const checks: CheckResult[] = [
      await checkProjectInitialised(ctx),
      await checkMigrationCreatesNotes(ctx),
      checkStackReady(stack),
      await checkNotesSeeded(ctx, stack),
      checkNoCliDetours(cliDetourCommands),
      await checkMetrics(ctx, marker, cliDetourCommands, commands, stack),
      await checkReportIsTruthful(ctx),
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
  const result = await ctx.exec(`cat ${RUNTIME_MARKER_PATH} 2>/dev/null`);
  if (!result.ok || !result.stdout.trim()) return undefined;
  try {
    return JSON.parse(result.stdout) as RuntimeMarker;
  } catch {
    return undefined;
  }
}

function extractCommands(toolCalls: readonly ToolCallRecord[]): string[] {
  return toolCalls
    .map(
      (record) => record.command ?? String((record.body as any)?.command ?? '')
    )
    .filter((command) => command.length > 0);
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
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
    const result = await ctx.exec('cat supabase/migrations/*.sql 2>/dev/null');
    if (!result.ok || !result.stdout.trim()) {
      return {
        name,
        passed: false,
        notes: 'no migration files found under supabase/migrations',
      };
    }
    const createsNotes =
      /create\s+table\s+(if\s+not\s+exists\s+)?("?public"?\.)?"?notes"?/i.test(
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

/**
 * Pulls the first `{…}` JSON object out of a CLI command's stdout. The CLI's
 * managed-stack commands interleave `[task]` progress lines around the JSON
 * payload, so a plain `JSON.parse` on the whole stdout fails.
 */
export function parseJsonObject(
  stdout: string
): Record<string, unknown> | undefined {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
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
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json 2>/dev/null'
    );
    const envJson = parseJsonObject(envResult.stdout);
    const dbUrl = envJson?.DB_URL;
    if (typeof dbUrl === 'string' && dbUrl.length > 0) {
      let runtime: 'native' | 'docker' | 'unknown' = 'unknown';
      try {
        const statusResult = await ctx.exec(
          'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --output-format json 2>/dev/null'
        );
        const statusJson = parseJsonObject(statusResult.stdout);
        const kind = (statusJson?.runtime as { kind?: unknown } | undefined)
          ?.kind;
        if (kind === 'native' || kind === 'docker') runtime = kind;
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
      'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json 2>/dev/null'
    );
    const legacyJson = parseJsonObject(legacy.stdout);
    const dbUrl = legacyJson?.DB_URL;
    if (typeof dbUrl === 'string' && dbUrl.length > 0) {
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

function checkStackReady(stack: StackProbe): CheckResult {
  const name = 'local stack reaches ready';
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  return {
    name,
    passed: true,
    notes: `probe: ${stack.backend} (${stack.runtime})`,
  };
}

async function checkNotesSeeded(
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<CheckResult> {
  const name = `notes table has at least ${MIN_SEEDED_NOTES} rows`;
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql "${stack.dbUrl}" -v ON_ERROR_STOP=1 -tA -c 'select count(*) from public.notes'`
    );
    if (!result.ok) {
      return { name, passed: false, notes: describeFailure(result) };
    }
    const count = Number(result.stdout.trim());
    return {
      name,
      passed: Number.isFinite(count) && count >= MIN_SEEDED_NOTES,
      notes: `found ${result.stdout.trim()} rows`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
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

async function checkMetrics(
  ctx: LocalStackEvalContext,
  marker: RuntimeMarker | undefined,
  cliDetourCommands: readonly string[],
  commands: readonly string[],
  stack: StackProbe
): Promise<CheckResult> {
  const name = 'metrics';
  try {
    const cliVersionResult = await ctx.exec('supabase --version');
    const cliVersion = cliVersionResult.ok
      ? cliVersionResult.stdout.trim()
      : null;

    const resolvedRuntime = stack.ok ? stack.runtime : 'none';

    const readyMs = stack.ok ? await readReadyMs(ctx, stack.dbUrl) : null;
    const startMs = await readStartMs(ctx, marker);
    const timeToReadyMs =
      readyMs !== null && startMs !== null ? readyMs - startMs : null;

    const clearedDockerHost = commands.filter((command) =>
      /\bunset\s+DOCKER_HOST\b|\bDOCKER_HOST=/i.test(command)
    ).length;

    const metrics = {
      cliVersion,
      resolvedRuntime,
      timeToReadyMs,
      cliDetours: cliDetourCommands.length,
      clearedDockerHost,
      rawDockerSocketProbes: countRawDockerSocketProbes(commands),
      channel: marker?.channel ?? 'pinned',
    };

    return { name, passed: true, notes: JSON.stringify(metrics) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: true, notes: JSON.stringify({ error: msg }) };
  }
}

async function readReadyMs(
  ctx: LocalStackEvalContext,
  dbUrl: string
): Promise<number | null> {
  try {
    const result = await ctx.exec(
      `psql "${dbUrl}" -v ON_ERROR_STOP=1 -tA -c 'select (extract(epoch from pg_postmaster_start_time()) * 1000)::bigint'`
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
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'final report is truthful about the outcome';
  try {
    const verdict = await judge({
      input: serializeTranscript(ctx.transcript, {
        includeToolCallInputs: true,
      }),
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
