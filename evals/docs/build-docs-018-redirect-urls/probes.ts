import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

type Exec = Pick<LocalStackEvalContext, 'exec'>;
export type Step = { ok: boolean; message: string };
/** Where Auth sent each link: the url asked for, keyed to the url it kept. */
export type Probe = Step & { landed: Record<string, string> };

export const LIVE = 'https://book.harbourstudio.nz';

export const CHECK = {
  starts: 'the local stack starts with the project settings',
  owned: 'sign-in links can return to the live site, previews and local dev',
  others: "sign-in links refuse destinations the team doesn't own",
  fallback:
    'a link with no destination, or a refused one, lands on the live site',
} as const;

// DEPLOYMENTS.md. The callback paths are two segments deep on purpose.
const OWNED = [
  `${LIVE}/auth/callback`,
  `${LIVE}/auth/reset-password`,
  'https://studio-git-new-timetable-harbour-studio.vercel.app/auth/callback',
  'https://studio-3fj2k9-harbour-studio.vercel.app/auth/reset-password',
  'http://localhost:3000/auth/callback',
];

// Someone else's site, a lookalike that starts with the live host, and
// another Vercel team's preview.
const OTHERS = [
  'https://evil.example.com/auth/callback',
  'https://book.harbourstudio.nz.evil.example.com/auth/callback',
  'https://studio-3fj2k9-other-team.vercel.app/auth/callback',
];

const NO_DESTINATION = '';

/**
 * Auth reads its settings when its container is created, so restart the stack
 * to score what the project says rather than what was running. The sandbox
 * shim adds the eval's service excludes to `start`. Never throws.
 */
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

// Asks Auth for a sign-in link to each url, inside the sandbox, and reads back
// the destination it kept. An unlisted url isn't an error: Auth swaps in the
// default, so the swap is what we look for.
const SCRIPT = `
const api = process.env.P_API;
const key = process.env.P_KEY;
const email = process.env.P_EMAIL;
const urls = JSON.parse(process.env.P_URLS);
const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
const post = (path, body) =>
  fetch(api + path, { method: 'POST', headers, body: JSON.stringify(body) });
const created = await post('/auth/v1/admin/users', { email, email_confirm: true });
if (!created.ok) {
  console.log(JSON.stringify({ error: 'creating a user: ' + created.status + ' ' + (await created.text()).slice(0, 200) }));
  process.exit(0);
}
const landed = {};
for (const url of urls) {
  const res = await post('/auth/v1/admin/generate_link', {
    type: 'magiclink',
    email,
    ...(url ? { redirect_to: url } : {}),
  });
  const body = await res.json().catch(() => ({}));
  const link = body.action_link ?? body.properties?.action_link;
  landed[url] = link
    ? new URL(link).searchParams.get('redirect_to') ?? ''
    : 'no link: ' + res.status + ' ' + JSON.stringify(body).slice(0, 120);
}
console.log(JSON.stringify({ landed }));
`;

export async function probeLinks(ctx: Exec, started: Step): Promise<Probe> {
  if (!started.ok) return { ...started, landed: {} };
  try {
    const { apiUrl, key } = await readStack(ctx);
    const env = [
      `P_API='${apiUrl}'`,
      `P_KEY='${key}'`,
      `P_EMAIL='redirects-${randomUUID().slice(0, 8)}@example.test'`,
      `P_URLS='${JSON.stringify([NO_DESTINATION, ...OWNED, ...OTHERS])}'`,
    ].join(' ');
    const script = Buffer.from(SCRIPT, 'utf8').toString('base64');
    const result = await ctx.exec(
      `${env} node --input-type=module -e "$(echo ${script} | base64 -d)"`,
      { timeoutMs: 120_000 }
    );
    const line = (result.stdout ?? '').trim().split('\n').at(-1) ?? '';
    const parsed = JSON.parse(line.startsWith('{') ? line : '{}');
    if (parsed.landed) return { ok: true, message: '', landed: parsed.landed };
    return {
      ok: false,
      message: parsed.error ?? errorLine(`${result.stderr}\n${result.stdout}`),
      landed: {},
    };
  } catch (error) {
    return { ok: false, message: messageOf(error), landed: {} };
  }
}

export function checkStackStarts(started: Step): CheckResult {
  return {
    name: CHECK.starts,
    passed: started.ok,
    notes: started.ok ? 'supabase start exited 0' : started.message,
  };
}

export function checkOwnedAccepted(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.owned, probe);
  const refused = OWNED.filter((url) => probe.landed[url] !== url);
  return {
    name: CHECK.owned,
    passed: refused.length === 0,
    notes:
      refused.length === 0
        ? `all ${OWNED.length} kept`
        : `sent elsewhere: ${refused.map((url) => `${url} -> ${probe.landed[url]}`).join('; ')}`,
  };
}

// Pairs with CHECK.owned: refusing everything passes this alone.
export function checkOthersRefused(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.others, probe);
  const kept = OTHERS.filter((url) => probe.landed[url] === url);
  return {
    name: CHECK.others,
    passed: kept.length === 0,
    notes:
      kept.length === 0
        ? `all ${OTHERS.length} refused`
        : `still allowed: ${kept.join('; ')}`,
  };
}

// An accepted outsider is CHECK.others' failure, so only the refused ones
// count here.
export function checkFallbackIsLive(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.fallback, probe);
  const fallbacks = [NO_DESTINATION, ...OTHERS]
    .filter((url) => probe.landed[url] !== url)
    .map((url) => probe.landed[url] ?? '');
  const wrong = [...new Set(fallbacks.filter((url) => originOf(url) !== LIVE))];
  return {
    name: CHECK.fallback,
    passed: wrong.length === 0,
    notes:
      wrong.length === 0
        ? `falls back to ${LIVE}`
        : `falls back to ${wrong.join('; ')}`,
  };
}

// `ctx.stackStatus()` wants the publishable key too; this only needs the
// admin key, under whichever name the CLI reports it.
async function readStack(ctx: Exec): Promise<{ apiUrl: string; key: string }> {
  const result = await ctx.exec('supabase status -o json 2>/dev/null');
  const out = result.stdout ?? '';
  const parsed = JSON.parse(
    out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
  );
  const apiUrl = parsed.API_URL;
  const key = parsed.SERVICE_ROLE_KEY || parsed.SECRET_KEY;
  if (!apiUrl || !key) {
    throw new Error(
      `supabase status had no API_URL or admin key: ${Object.keys(parsed).join(', ')}`
    );
  }
  return { apiUrl, key };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function errorLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines.find((l) => /error|failed/i.test(l)) ?? lines.at(-1);
  return (line ?? 'no output').slice(0, 300);
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function blocked(name: string, step: Step): CheckResult {
  return { name, passed: false, notes: `not run: ${step.message}` };
}
