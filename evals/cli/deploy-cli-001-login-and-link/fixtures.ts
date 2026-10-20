import type {
  CommandResult,
  LocalStackEvalContext,
  ManagementApiClient,
  ToolCallRecord,
} from '@supabase-evals/core';
import { type HostedFacts, readHostedFacts } from './hosted.js';
import { LINKED_CLI_PROBE, PROJECT_REF_PATH } from './link.js';
import { ACCESS_TOKEN_PATTERN } from './token.js';

export type ExecCtx = Pick<LocalStackEvalContext, 'exec'>;

export const HOSTED_REF = 'abcdefghijklmnopqrst';
export const OTHER_REF = 'zyxwvutsrqponmlkjihg';
export const FAKE_ACCESS_TOKEN = `sbp_${'e'.repeat(40)}`;

export const HOSTED_CONTEXT = {
  hostedRef: HOSTED_REF,
  hostedMgmt: {} as ManagementApiClient,
};

export const HOSTED_OK: HostedFacts = { ok: true, ref: HOSTED_REF };

export const HOSTED_ABSENT: HostedFacts = readHostedFacts({});

export function commandResult(stdout = ''): CommandResult {
  return { ok: true, exitCode: 0, stdout, stderr: '' };
}

export function failure(exitCode: number, output = ''): CommandResult {
  return { ok: false, exitCode, stdout: output, stderr: '' };
}

export function stderrFailure(exitCode: number, stderr: string): CommandResult {
  return { ok: false, exitCode, stdout: '', stderr };
}

export const MISSING_FILE = stderrFailure(
  1,
  `cat: ${PROJECT_REF_PATH}: No such file or directory`
);

export const crash = (message = 'sandbox gone') => {
  return (): CommandResult => {
    throw new Error(message);
  };
};

type Respond = CommandResult | (() => CommandResult);
export type Route = [match: string | RegExp, respond: Respond];

/** Answers each command with the first route whose matcher it satisfies, so a prepended route overrides a later one. */
export function fakeExec(
  routes: readonly Route[],
  fallback: CommandResult = failure(127, 'command not found')
) {
  const calls: string[] = [];
  const exec: ExecCtx['exec'] = async (command) => {
    calls.push(command);
    const route = routes.find(([match]) =>
      typeof match === 'string' ? command.includes(match) : match.test(command)
    );
    if (route === undefined) return fallback;
    const [, respond] = route;
    return typeof respond === 'function' ? respond() : respond;
  };
  return { ctx: { exec } as ExecCtx, calls };
}

export const readLinkRoute = (respond: Respond): Route => [
  `cat ${PROJECT_REF_PATH}`,
  respond,
];
export const probeRoute = (respond: Respond): Route => [
  LINKED_CLI_PROBE,
  respond,
];
export const controlRoute = (respond: Respond): Route => [
  'test -f supabase/config.toml',
  respond,
];
export const grepRoute = (respond: Respond): Route => [
  ACCESS_TOKEN_PATTERN,
  respond,
];
export const tokenEnvRoute = (respond: Respond): Route => [
  /test -n .*SUPABASE_ACCESS_TOKEN/,
  respond,
];
export const persistedLoginRoute = (respond: Respond): Route => [
  /test -s .*\/access-token/,
  respond,
];
export const versionRoute = (respond: Respond): Route => [
  /supabase --version$/,
  respond,
];

export const PROBE_OUTPUT = 'NAME  DIGEST\n';

/** A run where every probe reports the repo linked to HOSTED_REF with the CLI reaching it and no token in the repo. */
export function healthyRoutes(): Route[] {
  return [
    versionRoute(commandResult('2.117.0\n')),
    readLinkRoute(commandResult(`${HOSTED_REF}\n`)),
    probeRoute(commandResult(PROBE_OUTPUT)),
    grepRoute(failure(1)),
    controlRoute(commandResult()),
    tokenEnvRoute(commandResult()),
    persistedLoginRoute(failure(1)),
  ];
}

export function shellCall(command: string): ToolCallRecord {
  return {
    tool: { kind: 'other', toolName: 'shell' },
    body: { command },
    command,
    result: '',
    ts: 0,
  };
}
