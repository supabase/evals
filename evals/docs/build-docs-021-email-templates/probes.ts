import { randomUUID } from 'node:crypto';
import type { CheckResult, LocalStackEvalContext } from '@supabase-evals/core';

type Exec = Pick<LocalStackEvalContext, 'exec'>;
type Query = Pick<LocalStackEvalContext, 'exec' | 'query'>;
export type Step = { ok: boolean; message: string };
type Mail = { subject: string; html: string; text: string };
type Link = { kind: string; status: number; error: string };
export type Probe = Step & {
  email: string;
  nickname: string;
  signedUp: Mail | null;
  signUpStatus: number;
  link: Link | null;
  confirmed: boolean | null;
  recovery: Mail | null;
  magicLink: Mail | null;
};

export const CHECK = {
  starts: 'the local stack starts with the project settings',
  sent: 'signing up sends an email to the new user',
  subject: 'the sign-up email has the subject the team wrote',
  copy: 'the sign-up email carries the heading, message and button the team wrote',
  nickname: 'the sign-up email says hi to the person by their nickname',
  button: 'the button in the sign-up email confirms the person',
  others: 'other emails are still the standard ones',
} as const;

export const SUBJECT = 'Welcome to Harbour Studio, confirm your email';
const HEADING = 'You are almost in';
const MESSAGE = 'one tap and you can book your first class';
const BUTTON = 'Confirm and book';
const STANDARD_SUBJECTS = {
  recovery: 'Reset your password',
  magicLink: 'Your sign-in link',
} as const;

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

const SCRIPT = `
const api = process.env.P_API;
const anon = process.env.P_ANON;
const admin = process.env.P_ADMIN;
const mailpit = process.env.P_MAILPIT;
const email = process.env.P_EMAIL;
const other = process.env.P_OTHER;
const nickname = process.env.P_NICKNAME;
const button = process.env.P_BUTTON;
const json = (key) => ({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const seen = new Set();
async function next(address) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    const list = await fetch(mailpit + '/api/v1/messages').then((r) => r.json()).catch(() => ({}));
    const found = (list.messages || []).find(
      (m) => !seen.has(m.ID) && (m.To || []).some((t) => t.Address === address)
    );
    if (found) {
      seen.add(found.ID);
      const full = await fetch(mailpit + '/api/v1/message/' + found.ID).then((r) => r.json());
      return { subject: full.Subject || '', html: full.HTML || '', text: full.Text || '' };
    }
    await sleep(500);
  }
  return null;
}
const out = { signUpStatus: 0, signedUp: null, link: null, recovery: null, magicLink: null };
const signUp = await fetch(api + '/auth/v1/signup', {
  method: 'POST',
  headers: json(anon),
  body: JSON.stringify({ email, password: 'Harbour-' + email.slice(0, 6) + '-9', data: { nickname } }),
});
out.signUpStatus = signUp.status;
out.signedUp = await next(email);
if (out.signedUp) {
  const anchors = [...out.signedUp.html.matchAll(/<a\\b[^>]*href\\s*=\\s*(?:["']([^"']+)["']|([^\\s>"']+))[^>]*>([\\s\\S]*?)<\\/a>/gi)];
  const decode = (s) => s.replace(/&#(\\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
  const labelled = anchors.find((a) => a[3].replace(/<[^>]+>/g, '').includes(button));
  const tokened = anchors.find((a) => /token|verify/.test(a[1] || a[2]));
  const chosen = labelled || tokened;
  if (!chosen) {
    out.link = { kind: 'none', status: 0, error: 'the email has no link to follow' };
  } else {
    try {
      const url = new URL(decode(chosen[1] || chosen[2]));
      const hash = url.searchParams.get('token_hash');
      if (url.pathname.endsWith('/auth/v1/verify') && url.searchParams.get('token')) {
        const res = await fetch(url, { redirect: 'manual' });
        out.link = { kind: 'verify link', status: res.status, error: '' };
      } else if (hash) {
        const res = await fetch(api + '/auth/v1/verify', {
          method: 'POST',
          headers: json(anon),
          body: JSON.stringify({ type: url.searchParams.get('type') || 'email', token_hash: hash }),
        });
        out.link = { kind: 'token hash', status: res.status, error: '' };
      } else {
        out.link = { kind: 'other', status: 0, error: 'the link carries no token: ' + url.href.slice(0, 160) };
      }
    } catch (error) {
      out.link = { kind: 'unreadable', status: 0, error: 'the link is not a url: ' + String(chosen[1] || chosen[2]).slice(0, 160) };
    }
  }
}
const created = await fetch(api + '/auth/v1/admin/users', {
  method: 'POST',
  headers: json(admin),
  body: JSON.stringify({ email: other, email_confirm: true }),
});
if (created.ok) {
  await fetch(api + '/auth/v1/recover', { method: 'POST', headers: json(anon), body: JSON.stringify({ email: other }) });
  out.recovery = await next(other);
  await sleep(2500);
  await fetch(api + '/auth/v1/otp', { method: 'POST', headers: json(anon), body: JSON.stringify({ email: other, create_user: false }) });
  out.magicLink = await next(other);
}
console.log(JSON.stringify(out));
`;

