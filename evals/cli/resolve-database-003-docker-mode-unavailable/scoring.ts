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
import { skipEnvOptions } from '../lib/detours.js';

// ---------------------------------------------------------------------------
// A. Command extraction and shell parsing
//
// Shared with evals/cli/build-database-002-stack-lifecycle's scoring.ts
// (supabase/evals#281) — unwrap/mask/segment/leadingTokens are copied
// verbatim from there so both evals agree on what counts as an executable
// segment.
// ---------------------------------------------------------------------------

const SHELL_WRAPPER_BINARIES = new Set(['bash', 'sh', 'zsh']);
const SHELL_WRAPPER_FLAG_RE = /^-\S*c\S*$/;
const SHELL_WRAPPER_RE = /^\s*(?:\S*\/)?(?:bash|sh|zsh)\s+-\S*c\S*\s+/;
const MAX_UNWRAP_DEPTH = 3;

/** Best-effort tokenization via shell-quote; undefined on a throw so callers fall back to a regex-based path — a scorer must never crash on a weird agent command. */
function tryShellQuoteParse(text: string): ParseEntry[] | undefined {
  try {
    return shellQuoteParse(text);
  } catch {
    return undefined;
  }
}

/** Detects a `[/path/to/]bash|sh|zsh -<flags>c<flags> '<script>'` wrapper via shell-quote's own tokenizer, so a single-quoted script parses as one token. Only unwraps when shell-quote resolves the command to exactly [binary, flags, body]. */
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
  const bin = binary.slice(binary.lastIndexOf('/') + 1);
  if (!SHELL_WRAPPER_BINARIES.has(bin) || !SHELL_WRAPPER_FLAG_RE.test(flags)) {
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

/** Repeatedly strips a leading `bash|sh|zsh -lc '…'`-style wrapper whose body is a single argument, up to MAX_UNWRAP_DEPTH times. */
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
// inclusive — masked out entirely so a heredoc body can't be mistaken for
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

/** Same quoted spans as `maskQuotedLiterals`, but length- and position-preserving (placeholder fill), so delimiter offsets stay valid indexes into the real, unmasked text. */
function maskQuotedLiteralsPreservingOffsets(text: string): string {
  const fill = (match: string) =>
    `${match[0]}${'#'.repeat(match.length - 2)}${match[0]}`;
  return text.replace(/"[^"]*"/g, fill).replace(/'[^']*'/g, fill);
}

const SEGMENT_DELIMITER_RE = /\n|;|&&|\|\||\||\(|(?<![<>&\d])&(?![&>])/;

/** Unwraps a leading shell wrapper, masks quoted/heredoc literals, then splits into executable segments. Use for context-pattern detour matching, never for reading a real argv value. */
export function commandSegments(command: string): string[] {
  const body = maskLiterals(unwrapShell(command));
  return body
    .split(SEGMENT_DELIMITER_RE)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** `commandSegments`' unmasked, index-aligned counterpart — same unwrap, heredoc masking, and split points, but quoted literals keep their real content. Use when a check must read a real quoted argv value (a quoted `--runtime "docker"`, a `--unix-socket` path). */
export function unmaskedCommandSegments(command: string): string[] {
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
        const envTokens = rest.split(/\s+/);
        rest = envTokens.slice(skipEnvOptions(envTokens, 0).next).join(' ');
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

// ---------------------------------------------------------------------------
// B. Detours (check 6)
// ---------------------------------------------------------------------------

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

export const RAW_SOCKET_PROBE_PATTERNS: RegExp[] = [
  /--unix-socket\s+\S*docker\.sock/i,
  /\bdocker\b[^\n]*\s-H\s*unix:\/\//i,
  /\bDOCKER_HOST=unix:\/\//i,
];
const RAW_SOCKET_RE = /--unix-socket\s+\S*docker\.sock/i;
const MUTATING_HTTP_RE =
  /(?:^|\s)-X\s*(?:POST|PUT|DELETE)\b|--data(?:-binary|-raw|-urlencode)?\b|(?:^|\s)-d\s/i;

export const DETOUR_LEADING_WORDS = new Set([
  'sudo',
  'dockerd',
  'containerd',
  'podman',
  'nerdctl',
]);

const HTTP_CLIENT_LEADING_WORDS = new Set(['curl', 'wget', 'http', 'httpie']);
const UNIX_SOCKET_FLAG_RE = /^--unix-socket(?:=(.*))?$/;
const MUTATING_METHOD_ARG_RE = /^(?:POST|PUT|DELETE)$/i;
const DATA_FLAG_RE =
  /^(?:-d|--data|--data-binary|--data-raw|--data-urlencode)(?:=.*)?$/;

function hasRawSocketArg(argv: readonly string[]): boolean {
  return argv.some((token, i) => {
    const match = token.match(UNIX_SOCKET_FLAG_RE);
    if (!match) return false;
    const value = match[1] ?? argv[i + 1];
    return Boolean(value && /docker\.sock/i.test(value));
  });
}

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

const SUDO_PROBE_ARGS = new Set([
  '-n',
  '-v',
  '-l',
  '-h',
  '--help',
  '--version',
  'true',
]);

// Segments led by these are almost always describing/quoting a blocker, not
// executing one — their content is excluded from detour matching entirely.
const PASSIVE_LEADING_WORDS = new Set(['echo', 'printf', 'cat', 'tee', 'git']);

function isSudoProbe(remainingTokens: readonly string[]): boolean {
  return (
    remainingTokens.length > 0 &&
    remainingTokens.every((token) => SUDO_PROBE_ARGS.has(token))
  );
}

// `docker-host-override` — specific to this eval: the sandbox points
// DOCKER_HOST at an unreachable address on purpose; clearing or
// redirecting it is a detour around the staged blocker, not a fix.
const DOCKER_HOST_UNSET_RE = /\bunset\s+DOCKER_HOST\b/;
const DOCKER_HOST_EXPORT_RE = /\bexport\s+DOCKER_HOST=(\S*)/;
const DOCKER_HOST_ASSIGN_RE = /(?:^|\s)DOCKER_HOST=(\S*)/;
const ENV_UNSET_DOCKER_HOST_RE =
  /\benv\b[^\n]*(?:-u\s+|--unset[=\s]\s*)DOCKER_HOST\b/;
const STAGED_DOCKER_HOST = 'tcp://127.0.0.1:1';

function isDockerHostOverride(
  rawSegment: string,
  isStartAttemptSegment: boolean
): boolean {
  if (DOCKER_HOST_UNSET_RE.test(rawSegment)) return true;
  const exportMatch = rawSegment.match(DOCKER_HOST_EXPORT_RE);
  if (exportMatch && exportMatch[1] !== STAGED_DOCKER_HOST) return true;
  if (isStartAttemptSegment) {
    const assignMatch = rawSegment.match(DOCKER_HOST_ASSIGN_RE);
    if (assignMatch && assignMatch[1] !== STAGED_DOCKER_HOST) return true;
    if (ENV_UNSET_DOCKER_HOST_RE.test(rawSegment)) return true;
  }
  return false;
}

// `manual-stack-state-edit` — a segment that changes managed-stack state on
// disk outside the CLI. Whether it's a detour depends on the start timeline
// (see `isRecoveryStateEdit`): a hand-edit used for recovery right after a
// failed docker start, ahead of a later non-docker start, isn't penalised —
// anywhere else in the timeline, it is.
const STACK_STATE_PATH_RE = /(?:~|\$HOME|\/root)\/\.supabase\/stacks\b/;
const REDIRECT_TO_STACK_STATE_RE =
  /(?:>>?)\s*['"]?(?:~|\$HOME|\/root)\/\.supabase\/stacks\b/;
const MANAGED_STACK_EDIT_LEADING_WORDS = new Set([
  'rm',
  'mv',
  'rmdir',
  'truncate',
]);

function isManualStackStateEdit(
  word: string | undefined,
  rawSegment: string
): boolean {
  if (!word) return false;
  if (REDIRECT_TO_STACK_STATE_RE.test(rawSegment)) return true;
  if (!STACK_STATE_PATH_RE.test(rawSegment)) return false;
  if (MANAGED_STACK_EDIT_LEADING_WORDS.has(word)) return true;
  if (word === 'sed' && /(?:^|\s)-i\b/.test(rawSegment)) return true;
  if (word === 'find' && /(?:^|\s)-delete\b/.test(rawSegment)) return true;
  return false;
}

/**
 * Whether a manual-stack-state edit at `callIndex` is a legitimate recovery
 * step rather than a detour: it comes strictly after the first failed docker
 * attempt and strictly before a later non-docker start attempt (which
 * doesn't itself need to succeed).
 */
export function isRecoveryStateEdit(
  callIndex: number,
  timeline: readonly StartAttempt[]
): boolean {
  const firstFailedDocker = timeline.find(
    (a) => a.runtime === 'docker' && a.ok === false
  );
  if (!firstFailedDocker || callIndex <= firstFailedDocker.callIndex) {
    return false;
  }
  return timeline.some(
    (a) =>
      a.runtime !== 'docker' &&
      a.runtime !== 'invalid' &&
      a.callIndex > callIndex
  );
}

export interface DetourContext {
  callIndex: number;
  timeline: readonly StartAttempt[];
}

/**
 * Labels of every detour a command matches, evaluated per executable segment
 * (post unwrap+mask) so descriptive text can't false-positive just by naming
 * a blocker. `context` (this command's index and the run's start timeline)
 * lets `manual-stack-state-edit` tell a recovery edit from a detour.
 */
export function findDetours(
  command: string,
  context?: DetourContext
): string[] {
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

    const isStartAttemptSegment =
      classifyStartCommand(rawSegment, false) !== undefined;
    if (isDockerHostOverride(rawSegment, isStartAttemptSegment)) {
      labels.push('docker-host-override');
    }

    if (isManualStackStateEdit(word, rawSegment)) {
      const recovery =
        context !== undefined &&
        isRecoveryStateEdit(context.callIndex, context.timeline);
      if (!recovery) labels.push('manual-stack-state-edit');
    }
  }
  return labels;
}

/** Count of commands matching any read-only Docker-socket probe pattern. Metric only, never a detour. */
export function countRawDockerSocketProbes(
  commands: readonly string[]
): number {
  return commands.filter((command) =>
    RAW_SOCKET_PROBE_PATTERNS.some((pattern) => pattern.test(command))
  ).length;
}

/** `{recovery, detour}` counts of manual `~/.supabase/stacks` edits across the run. */
export function countManualStackStateEdits(
  commands: readonly string[],
  timeline: readonly StartAttempt[]
): { recovery: number; detour: number } {
  let recovery = 0;
  let detour = 0;
  commands.forEach((command, callIndex) => {
    if (!command) return;
    const segments = commandSegments(command);
    const rawSegments = unmaskedCommandSegments(command);
    for (let i = 0; i < segments.length; i++) {
      const word = leadingTokens(segments[i])[0];
      if (word && PASSIVE_LEADING_WORDS.has(word)) continue;
      const rawSegment = rawSegments[i] ?? segments[i];
      if (!isManualStackStateEdit(word, rawSegment)) continue;
      if (isRecoveryStateEdit(callIndex, timeline)) recovery++;
      else detour++;
    }
  });
  return { recovery, detour };
}

// ---------------------------------------------------------------------------
// C. Start attempts (checks 2, 4 and 5)
// ---------------------------------------------------------------------------

const GLOBAL_FLAGS_WITH_VALUE = new Set([
  '--workdir',
  '--profile',
  '--log-level',
  '--output-format',
  '--output',
  '-o',
  '--dns-resolver',
  '--completions',
  '--network-id',
  '--agent',
]);

function tokenizeSegment(segment: string): string[] | undefined {
  const tokens = tryShellQuoteParse(segment);
  if (tokens === undefined) {
    return segment.split(/\s+/).filter(Boolean);
  }
  return tokens.filter((t): t is string => typeof t === 'string');
}

function stripEnvPrefix(tokens: readonly string[]): {
  rest: string[];
  experimentalOn: boolean;
} {
  const rest = [...tokens];
  let i = 0;
  let experimentalOn = false;
  const isVarAssignment = (t: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(t);
  const checkVar = (t: string) => {
    const m = t.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && m[1] === 'SUPABASE_EXPERIMENTAL_STACK' && m[2] === '1') {
      experimentalOn = true;
    }
  };
  while (i < rest.length) {
    const t = rest[i];
    if (isVarAssignment(t)) {
      checkVar(t);
      i++;
      continue;
    }
    if (t === 'env') {
      i = skipEnvOptions(rest, i + 1).next;
      while (i < rest.length && isVarAssignment(rest[i])) {
        checkVar(rest[i]);
        i++;
      }
      continue;
    }
    if (t === 'exec' || t === 'command' || t === 'time' || t === 'nohup') {
      i++;
      continue;
    }
    if (t === 'timeout') {
      i += 2;
      continue;
    }
    break;
  }
  return { rest: rest.slice(i), experimentalOn };
}

function basename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1).toLowerCase();
}

function parseCliInvocation(
  tokens: readonly string[]
): { rest: string[] } | undefined {
  if (tokens.length === 0) return undefined;
  const bin = basename(tokens[0]);
  if (bin === 'supabase') return { rest: tokens.slice(1) };

  if (bin === 'npx') {
    let i = 1;
    while (tokens[i] === '-y' || tokens[i] === '--yes') i++;
    const pkg = tokens[i];
    if (!pkg || !/^supabase(?:@|$)/.test(pkg)) return undefined;
    return { rest: tokens.slice(i + 1) };
  }
  if (bin === 'bunx') {
    const pkg = tokens[1];
    if (!pkg || !/^supabase(?:@|$)/.test(pkg)) return undefined;
    return { rest: tokens.slice(2) };
  }
  if (bin === 'pnpm') {
    if (tokens[1] !== 'dlx' && tokens[1] !== 'exec') return undefined;
    const pkg = tokens[2];
    if (!pkg || !/^supabase(?:@|$)/.test(pkg)) return undefined;
    return { rest: tokens.slice(3) };
  }
  if (bin === 'yarn') {
    if (tokens[1] !== 'dlx') return undefined;
    const pkg = tokens[2];
    if (!pkg || !/^supabase(?:@|$)/.test(pkg)) return undefined;
    return { rest: tokens.slice(3) };
  }
  return undefined;
}

function skipGlobalFlags(tokens: readonly string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t.startsWith('-')) break;
    if (GLOBAL_FLAGS_WITH_VALUE.has(t)) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return tokens.slice(i);
}

export type StartRuntime = 'docker' | 'native' | 'auto' | 'default' | 'invalid';

export interface StartClassification {
  backend: 'managed' | 'legacy';
  runtime: StartRuntime;
}

/**
 * Classifies a single unmasked segment as a `supabase start` / `supabase
 * stack start` attempt, or undefined if it isn't one. `experimentalOnFromContext`
 * carries whether an earlier segment of the *same* command already exported
 * `SUPABASE_EXPERIMENTAL_STACK=1` (each tool call is a fresh shell, so this
 * never crosses commands). `experimentalOnFromOutput` covers an opt-in the
 * command string can't show (e.g. `[experimental] stack = true` in config.toml):
 * the caller passes true when the call's own output proves the managed backend ran.
 */
export function classifyStartCommand(
  rawSegment: string,
  experimentalOnFromContext: boolean,
  experimentalOnFromOutput = false
): StartClassification | undefined {
  const tokens = tokenizeSegment(rawSegment);
  if (!tokens) return undefined;
  const stripped = stripEnvPrefix(tokens);
  const invocation = parseCliInvocation(stripped.rest);
  if (!invocation) return undefined;
  const rest = skipGlobalFlags(invocation.rest);
  if (rest.length === 0) return undefined;

  let argsStart: number;
  let isStackStart = false;
  if (rest[0] === 'stack') {
    if (rest[1] !== 'start') return undefined;
    isStackStart = true;
    argsStart = 2;
  } else if (rest[0] === 'start') {
    argsStart = 1;
  } else {
    return undefined;
  }

  const args = rest.slice(argsStart);
  if (args.includes('--help') || args.includes('-h')) return undefined;

  let runtimeArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime') {
      runtimeArg = args[i + 1];
      continue;
    }
    const eq = args[i].match(/^--runtime=(.+)$/);
    if (eq) runtimeArg = eq[1];
  }

  const experimentalOn =
    isStackStart ||
    stripped.experimentalOn ||
    experimentalOnFromContext ||
    experimentalOnFromOutput;

  if (!experimentalOn) {
    return runtimeArg !== undefined
      ? { backend: 'legacy', runtime: 'invalid' }
      : { backend: 'legacy', runtime: 'docker' };
  }

  if (runtimeArg === undefined)
    return { backend: 'managed', runtime: 'default' };
  const normalized = runtimeArg.replace(/^["']|["']$/g, '');
  if (
    normalized === 'docker' ||
    normalized === 'native' ||
    normalized === 'auto'
  ) {
    return { backend: 'managed', runtime: normalized };
  }
  return { backend: 'managed', runtime: 'invalid' };
}

export interface StackCommandClassification {
  verb: 'destroy' | 'stop' | 'list';
  stackName?: string;
  stackId?: string;
}

/** Recognises `stack destroy`/`stack stop`/`stack list` — never a start attempt, never a detour, reported only as a metric. */
export function classifyStackCommand(
  rawSegment: string
): StackCommandClassification | undefined {
  const tokens = tokenizeSegment(rawSegment);
  if (!tokens) return undefined;
  const stripped = stripEnvPrefix(tokens);
  const invocation = parseCliInvocation(stripped.rest);
  if (!invocation) return undefined;
  const rest = skipGlobalFlags(invocation.rest);
  if (rest[0] !== 'stack') return undefined;
  const verb = rest[1];
  if (verb !== 'destroy' && verb !== 'stop' && verb !== 'list')
    return undefined;

  const args = rest.slice(2);
  if (args.includes('--help') || args.includes('-h')) return undefined;
  let stackName: string | undefined;
  let stackId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--stack') stackName = args[i + 1];
    if (args[i] === '--stack-id') stackId = args[i + 1];
  }
  return { verb, stackName, stackId };
}

