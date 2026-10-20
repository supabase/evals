import type {
  CommandResult,
  LocalStackEvalContext,
} from '@supabase-evals/core';
import {
  DIGEST_SECRET,
  FUNCTION_NAME,
  SECRET_HEADER,
  WRONG_SECRET,
} from './fixture.js';

export const API_URL = 'http://127.0.0.1:54321';
export const FUNCTION_URL = `${API_URL}/functions/v1/${FUNCTION_NAME}`;
export const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
export const PUBLISHABLE = 'sb_publishable_test_key';
export const ANON = 'anon.jwt.test';
export const SECRET_KEY = 'sb_secret_test_key';
export const SERVICE_ROLE = 'service.role.jwt.test';
export const PGID = 4242;
export const REPLAY_LOG = '/tmp/eval-serve-replay.log';
export const HARNESS_LOG = '/tmp/functions-serve.log';

export const KEYS = JSON.stringify({
  API_URL,
  DB_URL,
  PUBLISHABLE_KEY: PUBLISHABLE,
  ANON_KEY: ANON,
});

export const MANAGED_KEYS = [
  '[task] Resolving the default stack',
  JSON.stringify({
    API_URL,
    PUBLISHABLE_KEY: PUBLISHABLE,
    SECRET_KEY,
    ANON_KEY: ANON,
    SERVICE_ROLE_KEY: SERVICE_ROLE,
  }),
  '[task] Done',
].join('\n');

export type Reply =
  | { status: number; body?: string; takesMs?: number }
  | 'throw';

export type Seen = {
  secret: 'right' | 'wrong' | 'absent' | 'other';
  apikey?: string;
  authorization?: string;
  server: 'live' | 'replay';
  at: number;
};

export type Handler = (request: Seen, attempt: number) => Reply;

export type Kill = { signal: 'TERM' | 'KILL'; operands: number[] };

type Intercepted = CommandResult | 'throw' | undefined;

export type SandboxOptions = {
  live: Handler;
  replay?: Handler;
  legacyKeys?: string | null;
  managedKeys?: string | null;
  log?: string;
  harnessServe?: boolean;
  servers?: readonly number[];
  zombieServers?: readonly number[];
  serversSurviveTerm?: boolean;
  stubbornServers?: readonly number[];
  survivesTerm?: boolean;
  leavesZombies?: boolean;
  replayDies?: boolean;
  replayDiesAfter?: number;
  trailingNewline?: boolean;
  /** Overrides the reply to the `call`th command of `kind` (counting from 0). */
  intercept?: (kind: string, call: number) => Intercepted;
  /** Answers commands the sandbox does not model; its `kind` is recorded as the event. */
  fallback?: (
    command: string
  ) => { kind: string; result: CommandResult } | undefined;
};

type Process = {
  pid: number;
  pgid: number;
  state: 'S' | 'Z';
  serves: boolean;
};

const KILL_COMMAND = /^kill -(TERM|KILL) -- (.+)$/;

function parseKill(command: string): Kill | undefined {
  const match = KILL_COMMAND.exec(command);
  return match
    ? {
        signal: match[1] as Kill['signal'],
        operands: match[2].split(' ').map(Number),
      }
    : undefined;
}

export const ok = (stdout = ''): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: '',
});

export const failed = (stderr: string, exitCode = 1): CommandResult => ({
  ok: false,
  exitCode,
  stdout: '',
  stderr,
});

function secretKind(value: string | undefined): Seen['secret'] {
  if (value === undefined || value === '') return 'absent';
  if (value === DIGEST_SECRET) return 'right';
  if (value === WRONG_SECRET) return 'wrong';
  return 'other';
}

