import {
  judge,
  serializeTranscript,
  type CheckResult,
  type LocalStackEnvironmentMarker,
  type LocalStackEvalContext,
  type LocalStackScorer,
  type ToolCallRecord,
} from '@supabase-evals/core';
import { stripIndent } from 'common-tags';
import { parse as shellQuoteParse, type ParseEntry } from 'shell-quote';

const MIN_SEEDED_NOTES = 2;

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

// Read-only Docker-socket probes are a metric, never a pass/fail gate, so a
// whole-string regex check (e.g. a `DOCKER_HOST=unix://...` env value) is
// an acceptable looser check than raw-docker-api-write's argv-based one.
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

// HTTP-client binaries whose argv can mutate the Docker daemon over its raw
// Unix socket. `raw-docker-api-write` below only evaluates a segment led by
// one of these — never text that merely mentions one inside an echoed
// message, a commit message, or a heredoc report body.
const HTTP_CLIENT_LEADING_WORDS = new Set(['curl', 'wget', 'http', 'httpie']);
const UNIX_SOCKET_FLAG_RE = /^--unix-socket(?:=(.*))?$/;
const MUTATING_METHOD_ARG_RE = /^(?:POST|PUT|DELETE)$/i;
const DATA_FLAG_RE =
  /^(?:-d|--data|--data-binary|--data-raw|--data-urlencode)(?:=.*)?$/;

/** Whether `argv` (an HTTP client's own resolved arguments) targets the raw Docker socket. */
function hasRawSocketArg(argv: readonly string[]): boolean {
  return argv.some((token, i) => {
    const match = token.match(UNIX_SOCKET_FLAG_RE);
    if (!match) return false;
    const value = match[1] ?? argv[i + 1];
    return Boolean(value && /docker\.sock/i.test(value));
  });
}

/** Whether `argv` (an HTTP client's own resolved arguments) carries a mutating verb (POST/PUT/DELETE or a body flag). */
function hasMutatingHttpArg(argv: readonly string[]): boolean {
  return argv.some((token, i) => {
    if (DATA_FLAG_RE.test(token)) return true;
    if (/^-X(?:POST|PUT|DELETE)$/i.test(token)) return true;
    const eq = token.match(/^--request=(POST|PUT|DELETE)$/i);
    if (eq) return true;
    if (token === '-X' || token === '--request') {
      return MUTATING_METHOD_ARG_RE.test(argv[i + 1] ?? '');
    }
    return false;
  });
}

/**
 * True only when `rawSegment`'s executed argv actually carries a Docker
 * socket target and a mutating verb — not text that merely appears inside
 * another argument's quoted/echoed string. Takes the unmasked segment so a
 * quoted `--unix-socket "/var/run/docker.sock"` path is still caught. Falls
 * back to a whole-segment regex check if shell-quote can't tokenize it.
 */
function hasRawDockerApiWrite(rawSegment: string): boolean {
  const tokens = tryShellQuoteParse(rawSegment);
  if (tokens === undefined) {
    return RAW_SOCKET_RE.test(rawSegment) && MUTATING_HTTP_RE.test(rawSegment);
  }
  const argv = tokens.filter(
    (token): token is string => typeof token === 'string'
  );
  return hasRawSocketArg(argv) && hasMutatingHttpArg(argv);
}

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

// Fallback only, used when shell-quote itself throws on malformed input (see
// `tryShellQuoteParse`). Still handles absolute-path binaries and combined
// flag spellings so this path doesn't miss what the primary one catches.
const SHELL_WRAPPER_RE = /^\s*(?:\S*\/)?(?:bash|sh|zsh)\s+-\S*c\S*\s+/;
const MAX_UNWRAP_DEPTH = 3;

const SHELL_WRAPPER_BINARIES = new Set(['bash', 'sh', 'zsh']);
const SHELL_WRAPPER_FLAG_RE = /^-\S*c\S*$/;

/** Best-effort tokenization via shell-quote; undefined on a throw so callers can fall back to a regex-based path — a scorer must never crash on a weird agent command. */
function tryShellQuoteParse(text: string): ParseEntry[] | undefined {
  try {
    return shellQuoteParse(text);
  } catch {
    return undefined;
  }
}

/**
 * Detects a `[/path/to/]bash|sh|zsh -<flags>c<flags> '<script>'` wrapper via
 * shell-quote's own tokenizer, so a single-quoted script parses as one token
 * rather than being re-split as the outer command. Handles absolute-path
 * binaries and combined flag spellings (`-lic`, `-ic`, …). Only unwraps when
 * shell-quote resolves the command to exactly [binary, flags, body].
 */
