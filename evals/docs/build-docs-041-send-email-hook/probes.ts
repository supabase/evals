import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';
import {
  messageOf,
  readStack,
  runScript,
  type Stack,
  type Step,
} from '../lib/local-stack.js';

type Ctx = Pick<LocalStackEvalContext, 'exec' | 'query'>;

export const CHECK = {
  starts: 'the local stack starts with the project settings',
  queued: 'signing up puts the sign-up email in the outbox',
  confirms: "the sign-up email's button confirms the person",
  reset:
    "the password reset email's button opens the new-password page signed in",
} as const;

export const NEW_PASSWORD_PAGE = 'http://127.0.0.1:3000/account/new-password';
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

type Mail = { to_email: string; subject: string; html: string };

type Link = { kind: 'verify link' | 'token hash'; href: string; hash: string };

type Followed = Link & {
  status: number;
  location: string;
  session: boolean;
  error: string;
};

type Requests = {
  signUpStatus: number;
  signUpError: string;
  userId: string;
  resetStatus: number;
  resetError: string;
};

export type Probe = Step & {
  stack: Stack | null;
  signUpEmail: string;
  resetEmail: string;
  requests: Requests | null;
  signUpMails: Mail[];
  resetMails: Mail[];
  outboxError: string;
  signUpLinks: Followed[];
  resetLinks: Followed[];
  confirmed: boolean | null;
};

const REQUESTS = `
const api = process.env.P_API;
const client = process.env.P_CLIENT;
const admin = process.env.P_ADMIN;
const password = 'Kestrel-' + process.env.P_RUN + '-9';
const asClient = { apikey: client, 'Content-Type': 'application/json' };
const asAdmin = { apikey: admin, Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' };
const describe = (body) => String(body.msg || body.message || body.error_description || body.error || JSON.stringify(body)).slice(0, 200);
const healthy = () => fetch(api + '/auth/v1/health', { headers: { apikey: client } }).then((res) => res.ok).catch(() => false);
const until = Date.now() + 60000;
while (Date.now() < until && !(await healthy())) {
  await new Promise((resolve) => setTimeout(() => resolve(), 1000));
}
const out = { signUpStatus: 0, signUpError: '', userId: '', resetStatus: 0, resetError: '' };
const signUp = await fetch(api + '/auth/v1/signup', {
  method: 'POST',
  headers: asClient,
  body: JSON.stringify({ email: process.env.P_SIGNUP, password }),
});
const signedUp = await signUp.json().catch(() => ({}));
out.signUpStatus = signUp.status;
out.userId = signedUp.id || (signedUp.user && signedUp.user.id) || '';
if (!signUp.ok) out.signUpError = describe(signedUp);
const made = await fetch(api + '/auth/v1/admin/users', {
  method: 'POST',
  headers: asAdmin,
  body: JSON.stringify({ email: process.env.P_RESET, password, email_confirm: true }),
});
if (made.ok) {
  const reset = await fetch(api + '/auth/v1/recover?redirect_to=' + encodeURIComponent(process.env.P_PAGE), {
    method: 'POST',
    headers: asClient,
    body: JSON.stringify({ email: process.env.P_RESET }),
  });
  out.resetStatus = reset.status;
  if (!reset.ok) out.resetError = describe(await reset.json().catch(() => ({})));
} else {
  out.resetError = 'the scorer could not create the person: ' + describe(await made.json().catch(() => ({})));
}
console.log(JSON.stringify(out));
`;

const FOLLOW = `
const api = process.env.P_API;
const client = process.env.P_CLIENT;
const out = { status: 0, location: '', session: false, error: '' };
try {
  if (process.env.P_KIND === 'verify link') {
    const res = await fetch(process.env.P_HREF, { redirect: 'manual' });
    out.status = res.status;
    out.location = res.headers.get('location') || '';
  } else {
    const types = [...new Set([process.env.P_TYPE, 'email', 'recovery'].filter((type) => type))];
    for (const type of types) {
      const res = await fetch(api + '/auth/v1/verify', {
        method: 'POST',
        headers: { apikey: client, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, token_hash: process.env.P_HASH }),
      });
      out.status = res.status;
      const body = await res.json().catch(() => ({}));
      if (typeof body.access_token === 'string') {
        out.session = true;
        break;
      }
    }
  }
} catch (error) {
  out.error = String(error && error.cause ? error.cause.message || error.cause : error).slice(0, 200);
}
console.log(JSON.stringify(out));
`;

