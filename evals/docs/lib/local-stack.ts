import type { LocalStackEvalContext } from '@supabase-evals/core';

type Exec = Pick<LocalStackEvalContext, 'exec'>;
export type Step = { ok: boolean; message: string };

// Auth only reads config at container start. `supabase stop` keeps volumes.
export async function restartStack(ctx: Exec): Promise<Step> {
  try {
    const result = await ctx.exec(
      'supabase stop >/dev/null 2>&1; supabase start 2>&1',
      { timeoutMs: 300_000 }
    );
    return result.exitCode === 0
      ? { ok: true, message: '' }
      : { ok: false, message: errorLine(result.stdout ?? '') };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

export type Stack = { apiUrl: string; adminKey: string; clientKey: string };

// `ctx.stackStatus()` throws if any key it expects is missing.
export async function readStack(ctx: Exec): Promise<Stack> {
  const result = await ctx.exec('supabase status -o json 2>/dev/null');
  const out = result.stdout ?? '';
  const parsed = JSON.parse(
    out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
  );
  const stack = {
    apiUrl: parsed.API_URL,
    adminKey: parsed.SERVICE_ROLE_KEY || parsed.SECRET_KEY,
    clientKey: parsed.PUBLISHABLE_KEY || parsed.ANON_KEY,
  };
  if (!stack.apiUrl || !stack.adminKey || !stack.clientKey) {
    throw new Error(
      `supabase status is missing the api url or a key: ${Object.keys(parsed).join(', ')}`
    );
  }
  return stack;
}

// Env values are single-quoted in the shell, so they can't contain quotes.
export async function runScript(
  ctx: Exec,
  script: string,
  env: Record<string, string>
): Promise<Record<string, unknown>> {
  const vars = Object.entries(env)
    .map(([name, value]) => `${name}='${value}'`)
    .join(' ');
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  const result = await ctx.exec(
    `${vars} node --input-type=module -e "$(echo ${encoded} | base64 -d)"`,
    { timeoutMs: 120_000 }
  );
  const line = (result.stdout ?? '').trim().split('\n').at(-1) ?? '';
  if (line.startsWith('{')) return JSON.parse(line);
  throw new Error(errorLine(`${result.stderr}\n${result.stdout}`));
}

export function errorLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.find((l) => /error|failed/i.test(l)) ?? lines.at(-1);
  return (line ?? 'no output').slice(0, 300);
}

export function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