function parseRequest(command: string): Omit<Seen, 'server' | 'at'> {
  const header = (pattern: RegExp) => pattern.exec(command)?.[1];
  return {
    secret: secretKind(
      header(new RegExp(`${SECRET_HEADER}:[ \\t]*([^'"\\s]*)`, 'i'))
    ),
    apikey: header(/apikey:[ \t]*([^'"\s]*)/i),
    authorization: header(/authorization:[ \t]*(?:Bearer[ \t]+)?([^'"\s]*)/i),
  };
}

function curlResult(reply: Reply, trailingNewline: boolean): CommandResult {
  if (reply === 'throw') throw new Error('sandbox gone');
  const { status, body = '' } = reply;
  if (status === 0) {
    return { ok: false, exitCode: 7, stdout: '\n000', stderr: body };
  }
  return ok(`${body}\n${status}${trailingNewline ? '\n' : ''}`);
}

export function functionReplies(
  gate?: (request: Seen) => Reply | undefined
): Handler {
  return (request) => {
    const blocked = gate?.(request);
    if (blocked !== undefined) return blocked;
    if (request.secret === 'right') {
      return { status: 200, body: '{"queued":true}' };
    }
    return request.secret === 'wrong'
      ? { status: 401, body: 'wrong secret' }
      : { status: 401, body: 'missing secret' };
  };
}

export const needsAnonBearer = (request: Seen): Reply | undefined =>
  request.authorization === ANON
    ? undefined
    : { status: 401, body: 'Invalid JWT' };

export const needsPublishable = (request: Seen): Reply | undefined =>
  request.apikey === PUBLISHABLE
    ? undefined
    : { status: 401, body: 'Invalid JWT' };

export const rejectEverything: Handler = () => ({
  status: 401,
  body: 'unauthorized',
});

/** An in-memory sandbox that answers the probe's curl, process and key commands and records what was run. */
export function createSandbox(options: SandboxOptions) {
  const commands: string[] = [];
  const events: string[] = [];
  const requests: Seen[] = [];
  const kills: Kill[] = [];
  const calls = new Map<string, number>();
  const served = { live: 0, replay: 0 };
  const processes: Process[] = [
    { pid: 1, pgid: 1, state: 'S', serves: false },
    ...(options.servers ?? []).map(
      (pid): Process => ({ pid, pgid: pid, state: 'S', serves: true })
    ),
    ...(options.zombieServers ?? []).map(
      (pid): Process => ({ pid, pgid: pid, state: 'Z', serves: true })
    ),
  ];
  let clock = 0;
  let started = false;
  let replayUp = false;

  const inReplayGroup = (process: Process) => process.pgid === PGID;
  const isLive = (process: Process) => process.state === 'S';

  const end = (process: Process) => {
    if (options.leavesZombies === true) process.state = 'Z';
    else processes.splice(processes.indexOf(process), 1);
  };

  const refreshReplay = () => {
    replayUp = processes.some(
      (process) => inReplayGroup(process) && isLive(process)
    );
  };

  const refused: Handler = () => ({ status: 0, body: 'refused' });

  const curl = (command: string): CommandResult => {
    const server = started ? 'replay' : 'live';
    const request: Seen = { ...parseRequest(command), server, at: clock };
    requests.push(request);
    const handler =
      server === 'live'
        ? options.live
        : replayUp
          ? (options.replay ?? refused)
          : refused;
    const reply = handler(request, served[server]++);
    if (reply !== 'throw') clock += reply.takesMs ?? 0;
    if (server === 'replay' && served.replay === options.replayDiesAfter) {
      for (const process of processes.filter(inReplayGroup)) end(process);
      refreshReplay();
    }
    return curlResult(reply, options.trailingNewline === true);
  };

  const start = (): CommandResult => {
    started = true;
    const state = options.replayDies === true ? 'Z' : 'S';
    processes.push(
      { pid: PGID, pgid: PGID, state, serves: false },
      { pid: PGID + 1, pgid: PGID, state, serves: true }
    );
    refreshReplay();
    return ok(`${PGID}\n`);
  };

  const scan = (): CommandResult =>
    ok(
      `${processes
        .map(
          ({ pid, pgid, state, serves }) =>
            `${pid} ${pgid} ${state} ${serves ? 1 : 0}`
        )
        .join('\n')}\n`
    );

  const survivesSignal = (process: Process, { signal, operands }: Kill) => {
    if (signal !== 'TERM') return false;
    if (operands.some((operand) => operand < 0)) {
      return options.survivesTerm === true;
    }
    return (
      options.serversSurviveTerm === true ||
      options.stubbornServers?.includes(process.pid) === true
    );
  };

  const kill = (request: Kill): CommandResult => {
    kills.push(request);
    for (const process of processes.filter(
      (candidate) =>
        request.operands.includes(candidate.pid) ||
        request.operands.includes(-candidate.pgid)
    )) {
      if (!survivesSignal(process, request)) end(process);
    }
    refreshReplay();
    return ok();
  };

  const keys = (output: string | null | undefined): CommandResult =>
    output === null ? failed('The local stack is not running') : ok(output);

  const classify = (command: string): string => {
    if (command.includes('curl')) return 'curl';
    if (command.includes('setsid')) return 'start';
    if (command.includes('/proc/')) return 'scan';
    const killed = parseKill(command);
    if (killed) {
      const group = killed.operands.some((operand) => operand < 0);
      if (killed.signal === 'TERM') return group ? 'term' : 'term-servers';
      return group ? 'sigkill' : 'kill-servers';
    }
    if (command.includes('tail')) return 'tail';
    if (command.includes(HARNESS_LOG)) return 'harness';
    if (
      command.includes('supabase status -o json') ||
      command.includes('stack status --env')
    ) {
      return 'keys';
    }
    return 'other';
  };

  const respond = (kind: string, command: string): CommandResult => {
    switch (kind) {
      case 'curl':
        return curl(command);
      case 'start':
        return start();
      case 'scan':
        return scan();
      case 'term':
      case 'term-servers':
      case 'sigkill':
      case 'kill-servers':
        return kill(parseKill(command) as Kill);
      case 'tail':
        return ok(command.includes(REPLAY_LOG) ? (options.log ?? '') : '');
      case 'harness':
        return options.harnessServe === true ? ok() : failed('');
      case 'keys':
        return command.includes('stack status')
          ? keys(options.managedKeys ?? null)
          : keys(options.legacyKeys === undefined ? KEYS : options.legacyKeys);
      default:
        return ok();
    }
  };

  const exec = async (command: string): Promise<CommandResult> => {
    commands.push(command);
    let kind = classify(command);
    let result: CommandResult | undefined;
    if (kind === 'other') {
      const custom = options.fallback?.(command);
      if (custom !== undefined) {
        kind = custom.kind;
        result = custom.result;
      }
    }
    events.push(kind);
    const call = calls.get(kind) ?? 0;
    calls.set(kind, call + 1);
    const forced = options.intercept?.(kind, call);
    if (forced === 'throw') throw new Error('sandbox gone');
    if (forced !== undefined) return forced;
    return result ?? respond(kind, command);
  };

  const sleep = async (ms: number) => {
    events.push(`sleep ${ms}`);
    clock += ms;
  };

  const sleepsIn = (from: number, to?: number) =>
    events
      .slice(from, to)
      .filter((event) => event.startsWith('sleep '))
      .reduce(
        (total, event) => total + Number(event.slice('sleep '.length)),
        0
      );

  return {
    ctx: { exec } as unknown as LocalStackEvalContext,
    commands,
    events,
    requests,
    kills,
    clock: { sleep, now: () => clock },
    sleeps: () =>
      events
        .filter((event) => event.startsWith('sleep '))
        .map((event) => Number(event.slice('sleep '.length))),
    sleptBetween: (from: string, to: string) =>
      sleepsIn(events.indexOf(from), events.indexOf(to)),
    sleptAfter: (event: string) => sleepsIn(events.lastIndexOf(event)),
  };
}
