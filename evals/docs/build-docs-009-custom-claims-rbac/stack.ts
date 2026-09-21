import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import { parse as parseToml } from 'smol-toml';

export type StackState = {
  running: boolean;
  statusError?: string;
};

export async function readStackState(
  ctx: LocalStackEvalContext
): Promise<StackState> {
  const status = await ctx.exec('supabase status -o env 2>/dev/null', {
    timeoutMs: 120_000,
  });
  const running = /(^|\n)(PUBLISHABLE_KEY|ANON_KEY)=/.test(status.stdout ?? '');
  return {
    running,
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
  ctx: LocalStackEvalContext
): Promise<CheckResult> {
  const name = 'the access token hook is switched on for the local project';
  let config: string;
  try {
    config = await ctx.readFile('supabase/config.toml');
  } catch (error) {
    return {
      name,
      passed: false,
      notes: `could not read supabase/config.toml: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseToml(config);
  } catch (error) {
    return {
      name,
      passed: false,
      notes: `supabase/config.toml is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const hook = readTable(
    readTable(readTable(parsed, 'auth'), 'hook'),
    'custom_access_token'
  );
  if (!hook) {
    return {
      name,
      passed: false,
      notes:
        'supabase/config.toml has no [auth.hook.custom_access_token] section',
    };
  }

  const enabled = hook.enabled === true || hook.enabled === 'true';
  const uri =
    typeof hook.uri === 'string' && hook.uri.length > 0 ? hook.uri : undefined;

  return {
    name,
    passed: enabled && uri !== undefined,
    notes: enabled
      ? uri
        ? `enabled, pointing at ${uri}`
        : 'enabled with no uri, so Auth has no function to call'
      : 'the section is present but not enabled',
  };
}

function readTable(
  value: unknown,
  key: string
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const child = (value as Record<string, unknown>)[key];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) {
    return undefined;
  }
  return child as Record<string, unknown>;
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
