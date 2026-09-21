import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

export type StackState = {
  running: boolean;
  apiUrl?: string;
  publishableKey?: string;
  secretKey?: string;
  error?: string;
};

export async function readStackState(
  ctx: LocalStackEvalContext
): Promise<StackState> {
  const status = await ctx.exec('supabase status -o env 2>/dev/null', {
    timeoutMs: 180_000,
  });
  const env = parseEnv(status.stdout ?? '');
  const apiUrl = env.API_URL;
  const publishableKey = env.PUBLISHABLE_KEY ?? env.ANON_KEY;
  const secretKey = env.SECRET_KEY ?? env.SERVICE_ROLE_KEY;

  if (!apiUrl || !publishableKey) {
    return {
      running: false,
      error: `supabase status gave no ${apiUrl ? 'api key' : 'API_URL'}; it reported: ${Object.keys(env).join(', ') || 'nothing'}`,
    };
  }
  return { running: true, apiUrl, publishableKey, secretKey };
}

export function checkStackIsRunning(state: StackState): CheckResult {
  return {
    name: 'the local stack is running',
    passed: state.running,
    notes: state.running ? state.apiUrl : state.error,
  };
}

function parseEnv(stdout: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  return env;
}
