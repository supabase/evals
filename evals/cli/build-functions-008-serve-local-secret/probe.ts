import type {
  CheckResult,
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  invocationVerb,
  type SupabaseInvocation,
} from '../lib/cli-invocations.js';
import { safely } from '../lib/metrics.js';
import {
  errorMessage,
  inProjectDir,
  shellQuote,
  truncate,
} from '../lib/shell.js';
import {
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

/** Status 0 means no HTTP response came back; the body then holds the transport error. */
export type HttpResponse = { status: number; body: string };

export type ProbeAttempt = { variant: AuthVariant; response: HttpResponse };

export type ServedBy = 'live' | 'replay';

export type ReplayOutcome =
  | { ran: false; reason: string }
  | { ran: true; command: string; attempts: ProbeAttempt[]; log: string };

export type FunctionProbe = {
  url?: string;
  stackNotes?: string;
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
type Patience = {
  retryMs: number;
  canRetry: (attemptsMade: number) => boolean;
};

export const FUNCTIONS_PATH = '/functions/v1/';

const PAYLOAD = '{"run":"nightly"}';
const REQUEST_TIMEOUT_SECONDS = 60;
const LIVE_ATTEMPTS = 5;
const LIVE_RETRY_MS = 2_000;
const REPLAY_BOOT_BUDGET_MS = 90_000;
const REPLAY_POLL_MS = 3_000;
const STOP_GRACE_MS = 15_000;
const STOP_POLL_MS = 1_000;
const REPLAY_LOG = '/tmp/eval-serve-replay.log';
const REPLAY_LOG_TAIL_BYTES = 500;
const NOTE_BODY_CHARS = 200;
const NO_STACK_REASON = 'no local stack to serve the function';
const REPLAY_ENV_VARS = ['SUPABASE_HOME', 'HOME', 'TMPDIR'] as const;
const BOOTING_STATUSES = new Set([0, 502, 503, 504]);
const INSPECT_FLAG_PREFIX = '--inspect';
const INSPECT_MODE_FLAG = '--inspect-mode';

const wait: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `invocationVerb` is the only positional parser cli-invocations exposes, so the
// token that made it answer the verb is dropped to read the next positional.
function subcommand(invocation: SupabaseInvocation): string | undefined {
  const { argv } = invocation;
  const verbAt = argv.findIndex(
    (_, index) =>
      index > 0 &&
      invocationVerb({ ...invocation, argv: argv.slice(0, index + 1) }) !==
        undefined
  );
  return invocationVerb({
    ...invocation,
    argv: argv.filter((_, index) => index !== verbAt),
  });
}

export function isFunctionsServe(invocation: SupabaseInvocation): boolean {
  return (
    invocationVerb(invocation) === 'functions' &&
    subcommand(invocation) === 'serve'
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

/** A shell command that reruns the invocation from its directory, with its CLI homes, workdir and experimental flag, minus any debugger flags that would block on attach. */
export function replayCommand(invocation: SupabaseInvocation): string {
  const assignments = [
    ...REPLAY_ENV_VARS.flatMap((name) => {
      const value = invocation.env?.[name];
      return value === undefined ? [] : [`${name}=${shellQuote(value)}`];
    }),
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

const isRejected = ({ status }: HttpResponse) =>
  status >= 400 && status < 500 && status !== 404;

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

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

function describeAttempts(attempts: readonly ProbeAttempt[]): string {
  return attempts
    .map(({ variant, response }) => `${variant}→${response.status}`)
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
      `no 2xx. live: ${describeAttempts(probe.live)}; ${replay}${lastBodyPreview(probe)}`
    ),
  };
}

function describeProblems(label: string, response: HttpResponse): string[] {
  return [
    ...(isRejected(response) ? [] : [`${label} got ${response.status}`]),
    ...(response.body.includes(DIGEST_SECRET)
      ? [`the ${label} response echoes the secret`]
      : []),
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

function keysCommand(stack: ResolvedStack): string {
  if (stack.backend === 'legacy') {
    return 'SUPABASE_EXPERIMENTAL_STACK=0 supabase status -o json';
  }
  const home =
    stack.relocatedHome === undefined
      ? ''
      : `SUPABASE_HOME=${shellQuote(stack.relocatedHome)} `;
  return `${home}SUPABASE_EXPERIMENTAL_STACK=1 supabase stack status --env --output-format json`;
}

const nonEmptyString = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value : undefined;

async function readKeys(
  ctx: LocalStackEvalContext,
  stack: ResolvedStack
): Promise<ApiKeys> {
  const result = await safely(() => ctx.exec(keysCommand(stack)));
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
    'curl -sS -X POST',
    `--max-time ${REQUEST_TIMEOUT_SECONDS}`,
    ...headerFlags,
    `-d ${shellQuote(PAYLOAD)}`,
    `-w ${shellQuote('\n%{http_code}')}`,
    shellQuote(url),
  ].join(' ');
}

function parseCurlResult(result: CommandResult): HttpResponse {
  const output = result.stdout.trimEnd();
  const split = output.lastIndexOf('\n');
  const status = Number(output.slice(split + 1));
  if (split === -1 || !Number.isInteger(status) || status === 0) {
    return { status: 0, body: (result.stderr || result.stdout).trim() };
  }
  return { status, body: output.slice(0, split) };
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
      return { status: 0, body: errorMessage(error) };
    }
  };
}

async function pollWhileBooting(
  attempt: () => Promise<HttpResponse>,
  { retryMs, canRetry }: Patience,
  sleep: Sleep
): Promise<HttpResponse> {
  let response = await attempt();
  for (let made = 1; isStillBooting(response) && canRetry(made); made++) {
    await sleep(retryMs);
    response = await attempt();
  }
  return response;
}

async function probeServer(
  send: Send,
  variants: readonly VariantRequest[],
  servedBy: ServedBy,
  patience: Patience,
  sleep: Sleep
): Promise<ServerProbe> {
  const attempts: ProbeAttempt[] = [];
  for (const [index, { variant, headers }] of variants.entries()) {
    const attempt = () => send(headers, DIGEST_SECRET);
    const first = index === 0;
    const response = first
      ? await pollWhileBooting(attempt, patience, sleep)
      : await attempt();
    attempts.push({ variant, response });
    if (isAccepted(response)) {
      return {
        attempts,
        accepted: { servedBy, variant, response },
        wrongSecret: await send(headers, WRONG_SECRET),
        missingHeader: await send(headers),
      };
    }
    if (first && isStillBooting(response)) break;
  }
  return { attempts };
}

const livePatience: Patience = {
  retryMs: LIVE_RETRY_MS,
  canRetry: (attemptsMade) => attemptsMade < LIVE_ATTEMPTS,
};

function replayPatience(): Patience {
  const deadline = Date.now() + REPLAY_BOOT_BUDGET_MS;
  return { retryMs: REPLAY_POLL_MS, canRetry: () => Date.now() < deadline };
}

async function stopProcessGroup(
  ctx: LocalStackEvalContext,
  pgid: number,
  sleep: Sleep
): Promise<void> {
  await ctx.exec(`kill -TERM -- -${pgid}`);
  const deadline = Date.now() + STOP_GRACE_MS;
  while ((await ctx.exec(`kill -0 -- -${pgid}`)).ok) {
    if (Date.now() >= deadline) {
      await ctx.exec(`kill -KILL -- -${pgid}`);
      return;
    }
    await sleep(STOP_POLL_MS);
  }
}

async function replayServe(
  ctx: LocalStackEvalContext,
  serve: SupabaseInvocation,
  send: Send,
  variants: readonly VariantRequest[],
  sleep: Sleep
): Promise<Verdict & { replay: ReplayOutcome }> {
  const command = replayCommand(serve);
  const started = await ctx.exec(
    `setsid nohup sh -c ${shellQuote(command)} > ${REPLAY_LOG} 2>&1 < /dev/null & echo $!`
  );
  const pgid = Number.parseInt(started.stdout, 10);
  try {
    const { attempts, ...verdict } = await probeServer(
      send,
      variants,
      'replay',
      replayPatience(),
      sleep
    );
    const tail = await ctx.exec(
      `tail -c ${REPLAY_LOG_TAIL_BYTES} ${REPLAY_LOG}`
    );
    return {
      ...verdict,
      replay: { ran: true, command, attempts, log: tail.stdout.trim() },
    };
  } finally {
    await stopProcessGroup(ctx, pgid, sleep);
  }
}

/**
 * POSTs the scheduler's call to the local function and, when nothing accepts the secret live, replays the agent's last
 * `functions serve` long enough to probe it.
 */
export async function probeFunction(
  ctx: LocalStackEvalContext,
  stack: StackProbe,
  invocations: readonly SupabaseInvocation[],
  { sleep = wait }: { sleep?: Sleep } = {}
): Promise<FunctionProbe> {
  if (!stack.ok || !stack.apiUrl) {
    return {
      stackNotes: stack.ok
        ? 'the stack resolved without an API URL'
        : stack.notes,
      live: [],
      replay: { ran: false, reason: NO_STACK_REASON },
    };
  }
  const url = `${stack.apiUrl}${FUNCTIONS_PATH}${FUNCTION_NAME}`;
  const send = sender(ctx, url);
  const variants = authVariants(await readKeys(ctx, stack));

  const { attempts: live, ...liveVerdict } = await probeServer(
    send,
    variants,
    'live',
    livePatience,
    sleep
  );
  if (liveVerdict.accepted !== undefined) {
    return {
      url,
      live,
      replay: { ran: false, reason: 'the live server accepted the secret' },
      ...liveVerdict,
    };
  }
  const serve = lastServeInvocation(invocations);
  if (serve === undefined) {
    return {
      url,
      live,
      replay: {
        ran: false,
        reason: 'the agent never ran supabase functions serve',
      },
    };
  }
  return {
    url,
    live,
    ...(await replayServe(ctx, serve, send, variants, sleep)),
  };
}