export async function probeEmails(ctx: Query, started: Step): Promise<Probe> {
  const run = randomUUID().slice(0, 8);
  const empty: Probe = {
    ok: false,
    message: '',
    email: `welcome-${run}@example.test`,
    nickname: `Wren${run}`,
    signedUp: null,
    signUpStatus: 0,
    link: null,
    confirmed: null,
    recovery: null,
    magicLink: null,
  };
  if (!started.ok) return { ...empty, message: started.message };
  try {
    const stack = await readStack(ctx);
    const env = [
      `P_API='${stack.apiUrl}'`,
      `P_ANON='${stack.anon}'`,
      `P_ADMIN='${stack.admin}'`,
      `P_MAILPIT='${stack.mailpit}'`,
      `P_EMAIL='${empty.email}'`,
      `P_OTHER='reset-${run}@example.test'`,
      `P_NICKNAME='${empty.nickname}'`,
      `P_BUTTON='${BUTTON}'`,
    ].join(' ');
    const script = Buffer.from(SCRIPT, 'utf8').toString('base64');
    const result = await ctx.exec(
      `${env} node --input-type=module -e "$(echo ${script} | base64 -d)"`,
      { timeoutMs: 180_000 }
    );
    const line = (result.stdout ?? '').trim().split('\n').at(-1) ?? '';
    if (!line.startsWith('{')) {
      return {
        ...empty,
        message: errorLine(`${result.stderr}\n${result.stdout}`),
      };
    }
    const parsed = JSON.parse(line);
    let confirmed: boolean | null = null;
    try {
      const { rows } = await ctx.query(
        `select (email_confirmed_at is not null) as confirmed from auth.users where email = '${empty.email}'`
      );
      confirmed = rows.length > 0 ? Boolean(rows[0].confirmed) : null;
    } catch {
      confirmed = null;
    }
    return { ...empty, ok: true, ...parsed, confirmed };
  } catch (error) {
    return { ...empty, message: messageOf(error) };
  }
}

export function checkStackStarts(started: Step): CheckResult {
  return {
    name: CHECK.starts,
    passed: started.ok,
    notes: started.ok ? 'supabase start exited 0' : started.message,
  };
}

export function checkSent(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.sent, probe);
  return {
    name: CHECK.sent,
    passed: probe.signedUp !== null,
    notes: probe.signedUp
      ? `"${probe.signedUp.subject}"`
      : `no message reached the inbox within 20s, sign-up returned ${probe.signUpStatus}`,
  };
}

