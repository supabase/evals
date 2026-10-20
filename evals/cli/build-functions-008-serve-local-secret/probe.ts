import type {
  CheckResult,
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  invocationSubcommand,
  invocationVerb,
  type InvocationEnv,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { safely } from '../lib/metrics.js';
import {
  describeFailure,
  errorMessage,
  inProjectDir,
  shellQuote,
  truncate,
} from '../lib/shell.js';
import {
  candidateHomes,
  effectiveRoot,
  parseJsonObject,
  type ResolvedStack,
  type StackProbe,
} from '../lib/stack.js';
import {
  DIGEST_SECRET,
  FUNCTION_NAME,
  SECRET_HEADER,
  WRONG_SECRET,
} from './fixture.js';
import { maskSecret } from './secret.js';

export type AuthVariant =
  | 'none'
  | 'publishable'
  | 'publishable+anon-bearer'
  | 'anon';

/** Status 0 means no HTTP response came back; the body then holds the transport error and `headers` is empty. */
export type HttpResponse = { status: number; body: string; headers: string };

export type ProbeAttempt = { variant: AuthVariant; response: HttpResponse };

export type ServedBy = 'live' | 'replay';

export type ReplayOutcome =
  | { ran: false; reason: string }
  | {
      ran: true;
      command: string;
      attempts: ProbeAttempt[];
      log: string;
      stoppedServers: number;
    };

export type FunctionProbe = {
  url?: string;
  stackNotes?: string;
  harnessServe: boolean;
  live: ProbeAttempt[];
  replay: ReplayOutcome;
  accepted?: {
    servedBy: ServedBy;
    variant: AuthVariant;
    response: HttpResponse;
  };
  wrongSecret?: HttpResponse;
  missingHeader?: HttpResponse;
};

type Sleep = (ms: number) => Promise<void>;
type Clock = { sleep: Sleep; now: () => number };
export type ProbeOptions = Partial<Clock> & {
  agentCommands?: readonly string[];
};
type ApiKeys = { publishable?: string; anon?: string };
type VariantRequest = { variant: AuthVariant; headers: Record<string, string> };
type Send = (
  headers: Record<string, string>,
  secret?: string
) => Promise<HttpResponse>;
type Verdict = Pick<
  FunctionProbe,
  'accepted' | 'wrongSecret' | 'missingHeader'
>;
type ServerProbe = Verdict & { attempts: ProbeAttempt[] };
export type ProcessRow = {
  pid: number;
  pgid: number;
  live: boolean;
  serves: boolean;
};

export const FUNCTIONS_PATH = '/functions/v1/';

const PAYLOAD = '{"run":"nightly"}';
const REJECTED_STATUS = 401;
const CONNECT_TIMEOUT_SECONDS = 5;
const REQUEST_TIMEOUT_SECONDS = 30;
const REQUEST_BUDGET_MS = REQUEST_TIMEOUT_SECONDS * 1_000;
const LIVE_BOOT_BUDGET_MS = 120_000;
const LIVE_RETRY_MS = 2_000;
const REPLAY_BOOT_BUDGET_MS = 120_000;
const REPLAY_POLL_MS = 3_000;
const STOP_GRACE_MS = 15_000;
const STOP_POLL_MS = 1_000;
const REPLAY_LOG = '/tmp/eval-serve-replay.log';
const HARNESS_SERVE_LOG = '/tmp/functions-serve.log';
const HARNESS_SERVE_LOG_TOKEN =
  /(^|[\s>'"=])\/tmp\/functions-serve\.log(?=$|[\s;&|)'"])/;
const HTTP_PREFIX = 'HTTP/';
const BLANK_LINE = /\r\n\r\n|\n\n/;
const INTERIM_STATUS_LINE = /^HTTP\/\S+ 1\d\d\b/;
const REPLAY_LOG_TAIL_BYTES = 500;
const NOTE_BODY_CHARS = 200;
const NO_STACK_REASON = 'no local stack to serve the function';
const HOME_VARIABLES = ['SUPABASE_HOME', 'HOME', 'TMPDIR'] as const;
// A cold worker can spend a whole request timeout fetching modules for its first call.
const BOOTING_STATUSES = new Set([0, 502, 503, 504]);
const INSPECT_FLAG_PREFIX = '--inspect';
const INSPECT_MODE_FLAG = '--inspect-mode';
const SERVE_TOKENS = ['functions', 'serve'] as const;
const PROCESS_ROW = /^(\d+) (\d+) (\S) ([01])$/;
const ZOMBIE_STATE = 'Z';

/** Prints `pid pgid state serves` per process, `serves` being 1 when its argv has the serve tokens in a row; they sit in variables so this shell's own argv never matches. */
export const PROCESS_TABLE_SCRIPT = [
  `a=${SERVE_TOKENS[0]}`,
  `b=${SERVE_TOKENS[1]}`,
  'for d in /proc/[0-9]*; do',
  '  pid=${d#/proc/}',
  '  [ "$pid" = "$$" ] && continue',
  '  read -r stat 2>/dev/null < "$d/stat" || continue',
  '  read -r state _ pgid _ <<< "${stat##*) }"',
  `  mapfile -d '' -t argv 2>/dev/null < "$d/cmdline" || continue`,
  '  serves=0',
  '  for ((i = 0; i + 1 < ${#argv[@]}; i++)); do',
  '    if [ "${argv[i]}" = "$a" ] && [ "${argv[i + 1]}" = "$b" ]; then serves=1; break; fi',
  '  done',
  '  echo "$pid $pgid $state $serves"',
  'done',
].join('\n');

const wait: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isFunctionsServe(invocation: SupabaseInvocation): boolean {
  return (
    invocationVerb(invocation) === 'functions' &&
    invocationSubcommand(invocation) === 'serve'
  );
}

export function lastServeInvocation(
  invocations: readonly SupabaseInvocation[]
): SupabaseInvocation | undefined {
  return invocations.filter(isFunctionsServe).at(-1);
}

// `--inspect-mode` takes its value as a separate argument, which would
// otherwise be left behind as a positional.
function withoutInspectorFlags(args: readonly string[]): string[] {
  return args.filter(
    (arg, index) =>
      !arg.startsWith(INSPECT_FLAG_PREFIX) &&
      args[index - 1] !== INSPECT_MODE_FLAG
  );
}

function homeAssignments(env: InvocationEnv | undefined): string[] {
  return HOME_VARIABLES.flatMap((name) => {
    const value = env?.[name];
    return value === undefined ? [] : [`${name}=${shellQuote(value)}`];
  });
}

/** A shell command that reruns the invocation from its directory, with its CLI homes, workdir and experimental flag, minus any debugger flags that would block on attach. */
export function replayCommand(invocation: SupabaseInvocation): string {
  const assignments = [
    ...homeAssignments(invocation.env),
    ...(invocation.workdir === undefined
      ? []
      : [`SUPABASE_WORKDIR=${shellQuote(invocation.workdir)}`]),
    ...(invocation.experimentalStack ? ['SUPABASE_EXPERIMENTAL_STACK=1'] : []),
  ];
  const args = withoutInspectorFlags(invocation.argv.slice(1)).map(shellQuote);
  return inProjectDir(
    invocation.cwd,
    [...assignments, 'supabase', ...args].join(' ')
  );
}

export function isStillBooting({ status }: HttpResponse): boolean {
  return BOOTING_STATUSES.has(status);
}

const isAccepted = ({ status }: HttpResponse) => status >= 200 && status < 300;

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

export function authVariants({ publishable, anon }: ApiKeys): VariantRequest[] {
  const variants: VariantRequest[] = [{ variant: 'none', headers: {} }];
  if (publishable) {
    variants.push({ variant: 'publishable', headers: { apikey: publishable } });
  }
  if (publishable && anon) {
    variants.push({
      variant: 'publishable+anon-bearer',
      headers: { apikey: publishable, ...bearer(anon) },
    });
  }
  if (anon) {
    variants.push({
      variant: 'anon',
      headers: { apikey: anon, ...bearer(anon) },
    });
  }
  return variants;
}

export const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

export function describeAttempts(
  attempts: readonly ProbeAttempt[],
  arrow = '→'
): string {
  return attempts.length === 0
    ? 'none'
    : attempts
        .map(({ variant, response }) => `${variant}${arrow}${response.status}`)
        .join(', ');
}

function lastBodyPreview({ live, replay }: FunctionProbe): string {
  const attempts = replay.ran ? replay.attempts : live;
  const body = oneLine(attempts.at(-1)?.response.body ?? '');
  return body === ''
    ? ''
    : `; last response: ${truncate(body, NOTE_BODY_CHARS)}`;
}

export function checkAcceptsSecret(probe: FunctionProbe): CheckResult {
  const name = "nightly-digest accepts the scheduler's secret";
  const { accepted } = probe;
  if (accepted !== undefined) {
    return {
      name,
      passed: true,
      notes: `${accepted.servedBy} server accepted the secret with the ${accepted.variant} variant (status ${accepted.response.status})`,
    };
  }
  if (probe.url === undefined) {
    return {
      name,
      passed: false,
      notes: maskSecret(
        `no function url: ${probe.stackNotes ?? 'no local stack'}`
      ),
    };
  }
  const replay = probe.replay.ran
    ? `replay: ${describeAttempts(probe.replay.attempts)}`
    : `replay not run: ${probe.replay.reason}`;
  return {
    name,
    passed: false,
    notes: maskSecret(
      `no 2xx. live (last sweep): ${describeAttempts(probe.live)}; ${replay}${lastBodyPreview(probe)}`
    ),
  };
}

const describeEcho = (
  label: string,
  { body, headers }: HttpResponse
): string[] =>
  body.includes(DIGEST_SECRET) || headers.includes(DIGEST_SECRET)
    ? [`the ${label} response echoes the secret`]
    : [];

function describeProblems(label: string, response: HttpResponse): string[] {
  return [
    ...(response.status === REJECTED_STATUS
      ? []
      : [`${label} got ${response.status} (expected ${REJECTED_STATUS})`]),
    ...describeEcho(label, response),
  ];
}

export function checkRejectsWrongSecret(probe: FunctionProbe): CheckResult {
  const name = 'nightly-digest rejects a wrong or missing secret';
  const { accepted, wrongSecret, missingHeader } = probe;
  if (!accepted || !wrongSecret || !missingHeader) {
    return {
      name,
      passed: false,
      notes: 'not run because nothing accepted the right secret',
    };
  }
  const problems = [
    ...describeEcho('accepted', accepted.response),
    ...describeProblems('wrong secret', wrongSecret),
    ...describeProblems('missing header', missingHeader),
  ];
  return problems.length > 0
    ? { name, passed: false, notes: problems.join('; ') }
    : {
        name,
        passed: true,
        notes: `wrong secret got ${wrongSecret.status}, missing header got ${missingHeader.status}`,
      };
}

function managedHomePrefix(
  { relocatedHome }: ResolvedStack,
  invocations: readonly SupabaseInvocation[]
): string {
  if (relocatedHome === undefined) return '';
  const home = candidateHomes(invocations, { kind: 'root' }).find(
    (candidate) => effectiveRoot(candidate) === relocatedHome
  );
  const assignments =
    home === undefined
      ? [`SUPABASE_HOME=${shellQuote(relocatedHome)}`]
      : homeAssignments(home);
  return `${assignments.join(' ')} `;
}

function keysCommand(
  stack: ResolvedStack,
  invocations: readonly SupabaseInvocation[]
): string {
  if (stack.backend === 'legacy') {
    return 'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json';
  }
  return `${managedHomePrefix(stack, invocations)}SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json`;
}

const nonEmptyString = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value : undefined;

async function readKeys(
  ctx: LocalStackEvalContext,
  stack: ResolvedStack,
  invocations: readonly SupabaseInvocation[]
): Promise<ApiKeys> {
  const result = await safely(() => ctx.exec(keysCommand(stack, invocations)));
  const keys = parseJsonObject(result?.stdout ?? '');
  return {
    publishable: nonEmptyString(keys?.PUBLISHABLE_KEY),
    anon: nonEmptyString(keys?.ANON_KEY),
  };
}

function curlCommand(url: string, headers: Record<string, string>): string {
  const headerFlags = Object.entries(headers).map(
    ([name, value]) => `-H ${shellQuote(`${name}: ${value}`)}`
  );
  return [
    'curl -sS -i -X POST',
    `--connect-timeout ${CONNECT_TIMEOUT_SECONDS}`,
    `--max-time ${REQUEST_TIMEOUT_SECONDS}`,
    ...headerFlags,
    `-d ${shellQuote(PAYLOAD)}`,
    `-w ${shellQuote('\n%{http_code}')}`,
    shellQuote(url),
  ].join(' ');
}

function splitHeaders(text: string): Pick<HttpResponse, 'body' | 'headers'> {
  if (!text.startsWith(HTTP_PREFIX)) return { headers: '', body: text };
  const separator = BLANK_LINE.exec(text);
  if (separator === null) return { headers: text, body: '' };
  const headers = text.slice(0, separator.index);
  const body = text.slice(separator.index + separator[0].length);
  return INTERIM_STATUS_LINE.test(headers) && body.startsWith(HTTP_PREFIX)
    ? splitHeaders(body)
    : { headers, body };
}

/** Reads `curl -i -w '\n%{http_code}'` output: the final response's headers and body, and the status from the trailing code. */
export function parseCurlResponse(stdout: string): HttpResponse {
  const output = stdout.trimEnd();
  const split = output.lastIndexOf('\n');
  const status = Number(output.slice(split + 1));
  if (split === -1 || !Number.isInteger(status) || status === 0) {
    return { status: 0, body: stdout.trim(), headers: '' };
  }
  return { status, ...splitHeaders(output.slice(0, split)) };
}

function parseCurlResult(result: CommandResult): HttpResponse {
  const response = parseCurlResponse(result.stdout);
  return response.status === 0
    ? { ...response, body: (result.stderr || result.stdout).trim() }
    : response;
}

function sender(ctx: LocalStackEvalContext, url: string): Send {
  return async (headers, secret) => {
    const allHeaders = {
      'content-type': 'application/json',
      ...(secret === undefined ? {} : { [SECRET_HEADER]: secret }),
      ...headers,
    };
    try {
      return parseCurlResult(await ctx.exec(curlCommand(url, allHeaders)));
    } catch (error) {
      return { status: 0, body: errorMessage(error), headers: '' };
    }
  };
}

// Another attempt after `waitMs` must still have one full request's time left.
const hasTimeFor = (deadline: number, waitMs: number, { now }: Clock) =>
  deadline - now() - waitMs >= REQUEST_BUDGET_MS;

async function sweep(
  send: Send,
  variants: readonly VariantRequest[],
  servedBy: ServedBy
): Promise<ServerProbe> {
  const attempts: ProbeAttempt[] = [];
  for (const { variant, headers } of variants) {
    const response = await send(headers, DIGEST_SECRET);
    attempts.push({ variant, response });
    if (isAccepted(response)) {
      return {
        attempts,
        accepted: { servedBy, variant, response },
        wrongSecret: await send(headers, WRONG_SECRET),
        missingHeader: await send(headers),
      };
    }
    if (isStillBooting(response)) break;
  }
  return { attempts };
}

const endedBooting = ({ attempts }: ServerProbe) => {
  const last = attempts.at(-1);
  return last !== undefined && isStillBooting(last.response);
};

async function probeLive(
  send: Send,
  variants: readonly VariantRequest[],
  clock: Clock
): Promise<ServerProbe> {
  const deadline = clock.now() + LIVE_BOOT_BUDGET_MS;
  for (;;) {
    const probe = await sweep(send, variants, 'live');
    if (
      probe.accepted !== undefined ||
      !endedBooting(probe) ||
      !hasTimeFor(deadline, LIVE_RETRY_MS, clock)
    ) {
      return probe;
    }
    await clock.sleep(LIVE_RETRY_MS);
  }
}

export function parseProcessTable(stdout: string): ProcessRow[] {
  return stdout.split('\n').flatMap((line) => {
    const match = PROCESS_ROW.exec(line.trim());
    return match === null
      ? []
      : [
          {
            pid: Number(match[1]),
            pgid: Number(match[2]),
            live: match[3] !== ZOMBIE_STATE,
            serves: match[4] === '1',
          },
        ];
  });
}

async function listProcesses(
  ctx: LocalStackEvalContext
): Promise<ProcessRow[]> {
  const result = await ctx.exec(PROCESS_TABLE_SCRIPT);
  const rows = parseProcessTable(result.stdout);
  if (!result.ok || rows.length === 0) {
    throw new Error(`process scan failed: ${describeFailure(result)}`);
  }
  return rows;
}

export const runningServers = (rows: readonly ProcessRow[]) =>
  rows.filter(({ live, serves }) => live && serves).map(({ pid }) => pid);

export const groupMembers = (rows: readonly ProcessRow[], pgid: number) =>
  rows.filter((row) => row.live && row.pgid === pgid).map(({ pid }) => pid);

const stillRunning = (rows: readonly ProcessRow[], pids: readonly number[]) =>
  rows
    .filter((row) => row.live && pids.includes(row.pid))
    .map(({ pid }) => pid);

// A scan that fails reads as "still running", so the grace period runs out and the KILL still goes out.
async function awaitGone(
  running: () => Promise<number[]>,
  clock: Clock
): Promise<number[]> {
  const deadline = clock.now() + STOP_GRACE_MS;
  for (let found = await running(); found.length > 0; found = await running()) {
    if (clock.now() >= deadline) return found;
    await clock.sleep(STOP_POLL_MS);
  }
  return [];
}

async function stopServers(
  ctx: LocalStackEvalContext,
  pids: readonly number[],
  clock: Clock
): Promise<void> {
  await ctx.exec(`kill -TERM -- ${pids.join(' ')}`);
  const survivors = await awaitGone(
    async () =>
      (await safely(async () =>
        stillRunning(await listProcesses(ctx), pids)
      )) ?? [...pids],
    clock
  );
  if (survivors.length > 0) {
    await ctx.exec(`kill -KILL -- ${survivors.join(' ')}`);
  }
}

async function stopGroup(
  ctx: LocalStackEvalContext,
  pgid: number,
  clock: Clock
): Promise<void> {
  await ctx.exec(`kill -TERM -- -${pgid}`);
  const survivors = await awaitGone(
    async () =>
      (await safely(async () =>
        groupMembers(await listProcesses(ctx), pgid)
      )) ?? [pgid],
    clock
  );
  if (survivors.length > 0) await ctx.exec(`kill -KILL -- -${pgid}`);
}

async function stopRunningServers(
  ctx: LocalStackEvalContext,
  clock: Clock
): Promise<{ stopped: number } | { reason: string }> {
  try {
    const pids = runningServers(await listProcesses(ctx));
    if (pids.length > 0) await stopServers(ctx, pids, clock);
    return { stopped: pids.length };
  } catch (error) {
    return {
      reason: `could not stop the running functions serve: ${errorMessage(error)}`,
    };
  }
}

async function startReplay(
  ctx: LocalStackEvalContext,
  command: string
): Promise<{ pgid: number } | { reason: string }> {
  const fail = (detail: string) => ({
    reason: `could not start the replay: ${detail}`,
  });
  try {
    const started = await ctx.exec(
      `setsid nohup sh -c ${shellQuote(command)} > ${REPLAY_LOG} 2>&1 < /dev/null & echo $!`
    );
    if (!started.ok) return fail(describeFailure(started));
    const pgid = Number(started.stdout.trim());
    return Number.isInteger(pgid) && pgid > 0
      ? { pgid }
      : fail(`no process id in ${JSON.stringify(started.stdout.trim())}`);
  } catch (error) {
    return fail(errorMessage(error));
  }
}

async function groupAlive(
  ctx: LocalStackEvalContext,
  pgid: number
): Promise<boolean> {
  const rows = await safely(() => listProcesses(ctx));
  return rows === null || groupMembers(rows, pgid).length > 0;
}

async function probeReplay(
  ctx: LocalStackEvalContext,
  pgid: number,
  send: Send,
  variants: readonly VariantRequest[],
  clock: Clock
): Promise<ServerProbe> {
  const deadline = clock.now() + REPLAY_BOOT_BUDGET_MS;
  for (;;) {
    const probe = await sweep(send, variants, 'replay');
    if (
      probe.accepted !== undefined ||
      !hasTimeFor(deadline, REPLAY_POLL_MS, clock) ||
      !(await groupAlive(ctx, pgid))
    ) {
      return probe;
    }
    await clock.sleep(REPLAY_POLL_MS);
  }
}

async function replayServe(
  ctx: LocalStackEvalContext,
  serve: SupabaseInvocation,
  send: Send,
  variants: readonly VariantRequest[],
  clock: Clock
): Promise<Verdict & { replay: ReplayOutcome }> {
  const command = replayCommand(serve);
  const takeover = await stopRunningServers(ctx, clock);
  if ('reason' in takeover) return { replay: { ran: false, ...takeover } };
  const started = await startReplay(ctx, command);
  if ('reason' in started) return { replay: { ran: false, ...started } };
  try {
    const { attempts, ...verdict } = await probeReplay(
      ctx,
      started.pgid,
      send,
      variants,
      clock
    );
    const tail = await safely(() =>
      ctx.exec(`tail -c ${REPLAY_LOG_TAIL_BYTES} ${REPLAY_LOG}`)
    );
    return {
      ...verdict,
      replay: {
        ran: true,
        command,
        attempts,
        log: tail?.stdout.trim() ?? '',
        stoppedServers: takeover.stopped,
      },
    };
  } finally {
    await safely(() => stopGroup(ctx, started.pgid, clock));
  }
}

async function detectHarnessServe(
  ctx: LocalStackEvalContext,
  agentCommands: readonly string[]
): Promise<boolean> {
  if (agentCommands.some((command) => HARNESS_SERVE_LOG_TOKEN.test(command))) {
    return false;
  }
  const result = await safely(() => ctx.exec(`test -e ${HARNESS_SERVE_LOG}`));
  return result?.ok === true;
}

/**
 * POSTs the scheduler's call to the local function and, when nothing accepts the secret live, takes over from any running
 * `functions serve` and replays the agent's last one long enough to probe it.
 */
export async function probeFunction(
  ctx: LocalStackEvalContext,
  stack: StackProbe,
  invocations: readonly SupabaseInvocation[],
  { sleep = wait, now = Date.now, agentCommands = [] }: ProbeOptions = {}
): Promise<FunctionProbe> {
  if (!stack.ok || !stack.apiUrl) {
    return {
      stackNotes: stack.ok
        ? 'the stack resolved without an API URL'
        : stack.notes,
      harnessServe: false,
      live: [],
      replay: { ran: false, reason: NO_STACK_REASON },
    };
  }
  const clock: Clock = { sleep, now };
  const harnessServe = await detectHarnessServe(ctx, agentCommands);
  const url = `${stack.apiUrl}${FUNCTIONS_PATH}${FUNCTION_NAME}`;
  const send = sender(ctx, url);
  const variants = authVariants(await readKeys(ctx, stack, invocations));

  const { attempts: live, ...liveVerdict } = await probeLive(
    send,
    variants,
    clock
  );
  if (liveVerdict.accepted !== undefined) {
    return {
      url,
      harnessServe,
      live,
      replay: { ran: false, reason: 'the live server accepted the secret' },
      ...liveVerdict,
    };
  }
  const serve = lastServeInvocation(invocations);
  if (serve === undefined) {
    return {
      url,
      harnessServe,
      live,
      replay: {
        ran: false,
        reason: 'the agent never ran supabase functions serve',
      },
    };
  }
  return {
    url,
    harnessServe,
    live,
    ...(await replayServe(ctx, serve, send, variants, clock)),
  };
}
