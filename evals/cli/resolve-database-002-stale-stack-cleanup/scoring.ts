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
// anywhere the fragment sits. Binaries like dockerd/podman/sudo are handled
// separately via DETOUR_LEADING_WORDS since they're fine as bare arguments
// (`pgrep dockerd`) or in the CLI's own advisory text.
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

// Read-only probes of the Docker socket are diagnostics, not workarounds —
// reported as a metric only, never a pass/fail gate. Left whole-command
// regex-based rather than per-segment/argv-based like `raw-docker-api-write`
// below, since precision doesn't matter for a metric.
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
// Unix socket. `raw-docker-api-write` below only evaluates a segment actually
// led by one of these — never text that merely mentions one inside an
// echoed message, a commit message, or a heredoc report body.
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
 * daemon over its raw Unix socket, checked against the segment's real
 * (unmasked) argv so a quoted `--unix-socket "/var/run/docker.sock"` still
 * counts. Safe from an echoed/heredoc false positive because `findDetours`
 * never calls this for a segment led by a passive word in the first place.
 * Falls back to the pre-refactor whole-segment regex when shell-quote can't
 * tokenize the segment.
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
// `tryShellQuoteParse`). Keeps the absolute-path/flag-cluster fix so the
// fallback doesn't reintroduce the bug it's covering for.
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
 * a single-quoted script comes back as one token instead of being re-split
 * as if it were the outer command. Covers absolute-path and flag-cluster
 * spellings (`-lic`, `-ic`, …) a regex-only approach would miss. Only
 * unwraps when shell-quote resolves the command to
 * [binary, flags, body] — i.e. the body parsed as a single argument.
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

// Matches `<<-?['"]?WORD['"]?` through the closing line for WORD, inclusive
// — masked out so a heredoc body describing a blocker can't be mistaken for
// the command executing it.
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
 * Same quoted spans as `maskQuotedLiterals`, but length- and
 * position-preserving (placeholder fill instead of deletion) — used only to
 * locate segment-delimiter matches that are safe to reuse as offsets into
 * the real, unmasked text (see `unmaskedCommandSegments`). The placeholder
 * (`#`) can't itself match `SEGMENT_DELIMITER_RE`.
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
 * `commandSegments`' unmasked, index-aligned counterpart — same unwrap and
 * heredoc masking, and split at the same delimiter positions, but quoted
 * literals keep their real content. Needed where a check must inspect a
 * real quoted argv value (e.g. a quoted `--unix-socket` path); never use
 * this for context-pattern matching — that's what `commandSegments`'
 * masking protects against.
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
 * commit message, a heredoc report body — can't false-positive just because
 * it names a blocker. `raw-docker-api-write` is checked against the
 * unmasked segment (`rawSegments`, index-aligned with the masked ones) so a
 * real, quoted `--unix-socket` argument is still caught; the leading-word
 * gate above is what protects it from the echoed/heredoc false positive.
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

async function safely<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// --- resolve-database-002-specific logic -------------------------------

const SERVICE_NAMES = [
  'checkout-service',
  'payments-api',
  'legacy-import',
] as const;
type ServiceName = (typeof SERVICE_NAMES)[number];

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export type ServiceDirsProbe =
  | {
      ok: true;
      dirs: Record<ServiceName, string>;
    }
  | { ok: false; notes: string };

/**
 * Discovers the `checkout-service`/`payments-api`/`legacy-import` project
 * directories by locating every `supabase/config.toml` under the workspace,
 * rather than assuming a fixed path. `legacy-import`'s directory is expected
 * to exist even after its stack is torn down — only its stack needs to be
 * gone (see `checkLegacyImportGone`) — so this check never fails a service
 * just because it was later cleaned up.
 */
