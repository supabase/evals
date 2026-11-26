import type { LocalStackEvalContext } from '@supabase-evals/core';
import { readStack, restartStack, type Step } from '../lib/local-stack.js';

const CONFIG = 'supabase/config.toml';
const SECTION = '[auth.mfa.totp]';
const SWITCHES = ['enroll_enabled = true', 'verify_enabled = true'];

type Exec = Pick<LocalStackEvalContext, 'exec'>;

export async function turnCodesOn(ctx: Exec): Promise<Step> {
  const read = await ctx.exec(`cat ${CONFIG}`);
  if (read.exitCode !== 0) {
    return { ok: false, message: `could not read ${CONFIG}` };
  }
  const encoded = Buffer.from(withCodesOn(read.stdout ?? ''), 'utf8').toString(
    'base64'
  );
  const written = await ctx.exec(`echo ${encoded} | base64 -d > ${CONFIG}`);
  if (written.exitCode !== 0) {
    return { ok: false, message: `could not write ${CONFIG}` };
  }
  const restarted = await restartStack(ctx);
  if (!restarted.ok) {
    return {
      ok: false,
      message: `the stack did not restart with codes on: ${restarted.message}`,
    };
  }
  return waitForAuth(ctx);
}

async function waitForAuth(ctx: Exec): Promise<Step> {
  let last = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const stack = await readStack(ctx);
      const response = await fetch(`${stack.apiUrl}/auth/v1/health`, {
        headers: { apikey: stack.clientKey },
      });
      if (response.ok) return { ok: true, message: '' };
      last = `health returned ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => {
      setTimeout((): void => resolve(undefined), 2000);
    });
  }
  return {
    ok: false,
    message: `Auth did not answer after the restart: ${last.slice(0, 200)}`,
  };
}

export function withCodesOn(toml: string): string {
  const lines = toml.split('\n');
  const start = lines.findIndex((line) => line.trim() === SECTION);
  if (start < 0) {
    return `${toml.trimEnd()}\n\n${SECTION}\n${SWITCHES.join('\n')}\n`;
  }
  const next = lines.findIndex(
    (line, index) => index > start && /^\s*\[/.test(line)
  );
  const end = next < 0 ? lines.length : next;
  const kept = lines
    .slice(start + 1, end)
    .filter((line) => !/^\s*(enroll_enabled|verify_enabled)\s*=/.test(line));
  return [
    ...lines.slice(0, start + 1),
    ...SWITCHES,
    ...kept,
    ...lines.slice(end),
  ].join('\n');
}
