import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

import {
  messageOf,
  readStack,
  runScript,
  type Step,
} from '../lib/local-stack.js';

type Exec = Pick<LocalStackEvalContext, 'exec'>;
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

// DEPLOYMENTS.md. The callback paths are two segments deep on purpose. The
// last preview isn't in the seed, so listing the example previews exactly
// doesn't pass: the next branch has to work too.
const OWNED = [
  `${LIVE}/auth/callback`,
  `${LIVE}/auth/reset-password`,
  'https://studio-git-new-timetable-harbour-studio.vercel.app/auth/callback',
  'https://studio-3fj2k9-harbour-studio.vercel.app/auth/reset-password',
  'http://localhost:3000/auth/callback',
  'https://studio-git-fix-login-harbour-studio.vercel.app/auth/callback',
];

// Someone else's site, lookalikes that start with the live host and with
// local dev, and another Vercel team's preview.
const OTHERS = [
  'https://evil.example.com/auth/callback',
  'https://book.harbourstudio.nz.evil.example.com/auth/callback',
  'http://localhost.evil.example.com/auth/callback',
  'https://studio-3fj2k9-other-team.vercel.app/auth/callback',
];

const NO_DESTINATION = '';

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
    const { apiUrl, adminKey } = await readStack(ctx);
    const parsed = await runScript(ctx, SCRIPT, {
      P_API: apiUrl,
      P_KEY: adminKey,
      P_EMAIL: `redirects-${randomUUID().slice(0, 8)}@example.test`,
      P_URLS: JSON.stringify([NO_DESTINATION, ...OWNED, ...OTHERS]),
    });
    if (parsed.landed) {
      return {
        ok: true,
        message: '',
        landed: parsed.landed as Record<string, string>,
      };
    }
    return { ok: false, message: String(parsed.error), landed: {} };
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

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function blocked(name: string, step: Step): CheckResult {
  return { name, passed: false, notes: `not run: ${step.message}` };
}
