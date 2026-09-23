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

// Case-insensitive, unanchored: matches a command segment (post unwrap+mask)
// wherever the offending fragment sits. Context patterns only — binaries
// like `dockerd`/`podman`/`sudo` are handled separately via
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

// Read-only probes of the Docker socket are diagnostics, not workarounds;
// reported as a metric. Left whole-command-string/regex-based (unlike
// `raw-docker-api-write` below) since this never gates pass/fail, so the
// looser, cheaper check is an acceptable tradeoff.
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
 * Whether a command segment is an HTTP client actually mutating the Docker
 * daemon over its raw Unix socket — the socket target and mutating verb must
 * be real argv tokens of the executed client, not text sitting inside some
 * other argument's quoted/echoed string. Takes the segment's real (unmasked)
 * text so a quoted path like `--unix-socket "/var/run/docker.sock"` is still
 * detected; `findDetours` already excludes segments led by a passive word
 * (`echo`, `printf`, …), so this never sees descriptive text. Falls back to
 * a whole-segment regex check if shell-quote can't tokenize the segment.
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

// Fallback only, used when shell-quote itself throws on malformed input
// (see `tryShellQuoteParse`). Handles absolute-path and flag-cluster
// spellings (`-lic`, `-ic`, …) too.
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
 * Detects a `[/path/to/]bash|sh|zsh -<flags>c<flags> '<script>'`-style
 * wrapper via shell-quote's own tokenizer, which resolves quoting itself so
 * a single-quoted script comes back as one token rather than being re-split
 * as the outer command. Only unwraps when the command resolves to a single
 * [binary, flags, body] triple.
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