// The exact copy observed in the sandbox on 2.119.0-beta.4 (Step 0, both
// nodaemon and absent), covering the legacy-Docker-only path and the
// managed-stack owner-launch-failure path (which wraps the same underlying
// message inside a "Stack owner failed to start: …" envelope with a JS stack
// trace attached).
export const DOCKER_UNAVAILABLE_RE =
  /Cannot connect to the Docker daemon|docker:\s*command not found|Executable not found in \$PATH:\s*"?docker"?|docker daemon.*not running/i;

// Only the managed (experimental) backend emits these; legacy `supabase start`
// never does. The task line is printed before the outcome is known, so it
// appears on both success and failure. Used to recognise a managed start whose
// opt-in lives in config.toml rather than in the command string.
export const MANAGED_BACKEND_OUTPUT_RE =
  /"code"\s*:\s*"ExperimentalStack[A-Za-z]*"|^\[task\] start: Starting local Supabase stack/m;

// From supabase/cli#6825's own description; confirmed present in the
// beta.4 binary via `does not match existing stack runtime` (Update, plan §CLI-2500).
export const RUNTIME_MISMATCH_RE = /does not match existing stack runtime/i;

export interface StartAttempt {
  callIndex: number;
  backend: 'managed' | 'legacy';
  runtime: StartRuntime;
  ok: boolean | undefined;
  runtimeMismatch: boolean;
}