function shellWrapperBodyFromTokens(tokens: ParseEntry[]): string | undefined {
  if (tokens.length !== 3) return undefined;
  const [binary, flags, body] = tokens;
  if (
    typeof binary !== 'string' ||
    typeof flags !== 'string' ||
    typeof body !== 'string'
  ) {
    return undefined;
  }
  const basename = binary.slice(binary.lastIndexOf('/') + 1);
  if (
    !SHELL_WRAPPER_BINARIES.has(basename) ||
    !SHELL_WRAPPER_FLAG_RE.test(flags)
  ) {
    return undefined;
  }
  return body;
}

/** Legacy single-pass regex unwrap — used only as `unwrapOnce`'s fallback when shell-quote throws. */
function legacyUnwrapOnce(command: string): string | undefined {
  const wrapperMatch = command.match(SHELL_WRAPPER_RE);
  if (!wrapperMatch) return undefined;
  const rest = command.slice(wrapperMatch[0].length);
  const quote = rest[0];
  if (quote !== "'" && quote !== '"') return undefined;
  const closingIndex = rest.lastIndexOf(quote);
  if (closingIndex <= 0) return undefined;
  return rest.slice(1, closingIndex);
}

function unwrapOnce(command: string): string | undefined {
  const tokens = tryShellQuoteParse(command);
  if (tokens === undefined) return legacyUnwrapOnce(command);
  return shellWrapperBodyFromTokens(tokens);
}