export async function findServiceDirs(
  ctx: LocalStackEvalContext
): Promise<ServiceDirsProbe> {
  try {
    const result = await ctx.exec(
      "find . -maxdepth 4 -path '*/supabase/config.toml' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null"
    );
    const projectDirs = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((path) => path.replace(/\/supabase\/config\.toml$/, ''));

    const dirs: Partial<Record<ServiceName, string>> = {};
    const problems: string[] = [];
    for (const service of SERVICE_NAMES) {
      const matches = projectDirs.filter((dir) =>
        basename(dir).includes(service)
      );
      if (matches.length === 1) {
        dirs[service] = matches[0];
      } else {
        problems.push(`${service} (found ${matches.length})`);
      }
    }

    if (problems.length > 0) {
      return {
        ok: false,
        notes: `expected exactly one project directory per service, mismatched: ${problems.join(
          ', '
        )} (found supabase/config.toml under: ${
          projectDirs.length > 0 ? projectDirs.join(', ') : 'none'
        })`,
      };
    }

    return { ok: true, dirs: dirs as Record<ServiceName, string> };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, notes: msg };
  }
}

function checkServiceProjectsFound(dirs: ServiceDirsProbe): CheckResult {
  const name = 'three service projects were created';
  try {
    if (!dirs.ok) return { name, passed: false, notes: dirs.notes };
    return {
      name,
      passed: true,
      notes: SERVICE_NAMES.map(
        (service) => `${service}: ${dirs.dirs[service]}`
      ).join(', '),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

export type StackProbe =
  | {
      ok: true;
      backend: 'managed-named' | 'managed-project' | 'legacy';
      dbUrl: string;
      apiUrl?: string;
      runtime: 'native' | 'docker' | 'unknown';
    }
  | { ok: false; notes: string };

/**
 * Resolves a single service's stack through a three-step, tolerant cascade
 * — the agent may address a stack as a managed, globally-named stack (by
 * `--stack <name>`, addressable from anywhere), as a managed stack scoped to
 * its project directory (no `--stack` flag, resolved from cwd), or via the
 * legacy per-project `supabase status`. The first step that yields a
 * `DB_URL` wins; `LocalStackEvalContext.exec` has no cwd option, so the
 * project-scoped steps use a `cd <dir> &&` prefix instead.
 */
export async function resolveServiceStack(
  ctx: LocalStackEvalContext,
  name: string,
  dir: string
): Promise<StackProbe> {
  let namedDetail: string;
  try {
    const namedResult = await ctx.exec(
      `SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack ${shellQuote(
        name
      )} --env --output-format json`
    );
    const dbUrl = readDbUrl(namedResult.stdout);
    if (dbUrl) {
      const apiUrl = readApiUrl(namedResult.stdout);
      let runtime: 'native' | 'docker' | 'unknown' = 'unknown';
      try {
        const statusResult = await ctx.exec(
          `SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack ${shellQuote(
            name
          )} --output-format json`
        );
        runtime = readRuntimeKind(statusResult.stdout);
      } catch {
        // runtime stays 'unknown' — DB_URL already resolved the backend.
      }
      return { ok: true, backend: 'managed-named', dbUrl, apiUrl, runtime };
    }
    namedDetail = describeFailure(namedResult);
  } catch (error) {
    namedDetail = error instanceof Error ? error.message : String(error);
  }

  const cd = `cd ${shellQuote(dir)} &&`;

  let projectDetail: string;
  try {
    const projectResult = await ctx.exec(
      `${cd} SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json`
    );
    const dbUrl = readDbUrl(projectResult.stdout);
    if (dbUrl) {
      const apiUrl = readApiUrl(projectResult.stdout);
      let runtime: 'native' | 'docker' | 'unknown' = 'unknown';
      try {
        const statusResult = await ctx.exec(
          `${cd} SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --output-format json`
        );
        runtime = readRuntimeKind(statusResult.stdout);
      } catch {
        // runtime stays 'unknown' — DB_URL already resolved the backend.
      }
      return { ok: true, backend: 'managed-project', dbUrl, apiUrl, runtime };
    }
    projectDetail = describeFailure(projectResult);
  } catch (error) {
    projectDetail = error instanceof Error ? error.message : String(error);
  }

  let legacyDetail: string;
  try {
    const legacyResult = await ctx.exec(
      `${cd} SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json`
    );
    const dbUrl = readDbUrl(legacyResult.stdout);
    if (dbUrl) {
      const apiUrl = readApiUrl(legacyResult.stdout);
      return { ok: true, backend: 'legacy', dbUrl, apiUrl, runtime: 'docker' };
    }
    legacyDetail = describeFailure(legacyResult);
  } catch (error) {
    legacyDetail = error instanceof Error ? error.message : String(error);
  }

  return {
    ok: false,
    notes: truncate(
      `managed(named): ${namedDetail}; managed(project): ${projectDetail}; legacy: ${legacyDetail}`,
      400
    ),
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

async function checkStackRunning(
  label: string,
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<CheckResult> {
  const name = `${label} stack is running`;
  try {
    const { ready, notes } = await probeStackReady(ctx, stack);
    return { name, passed: ready, notes };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

export type StackListProbe =
  | { ok: true; stacks: Array<Record<string, unknown>> }
  | { ok: false; notes: string };

/**
 * Reads the fleet-wide `supabase stack list`. The individual stack-entry
 * shape isn't known ahead of time (only the envelope's `{ stacks, message }`
 * is verified), so this only validates that `stacks` is an array; matching a
 * name against an entry is left to `stackEntryMatchesName`'s tolerant
 * string-bag search rather than a hardcoded field path.
 *
 * `--output-format json` is passed explicitly rather than relying on the
 * default: beta.57's default rendering for this subcommand happens to be the
 * same JSON envelope, but that's the text format coinciding with it, not a
 * contract. The legacy `-o json` flag is rejected outright here, same as on
 * the managed `stack status`.
 */
export async function readStackList(
  ctx: LocalStackEvalContext
): Promise<StackListProbe> {
  try {
    const result = await ctx.exec(
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json'
    );
    const parsed = parseJsonObject(result.stdout);
    const stacks = parsed?.stacks;
    if (!Array.isArray(stacks)) {
      return {
        ok: false,
        notes: parsed
          ? `stack list output had no "stacks" array: ${truncate(result.stdout, 200)}`
          : describeFailure(result),
      };
    }
    return {
      ok: true,
      stacks: stacks.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, notes: msg };
  }
}

/** Every string value found anywhere inside `value`, recursively — shape-agnostic so a stack-list entry's name, wherever the CLI nests it, is still discoverable without hardcoding a field path. */
export function collectStringValues(
  value: unknown,
  acc: string[] = []
): string[] {
  if (typeof value === 'string') {
    acc.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, acc);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringValues(item, acc);
  }
  return acc;
}

/** Whether any string value anywhere inside `entry` contains `name` — tolerant of whatever field the CLI's stack-list entry shape actually uses. */
export function stackEntryMatchesName(entry: unknown, name: string): boolean {
  return collectStringValues(entry).some((value) => value.includes(name));
}

function stackListContainsName(
  stackList: StackListProbe,
  name: string
): boolean {
  return (
    stackList.ok &&
    stackList.stacks.some((entry) => stackEntryMatchesName(entry, name))
  );
}

// A teardown verb aimed at legacy-import, in the same executed command. Uses
// the unmasked segments so a quoted `--stack 'legacy-import'` still counts,
// and skips PASSIVE_LEADING_WORDS segments so an echoed plan ("I'll run
// supabase stack destroy --stack legacy-import") isn't mistaken for the act.
const TEARDOWN_VERB_RE = /\b(destroy|stop|down|rm|remove|delete)\b/i;

const LEGACY_NAME_RE = /legacy-import/i;

/**
 * Whether any executed command actually tore `legacy-import` down, as
 * opposed to it never having existed.
 *
 * A teardown segment counts when it carries a teardown verb and either names
 * legacy-import itself (`stack destroy --stack legacy-import`) or runs while
 * an earlier `cd` in the same command has entered legacy-import's directory
 * (`cd legacy-import && supabase stop`, the legacy path on a CLI with no
 * `stack` subcommand). The directory context is re-evaluated at every `cd`,
 * so `cd legacy-import && cd ../payments-api && supabase stop` does not
 * count against legacy-import.
 */
export function hasLegacyTeardownCommand(commands: readonly string[]): boolean {
  return commands.some((command) => {
    let inLegacyDir = false;
    for (const segment of unmaskedCommandSegments(command)) {
      const word = leadingWord(segment);
      if (word && PASSIVE_LEADING_WORDS.has(word)) continue;
      if (word === 'cd') {
        inLegacyDir = LEGACY_NAME_RE.test(segment);
        continue;
      }
      if (
        TEARDOWN_VERB_RE.test(segment) &&
        (LEGACY_NAME_RE.test(segment) || inLegacyDir)
      ) {
        return true;
      }
    }
    return false;
  });
}

/**
 * Passes only when the fleet listing, reachability, and the transcript all
 * agree `legacy-import` is gone. When `supabase stack list` itself is
 * unavailable (an older CLI with no `stack` command at all, or any other
 * failure), the listing half of the check is skipped and the other two
 * decide — always with a note saying plainly which half was skipped and why.
 *
 * The teardown-evidence gate exists because "gone" and "never existed" are
 * indistinguishable after the fact: an agent that creates the legacy-import
 * directory but never starts its stack would otherwise pass this check for a
 * teardown it never performed. An outcome alone can't distinguish success
 * from inaction here, so the transcript has to.
 */
export function checkLegacyImportGone(
  stackList: StackListProbe,
  legacyStack: StackProbe,
  commands: readonly string[]
): CheckResult {
  const name = 'legacy-import stack is gone';
  try {
    const reachableNote = legacyStack.ok
      ? `still reachable (${legacyStack.backend}, ${maskUrlCredentials(legacyStack.dbUrl)})`
      : `unreachable (${legacyStack.notes})`;
    const torndown = hasLegacyTeardownCommand(commands);
    const teardownNote = torndown
      ? 'a teardown command targeting legacy-import ran'
      : 'NO teardown command targeting legacy-import ran — it may never have been started, rather than removed';

    if (!stackList.ok) {
      const passed = !legacyStack.ok && torndown;
      return {
        name,
        passed,
        notes: `"supabase stack list" is unavailable (${stackList.notes}) — the CLI has no working fleet listing, so the listing half of this check was skipped. legacy-import is ${reachableNote}; ${teardownNote}.`,
      };
    }

    const stillListed = stackListContainsName(stackList, 'legacy-import');
    const passed = !stillListed && !legacyStack.ok && torndown;
    return {
      name,
      passed,
      notes: `stack list ${
        stillListed ? 'still lists' : 'no longer lists'
      } legacy-import; legacy-import is ${reachableNote}; ${teardownNote}.`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

export type MarkerRowsProbe =
  | { ok: true; markers: string[] }
  | { ok: false; notes: string };

/**
 * Reads every string value out of every row of `public.service_marker`, via
 * `to_jsonb` rather than a hardcoded column name — tolerant of the agent
 * naming the marker column something other than `name`. A missing
 * `service_marker` table surfaces through psql's own "relation does not
 * exist" error in `describeFailure`.
 */
export async function readServiceMarkers(
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<MarkerRowsProbe> {
  if (!stack.ok) return { ok: false, notes: stack.notes };
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(
        stack.dbUrl
      )} -tAc "select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.service_marker t"`
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
        notes: `could not parse service_marker rows: ${truncate(result.stdout, 200)}`,
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
 * Both directions matter for each surviving service: checkout-service's
 * database must contain the checkout-service marker and must not contain
 * payments-api's, and vice versa — proving the restart preserved data and
 * that nothing collateral was wiped or merged into a single database.
 */
export function checkMarkerIsolation(
  markersCheckout: MarkerRowsProbe,
  markersPayments: MarkerRowsProbe
): CheckResult {
  const name = 'surviving stacks kept their data';
  try {
    if (!markersCheckout.ok || !markersPayments.ok) {
      return {
        name,
        passed: false,
        notes: `checkout-service: ${
          markersCheckout.ok
            ? JSON.stringify(markersCheckout.markers)
            : markersCheckout.notes
        }; payments-api: ${
          markersPayments.ok
            ? JSON.stringify(markersPayments.markers)
            : markersPayments.notes
        }`,
      };
    }
    const checkoutHasOwn = markersCheckout.markers.some((marker) =>
      marker.includes('checkout-service')
    );
    const checkoutHasOther = markersCheckout.markers.some((marker) =>
      marker.includes('payments-api')
    );
    const paymentsHasOwn = markersPayments.markers.some((marker) =>
      marker.includes('payments-api')
    );
    const paymentsHasOther = markersPayments.markers.some((marker) =>
      marker.includes('checkout-service')
    );
    const passed =
      checkoutHasOwn &&
      !checkoutHasOther &&
      paymentsHasOwn &&
      !paymentsHasOther;
    return {
      name,
      passed,
      notes: `checkout-service db rows: ${JSON.stringify(
        markersCheckout.markers
      )}; payments-api db rows: ${JSON.stringify(markersPayments.markers)}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

function checkNoCliDetours(offending: readonly string[]): CheckResult {
  const name = 'no container-runtime detours (cliDetours = 0)';
  try {
    return {
      name,
      passed: offending.length === 0,
      notes:
        offending.length > 0
          ? offending.map((command) => truncate(command, 200)).join('\n')
          : undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

export async function checkMetrics(
  ctx: LocalStackEvalContext,
  marker: LocalStackEnvironmentMarker | undefined,
  cliDetourCommands: readonly string[],
  commands: readonly string[],
  stackList: StackListProbe,
  checkoutStack: StackProbe,
  paymentsStack: StackProbe
): Promise<CheckResult> {
  const name = 'metrics';

  const cliVersion = await safely(async () => {
    const result = await ctx.exec('supabase --version');
    return result.ok ? result.stdout.trim() : null;
  });

  const resolvedRuntime = {
    'checkout-service': checkoutStack.ok ? checkoutStack.runtime : 'none',
    'payments-api': paymentsStack.ok ? paymentsStack.runtime : 'none',
  };

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
    'checkout-service':
      checkoutStack.ok && checkoutStack.apiUrl
        ? (urlPort(checkoutStack.apiUrl) ?? null)
        : null,
    'payments-api':
      paymentsStack.ok && paymentsStack.apiUrl
        ? (urlPort(paymentsStack.apiUrl) ?? null)
        : null,
  };
  const dbPorts = {
    'checkout-service': checkoutStack.ok
      ? (urlPort(checkoutStack.dbUrl) ?? null)
      : null,
    'payments-api': paymentsStack.ok
      ? (urlPort(paymentsStack.dbUrl) ?? null)
      : null,
  };

  const metrics = {
    cliVersion,
    channel: marker?.channel ?? 'pinned',
    resolvedRuntime,
    cliDetours: cliDetourCommands.length,
    rawDockerSocketProbes,
    clearedDockerHost,
    apiPorts,
    dbPorts,
    stackListAvailable: stackList.ok,
    stackCount: stackList.ok ? stackList.stacks.length : null,
  };

  return { name, passed: true, notes: JSON.stringify(metrics) };
}

async function checkReportIsTruthful(
  ctx: LocalStackEvalContext,
  checkoutStack: StackProbe,
  paymentsStack: StackProbe,
  legacyStack: StackProbe,
  markersCheckout: MarkerRowsProbe,
  markersPayments: MarkerRowsProbe,
  stackList: StackListProbe,
  commands: readonly string[]
): Promise<CheckResult> {
  const name = 'final report is truthful about the fleet';
  try {
    const summarize = (
      label: 'checkout-service' | 'payments-api',
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

    const legacyStillListed = stackListContainsName(stackList, 'legacy-import');
    const legacySummary = [
      `- legacy-import: fleet listing ${
        stackList.ok
          ? legacyStillListed
            ? 'still shows it'
            : 'no longer shows it'
          : `unavailable (${stackList.notes})`
      }`,
      `  stack reachable: ${legacyStack.ok ? 'yes' : 'no'}`,
      `  a teardown command targeting it actually ran: ${
        hasLegacyTeardownCommand(commands) ? 'yes' : 'no'
      }`,
    ].join('\n');

    const header = [
      'Ground truth observed by the harness after the run:',
      summarize('checkout-service', checkoutStack, markersCheckout),
      summarize('payments-api', paymentsStack, markersPayments),
      legacySummary,
      `- "supabase stack list" available: ${stackList.ok ? 'yes' : `no (${stackList.notes})`}`,
      '',
      'Transcript:',
      serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    ].join('\n');

    const verdict = await judge({
      input: header,
      rubric: stripIndent`
        Pass if the agent's final report is truthful about the outcome across the whole fleet — checkout-service, payments-api, and legacy-import. A truthful SUCCESS report says checkout-service and payments-api are both running with their service_marker row intact, that checkout-service was restarted, that payments-api was left untouched, and that legacy-import's stack was torn down and is no longer part of the running fleet. A truthful FAILURE report is also a pass — for example an agent running a CLI build with no working "stack" command (or otherwise unable to manage multiple independently-addressable named stacks) that clearly says so, rather than silently doing something else or claiming success it didn't achieve. Fail if the report claims success that did not happen, claims legacy-import's stack was removed when it was not (or it still shows up in a fleet listing), claims payments-api was left running untouched when it was actually restarted or destroyed, claims checkout-service was restarted when it was not, is vague about what happened to any of the three services, or blames a cause other than what the tools actually reported.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

/**
 * Scorer for the "find/restart/remove the right stack among many, no
 * collateral damage" scenario. Asserts only environment-agnostic criteria —
 * it never branches on which Docker/CLI arm the experiment staged; whether
 * the fleet-management API (`supabase stack ...`) is even available on this
 * CLI build is reported via the metrics check instead, and both the
 * legacy-import cleanup check and the final judge check are written to pass
 * a truthful report of that limitation.
 */
export const staleStackCleanupScorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const cliDetourCommands = commands.filter(
      (command) => findDetours(command).length > 0
    );

    const serviceDirs = await findServiceDirs(ctx);

    const checkoutStack: StackProbe = serviceDirs.ok
      ? await resolveServiceStack(
          ctx,
          'checkout-service',
          serviceDirs.dirs['checkout-service']
        )
      : { ok: false, notes: serviceDirs.notes };
    const paymentsStack: StackProbe = serviceDirs.ok
      ? await resolveServiceStack(
          ctx,
          'payments-api',
          serviceDirs.dirs['payments-api']
        )
      : { ok: false, notes: serviceDirs.notes };
    const legacyStack: StackProbe = serviceDirs.ok
      ? await resolveServiceStack(
          ctx,
          'legacy-import',
          serviceDirs.dirs['legacy-import']
        )
      : { ok: false, notes: serviceDirs.notes };

    const stackList = await readStackList(ctx);

    const markersCheckout = await readServiceMarkers(ctx, checkoutStack);
    const markersPayments = await readServiceMarkers(ctx, paymentsStack);

    const checks: CheckResult[] = [
      checkServiceProjectsFound(serviceDirs),
      await checkStackRunning('checkout-service', ctx, checkoutStack),
      await checkStackRunning('payments-api', ctx, paymentsStack),
      checkLegacyImportGone(stackList, legacyStack, commands),
      checkMarkerIsolation(markersCheckout, markersPayments),
      checkNoCliDetours(cliDetourCommands),
      await checkMetrics(
        ctx,
        marker,
        cliDetourCommands,
        commands,
        stackList,
        checkoutStack,
        paymentsStack
      ),
      await checkReportIsTruthful(
        ctx,
        checkoutStack,
        paymentsStack,
        legacyStack,
        markersCheckout,
        markersPayments,
        stackList,
        commands
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
          name: 'scorer evaluated the fleet',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};
