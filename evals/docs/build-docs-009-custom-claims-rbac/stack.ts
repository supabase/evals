import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

const HOOK_PREFIX = 'GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN';

export type StackState = {
  running: boolean;
  apiUrl?: string;
  statusError?: string;
};

export async function readStackState(
  ctx: LocalStackEvalContext
): Promise<StackState> {
  const status = await ctx.exec('supabase status -o env 2>/dev/null', {
    timeoutMs: 120_000,
  });
  const env = parseEnv(status.stdout ?? '');
  const running = Boolean(env.PUBLISHABLE_KEY ?? env.ANON_KEY);
  return {
    running,
    apiUrl: env.API_URL,
    statusError: running ? undefined : firstError(status),
  };
}

export function checkStackIsRunning(state: StackState): CheckResult {
  return {
    name: 'the local stack is running',
    passed: state.running,
    notes: state.running
      ? undefined
      : `supabase status reported no api keys: ${state.statusError ?? 'no output'}`,
  };
}

export async function checkHookIsEnabled(
  ctx: LocalStackEvalContext,
  state: StackState
): Promise<CheckResult> {
  const name = 'the access token hook is switched on for the local project';
  const port = state.apiUrl ? /:(\d+)\/?$/.exec(state.apiUrl)?.[1] : undefined;
  if (!port) {
    return {
      name,
      passed: false,
      notes: `supabase status gave no API_URL to locate the stack by${state.apiUrl ? `, only ${state.apiUrl}` : ''}`,
    };
  }

  const read = await ctx.exec(readAuthHookEnv(port), { timeoutMs: 120_000 });
  const container = /^container=(.*)$/m.exec(read.stdout ?? '')?.[1]?.trim();
  if (!container) {
    return {
      name,
      passed: false,
      notes: `the stack is up but no auth container carries this project's label: ${firstError(read)}`,
    };
  }

  const env = parseEnv(read.stdout ?? '');
  const enabled = env[`${HOOK_PREFIX}_ENABLED`];
  const uri = env[`${HOOK_PREFIX}_URI`];

  if (enabled === undefined && uri === undefined) {
    return {
      name,
      passed: false,
      notes: `${container} started without the hook in its environment${await configHint(ctx)}`,
    };
  }
  if (enabled?.toLowerCase() !== 'true') {
    return {
      name,
      passed: false,
      notes: `${container} carries the hook but not switched on (${HOOK_PREFIX}_ENABLED=${enabled ?? 'unset'})`,
    };
  }
  if (!uri) {
    return {
      name,
      passed: false,
      notes: 'enabled with no uri, so Auth has no function to call',
    };
  }
  return { name, passed: true, notes: `enabled, pointing at ${uri}` };
}

function readAuthHookEnv(port: string): string {
  const label = 'com.supabase.cli.project';
  return [
    `PROJECT=$(docker ps --filter publish=${port} --filter label=${label} --format '{{.Label "${label}"}}' 2>/dev/null | head -n 1)`,
    '[ -n "$PROJECT" ] || { echo "no container publishes the api port" >&2; exit 1; }',
    `AUTH=$(docker ps --filter label=${label}="$PROJECT" --format '{{.Names}}' 2>/dev/null | grep '^supabase_auth_' | head -n 1)`,
    '[ -n "$AUTH" ] || { echo "project $PROJECT has no running auth container" >&2; exit 1; }',
    'echo "container=$AUTH"',
    `docker inspect "$AUTH" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep "^${HOOK_PREFIX}_" || true`,
  ].join('\n');
}

async function configHint(ctx: LocalStackEvalContext): Promise<string> {
  try {
    const config = await ctx.readFile('supabase/config.toml');
    return config.includes('custom_access_token')
      ? ', though supabase/config.toml names custom_access_token, so it is either not switched on there or was switched on after the stack started'
      : ', and supabase/config.toml never names custom_access_token';
  } catch {
    return '';
  }
}

function parseEnv(stdout: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return env;
}

function firstError(result: {
  stdout?: string;
  stderr?: string;
}): string {
  const lines = `${result.stderr ?? ''}\n${result.stdout ?? ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const named = lines.find((line) => /^(ERROR|FATAL|failed)\b/i.test(line));
  return (named ?? lines[0] ?? 'no output').slice(0, 300);
}
