import type { LocalStackEvalContext } from '@supabase-evals/core';

export type StackStatus = {
  apiUrl: string;
  publishableKey: string;
  /** Legacy, and still what the guide says serves the same purpose. */
  anonKey: string;
  secretKey: string;
};

/** Parse `supabase status -o json` for the stack's URL and keys. */
export async function readStatus(
  ctx: LocalStackEvalContext
): Promise<StackStatus> {
  const res = await ctx.exec('supabase status -o json');
  const start = res.stdout.indexOf('{');
  const end = res.stdout.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(
      `could not read \`supabase status\`: ${res.stderr || res.stdout}`
    );
  }
  const status = JSON.parse(res.stdout.slice(start, end + 1)) as Record<
    string,
    unknown
  >;

  const apiUrl = str(status.API_URL);
  const publishableKey = str(status.PUBLISHABLE_KEY);
  const anonKey = str(status.ANON_KEY);
  const secretKey = str(status.SECRET_KEY);

  if (!apiUrl || !publishableKey || !secretKey) {
    throw new Error(
      `missing API_URL/PUBLISHABLE_KEY/SECRET_KEY from \`supabase status\`; got keys: ${Object.keys(status).join(', ')}`
    );
  }

  return { apiUrl, publishableKey, anonKey, secretKey };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