export function checkSubject(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.subject, probe);
  if (!probe.signedUp) return noMail(CHECK.subject);
  return {
    name: CHECK.subject,
    passed: probe.signedUp.subject === SUBJECT,
    notes: `subject was "${probe.signedUp.subject}"`,
  };
}

export function checkCopy(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.copy, probe);
  if (!probe.signedUp) return noMail(CHECK.copy);
  const html = probe.signedUp.html;
  const words = plain(html);
  const missing = [
    words.includes(HEADING) ? '' : `heading "${HEADING}"`,
    words.includes(MESSAGE) ? '' : `message "${MESSAGE}"`,
    /\b\d{6,8}\b/.test(words) ? 'no code, but the email has one' : '',
    buttonText(html).some((text) => text.includes(BUTTON))
      ? ''
      : `a link labelled "${BUTTON}"`,
  ].filter(Boolean);
  return {
    name: CHECK.copy,
    passed: missing.length === 0,
    notes:
      missing.length === 0
        ? 'all three present'
        : `missing ${missing.join(', ')}`,
  };
}

export function checkNickname(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.nickname, probe);
  if (!probe.signedUp) return noMail(CHECK.nickname);
  const words = plain(probe.signedUp.html);
  const greeted = words.includes(`Hi ${probe.nickname}`);
  return {
    name: CHECK.nickname,
    passed: greeted,
    notes: greeted
      ? 'greets the nickname given at sign-up'
      : `the message reads: ${words.slice(0, 160)}`,
  };
}

export function checkButton(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.button, probe);
  if (!probe.signedUp) return noMail(CHECK.button);
  const link = probe.link;
  const worked = probe.confirmed === true;
  return {
    name: CHECK.button,
    passed: worked,
    notes: worked
      ? `followed the ${link?.kind}, the user is confirmed`
      : link?.error ||
        `followed the ${link?.kind} (status ${link?.status}), the user is ${probe.confirmed === null ? 'missing' : 'not confirmed'}`,
  };
}

export function checkOthers(probe: Probe): CheckResult {
  if (!probe.ok) return blocked(CHECK.others, probe);
  const mails = [
    ['password reset', probe.recovery, STANDARD_SUBJECTS.recovery],
    ['magic link', probe.magicLink, STANDARD_SUBJECTS.magicLink],
  ] as const;
  const problems = mails
    .map(([label, mail, subject]) => {
      if (!mail) return `no ${label} email reached the inbox within 20s`;
      const words = plain(mail.html);
      return mail.subject === subject && !words.includes(HEADING)
        ? ''
        : `the ${label} email is "${mail.subject}"`;
    })
    .filter(Boolean);
  return {
    name: CHECK.others,
    passed: problems.length === 0,
    notes:
      problems.length === 0
        ? 'the password reset and magic link emails are the standard ones'
        : problems.join('; '),
  };
}

function noMail(name: string): CheckResult {
  return { name, passed: false, notes: 'no sign-up email to read' };
}

function plain(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function buttonText(html: string): string[] {
  return [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((match) =>
    plain(match[1] ?? '')
  );
}

async function readStack(ctx: Exec): Promise<{
  apiUrl: string;
  anon: string;
  admin: string;
  mailpit: string;
}> {
  const result = await ctx.exec('supabase status -o json 2>/dev/null');
  const out = result.stdout ?? '';
  const parsed = JSON.parse(
    out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)
  );
  const apiUrl = parsed.API_URL;
  const anon = parsed.PUBLISHABLE_KEY || parsed.ANON_KEY;
  const admin = parsed.SERVICE_ROLE_KEY || parsed.SECRET_KEY;
  if (!apiUrl || !anon || !admin) {
    throw new Error(
      `supabase status had no API_URL or keys: ${Object.keys(parsed).join(', ')}`
    );
  }
  const mailpit =
    parsed.MAILPIT_URL || parsed.INBUCKET_URL || 'http://127.0.0.1:54324';
  return { apiUrl, anon, admin, mailpit };
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