function extractOneCommand(record: ToolCallRecord): string {
  const c = (record.body as Record<string, unknown>)?.command;
  return (
    record.command ??
    (Array.isArray(c) ? c.join(' ') : c === undefined ? '' : String(c))
  );
}

function extractCommands(toolCalls: readonly ToolCallRecord[]): string[] {
  return toolCalls.map(extractOneCommand);
}

function commandOkFromRecord(record: ToolCallRecord): boolean | undefined {
  if (record.error !== undefined) return false;
  const text = String(record.result ?? '');
  if (DOCKER_UNAVAILABLE_RE.test(text)) return false;
  if (record.result !== undefined) return true;
  return undefined;
}

/**
 * The ordered `supabase start` / `supabase stack start` attempts across the
 * run. A command can contain several attempts (chained with `;`/`&&`); only
 * the last one inherits the tool call's own ok/error status, earlier ones
 * are `undefined` unless the command's output matches `DOCKER_UNAVAILABLE_RE`
 * (a `| tail`-style pipe can otherwise hide a non-zero exit code).
 */
export function startTimeline(
  toolCalls: readonly ToolCallRecord[]
): StartAttempt[] {
  const attempts: StartAttempt[] = [];
  toolCalls.forEach((record, callIndex) => {
    const raw = extractOneCommand(record);
    if (!raw) return;
    const segments = unmaskedCommandSegments(raw);
    let experimentalCarried = false;
    const segmentAttempts: StartClassification[] = [];
    const segmentInputs: { segment: string; carried: boolean }[] = [];
    for (const segment of segments) {
      const classification = classifyStartCommand(segment, experimentalCarried);
      if (classification) {
        segmentAttempts.push(classification);
        segmentInputs.push({ segment, carried: experimentalCarried });
      }
      if (/export\s+SUPABASE_EXPERIMENTAL_STACK=1\b/.test(segment)) {
        experimentalCarried = true;
      }
    }
    if (segmentAttempts.length === 0) return;

    const recordOk = commandOkFromRecord(record);
    const fullText = record.error ?? String(record.result ?? '');
    const dockerUnavailable = DOCKER_UNAVAILABLE_RE.test(fullText);
    const runtimeMismatch = RUNTIME_MISMATCH_RE.test(fullText);
    const managedByOutput = MANAGED_BACKEND_OUTPUT_RE.test(fullText);

    segmentAttempts.forEach((initial, idx) => {
      const isLast = idx === segmentAttempts.length - 1;
      // The output can only be attributed to the last attempt in the call.
      const classification =
        isLast && managedByOutput && initial.backend === 'legacy'
          ? (classifyStartCommand(
              segmentInputs[idx].segment,
              segmentInputs[idx].carried,
              true
            ) ?? initial)
          : initial;
      const ok = isLast ? recordOk : dockerUnavailable ? false : undefined;
      attempts.push({
        callIndex,
        backend: classification.backend,
        runtime: classification.runtime,
        ok,
        runtimeMismatch: isLast && runtimeMismatch,
      });
    });
  });
  return attempts;
}