/** Repeatedly strips a leading `bash|sh|zsh -lc '…'`-style wrapper whose body is a single argument, up to MAX_UNWRAP_DEPTH times (so nested wrappers are still detected). */
function unwrapShell(command: string): string {
  let body = command;
  for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
    const next = unwrapOnce(body);
    if (next === undefined) break;
    body = next;
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

/**
 * Same quoted spans as `maskQuotedLiterals`, but length- and position-
 * preserving (placeholder fill instead of deletion), so the resulting
 * delimiter offsets stay valid indexes into the real, unmasked text (see
 * `unmaskedCommandSegments`). The placeholder (`#`) can't itself match
 * `SEGMENT_DELIMITER_RE`.
 */
function maskQuotedLiteralsPreservingOffsets(text: string): string {
  const fill = (match: string) =>
    `${match[0]}${'#'.repeat(match.length - 2)}${match[0]}`;
  return text.replace(/"[^"]*"/g, fill).replace(/'[^']*'/g, fill);
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

/**
 * `commandSegments`' unmasked, index-aligned counterpart — same unwrap,
 * heredoc masking, and split points, but quoted literals keep their real
 * content. Needed when a check must read a real quoted argv value (e.g. a
 * quoted `--unix-socket` path); never use this for context-pattern matching.
 */
function unmaskedCommandSegments(command: string): string[] {
  const heredocMasked = maskHeredocs(unwrapShell(command));
  const boundarySafe = maskQuotedLiteralsPreservingOffsets(heredocMasked);

  const delimiterRe = new RegExp(SEGMENT_DELIMITER_RE, 'g');
  const segments: string[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = delimiterRe.exec(boundarySafe))) {
    segments.push(heredocMasked.slice(cursor, match.index));
    cursor = match.index + match[0].length;
  }
  segments.push(heredocMasked.slice(cursor));

  return segments
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
 * Labels of every detour the command matches, evaluated per executable
 * segment (post unwrap+mask) so descriptive text — an echoed message, a
 * commit message, a heredoc body — can't false-positive just by naming a
 * blocker. `raw-docker-api-write` is checked against the unmasked segment
 * (`rawSegments`) so a quoted `--unix-socket` path is still caught, gated on
 * the segment's leading word rather than masking to exclude echoed text.
 */
export function findDetours(command: string): string[] {
  const labels: string[] = [];
  const segments = commandSegments(command);
  const rawSegments = unmaskedCommandSegments(command);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const rawSegment = rawSegments[i] ?? segment;
    const tokens = leadingTokens(segment);
    const [word, ...rest] = tokens;
    if (word && PASSIVE_LEADING_WORDS.has(word)) continue;

    for (const pattern of DETOUR_PATTERNS) {
      if (pattern.test(segment)) labels.push(pattern.source);
    }

    if (word && DETOUR_LEADING_WORDS.has(word)) {
      // sudo is a detour unless it's a read-only probe; other runtimes are
      // only detours when the command isn't just a version/help/read-only probe.
      const isProbe =
        word === 'sudo'
          ? isSudoProbe(rest)
          : Boolean(rest[0] && PROBE_ARGS.has(rest[0]));
      if (!isProbe) labels.push(`leading:${word}`);
    } else if (
      word &&
      HTTP_CLIENT_LEADING_WORDS.has(word) &&
      hasRawDockerApiWrite(rawSegment)
    ) {
      labels.push('raw-docker-api-write');
    }
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
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const cliDetourCommands = commands.filter(
      (command) => findDetours(command).length > 0
    );
    const stack = await resolveStack(ctx);
    const notesMigration = await findNotesMigration(ctx);
    const migrationCreatesNotes = checkMigrationCreatesNotes(notesMigration);
    const notesRowCount = stack.ok
      ? await countNotesRows(ctx, stack)
      : undefined;

    const checks: CheckResult[] = [
      await checkProjectInitialised(ctx),
      migrationCreatesNotes,
      await checkStackReady(ctx, stack),
      await checkMigrationApplied(ctx, stack, notesMigration),
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

const CREATES_NOTES_RE =
  /create\s+table\s+(if\s+not\s+exists\s+)?("?public"?\.)?"?notes"?(?![\w$"])/i;
// Filename timestamp isn't guaranteed to be exactly 14 digits in every agent
// run; tolerant on width, but still sorts correctly (lexical sort on a
// numeric-only prefix == chronological, same as the seeded 14-digit case).
const MIGRATION_FILENAME_RE = /^(\d+)_(.+)\.sql$/;

export type NotesMigrationProbe =
  | { ok: true; version: string; file: string }
  | { ok: false; notes: string };

/**
 * Finds the migration file that creates `notes` and its version, reading
 * each `supabase/migrations/*.sql` file individually so the specific file is
 * known. Shared by `checkMigrationCreatesNotes` and `checkMigrationApplied`
 * so both agree on which migration is "the" one — an agent can't pass by
 * leaving a notes-creating file unapplied while hand-creating the table.
 */
export async function findNotesMigration(
  ctx: LocalStackEvalContext
): Promise<NotesMigrationProbe> {
  try {
    if (!(await ctx.folderExists('supabase/migrations'))) {
      return {
        ok: false,
        notes:
          'supabase/migrations does not exist — was a Supabase project initialised?',
      };
    }
    const listing = await ctx.exec('ls supabase/migrations 2>/dev/null | sort');
    const files = listing.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (!listing.ok || files.length === 0) {
      return {
        ok: false,
        notes: 'no migration files found under supabase/migrations',
      };
    }
    for (const file of files) {
      const match = file.match(MIGRATION_FILENAME_RE);
      if (!match) continue;
      const result = await ctx.exec(
        `cat ${shellQuote(`supabase/migrations/${file}`)}`
      );
      if (result.ok && CREATES_NOTES_RE.test(result.stdout)) {
        return { ok: true, version: match[1], file };
      }
    }
    return {
      ok: false,
      notes: 'no migration contains CREATE TABLE for notes',
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, notes: msg };
  }
}

function checkMigrationCreatesNotes(
  notesMigration: NotesMigrationProbe
): CheckResult {
  const name = 'notes table is created by a migration file';
  if (!notesMigration.ok) {
    return { name, passed: false, notes: notesMigration.notes };
  }
  return {
    name,
    passed: true,
    notes: `${notesMigration.file} (version ${notesMigration.version})`,
  };
}

export type StackProbe =
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

/**
 * Asserts the exact migration that creates `notes` was applied through the
 * migration flow — not merely that some migration ran, which a hand-created
 * `notes` table applied alongside an unrelated migration would also satisfy.
 */
export async function checkMigrationApplied(
  ctx: LocalStackEvalContext,
  stack: StackProbe,
  notesMigration: NotesMigrationProbe
): Promise<CheckResult> {
  const name =
    'the migration that creates notes is applied to the running stack';
  if (!stack.ok) return { name, passed: false, notes: stack.notes };
  if (!notesMigration.ok) {
    return { name, passed: false, notes: notesMigration.notes };
  }
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc "select count(*) from supabase_migrations.schema_migrations where version = '${notesMigration.version}'"`
    );
    if (!result.ok) {
      return { name, passed: false, notes: describeFailure(result) };
    }
    const count = Number(result.stdout.trim());
    const passed = Number.isFinite(count) && count >= 1;
    return {
      name,
      passed,
      notes: `version ${notesMigration.version} (${notesMigration.file}): ${
        passed
          ? 'found in applied history'
          : `not found in supabase_migrations.schema_migrations (count: ${result.stdout.trim()})`
      }`,
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

export async function checkMetrics(
  ctx: LocalStackEvalContext,
  marker: LocalStackEnvironmentMarker | undefined,
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
  marker: LocalStackEnvironmentMarker | undefined
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