export async function probeEmails(ctx: Ctx, started: Step): Promise<Probe> {
  const run = randomUUID().slice(0, 8);
  const notRun: Probe = {
    ok: false,
    message: '',
    stack: null,
    signUpEmail: `reader-${run}@example.test`,
    resetEmail: `forgot-${run}@example.test`,
    requests: null,
    signUpMails: [],
    resetMails: [],
    outboxError: '',
    signUpLinks: [],
    resetLinks: [],
    confirmed: null,
  };
  if (!started.ok) return { ...notRun, message: started.message };
  try {
    const stack = await readStack(ctx);
    const requests = (await runScript(ctx, REQUESTS, {
      P_API: stack.apiUrl,
      P_CLIENT: stack.clientKey,
      P_ADMIN: stack.adminKey,
      P_RUN: run,
      P_SIGNUP: notRun.signUpEmail,
      P_RESET: notRun.resetEmail,
      P_PAGE: NEW_PASSWORD_PAGE,
    })) as Requests;
    const signUpMails = await readOutbox(ctx, notRun.signUpEmail);
    const resetMails = await readOutbox(ctx, notRun.resetEmail);
    const signUpHashes = await tokenHashes(ctx, notRun.signUpEmail);
    const resetHashes = await tokenHashes(ctx, notRun.resetEmail);
    const signUpLinks = await followEvery(
      ctx,
      stack,
      linksIn(mailsOf(signUpMails), signUpHashes),
      () => false
    );
    const resetLinks = await followEvery(
      ctx,
      stack,
      linksIn(mailsOf(resetMails), resetHashes),
      (followed) => resetProblem(followed) === undefined
    );
    return {
      ...notRun,
      ok: true,
      stack,
      requests,
      signUpMails: mailsOf(signUpMails),
      resetMails: mailsOf(resetMails),
      outboxError: errorOf(signUpMails) || errorOf(resetMails),
      signUpLinks,
      resetLinks,
      confirmed: await isConfirmed(ctx, notRun.signUpEmail),
    };
  } catch (error) {
    return { ...notRun, message: messageOf(error) };
  }
}

type OutboxRead = Mail[] | { error: string };

function mailsOf(read: OutboxRead): Mail[] {
  return 'error' in read ? [] : read;
}

function errorOf(read: OutboxRead): string {
  return 'error' in read ? read.error : '';
}

async function readOutbox(ctx: Ctx, address: string): Promise<OutboxRead> {
  try {
    const { rows } = await ctx.query(
      `select to_email, subject, html from public.outbox where to_email ilike ${sqlLiteral(`%${address}%`)} order by id`
    );
    return rows.map((row) => ({
      to_email: String(row.to_email ?? ''),
      subject: String(row.subject ?? ''),
      html: String(row.html ?? ''),
    }));
  } catch (error) {
    return { error: messageOf(error) };
  }
}

async function tokenHashes(ctx: Ctx, address: string): Promise<string[]> {
  const email = sqlLiteral(address);
  try {
    const { rows } = await ctx.query(
      `select token_hash as hash from auth.one_time_tokens where relates_to = ${email}
       union
       select confirmation_token from auth.users where email = ${email}
       union
       select recovery_token from auth.users where email = ${email}`
    );
    return rows
      .map((row) => String(row.hash ?? '').replace(/^pkce_/, ''))
      .filter((hash) => hash.length >= 16);
  } catch {
    return [];
  }
}

function linksIn(mails: Mail[], hashes: string[]): Link[] {
  const hrefs = mails.flatMap((mail) =>
    [
      ...mail.html.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi),
    ].map((match) => decode(match[1] ?? match[2] ?? match[3] ?? '').trim())
  );
  return [...new Set(hrefs)]
    .filter((href) => URL.canParse(href))
    .flatMap((href): Link[] => {
      const url = new URL(href);
      const token = url.searchParams.get('token');
      if (url.pathname.endsWith('/verify') && token) {
        return [{ kind: 'verify link', href, hash: token }];
      }
      const values = [...url.searchParams.values()].map((value) =>
        value.replace(/^pkce_/, '')
      );
      const hash =
        values.find((value) => hashes.includes(value)) ??
        url.searchParams.get('token_hash');
      return hash ? [{ kind: 'token hash', href, hash }] : [];
    });
}

function decode(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCharCode(Number.parseInt(code, 16))
    )
    .replace(/&amp;/g, '&');
}

async function followEvery(
  ctx: Ctx,
  stack: Stack,
  links: Link[],
  enough: (followed: Followed) => boolean
): Promise<Followed[]> {
  const followed: Followed[] = [];
  for (const link of links) {
    const result = await follow(ctx, stack, link);
    followed.push(result);
    if (enough(result)) break;
  }
  return followed;
}

async function follow(ctx: Ctx, stack: Stack, link: Link): Promise<Followed> {
  const host = new URL(link.href).hostname;
  if (!LOCAL_HOSTS.includes(host)) {
    return unfollowed(
      link,
      `the link points at ${host}, which is not the local project`
    );
  }
  try {
    const result = (await runScript(ctx, FOLLOW, {
      P_API: stack.apiUrl,
      P_CLIENT: stack.clientKey,
      P_HREF: link.href,
      P_KIND: link.kind,
      P_HASH: link.hash,
      P_TYPE: new URL(link.href).searchParams.get('type') ?? '',
    })) as Omit<Followed, keyof Link>;
    return { ...link, ...result };
  } catch (error) {
    return unfollowed(link, messageOf(error));
  }
}

function unfollowed(link: Link, error: string): Followed {
  return { ...link, status: 0, location: '', session: false, error };
}