// Matches a heredoc marker through its closing line, inclusive — masked out
// so a heredoc body describing a blocker can't be mistaken for the command
// executing it.
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
 * delimiter-match offsets stay valid against the real, unmasked text (see
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
 * `commandSegments`' unmasked, index-aligned counterpart: same unwrap,
 * heredoc masking, and delimiter positions, but quoted literals keep their
 * real content. Needed where a check must inspect a real argv value that
 * happens to be quoted (e.g. a quoted `--unix-socket` path). Never use this
 * for context-pattern matching — that's what `commandSegments` is for.
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
 * Labels of every detour the command matches. Evaluated per executable
 * segment (post unwrap+mask) so descriptive text — an echoed message, a
 * commit message, a heredoc report body — can't false-positive just because
 * it names a blocker. `raw-docker-api-write` is checked against the
 * unmasked segment instead, so a real quoted `--unix-socket
 * "/var/run/docker.sock"` argument is still caught; it's still gated on the
 * (masked) leading word, which is what excludes echoed/heredoc text.
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

/** `API_URL` from a `parseJsonObject`-parsed stdout, when present and non-empty. */
export function readApiUrl(stdout: string): string | undefined {
  const apiUrl = parseJsonObject(stdout)?.API_URL;
  return typeof apiUrl === 'string' && apiUrl.length > 0 ? apiUrl : undefined;
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

/** Numeric port from a URL string, or undefined if it can't be parsed / has none. */
export function urlPort(rawUrl: string): number | undefined {
  try {
    const port = Number(new URL(rawUrl).port);
    return Number.isFinite(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

/** `rawUrl` with any userinfo (user:password@) stripped — for putting a DB/API url in notes without leaking credentials. */
export function maskUrlCredentials(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return '<unparseable-url>';
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export type ProjectDirsProbe =
  | { ok: true; clientA: string; clientB: string }
  | { ok: false; notes: string };

/**
 * Discovers the `client-a`/`client-b` project directories by locating every
 * `supabase/config.toml` under the workspace, rather than assuming a fixed
 * path — the agent may put each project at the workspace root or nest it
 * (e.g. under `projects/`). Requires a single directory matching each of
 * `client-a`/`client-b`; otherwise fails with what was actually found.
 */
export async function findProjectDirs(
  ctx: LocalStackEvalContext
): Promise<ProjectDirsProbe> {
  try {
    const result = await ctx.exec(
      "find . -maxdepth 4 -path '*/supabase/config.toml' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null"
    );
    const projectDirs = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((path) => path.replace(/\/supabase\/config\.toml$/, ''));

    const clientADirs = projectDirs.filter((dir) =>
      basename(dir).includes('client-a')
    );
    const clientBDirs = projectDirs.filter((dir) =>
      basename(dir).includes('client-b')
    );

    if (clientADirs.length !== 1 || clientBDirs.length !== 1) {
      return {
        ok: false,
        notes: `expected exactly one client-a and one client-b project (found supabase/config.toml under: ${
          projectDirs.length > 0 ? projectDirs.join(', ') : 'none'
        })`,
      };
    }

    return { ok: true, clientA: clientADirs[0], clientB: clientBDirs[0] };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, notes: msg };
  }
}

function checkProjectDirsFound(projectDirs: ProjectDirsProbe): CheckResult {
  const name = 'two projects initialised';
  if (!projectDirs.ok) return { name, passed: false, notes: projectDirs.notes };
  return {
    name,
    passed: true,
    notes: `client-a: ${projectDirs.clientA}, client-b: ${projectDirs.clientB}`,
  };
}

export type StackProbe =
  | {
      ok: true;
      backend: 'managed' | 'legacy';
      dbUrl: string;
      apiUrl?: string;
      runtime: 'native' | 'docker' | 'unknown';
    }
  | { ok: false; notes: string };

/**
 * Managed-first (`stack status --env`) then legacy (`status -o json`)
 * fallback, run inside `dir` via a `cd && ` prefix — `LocalStackEvalContext.exec`
 * has no cwd option, so this is the only way to probe two independent
 * projects in one sandbox.
 */
async function resolveProjectStack(
  ctx: LocalStackEvalContext,
  dir: string
): Promise<StackProbe> {
  const cd = `cd ${shellQuote(dir)} &&`;

  let managedDetail: string;
  try {
    const envResult = await ctx.exec(
      `${cd} SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json`
    );
    const dbUrl = readDbUrl(envResult.stdout);
    if (dbUrl) {
      const apiUrl = readApiUrl(envResult.stdout);
      let runtime: 'native' | 'docker' | 'unknown' = 'unknown';
      try {
        const statusResult = await ctx.exec(
          `${cd} SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --output-format json`
        );
        runtime = readRuntimeKind(statusResult.stdout);
      } catch {
        // runtime stays 'unknown' — DB_URL already resolved the backend.
      }
      return { ok: true, backend: 'managed', dbUrl, apiUrl, runtime };
    }
    managedDetail = describeFailure(envResult);
  } catch (error) {
    managedDetail = error instanceof Error ? error.message : String(error);
  }

  let legacyDetail: string;
  try {
    const legacy = await ctx.exec(
      `${cd} SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json`
    );
    const dbUrl = readDbUrl(legacy.stdout);
    if (dbUrl) {
      const apiUrl = readApiUrl(legacy.stdout);
      return { ok: true, backend: 'legacy', dbUrl, apiUrl, runtime: 'docker' };
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

async function probeStackReady(
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<{ ready: boolean; notes: string }> {
  if (!stack.ok) return { ready: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc 'select 1'`
    );
    const ready = result.ok && result.stdout.trim() === '1';
    return {
      ready,
      notes: ready
        ? `${stack.backend} (${stack.runtime}), select 1 ok`
        : describeFailure(result),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ready: false, notes: msg };
  }
}

async function checkBothStacksReady(
  ctx: LocalStackEvalContext,
  stackA: StackProbe,
  stackB: StackProbe
): Promise<CheckResult> {
  const name = 'both stacks reach ready';
  try {
    const [a, b] = await Promise.all([
      probeStackReady(ctx, stackA),
      probeStackReady(ctx, stackB),
    ]);
    return {
      name,
      passed: a.ready && b.ready,
      notes: `client-a: ${a.notes}; client-b: ${b.notes}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

/**
 * The port each stack's DB_URL differs is the check that actually proves two
 * independent stacks came up, rather than the second run reusing or
 * silently clobbering the first. Ports (not credentials) are all that ever
 * land in notes — `maskUrlCredentials` strips userinfo before either URL is
 * reported.
 */
export function checkDistinctPorts(
  stackA: StackProbe,
  stackB: StackProbe
): CheckResult {
  const name = 'stacks are on distinct ports';
  if (!stackA.ok || !stackB.ok) {
    return {
      name,
      passed: false,
      notes: `client-a: ${stackA.ok ? 'resolved' : stackA.notes}; client-b: ${
        stackB.ok ? 'resolved' : stackB.notes
      }`,
    };
  }
  const portA = urlPort(stackA.dbUrl);
  const portB = urlPort(stackB.dbUrl);
  if (portA === undefined || portB === undefined) {
    return {
      name,
      passed: false,
      notes: `could not parse a port from one or both DB URLs (client-a: ${maskUrlCredentials(
        stackA.dbUrl
      )}, client-b: ${maskUrlCredentials(stackB.dbUrl)})`,
    };
  }
  const passed = portA !== portB;
  return {
    name,
    passed,
    notes: passed
      ? `client-a port ${portA}, client-b port ${portB}`
      : `client-a and client-b are both on port ${portA} — stacks are not independent`,
  };
}

export type MarkerRowsProbe =
  | { ok: true; markers: string[] }
  | { ok: false; notes: string };

/**
 * Reads every string value out of every row of `public.clients`, via
 * `to_jsonb` rather than a hardcoded `select name` — tolerant of the agent
 * naming the marker column something other than `name` without needing a
 * separate fallback branch. A missing `clients` table surfaces through psql's
 * own "relation does not exist" error in `describeFailure`.
 */
export async function readClientsMarkers(
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<MarkerRowsProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(
        stack.dbUrl
      )} -tAc "select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.clients t"`
    );
    if (!result.ok) {
      return { ok: false, notes: describeFailure(result) };
    }
    let rows: Array<Record<string, unknown>>;
    try {
      rows = JSON.parse(result.stdout.trim());
    } catch {
      return {
        ok: false,
        notes: `could not parse clients rows: ${truncate(result.stdout, 200)}`,
      };
    }
    const markers = rows.flatMap((row) =>
      Object.values(row).filter(
        (value): value is string => typeof value === 'string'
      )
    );
    return { ok: true, markers };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, notes: msg };
  }
}

/**
 * Both directions matter: client-a's database must contain the client-a
 * marker and must not contain client-b's — proving the agent addressed the
 * right stack, not that it wrote both rows into a single database.
 */
export function checkMarkerIsolation(
  markersA: MarkerRowsProbe,
  markersB: MarkerRowsProbe
): CheckResult {
  const name = 'each project holds only its own marker row';
  if (!markersA.ok || !markersB.ok) {
    return {
      name,
      passed: false,
      notes: `client-a: ${
        markersA.ok ? JSON.stringify(markersA.markers) : markersA.notes
      }; client-b: ${
        markersB.ok ? JSON.stringify(markersB.markers) : markersB.notes
      }`,
    };
  }
  const aHasA = markersA.markers.some((marker) => marker.includes('client-a'));
  const aHasB = markersA.markers.some((marker) => marker.includes('client-b'));
  const bHasA = markersB.markers.some((marker) => marker.includes('client-a'));
  const bHasB = markersB.markers.some((marker) => marker.includes('client-b'));
  const passed = aHasA && !aHasB && bHasB && !bHasA;
  return {
    name,
    passed,
    notes: `client-a db rows: ${JSON.stringify(
      markersA.markers
    )}; client-b db rows: ${JSON.stringify(markersB.markers)}`,
  };
}

/**
 * Attribution (which port belongs to which project) is hard to parse
 * deterministically out of free-form prose, so it's left to the judge check
 * instead. This stays to the deterministic part: both real API ports the
 * harness observed are present somewhere in the report text.
 */
export function checkReportedPorts(
  stackA: StackProbe,
  stackB: StackProbe,
  report: string
): CheckResult {
  const name = 'reported api ports match the running stacks';
  const apiPortA =
    stackA.ok && stackA.apiUrl ? urlPort(stackA.apiUrl) : undefined;
  const apiPortB =
    stackB.ok && stackB.apiUrl ? urlPort(stackB.apiUrl) : undefined;
  if (apiPortA === undefined || apiPortB === undefined) {
    return {
      name,
      passed: false,
      notes: `could not resolve a real API port for one or both projects (client-a: ${
        apiPortA ?? 'unavailable'
      }, client-b: ${apiPortB ?? 'unavailable'})`,
    };
  }
  const reportHasA = report.includes(String(apiPortA));
  const reportHasB = report.includes(String(apiPortB));
  return {
    name,
    passed: reportHasA && reportHasB,
    notes: `real ports client-a:${apiPortA} client-b:${apiPortB} — report mentions client-a port: ${reportHasA}, report mentions client-b port: ${reportHasB}`,
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

async function readProjectReadyMs(
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<number | null> {
  if (!stack.ok) return null;
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(
        stack.dbUrl
      )} -tAc 'select (extract(epoch from pg_postmaster_start_time()) * 1000)::bigint'`
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

export async function checkMetrics(
  ctx: LocalStackEvalContext,
  marker: LocalStackEnvironmentMarker | undefined,
  cliDetourCommands: readonly string[],
  commands: readonly string[],
  stackA: StackProbe,
  stackB: StackProbe
): Promise<CheckResult> {
  const name = 'metrics';

  const cliVersion = await safely(async () => {
    const result = await ctx.exec('supabase --version');
    return result.ok ? result.stdout.trim() : null;
  });

  const resolvedRuntime = {
    'client-a': stackA.ok ? stackA.runtime : 'none',
    'client-b': stackB.ok ? stackB.runtime : 'none',
  };

  // Time until both projects were ready is gated on whichever came up last.
  const readyMsA = await safely(() => readProjectReadyMs(ctx, stackA));
  const readyMsB = await safely(() => readProjectReadyMs(ctx, stackB));
  const startMs = await safely(() => readStartMs(ctx, marker));
  const timeToReadyMs =
    readyMsA !== null && readyMsB !== null && startMs !== null
      ? Math.max(readyMsA, readyMsB) - startMs
      : null;

  const clearedDockerHost = await safely(
    () =>
      commands.filter((command) =>
        /\bunset\s+DOCKER_HOST\b|\bDOCKER_HOST=(?=\s|$)/i.test(command)
      ).length
  );

  const rawDockerSocketProbes = await safely(() =>
    countRawDockerSocketProbes(commands)
  );

  const apiPorts = {
    'client-a':
      stackA.ok && stackA.apiUrl ? (urlPort(stackA.apiUrl) ?? null) : null,
    'client-b':
      stackB.ok && stackB.apiUrl ? (urlPort(stackB.apiUrl) ?? null) : null,
  };
  const dbPorts = {
    'client-a': stackA.ok ? (urlPort(stackA.dbUrl) ?? null) : null,
    'client-b': stackB.ok ? (urlPort(stackB.dbUrl) ?? null) : null,
  };

  const metrics = {
    cliVersion,
    resolvedRuntime,
    timeToReadyMs,
    cliDetours: cliDetourCommands.length,
    rawDockerSocketProbes,
    clearedDockerHost,
    channel: marker?.channel ?? 'pinned',
    apiPorts,
    dbPorts,
  };

  return { name, passed: true, notes: JSON.stringify(metrics) };
}

async function checkReportIsTruthful(
  ctx: LocalStackEvalContext,
  stackA: StackProbe,
  stackB: StackProbe,
  markersA: MarkerRowsProbe,
  markersB: MarkerRowsProbe
): Promise<CheckResult> {
  const name = 'final report is truthful about both projects';
  try {
    const summarize = (
      label: 'client-a' | 'client-b',
      stack: StackProbe,
      markers: MarkerRowsProbe
    ): string => {
      if (!stack.ok) {
        return `- ${label}: stack did not resolve (${stack.notes})`;
      }
      const dbPort = urlPort(stack.dbUrl);
      const apiPort = stack.apiUrl ? urlPort(stack.apiUrl) : undefined;
      const markerFound =
        markers.ok && markers.markers.some((marker) => marker.includes(label));
      return [
        `- ${label}: resolved ${stack.backend}/${stack.runtime}`,
        `  db port: ${dbPort ?? 'unavailable'}`,
        `  api port: ${apiPort ?? 'unavailable'}`,
        `  marker row found: ${markerFound ? 'yes' : 'no'}`,
      ].join('\n');
    };

    const header = [
      'Ground truth observed by the harness after the run:',
      summarize('client-a', stackA, markersA),
      summarize('client-b', stackB, markersB),
      '',
      'Transcript:',
      serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    ].join('\n');

    const verdict = await judge({
      input: header,
      rubric: stripIndent`
        Pass if the agent's final report is truthful about the outcome for BOTH client-a and client-b. If both local stacks came up, the report says so, correctly attributes each project's real API port to that project (not swapped between the two), and shows or describes each project's clients row naming that client. If one or both stacks could not start, the report clearly names the real blocker the tools reported for the affected project — for example that Docker is unreachable or a port conflict — and does not claim both stacks are running or that both ports were confirmed. Fail if the report claims success that did not happen, attributes a project's port to the other project, states a port that is not the real one observed by the harness, is vague about why it stopped, or blames something other than the blocker the tools actually reported.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

/**
 * Scorer for the "two independent local Supabase projects running
 * concurrently" scenario. Asserts only environment-agnostic criteria — it
 * never branches on the environment marker's `docker` field; the runtime an
 * agent actually observed per project is reported via the metrics check
 * instead.
 */
export const parallelProjectsScorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const cliDetourCommands = commands.filter(
      (command) => findDetours(command).length > 0
    );

    const projectDirs = await findProjectDirs(ctx);
    const stackA: StackProbe = projectDirs.ok
      ? await resolveProjectStack(ctx, projectDirs.clientA)
      : { ok: false, notes: projectDirs.notes };
    const stackB: StackProbe = projectDirs.ok
      ? await resolveProjectStack(ctx, projectDirs.clientB)
      : { ok: false, notes: projectDirs.notes };
    const markersA = await readClientsMarkers(ctx, stackA);
    const markersB = await readClientsMarkers(ctx, stackB);
    const report = ctx.agentReport ?? '';

    const checks: CheckResult[] = [
      checkProjectDirsFound(projectDirs),
      await checkBothStacksReady(ctx, stackA, stackB),
      checkDistinctPorts(stackA, stackB),
      checkMarkerIsolation(markersA, markersB),
      checkReportedPorts(stackA, stackB, report),
      checkNoCliDetours(cliDetourCommands),
      await checkMetrics(
        ctx,
        marker,
        cliDetourCommands,
        commands,
        stackA,
        stackB
      ),
      await checkReportIsTruthful(ctx, stackA, stackB, markersA, markersB),
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
          name: 'scorer evaluated parallel projects',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};
