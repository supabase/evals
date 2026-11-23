import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  messageOf,
  readStack,
  runScript,
  type Step,
} from '../lib/local-stack.js';

type Ctx = Pick<LocalStackEvalContext, 'exec' | 'query'>;

export const CHECK = {
  starts: 'the local stack starts with the project settings',
  noNewAccounts: "a new email can't create an account",
  confirmed: 'testers who confirmed can still log in with their password',
  unconfirmed: 'testers who never confirmed can log in, as the same account',
  strangers: "people who aren't testers still can't get in",
} as const;

// Matches seed.sql.
const PASSWORD = 'fernhill-beta';
const ID = (n: number) => `6d1f4b0a-1c3e-4f6a-9b2d-0a1b2c3d4e0${n}`;
const CONFIRMED = {
  'maia.tane@example.com': ID(1),
  'oscar.lindqvist@example.com': ID(2),
};
const UNCONFIRMED = {
  'priya.raman@example.com': ID(3),
  'tomas.herrera@example.com': ID(4),
};
const STRANGERS = ['cheap.seeds.deals@example.net', 'j.wright.88@example.org'];

type Reply = { status: number; code: string };
type Login = Reply & { session: boolean; id: string };
export type Probe = Step & {
  signup?: Reply;
  magicLink?: Reply;
  logins: Record<string, Login>;
  created: string[];
};

const SCRIPT = `
const api = process.env.P_API;
const key = process.env.P_KEY;
const password = process.env.P_PASSWORD;
const call = async (path, body) => {
  const res = await fetch(api + path, {
    method: 'POST',
    headers: { apikey: key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, code: json.error_code ?? json.code ?? '', json };
};
const reply = ({ status, code }) => ({ status, code: String(code) });
const signup = reply(await call('/auth/v1/signup', { email: process.env.P_NEW_PASSWORD, password }));
const magicLink = reply(await call('/auth/v1/otp', { email: process.env.P_NEW_LINK, create_user: true }));
const logins = {};
for (const email of JSON.parse(process.env.P_LOGINS)) {
  const r = await call('/auth/v1/token?grant_type=password', { email, password });
  logins[email] = { ...reply(r), session: Boolean(r.json.access_token), id: r.json.user?.id ?? '' };
}
console.log(JSON.stringify({ signup, magicLink, logins }));
`;

export async function probeAccounts(ctx: Ctx, started: Step): Promise<Probe> {
  if (!started.ok) return { ...started, logins: {}, created: [] };
  const run = randomUUID().slice(0, 8);
  const fresh = [
    `new-${run}-password@example.com`,
    `new-${run}-link@example.com`,
  ];
  try {
    const { apiUrl, clientKey } = await readStack(ctx);
    const out = await runScript(ctx, SCRIPT, {
      P_API: apiUrl,
      P_KEY: clientKey,
      P_PASSWORD: PASSWORD,
      P_NEW_PASSWORD: fresh[0],
      P_NEW_LINK: fresh[1],
      P_LOGINS: JSON.stringify([
        ...Object.keys(CONFIRMED),
        ...Object.keys(UNCONFIRMED),
        ...STRANGERS,
      ]),
    });
    // Trust auth.users, not the reply.
    const { rows } = await ctx.query(
      `select email from auth.users where email in ('${fresh.join("', '")}')`
    );
    return {
      ok: true,
      message: '',
      signup: out.signup as Reply,
      magicLink: out.magicLink as Reply,
      logins: out.logins as Record<string, Login>,
      created: (rows as { email: string }[]).map((row) => row.email),
    };
  } catch (error) {
    return { ok: false, message: messageOf(error), logins: {}, created: [] };
  }
}

export function checkStackStarts(started: Step): CheckResult {
  return {
    name: CHECK.starts,
    passed: started.ok,
    notes: started.ok ? 'supabase start exited 0' : started.message,
  };
}

// 429 is rate limiting, not a refusal.
const refused = (reply?: Reply) =>
  !!reply && reply.status >= 400 && reply.status < 500 && reply.status !== 429;
const show = (reply?: Reply) =>
  reply ? `${reply.status} ${reply.code}`.trim() : 'no reply';

export function checkNoNewAccounts(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.noNewAccounts, probe);
  const passed =
    probe.created.length === 0 &&
    refused(probe.signup) &&
    refused(probe.magicLink);
  return {
    name: CHECK.noNewAccounts,
    passed,
    notes:
      probe.created.length > 0
        ? `created: ${probe.created.join(', ')}`
        : `password sign-up ${show(probe.signup)}, emailed link ${show(probe.magicLink)}`,
  };
}

export function checkConfirmedLogIn(probe: Probe): CheckResult {
  return logsIn(CHECK.confirmed, probe, CONFIRMED);
}

export function checkUnconfirmedLogIn(probe: Probe): CheckResult {
  return logsIn(CHECK.unconfirmed, probe, UNCONFIRMED);
}

export function checkStrangersKeptOut(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.strangers, probe);
  const inside = STRANGERS.filter((email) => probe.logins[email]?.session);
  return {
    name: CHECK.strangers,
    passed: inside.length === 0,
    notes:
      inside.length === 0
        ? STRANGERS.map((e) => `${e}: ${show(probe.logins[e])}`).join('; ')
        : `logged in: ${inside.join(', ')}`,
  };
}

function logsIn(
  name: string,
  probe: Probe,
  accounts: Record<string, string>
): CheckResult {
  if (!probe.ok) return blocked(name, probe);
  const wrong = Object.entries(accounts).flatMap(([email, id]) => {
    const login = probe.logins[email];
    if (!login?.session) return [`${email}: ${show(login)}`];
    if (login.id !== id) return [`${email}: a different account (${login.id})`];
    return [];
  });
  return {
    name,
    passed: wrong.length === 0,
    notes:
      wrong.length === 0
        ? `all ${Object.keys(accounts).length} logged in`
        : wrong.join('; '),
  };
}

function blocked(name: string, step: Step): CheckResult {
  return { name, passed: false, notes: `not run: ${step.message}` };
}