async function isConfirmed(ctx: Ctx, address: string): Promise<boolean | null> {
  try {
    const { rows } = await ctx.query(
      `select (email_confirmed_at is not null) as confirmed from auth.users where email = ${sqlLiteral(address)}`
    );
    return rows.length > 0 ? Boolean(rows[0]?.confirmed) : null;
  } catch {
    return null;
  }
}

export function checkStackStarts(started: Step): CheckResult {
  return {
    name: CHECK.starts,
    passed: started.ok,
    notes: started.ok ? 'supabase start exited 0' : started.message,
  };
}

export function checkQueued(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.queued, probe.message);
  const requests = probe.requests;
  const mail = probe.signUpMails[0];
  if (mail) {
    return {
      name: CHECK.queued,
      passed: true,
      notes: `"${mail.subject}" to ${mail.to_email}`,
    };
  }
  return {
    name: CHECK.queued,
    passed: false,
    notes: [
      'no outbox row for the new person',
      `sign-up returned ${requests?.signUpStatus ?? 0}${requests?.signUpError ? `: ${requests.signUpError}` : ''}`,
      probe.outboxError
        ? `reading the outbox failed: ${probe.outboxError}`
        : '',
    ]
      .filter((part) => part.length > 0)
      .join('; '),
  };
}

export function checkConfirms(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.confirms, probe.message);
  if (probe.signUpMails.length === 0) {
    return {
      name: CHECK.confirms,
      passed: false,
      notes: 'no sign-up email in the outbox to read',
    };
  }
  if (probe.signUpLinks.length === 0) {
    return {
      name: CHECK.confirms,
      passed: false,
      notes: noLink(probe.signUpMails),
    };
  }
  const worked = probe.confirmed === true;
  const tried = probe.signUpLinks
    .map(
      (link) =>
        `${link.kind} ${clip(link.href)} (${link.error || `status ${link.status}`})`
    )
    .join('; ');
  return {
    name: CHECK.confirms,
    passed: worked,
    notes: worked
      ? `followed every link in the email, the person is confirmed: ${tried}`
      : `followed every link in the email, the person is ${probe.confirmed === null ? 'missing' : 'not confirmed'}: ${tried}`,
  };
}

export function checkReset(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.reset, probe.message);
  const requests = probe.requests;
  if (probe.resetMails.length === 0) {
    return {
      name: CHECK.reset,
      passed: false,
      notes: `no password reset email in the outbox; the request returned ${requests?.resetStatus ?? 0}${requests?.resetError ? `: ${requests.resetError}` : ''}`,
    };
  }
  if (probe.resetLinks.length === 0) {
    return {
      name: CHECK.reset,
      passed: false,
      notes: noLink(probe.resetMails),
    };
  }
  const working = probe.resetLinks.find(
    (link) => resetProblem(link) === undefined
  );
  return {
    name: CHECK.reset,
    passed: working !== undefined,
    notes: working
      ? `the ${working.kind} ${clip(working.href)} opens ${NEW_PASSWORD_PAGE} signed in`
      : probe.resetLinks
          .map((link) => resetProblem(link))
          .filter((problem) => problem !== undefined)
          .join('; '),
  };
}

function resetProblem(link: Followed): string | undefined {
  if (link.error) return `following ${clip(link.href)} failed: ${link.error}`;
  if (link.kind === 'verify link') {
    if (!URL.canParse(link.location)) {
      return `Auth answered ${link.status} with no redirect for ${clip(link.href)}`;
    }
    const landed = new URL(link.location);
    if (!landed.hash.includes('access_token=')) {
      return `the person lands on ${clip(link.location)} without being signed in`;
    }
    return landsOnPage(landed.href)
      ? undefined
      : `the person lands signed in on ${pageOf(landed)}, not ${NEW_PASSWORD_PAGE}`;
  }
  if (!link.session) {
    return `Auth refused the token hash in ${clip(link.href)} (status ${link.status})`;
  }
  const url = new URL(link.href);
  return landsOnPage(url.href) ||
    [...url.searchParams.values()].some((value) => landsOnPage(value))
    ? undefined
    : `the link signs the person in but names no way to ${NEW_PASSWORD_PAGE}: ${clip(link.href)}`;
}

function landsOnPage(candidate: string): boolean {
  const page = new URL(NEW_PASSWORD_PAGE);
  if (!candidate.startsWith('/') && !URL.canParse(candidate)) return false;
  return pageOf(new URL(candidate, page.origin)) === pageOf(page);
}

function pageOf(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function noLink(mails: Mail[]): string {
  const preview = mails
    .map((mail) => mail.html.replace(/\s+/g, ' ').slice(0, 160))
    .join(' | ');
  return `the email has no link to Auth's verify endpoint and no link carrying the token hash: ${preview}`;
}

function clip(text: string): string {
  return text.slice(0, 200);
}

function blocked(name: string, message: string): CheckResult {
  return { name, passed: false, notes: `not run: ${message}` };
}

export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