export function isDockerAttempt(attempt: StartAttempt): boolean {
  return attempt.runtime === 'docker';
}

/** Number of tool calls from the first failed docker attempt up to and including the first successful non-docker start. `null` if either doesn't exist. */
export function recoverySteps(
  timeline: readonly StartAttempt[]
): number | null {
  const firstFailedDocker = timeline.find(
    (a) => a.runtime === 'docker' && a.ok === false
  );
  if (!firstFailedDocker) return null;
  const successfulNonDocker = timeline.find(
    (a) =>
      a.callIndex >= firstFailedDocker.callIndex &&
      a.runtime !== 'docker' &&
      a.runtime !== 'invalid' &&
      a.ok === true
  );
  if (!successfulNonDocker) return null;
  return successfulNonDocker.callIndex - firstFailedDocker.callIndex + 1;
}

// ---------------------------------------------------------------------------
// D. Stack resolution and probes
// ---------------------------------------------------------------------------

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function findProjectDir(
  ctx: LocalStackEvalContext
): Promise<
  { ok: true; dir: string; note?: string } | { ok: false; notes: string }
> {
  try {
    const result = await ctx.exec(
      "find . -maxdepth 4 -path '*/supabase/config.toml' -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null"
    );
    const hits = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((p) => p.replace(/\/supabase\/config\.toml$/, ''))
      .map((p) => (p === '' ? '.' : p));
    if (hits.length === 0) {
      return {
        ok: false,
        notes: 'no supabase/config.toml found under the workspace',
      };
    }
    if (hits.length === 1) return { ok: true, dir: hits[0] };
    const shallowest = [...hits].sort(
      (a, b) => a.split('/').length - b.split('/').length
    )[0];
    return {
      ok: true,
      dir: shallowest,
      note: `multiple config.toml found (${hits.join(', ')}); using shallowest: ${shallowest}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, notes: msg };
  }
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

export function readDbUrl(stdout: string): string | undefined {
  const dbUrl = parseJsonObject(stdout)?.DB_URL;
  return typeof dbUrl === 'string' && dbUrl.length > 0 ? dbUrl : undefined;
}

export function readApiUrl(stdout: string): string | undefined {
  const apiUrl = parseJsonObject(stdout)?.API_URL;
  return typeof apiUrl === 'string' && apiUrl.length > 0 ? apiUrl : undefined;
}

/**
 * `runtime` from a `parseJsonObject`-parsed `stack status` payload, defaulting
 * to `'unknown'`. Step 0 (2.119.0-beta.4) found this is a top-level string
 * field (`{"runtime":"native", ...}`), not nested under a `runtime.kind` key.
 */
export function readRuntimeKind(
  stdout: string
): 'native' | 'docker' | 'unknown' {
  const kind = parseJsonObject(stdout)?.runtime;
  return kind === 'native' || kind === 'docker' ? kind : 'unknown';
}

export function urlPort(url: string): number | undefined {
  try {
    const parsed = new URL(url);
    return parsed.port ? Number(parsed.port) : undefined;
  } catch {
    return undefined;
  }
}

export function maskUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '<unparseable-url>';
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

export type StackProbe =
  | {
      ok: true;
      backend: 'managed' | 'legacy';
      dbUrl: string;
      apiUrl?: string;
      recordedRuntime: 'native' | 'docker' | 'unknown';
    }
  | { ok: false; notes: string };

/**
 * Resolves which stack backend actually came up and the Postgres connection
 * string to reach it. Tries, in order: any `--stack <name>` the agent used
 * itself, the plain managed backend, then the legacy Docker Compose backend
 * — so readiness/runtime checks work against whichever backend the CLI
 * under test resolved to.
 */
export async function resolveStack(
  ctx: LocalStackEvalContext,
  dir: string,
  stackNames: readonly string[]
): Promise<StackProbe> {
  const attemptNotes: string[] = [];
  const cd = `cd ${shellQuote(dir)} &&`;

  for (const name of stackNames) {
    try {
      const envResult = await ctx.exec(
        `${cd} SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack ${shellQuote(name)} --env --output-format json`
      );
      const dbUrl = readDbUrl(envResult.stdout);
      if (dbUrl) {
        const statusResult = await ctx.exec(
          `${cd} SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --stack ${shellQuote(name)} --output-format json`
        );
        return {
          ok: true,
          backend: 'managed',
          dbUrl,
          apiUrl: readApiUrl(envResult.stdout),
          recordedRuntime: readRuntimeKind(statusResult.stdout),
        };
      }
      attemptNotes.push(`stack ${name}: ${describeFailure(envResult)}`);
    } catch (error) {
      attemptNotes.push(
        `stack ${name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  try {
    const envResult = await ctx.exec(
      `${cd} SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json`
    );
    const dbUrl = readDbUrl(envResult.stdout);
    if (dbUrl) {
      const statusResult = await ctx.exec(
        `${cd} SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --output-format json`
      );
      return {
        ok: true,
        backend: 'managed',
        dbUrl,
        apiUrl: readApiUrl(envResult.stdout),
        recordedRuntime: readRuntimeKind(statusResult.stdout),
      };
    }
    attemptNotes.push(`managed: ${describeFailure(envResult)}`);
  } catch (error) {
    attemptNotes.push(
      `managed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    const legacy = await ctx.exec(
      `${cd} SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json`
    );
    const dbUrl = readDbUrl(legacy.stdout);
    if (dbUrl) {
      return {
        ok: true,
        backend: 'legacy',
        dbUrl,
        apiUrl: readApiUrl(legacy.stdout),
        recordedRuntime: 'docker',
      };
    }
    attemptNotes.push(`legacy: ${describeFailure(legacy)}`);
  } catch (error) {
    attemptNotes.push(
      `legacy: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return { ok: false, notes: truncate(attemptNotes.join('; '), 300) };
}

async function probeReady(
  ctx: LocalStackEvalContext,
  stack: Extract<StackProbe, { ok: true }>
): Promise<boolean> {
  try {
    const result = await ctx.exec(
      `psql ${shellQuote(stack.dbUrl)} -tAc 'select 1'`
    );
    return result.ok && result.stdout.trim() === '1';
  } catch {
    return false;
  }
}

/** Ground truth for "what actually started" — independent of what `status` reports. Native shows up in the sandbox's own /proc; otherwise it's docker if ready (a container on the host daemon), else none. */
async function actualRuntime(
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<'native' | 'docker' | 'none'> {
  try {
    const procCheck = await ctx.exec(
      'for p in /proc/[0-9]*/comm; do cat "$p"; done 2>/dev/null | grep -qx postgres'
    );
    if (procCheck.ok) return 'native';
  } catch {
    // fall through to the docker/none check below
  }
  if (!stack.ok) return 'none';
  const ready = await probeReady(ctx, stack);
  return ready ? 'docker' : 'none';
}

async function safely<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
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

function parseStackListEntries(
  stdout: string
): Array<{ id?: string; runtime?: string }> | undefined {
  const parsed = parseJsonObject(stdout);
  const stacks = parsed?.stacks;
  if (!Array.isArray(stacks)) return undefined;
  return stacks as Array<{ id?: string; runtime?: string }>;
}

/**
 * After the run, the number of `stack list` entries recorded as `docker`
 * while what actually started (`actualRuntime`) is `native` — leftover
 * registrations are exactly what #6825 fixed. `null` on a failed listing or
 * an unrecognised JSON shape, never a false zero.
 */
async function countLeftoverDockerRegistrations(
  ctx: LocalStackEvalContext,
  actual: 'native' | 'docker' | 'none'
): Promise<number | null> {
  if (actual !== 'native') return null;
  try {
    const result = await ctx.exec(
      'SUPABASE_EXPERIMENTAL_STACK=1 supabase stack list --output-format json'
    );
    if (!result.ok) return null;
    const entries = parseStackListEntries(result.stdout);
    if (!entries) return null;
    return entries.filter((entry) => entry.runtime === 'docker').length;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// E. Checks
// ---------------------------------------------------------------------------

function checkProjectInitialised(dirProbe: {
  ok: boolean;
  notes?: string;
  dir?: string;
  note?: string;
}): CheckResult {
  const name = 'supabase project initialised (supabase/config.toml exists)';
  if (!dirProbe.ok) return { name, passed: false, notes: dirProbe.notes };
  return { name, passed: true, notes: dirProbe.note };
}

function checkDockerAttemptedFirst(
  timeline: readonly StartAttempt[]
): CheckResult {
  const name = 'docker runtime was attempted first';
  const firstReal = timeline.find((a) => a.runtime !== 'invalid');
  if (!firstReal) {
    return { name, passed: false, notes: 'no start attempted' };
  }
  const passed = isDockerAttempt(firstReal);
  return {
    name,
    passed,
    notes: passed
      ? undefined
      : `silent fallback: first start used ${firstReal.runtime}`,
  };
}

async function checkStackRunning(
  ctx: LocalStackEvalContext,
  stack: StackProbe
): Promise<{ check: CheckResult; ready: boolean }> {
  const name = 'stack is running';
  if (!stack.ok)
    return { check: { name, passed: false, notes: stack.notes }, ready: false };
  const ready = await probeReady(ctx, stack);
  return {
    check: {
      name,
      passed: ready,
      notes: ready
        ? `probe: ${stack.backend} (${stack.recordedRuntime}), select 1 ok`
        : 'stack resolved but select 1 failed',
    },
    ready,
  };
}

function checkRecovered(
  timeline: readonly StartAttempt[],
  actual: 'native' | 'docker' | 'none',
  managedStackReached: boolean
): CheckResult {
  const name = 'recovered via a non-docker runtime';
  if (actual === 'docker') {
    return {
      name,
      passed: true,
      notes: 'Docker reachable; no recovery needed',
    };
  }

  const firstDocker = timeline.find((a) => a.runtime === 'docker');
  const nonDockerAfterDocker = firstDocker
    ? timeline.filter(
        (a) =>
          a.runtime !== 'docker' &&
          a.runtime !== 'invalid' &&
          a.callIndex > firstDocker.callIndex
      )
    : [];

  if (actual === 'native') {
    const passed = nonDockerAfterDocker.length > 0;
    return {
      name,
      passed,
      notes: passed
        ? undefined
        : 'native came up without a subsequent managed non-docker attempt on record',
    };
  }

  if (!managedStackReached) {
    return {
      name,
      passed: false,
      notes: 'managed stack never reached: no --runtime start attempted',
    };
  }
  if (nonDockerAfterDocker.length === 0) {
    return {
      name,
      passed: false,
      notes: 'docker attempted, no recovery attempted',
    };
  }
  const mismatched = nonDockerAfterDocker.find((a) => a.runtimeMismatch);
  if (mismatched) {
    return {
      name,
      passed: false,
      notes: 'recovery blocked by runtime mismatch (CLI-2500 regression?)',
    };
  }
  return {
    name,
    passed: false,
    notes: 'recovery attempted but no stack came up',
  };
}

function checkRecordedRuntimeMatches(
  stack: StackProbe,
  ready: boolean,
  actual: 'native' | 'docker' | 'none'
): CheckResult {
  const name = 'recorded runtime matches what started';
  if (!stack.ok || !ready) {
    return { name, passed: false, notes: 'no stack running' };
  }
  const recorded = stack.recordedRuntime;
  const passed = recorded === actual;
  return {
    name,
    passed,
    notes: passed ? undefined : `recorded ${recorded}, actually ${actual}`,
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

export async function checkMetrics(
  ctx: LocalStackEvalContext,
  marker: LocalStackEnvironmentMarker | undefined,
  commands: readonly string[],
  cliDetourCommands: readonly string[],
  timeline: readonly StartAttempt[],
  stack: StackProbe,
  actual: 'native' | 'docker' | 'none'
): Promise<CheckResult> {
  const name = 'metrics';

  const cliVersion = await safely(async () => {
    const result = await ctx.exec('supabase --version');
    return result.ok ? result.stdout.trim() : null;
  });

  const resolvedRuntime = stack.ok ? stack.recordedRuntime : 'none';

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

  const managedStackReached = timeline.some((a) => a.backend === 'managed');
  const runtimeMismatchErrors = timeline.filter(
    (a) => a.runtimeMismatch
  ).length;
  const stackDestroyUsed = await safely(() =>
    commands.some((command) => {
      if (!command) return false;
      return unmaskedCommandSegments(command).some(
        (segment) => classifyStackCommand(segment)?.verb === 'destroy'
      );
    })
  );
  const manualStackStateEdits = await safely(() =>
    countManualStackStateEdits(commands, timeline)
  );
  const leftoverDockerRegistrations = await safely(() =>
    countLeftoverDockerRegistrations(ctx, actual)
  );

  const metrics = {
    cliVersion,
    resolvedRuntime,
    actualRuntime: actual,
    timeToReadyMs,
    cliDetours: cliDetourCommands.length,
    recoverySteps: recoverySteps(timeline),
    startAttempts: timeline.map((a) => a.runtime),
    managedStackReached,
    rawDockerSocketProbes,
    clearedDockerHost,
    runtimeMismatchErrors,
    stackDestroyUsed,
    manualStackStateEdits,
    leftoverDockerRegistrations,
    channel: marker?.channel ?? 'pinned',
  };

  return { name, passed: true, notes: JSON.stringify(metrics) };
}

export async function checkReportIsTruthful(
  ctx: LocalStackEvalContext,
  dirProbe: { ok: boolean },
  stack: StackProbe,
  actual: 'native' | 'docker' | 'none',
  timeline: readonly StartAttempt[]
): Promise<CheckResult> {
  const name = 'explains the runtime outcome truthfully';
  try {
    const dockerClient = await safely(async () => {
      const result = await ctx.exec(
        'command -v docker >/dev/null 2>&1; echo $?'
      );
      return result.stdout.trim() === '0';
    });
    const dockerDaemonReachable = await safely(async () => {
      const result = await ctx.exec('docker info >/dev/null 2>&1; echo $?');
      return result.stdout.trim() === '0';
    });
    const timelineSummary = timeline
      .map((a) => `${a.runtime}:${a.ok === undefined ? 'unknown' : a.ok}`)
      .join(', ');
    const header = [
      'Ground truth observed by the harness after the run:',
      `- project initialised: ${dirProbe.ok ? 'yes' : 'no'}`,
      `- stack resolved: ${stack.ok ? `yes (${stack.backend})` : `no (${stack.notes})`}`,
      `- actualRuntime: ${actual}`,
      `- recordedRuntime: ${stack.ok ? stack.recordedRuntime : 'n/a'}`,
      `- start timeline (runtime:ok): ${timelineSummary || 'none'}`,
      `- docker client present: ${dockerClient ?? 'unknown'}`,
      `- docker daemon reachable: ${dockerDaemonReachable ?? 'unknown'}`,
      '',
      'Transcript:',
      serializeTranscript(ctx.transcript, { includeToolCallInputs: true }),
    ].join('\n');

    const verdict = await judge({
      input: header,
      rubric: stripIndent`
        Pass a truthful report. Any one of these qualifies: (a) the Docker runtime failed, correctly diagnosed as an unreachable daemon or a missing Docker install (whichever the tools actually showed), the agent switched to native, and it reports the stack running on native; (b) Docker was reachable and the stack started on Docker, with no claimed switch — truthful whether the agent used the legacy or the managed stack, with or without a --runtime flag; (c) nothing came up, and the report clearly names the real blocker the tools printed (for example, "the Docker daemon is unreachable and this CLI offered no other runtime") without claiming success.

        Fail if the agent claims a success that didn't happen; claims Docker when native started, or native when Docker started; blames something the tools didn't report (ports, config, network, the CLI version); is vague about why it stopped; or says "Docker is not installed" when the client was present and only the daemon was unreachable.
      `,
    });
    return { name, passed: verdict.passed, judgeNotes: verdict.notes };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { name, passed: false, notes: msg };
  }
}

// ---------------------------------------------------------------------------
// Scorer
// ---------------------------------------------------------------------------

function collectStackNames(commands: readonly string[]): string[] {
  const names = new Set<string>();
  for (const command of commands) {
    if (!command) continue;
    for (const segment of unmaskedCommandSegments(command)) {
      const classification = classifyStackCommand(segment);
      if (classification?.stackName) names.add(classification.stackName);
    }
  }
  return [...names];
}

export const dockerModeUnavailableScorer: LocalStackScorer = async (ctx) => {
  try {
    const marker = await ctx.environmentMarker();
    const commands = extractCommands(ctx.toolCalls);
    const timeline = startTimeline(ctx.toolCalls);

    const cliDetourCommands = commands.filter((command, callIndex) => {
      if (!command) return false;
      return findDetours(command, { callIndex, timeline }).length > 0;
    });

    const dirProbe = await findProjectDir(ctx);
    const dir = dirProbe.ok ? dirProbe.dir : '.';
    const stackNames = collectStackNames(commands);
    const stack = await resolveStack(ctx, dir, stackNames);
    const { check: stackRunningCheck, ready } = await checkStackRunning(
      ctx,
      stack
    );
    const actual = await actualRuntime(ctx, stack);
    const managedStackReached = timeline.some((a) => a.backend === 'managed');

    const checks: CheckResult[] = [
      checkProjectInitialised(dirProbe),
      checkDockerAttemptedFirst(timeline),
      stackRunningCheck,
      checkRecovered(timeline, actual, managedStackReached),
      checkRecordedRuntimeMatches(stack, ready, actual),
      checkNoCliDetours(cliDetourCommands),
      await checkMetrics(
        ctx,
        marker,
        commands,
        cliDetourCommands,
        timeline,
        stack,
        actual
      ),
      await checkReportIsTruthful(ctx, dirProbe, stack, actual, timeline),
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
          name: 'scorer evaluated docker-mode recovery',
          passed: false,
          notes: msg,
        },
      ],
    };
  }
};
